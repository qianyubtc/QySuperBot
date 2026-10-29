import type { Database, Row } from './database.ts';
import { json } from './context.ts';

const kinds = [
  'login_required',
  'identity_changed',
  'temporary_error',
  'access_blocked',
  'permission_denied',
  'check_required',
] as const;
type IssueKind = (typeof kinds)[number];
type Issue = { kind: IssueKind; operation: string; group_id?: string; started: number; at: string };
type Health = {
  session_id?: string;
  checked_at?: string;
  verified_at?: string;
  synced_at?: string;
  checks?: Record<string, number>;
  auth_verified_started?: number;
  issues?: Record<string, Issue>;
};
let sequence = 0;
export const beginBinanceCheck = () => (sequence = Math.max(Date.now(), sequence + 1));

// Only explicit website authentication failures require a human login. A short-lived IM token,
// CDN rejection or HTTP 403 alone does not prove the saved website credentials have expired.
export function binanceFailureKind(error: unknown): IssueKind {
  const value = error as { code?: string; bridgeError?: Record<string, unknown> };
  if (value?.code === 'BINANCE_TOKEN_EXPIRED') return 'login_required';
  if (value?.code === 'BINANCE_IDENTITY_CHANGED') return 'identity_changed';
  const detail = value?.bridgeError;
  const website = ['profile', 'group', 'member', 'history', 'token', 'restriction', 'groups'].includes(
    String(detail?.stage),
  );
  if (website && (detail?.http_status === 401 || detail?.api_code === '100001005')) return 'login_required';
  if (detail?.detail === 'TOKEN_IDENTITY') return 'identity_changed';
  if (
    ['NETWORK', 'TIMEOUT', 'SOCKET'].includes(String(detail?.code)) ||
    detail?.http_status === 429 ||
    Number(detail?.http_status) >= 500 ||
    detail?.detail === 'TOKEN_EXPIRED'
  )
    return 'temporary_error';
  if (detail?.http_status === 403) return 'access_blocked';
  if (detail?.code === 'PERMISSION' && ['member', 'restriction'].includes(String(detail.stage)))
    return 'permission_denied';
  return 'check_required';
}

const messages: Record<IssueKind, string> = {
  login_required: '币安登录已失效，请重新登录并连接此账号；原同步群选择会保留。',
  identity_changed: '币安登录身份与此连接不一致，请重新登录原账号；其他账号请新建连接。',
  temporary_error: '币安请求暂时未完成，后台会自动检查连接；也可立即手动检查。',
  access_blocked: '币安拒绝了本次访问，请先检查服务器网络和账号访问限制；这不代表令牌已过期。',
  permission_denied: '当前群的成员身份、禁言状态或发送权限需要检查，重新登录不会自动恢复群权限。',
  check_required: '暂时无法确认币安连接状态，请先检查连接；持续失败时可重新登录。',
};
export const binanceFailureMessage = (error: unknown) => messages[binanceFailureKind(error)];

async function update(
  db: Database,
  account: Row,
  operation: string,
  group: unknown,
  started: number,
  failure?: { error: unknown },
) {
  if (account.settings?.transport !== 'direct') return false;
  const failureKind = failure ? binanceFailureKind(failure.error) : undefined;
  const stage = (failure?.error as { bridgeError?: { stage?: string } })?.bridgeError?.stage;
  if (
    failure &&
    ['member_set_mute', 'member_remove'].includes(operation) &&
    !['login_required', 'identity_changed'].includes(failureKind!) &&
    ['API', 'PERMISSION'].includes(
      String((failure.error as { bridgeError?: { code?: string } })?.bridgeError?.code),
    )
  )
    return true; // A rejected member operation belongs to its job, not the account login state.
  // Publication errors belong to the delivery record. They are not evidence that the
  // connection itself is broken; authentication/member/socket failures still are.
  if (
    failure &&
    ['send', 'send_image', 'image_url'].includes(operation) &&
    !['login_required', 'identity_changed'].includes(failureKind!) &&
    !['profile', 'group', 'member', 'history', 'token', 'domain', 'socket', 'restriction', 'groups'].includes(
      stage ?? '',
    )
  )
    return true;
  const groupId = typeof group === 'string' && /^\d{1,19}$/.test(group) ? group : undefined;
  const key = `${operation}:${groupId ?? ''}`;
  return db.transaction(async (tx) => {
    const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [account.id]))[0];
    if (
      !current ||
      current.status === 'paused' ||
      current.session_id !== account.session_id ||
      current.secret_box !== account.secret_box ||
      current.settings.transport !== 'direct' ||
      (groupId &&
        (!current.settings.group_ids.includes(groupId) ||
          current.settings.group_revision !== account.settings.group_revision)) ||
      (operation === 'sync' && current.settings.group_revision !== account.settings.group_revision)
    )
      return false;
    const metadataKey = `binance-health:${account.id}`;
    const saved = (await tx.query('SELECT value FROM metadata WHERE key=$1', [metadataKey]))[0]?.value as
      Health | undefined;
    const health: Health =
      saved && saved.session_id === current.session_id ? saved : { session_id: current.session_id };
    const issues = { ...health.issues };
    const checks = { ...health.checks };
    if ((checks[key] ?? 0) > started) return false;
    checks[key] = started;
    const now = new Date().toISOString();
    if (failure) {
      if ((issues[key]?.started ?? 0) > started) return false;
      const kind = binanceFailureKind(failure.error);
      if (
        ['login_required', 'identity_changed'].includes(kind) &&
        (health.auth_verified_started ?? 0) > started
      )
        return false;
      issues[key] = { kind, operation, ...(groupId ? { group_id: groupId } : {}), started, at: now };
      if (['login_required', 'identity_changed'].includes(kind))
        await tx.query("UPDATE accounts SET status='expired',last_error=$2 WHERE id=$1", [
          account.id,
          messages[kind],
        ]);
    } else {
      // An older successful request must not clear a newer error, nor can another group's
      // successful history request hide the failing group's state.
      if ((issues[key]?.started ?? 0) <= started) delete issues[key];
      if (operation === 'profile') {
        health.verified_at = new Date(started).toISOString();
        health.auth_verified_started = started;
        for (const [id, issue] of Object.entries(issues))
          if (['login_required', 'identity_changed'].includes(issue.kind) && issue.started <= started)
            delete issues[id];
      }
      if (operation === 'sync') health.synced_at = now;
      if (['send_check', 'send', 'send_image'].includes(operation))
        for (const [id, issue] of Object.entries(issues))
          if (
            issue.group_id === groupId &&
            issue.started <= started &&
            (issue.kind === 'permission_denied' ||
              (operation === 'send_check' &&
                ['send', 'send_image', 'image_url'].includes(issue.operation) &&
                !['login_required', 'identity_changed'].includes(issue.kind)))
          )
            delete issues[id];
    }
    for (const [id, issue] of Object.entries(issues))
      if (issue.group_id && !current.settings.group_ids.includes(issue.group_id)) delete issues[id];
    for (const id of Object.keys(checks)) {
      const group = id.split(':')[1];
      if (group && !current.settings.group_ids.includes(group)) delete checks[id];
    }
    await tx.query(
      'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
      [metadataKey, json({ ...health, checked_at: now, checks, issues })],
    );
    return true;
  });
}

export const recordBinanceFailure = (
  db: Database,
  account: Row,
  operation: string,
  group: unknown,
  started: number,
  error: unknown,
) => update(db, account, operation, group, started, { error });
export const recordBinanceSuccess = (
  db: Database,
  account: Row,
  operation: string,
  group: unknown,
  started: number,
) => update(db, account, operation, group, started);

export function hasBinanceLoginIssue(account: Row, raw?: Health) {
  return (
    account.settings?.transport === 'direct' &&
    raw?.session_id === account.session_id &&
    Object.values(raw?.issues ?? {}).some(
      (issue) =>
        ['login_required', 'identity_changed'].includes(issue.kind) &&
        (!issue.group_id || account.settings.group_ids?.includes(issue.group_id)),
    )
  );
}

export function binanceConnection(account: Row, raw?: Health, loginAvailable = false) {
  const direct = account.settings?.transport === 'direct';
  const health = raw?.session_id === account.session_id ? raw : undefined;
  const issues = Object.values(health?.issues ?? {}).filter(
    (issue) =>
      kinds.includes(issue.kind) && (!issue.group_id || account.settings.group_ids?.includes(issue.group_id)),
  );
  const issue = [...issues].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind))[0];
  const expired =
    direct &&
    account.settings.direct_auth?.expires_at &&
    Date.parse(account.settings.direct_auth.expires_at) <= Date.now();
  const syncSince = health?.synced_at ?? account.settings.direct_auth?.configured_at;
  let state = 'connected',
    title = direct ? '服务器直连正常' : '浏览器桥接在线',
    message = direct
      ? '无需保持浏览器或插件运行，新消息由服务器同步。'
      : '请保持已登录的币安聊天页和扩展运行。';
  if (account.status === 'paused') {
    state = 'paused';
    title = '连接已暂停';
    message = '恢复连接后才会继续同步和发送。';
  } else if (direct && (expired || account.status === 'expired' || hasBinanceLoginIssue(account, raw))) {
    state = issue?.kind === 'identity_changed' ? 'identity_changed' : 'login_required';
    title = state === 'identity_changed' ? '登录账号不一致' : '登录已失效';
    message = messages[state as IssueKind];
  } else if (issue) {
    state = issue.kind;
    title =
      (
        {
          temporary_error: '连接暂时异常',
          access_blocked: '访问受限',
          permission_denied: '群权限待处理',
          check_required: '连接待检查',
        } as Record<string, string>
      )[state] ?? '连接待检查';
    message = messages[issue.kind];
  } else if (['connecting', 'configuring'].includes(account.status)) {
    state = 'connecting';
    title = '等待连接';
    message = '完成币安登录后点击“连接此账号”，验证通过即恢复同步。';
  } else if (account.status !== 'online') {
    state = 'check_required';
    title = direct ? '连接待检查' : '浏览器桥接未连接';
    message = direct ? messages.check_required : '请恢复已登录的币安聊天页与扩展，或改用服务器登录。';
  } else if (!account.settings.group_ids?.length) {
    state = 'awaiting_groups';
    title = '等待选择同步群';
    message = '账号已连接，选择聊天室后即可开始同步。';
  } else if (direct && syncSince && Date.now() - Date.parse(syncSince) > 120_000) {
    state = 'check_required';
    title = '同步状态待检查';
    message = health?.synced_at
      ? '超过两分钟未完成一次消息同步检查，请检查连接。'
      : '登录后超过两分钟仍未完成首次消息同步检查，请检查连接。';
  }
  return {
    state,
    title,
    message,
    needs_relogin: ['login_required', 'identity_changed'].includes(state),
    login_available: loginAvailable,
    checked_at: health?.checked_at ?? null,
    verified_at: health?.verified_at ?? null,
    synced_at: health?.synced_at ?? null,
    configured_at: direct ? (account.settings.direct_auth?.configured_at ?? null) : null,
    expires_at: direct ? (account.settings.direct_auth?.expires_at ?? null) : null,
    issue_group_id: issue?.group_id ?? null,
  };
}
