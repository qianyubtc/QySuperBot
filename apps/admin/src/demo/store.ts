// Entirely synthetic fixtures. This module has no network or server dependency.
type Row = Record<string, any>;
export const DEMO_KEY = 'qysuperbot:demo:v1';
export const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const policy = () => ({
  mode: 'observe',
  action: 'delete',
  keywords: ['示例广告'],
  blocked_domains: ['spam.example'],
  verification_enabled: false,
  verification_timeout: 60,
  verification_timeout_action: 'manual',
  verification_failed_action: 'manual',
});
export const poster =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" rx="24" fill="#285b46"/><circle cx="545" cy="70" r="145" fill="#b6d09a" opacity=".25"/><text x="48" y="120" fill="#d9e9c8" font-size="22" font-family="sans-serif">SUPERBOT / COMMUNITY</text><text x="48" y="220" fill="white" font-size="48" font-family="sans-serif">一起聊聊，下一种可能</text><text x="48" y="310" fill="#d9e9c8" font-size="22" font-family="sans-serif">本地演示 · 社群分享会</text></svg>',
  );
export function seed(): Row {
  const platforms = ['telegram', 'qq', 'binance', 'custom'];
  const accounts = platforms.map((kind, i) => ({
    id: `demo-account-${kind}`,
    kind,
    platform: kind,
    name: ['青羽 · TG 演示机器人', 'QQ 演示机器人', '币安演示账号', '自有聊天示例'][i],
    external_id: String(900000 + i),
    status: 'online',
    is_demo: false,
    endpoint: null,
    created_at: now(),
    last_seen_at: now(),
    settings: {
      group_ids: [`demo-room-${kind}`],
      transport: kind === 'binance' ? 'direct' : 'bridge',
    },
    ...(kind === 'binance'
      ? {
          connection: {
            state: 'connected',
            title: '服务器直连正常（演示）',
            message: '本地模拟连接，不访问币安',
            needs_relogin: false,
            can_open_browser: true,
            can_refresh: true,
            transport: 'direct',
          },
        }
      : {}),
  }));
  const groups = platforms.flatMap((platform, i) =>
    [0, 1].map((n) => ({
      id: `demo-${platform}-${n}`,
      external_id: `demo-room-${platform}${n ? '-extra' : ''}`,
      name: n
        ? `${['技术交流', '产品体验', '社群交流', '开发者'][i]} · 备用群`
        : ['千羽技术交流群', '产品体验群', '社群公开交流', '开发者讨论区'][i],
      platform,
      kind: 'group',
      executor_account_id: `demo-account-${platform}`,
      account_name: accounts[i]!.name,
      account_status: 'online',
      member_count: 168 + i * 63,
      policy: policy(),
      policy_version: uid(),
      sync_enabled: !n,
      is_demo: false,
      messages_24h: 125,
      pending_verifications: 0,
      blocked_count: 1,
      created_at: now(),
      commands_enabled: false,
      auto_approve: false,
    })),
  );
  const names = ['小羽', '林舟', '阿禾', '星辰'];
  const messages = groups.flatMap((g) =>
    Array.from({ length: 125 }, (_, i) => ({
      id: `${g.id}-message-${String(i).padStart(3, '0')}`,
      external_id: `synthetic-${g.id}-${i}`,
      conversation_id: g.id,
      sender_id: String(100001 + (i % 4)),
      sender_name: names[i % 4],
      content:
        i === 123
          ? '今晚的社群分享会，欢迎大家参加。'
          : i === 124
            ? '可以在这里直接回复，也可以切换平台试试看。'
            : [
                '欢迎加入，我们在这里分享项目进展。',
                '图片和历史消息都可以查看。',
                '这是一条本地生成的演示消息。',
                '有什么想法都可以聊聊。',
              ][i % 4],
      segments: i === 123 ? [{ type: 'image' }] : [{ type: 'text', text: '演示消息' }],
      direction: 'incoming',
      verdict: 'allowed',
      reason: null,
      deleted: false,
      moderation_jobs: [],
      created_at: new Date(Date.now() - (125 - i) * 60000).toISOString(),
      source_at: new Date(Date.now() - (125 - i) * 60000).toISOString(),
    })),
  );
  return {
    version: 1,
    accounts,
    groups,
    messages,
    deliveries: [],
    announcements: [],
    actions: [],
    blacklists: [],
    verifications: [
      {
        id: 'demo-verification',
        conversation_id: 'demo-qq-0',
        conversation_name: '产品体验群',
        platform: 'qq',
        user_id: '100003',
        status: 'manual_review',
        expires_at: now(),
        created_at: now(),
        wrong_answers: 0,
        reason: '演示：验证超时，等待管理员处理',
      },
    ],
    projects: [],
    routes: [],
    lotteries: [
      {
        id: 'demo-lottery',
        title: '社群周末分享抽奖（演示）',
        conversation_id: 'demo-telegram-0',
        conversation_name: '千羽技术交流群',
        entries_count: 4,
        winners_count: 1,
        winners: [],
        closes_at: new Date(Date.now() - 1000).toISOString(),
        status: 'open',
      },
    ],
    audit: [
      {
        id: 'demo-audit',
        actor: '演示管理员',
        action: 'account.created',
        target: '虚拟平台连接',
        detail: { demo: true },
        created_at: now(),
      },
    ],
    images: {},
    idempotency: {},
  };
}
export class DemoError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export class DemoStore {
  state: Row;
  listeners = new Set<() => void>();
  private storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  constructor(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
    this.storage = storage;
    this.state = seed();
    try {
      const value = JSON.parse(storage?.getItem(DEMO_KEY) ?? 'null');
      if (
        value?.version === 1 &&
        ['accounts', 'groups', 'messages', 'deliveries', 'audit'].every((k) => Array.isArray(value[k])) &&
        value.images &&
        value.idempotency
      )
        this.state = value;
      for (const g of this.state.groups) if (g.kind === 'supergroup') g.kind = 'group';
    } catch {
      /* A corrupt or unavailable sandbox starts from synthetic fixtures. */
    }
  }
  reset() {
    this.storage?.removeItem(DEMO_KEY);
    this.state = seed();
    this.listeners.forEach((fn) => fn());
  }
  update(fn: (draft: Row) => any) {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    try {
      this.storage?.setItem(DEMO_KEY, JSON.stringify(draft));
    } catch {
      throw new DemoError('浏览器存储空间不足或不可用，本次修改未保存。请重置演示或减少图片大小。');
    }
    this.state = draft;
    this.listeners.forEach((fn) => fn());
    return structuredClone(result ?? { saved: true });
  }
  group(id: string) {
    const g = this.state.groups.find((g: Row) => g.id === id);
    if (!g) throw new DemoError('演示群不存在', 404);
    return g;
  }
  account(id: string) {
    const a = this.state.accounts.find((a: Row) => a.id === id);
    if (!a) throw new DemoError('演示账号不存在', 404);
    return a;
  }
  groups() {
    return this.state.groups.map((g: Row) => {
      const a = this.account(g.executor_account_id);
      return {
        ...g,
        account_status: a.status,
        sync_enabled: g.platform === 'custom' || a.settings.group_ids.includes(g.external_id),
      };
    });
  }
  enabled(id: string) {
    return this.groups().find((g: Row) => g.id === id)?.sync_enabled;
  }
  snapshot(id: string) {
    const g = this.groups().find((g: Row) => g.id === id);
    if (!g) throw new DemoError('演示群不存在', 404);
    const a = this.account(g.executor_account_id),
      messages = this.state.messages.filter((m: Row) => m.conversation_id === id).slice(-100);
    return {
      observed_at: now(),
      conversation: {
        ...g,
        account_id: a.id,
        can_send: g.sync_enabled && a.status === 'online',
        send_error: !g.sync_enabled
          ? '此群已取消同步'
          : a.status !== 'online'
            ? '演示连接已离线，请恢复连接'
            : null,
      },
      messages,
      deliveries: this.state.deliveries.filter((d: Row) => d.conversation_id === id),
      conversations: this.groups()
        .filter((g: Row) => g.sync_enabled)
        .map((g: Row) => {
          const m = this.state.messages.filter((m: Row) => m.conversation_id === g.id).at(-1);
          return {
            ...g,
            last_message_id: m?.id,
            last_at: m?.created_at,
            last_content: m?.content,
            last_direction: m?.direction,
          };
        }),
      pagination: {
        has_more: this.state.messages.filter((m: Row) => m.conversation_id === id).length > 100,
        before: messages[0]?.id ?? null,
      },
    };
  }
  log(s: Row, action: string, target: string) {
    s.audit.unshift({
      id: uid(),
      actor: '演示管理员',
      action,
      target,
      detail: { demo: true },
      created_at: now(),
    });
    s.audit = s.audit.slice(0, 200);
  }
  send(s: Row, g: Row, body: Row, status = 'succeeded') {
    if (!this.enabled(g.id) || this.account(g.executor_account_id).status !== 'online')
      throw new DemoError('请先开启该群同步并恢复虚拟连接');
    const segments = [
      ...(body.text ? [{ type: 'text', text: body.text }] : []),
      ...(body.image_asset_id ? [{ type: 'image', asset_id: body.image_asset_id }] : []),
    ];
    const d = {
      id: uid(),
      action: 'message.send',
      conversation_id: g.id,
      conversation_external_id: g.external_id,
      conversation_name: g.name,
      name: g.name,
      platform: g.platform,
      is_demo: true,
      status,
      content: body.text ?? '',
      image_asset_id: body.image_asset_id,
      params: { segments, reply_to: body.reply_to },
      created_at: now(),
      updated_at: now(),
      due_at: body.scheduled_at ?? now(),
      retryable: status === 'failed',
      attempts: [],
      receipt: { status, result: { message_id: 'demo-' + uid() } },
    };
    s.deliveries.unshift(d);
    if (status === 'succeeded') this.materialize(s, d);
    return d;
  }
  materialize(s: Row, d: Row) {
    const quote = s.messages.find(
      (m: Row) => m.id === d.reply_record_id || m.external_id === d.params.reply_to,
    );
    s.messages.push({
      id: uid(),
      external_id: d.receipt.result.message_id ?? 'demo-' + uid(),
      conversation_id: d.conversation_id,
      sender_id: 'demo-admin',
      sender_name: '演示机器人',
      content: d.content,
      segments: d.params.segments,
      direction: 'outgoing',
      verdict: 'official',
      moderation_jobs: [],
      created_at: now(),
      source_at: now(),
      reply_to: quote?.external_id,
      reply_content: quote?.content,
      reply_sender_name: quote?.sender_name,
    });
  }
  tick() {
    const due = this.state.deliveries.some(
      (d: Row) => d.status === 'pending' && Date.parse(d.due_at) <= Date.now(),
    );
    if (due)
      this.update((s) => {
        for (const d of s.deliveries.filter(
          (d: Row) => d.status === 'pending' && Date.parse(d.due_at) <= Date.now(),
        )) {
          d.status =
            this.enabled(d.conversation_id) &&
            this.account(this.group(d.conversation_id).executor_account_id).status === 'online'
              ? 'succeeded'
              : 'cancelled';
          if (d.status === 'succeeded') this.materialize(s, d);
          for (const a of s.announcements)
            for (const target of a.deliveries) if (target.id === d.id) target.status = d.status;
        }
      });
  }
  request(input: string, options: { method?: string; body?: any; key?: string } = {}) {
    this.tick();
    const url = new URL(input, 'https://demo.invalid'),
      path = url.pathname,
      method = options.method ?? 'GET',
      b = options.body ?? {};
    const user = {
      id: 'demo-admin',
      username: 'demo',
      name: '演示管理员',
      kind: 'admin',
      csrf: 'local-demo',
    };
    if (path === '/auth/state') return { setup_required: false };
    if (['/auth/me', '/auth/login', '/auth/setup'].includes(path)) return user;
    if (path === '/auth/logout') return { logged_out: true };
    const s = this.state;
    if (method === 'GET') {
      if (path === '/health') return { status: 'ok', storage: 'browser-local', version: '0.1.0' };
      if (path === '/accounts')
        return structuredClone(
          s.accounts.map((a: Row) => ({
            ...a,
            group_count: s.groups.filter((g: Row) => g.executor_account_id === a.id).length,
          })),
        );
      if (path === '/conversations') return this.groups();
      if (path === '/qq-local')
        return {
          available: true,
          account_id: 'demo-account-qq',
          accounts: s.accounts
            .filter((a: Row) => a.kind === 'qq')
            .map((a: Row) => ({ id: a.id, name: a.name, status: a.status })),
          online: this.account('demo-account-qq').status === 'online',
          message: '本地模拟登录',
        };
      if (path === '/announcements')
        return s.announcements.map((a: Row) => ({
          ...a,
          deliveries: a.deliveries.map((target: Row) => ({
            ...target,
            ...s.deliveries.find((d: Row) => d.id === target.id),
          })),
        }));
      if (path === '/overview')
        return {
          accounts: s.accounts.length,
          online_accounts: s.accounts.filter((a: Row) => a.status === 'online').length,
          conversations: s.groups.length,
          messages_today: s.messages.length,
          blocked_today: s.messages.filter((m: Row) => m.verdict === 'blocked').length,
          pending_verifications: s.verifications.filter((v: Row) => v.status !== 'passed').length,
          unknown_deliveries: s.deliveries.filter((d: Row) => d.status === 'unknown').length,
          deliveries_succeeded: s.deliveries.filter((d: Row) => d.status === 'succeeded').length,
          deliveries_pending: s.deliveries.filter((d: Row) => d.status === 'pending').length,
          demo_accounts: 0,
          series: Array.from({ length: 7 }, (_, i) => ({
            date: new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10),
            messages: 85 + i * 13,
            blocked: i % 3,
          })),
          platforms: ['telegram', 'qq', 'binance', 'custom'].map((platform) => ({
            platform,
            groups: 2,
          })),
          recent_activity: s.audit.slice(0, 8),
        };
      for (const collection of [
        'announcements',
        'deliveries',
        'blacklists',
        'verifications',
        'projects',
        'routes',
        'lotteries',
        'audit',
      ])
        if (path === '/' + collection) return structuredClone(s[collection]);
    }
    const aMatch = path.match(/^\/accounts\/([^/]+)\/(.+)$/);
    if (aMatch) {
      const a = this.account(aMatch[1]!),
        action = aMatch[2]!;
      if (/^(?:binance-)?groups(?:\/refresh)?$/.test(action)) {
        if (method === 'PUT')
          return this.update((d) => {
            if (b.revision !== (a.settings.revision ?? 'initial'))
              throw new DemoError('同步范围已变化，请刷新后重试', 409);
            const known = d.groups
              .filter((g: Row) => g.executor_account_id === a.id)
              .map((g: Row) => g.external_id);
            if (!Array.isArray(b.group_ids) || b.group_ids.some((id: string) => !known.includes(id)))
              throw new DemoError('群不属于此账号');
            const acc = d.accounts.find((v: Row) => v.id === a.id);
            const removed = new Set(
              d.groups
                .filter((g: Row) => g.executor_account_id === a.id && !b.group_ids.includes(g.external_id))
                .map((g: Row) => g.id),
            );
            for (const job of d.deliveries) {
              if (job.status !== 'pending' || !removed.has(job.conversation_id)) continue;
              job.status = 'cancelled';
              job.updated_at = now();
              job.receipt.status = 'cancelled';
              for (const announcement of d.announcements)
                for (const target of announcement.deliveries)
                  if (target.id === job.id) target.status = 'cancelled';
            }
            acc.settings.group_ids = b.group_ids;
            acc.settings.revision = uid();
            this.log(d, 'account.refreshed', a.name);
            return { saved: true };
          });
        return {
          groups: s.groups
            .filter((g: Row) => g.executor_account_id === a.id)
            .map((g: Row) => ({
              id: g.external_id,
              name: g.name,
              selected: a.settings.group_ids.includes(g.external_id),
            })),
          group_ids: a.settings.group_ids,
          revision: a.settings.revision ?? 'initial',
          discovered_at: now(),
        };
      }
      if (action === 'binance-browser' && method === 'GET') return { available: true, running: false };
      if (action === 'binance-browser' && method === 'POST') return { window_id: uid() };
      if (action === 'binance-browser' && method === 'DELETE') return { stopped: true };
      if (
        action === 'pause' ||
        [
          'refresh',
          'permissions-refresh',
          'binance-check',
          'binance-browser/connect',
          'binance-auth',
        ].includes(action ?? '')
      )
        return this.update((d) => {
          const acc = d.accounts.find((v: Row) => v.id === a.id);
          if (action !== 'permissions-refresh') acc.status = action === 'pause' ? 'paused' : 'online';
          if (acc.connection) {
            acc.connection.state = acc.status === 'paused' ? 'paused' : 'connected';
            acc.connection.needs_relogin = false;
            acc.connection.title = acc.status === 'paused' ? '演示连接已暂停' : '服务器直连正常（演示）';
          }
          this.log(d, action === 'pause' ? 'account.paused' : 'account.refreshed', a.name);
          return {
            id: a.id,
            mode: 'direct',
            groups: d.groups.filter((g: Row) => g.executor_account_id === a.id).length,
            connection: acc.connection,
            failed_groups: 0,
          };
        });
      if (action === 'binance-pairing')
        throw new DemoError('演示模式不生成真实配对密钥。请使用模拟登录体验连接流程。');
    }
    const gMatch = path.match(/^\/conversations\/([^/]+)(?:\/(.+))?$/);
    if (gMatch) {
      const id = gMatch[1]!,
        action = gMatch[2],
        g = this.group(id);
      if (!action && method === 'GET')
        return {
          ...this.groups().find((v: Row) => v.id === id),
          policy_options: Object.fromEntries(
            ['delete', 'remove', 'ban', 'verification', 'verification_remove', 'verification_mute'].map(
              (k) => [
                k,
                {
                  available: g.platform !== 'binance' && (g.platform !== 'qq' || k !== 'ban'),
                  reason: '演示：此平台未接入该动作',
                },
              ],
            ),
          ),
          bindings: [
            {
              account_id: g.executor_account_id,
              account_name: g.account_name,
              snapshot: {
                observed_at: now(),
                capabilities: [
                  'messages.send',
                  'messages.delete',
                  'members.remove',
                  'members.mute',
                  'members.ban',
                ].map((capability) => ({
                  capability,
                  state:
                    g.platform === 'binance' && capability === 'messages.delete'
                      ? 'unsupported'
                      : 'supported',
                })),
                permissions: [
                  'messages.send',
                  'messages.delete',
                  'members.remove',
                  'members.mute',
                  'members.ban',
                ].map((capability) => ({
                  capability,
                  permission: 'granted',
                  reason: '本地模拟权限',
                })),
              },
            },
          ],
          messages: s.messages
            .filter((m: Row) => m.conversation_id === id)
            .slice(-100)
            .reverse(),
          verifications: s.verifications.filter((v: Row) => v.conversation_id === id),
          blacklists: s.blacklists.filter((v: Row) => v.conversation_id === id),
        };
      if (action === 'chat') return this.snapshot(id);
      if (action === 'history') {
        const rows = s.messages.filter((m: Row) => m.conversation_id === id),
          index = rows.findIndex((m: Row) => m.id === url.searchParams.get('before'));
        if (index < 0) throw new DemoError('历史游标不存在', 409);
        const messages = rows.slice(Math.max(0, index - 50), index);
        return { messages, pagination: { has_more: index > 50, before: messages[0]?.id ?? null } };
      }
      if (action === 'verifications') return s.verifications.filter((v: Row) => v.conversation_id === id);
      if (action === 'policy')
        return this.update((d) => {
          if (
            b.mode === 'enforce' &&
            (g.platform === 'binance' || (g.platform === 'qq' && b.action === 'ban'))
          )
            throw new DemoError('此平台动作不支持');
          const row = d.groups.find((v: Row) => v.id === id);
          row.policy = { ...row.policy, ...b };
          row.policy_version = uid();
          this.log(d, 'policy.updated', g.name);
        });
      if (action === 'qq-requests') {
        if (method === 'PUT')
          return this.update((d) => {
            d.groups.find((v: Row) => v.id === id).auto_approve = !!b.auto_approve;
            this.log(d, 'qq.join.settings_updated', g.name);
          });
        return {
          available: this.enabled(id) && this.account(g.executor_account_id).status === 'online',
          auto_approve: g.auto_approve,
          requests: [],
          reason: '本地模拟权限',
        };
      }
      if (['member-management', 'binance-members'].includes(action ?? '')) {
        if (method === 'PUT')
          return this.update((d) => {
            d.groups.find((v: Row) => v.id === id).commands_enabled = !!b.commands_enabled;
          });
        const selected = url.searchParams.get('user_id');
        return {
          commands_enabled: g.commands_enabled,
          availability: Object.fromEntries(
            ['warn', 'mute', 'ban', 'clearwarnings', 'warnings', 'unmute', 'remove'].map((k) => [
              k,
              {
                available: this.enabled(id) && this.account(g.executor_account_id).status === 'online',
                reason: '请先恢复虚拟连接与群同步',
              },
            ]),
          ),
          selected_user_id: selected,
          selected_warning_count: s.actions.filter(
            (v: Row) => v.conversation_id === id && v.user_id === selected && v.warning_active,
          ).length,
          actions: s.actions.filter((v: Row) => v.conversation_id === id),
          group_name: g.name,
          group_id: g.external_id,
          account_name: g.account_name,
          account_id: g.executor_account_id,
          actor: { role: 1, user_id: '900002' },
          paid_group: false,
          checked_at: now(),
          target: selected
            ? {
                user_id: selected,
                name: '演示成员 ' + selected,
                role: selected === '900002' ? 1 : 0,
                muted:
                  s.actions.find((v: Row) => v.conversation_id === id && v.user_id === selected)?.action ===
                  'mute',
              }
            : null,
        };
      }
      if (['member-actions', 'binance-member-actions'].includes(action ?? ''))
        return this.writeOnce(options, path, (d) => {
          if (!this.enabled(id) || this.account(g.executor_account_id).status !== 'online')
            throw new DemoError('此群未同步或连接离线');
          if (
            !/^[1-9]\d{0,19}$/.test(b.user_id) ||
            this.state.accounts.some((a: Row) => a.external_id === b.user_id)
          )
            throw new DemoError('管理员和机器人自身受保护');
          if (!b.reason?.trim()) throw new DemoError('请填写操作原因');
          const warning = ['warn', 'warnings', 'clearwarnings'].includes(b.action),
            row = {
              id: uid(),
              conversation_id: id,
              user_id: b.user_id,
              action: b.action,
              reason: b.reason,
              actor: '演示管理员',
              created_at: now(),
              warning_active: b.action === 'warn',
              job_id: warning ? null : uid(),
              job_status: 'succeeded',
            };
          if (b.action === 'clearwarnings')
            for (const a of d.actions.filter((v: Row) => v.user_id === b.user_id && v.conversation_id === id))
              a.warning_active = false;
          d.actions.unshift(row);
          if (row.job_id)
            d.deliveries.unshift({
              id: row.job_id,
              conversation_id: id,
              conversation_name: g.name,
              platform: g.platform,
              action: 'member.' + b.action,
              params: {},
              status: 'succeeded',
              is_demo: true,
              created_at: now(),
              due_at: now(),
              attempts: [],
              receipt: {
                result: {
                  member: {
                    user_id: b.user_id,
                    group_id: g.external_id,
                    state: b.action === 'mute' ? 'muted' : b.action === 'unmute' ? 'unmuted' : 'removed',
                    verified_at: now(),
                  },
                },
              },
            });
          this.log(d, 'member.' + b.action, g.name);
          return {
            ...row,
            warning_count: d.actions.filter(
              (v: Row) => v.user_id === b.user_id && v.conversation_id === id && v.warning_active,
            ).length,
          };
        });
    }
    if (method === 'POST' && path === '/messages')
      return this.writeOnce(options, path, (d) => {
        if (!b.text?.trim()) throw new DemoError('请输入消息内容');
        const ids = b.conversation_ids;
        if (!Array.isArray(ids) || !ids.length) throw new DemoError('请选择群');
        let quote: Row | undefined;
        if (b.reply_to_message_id) {
          quote = d.messages.find((m: Row) => m.id === b.reply_to_message_id);
          if (!quote || ids.length !== 1 || quote.conversation_id !== ids[0])
            throw new DemoError('引用消息不属于该群');
        }
        const delivery_ids = ids.map(
          (id: string) => this.send(d, this.group(id), { text: b.text, reply_to: quote?.external_id }).id,
        );
        this.log(d, 'message.queued', '本地回复');
        return { delivery_ids };
      });
    if (method === 'POST' && path === '/announcements')
      return this.writeOnce(options, path, (d) => {
        if (!b.title?.trim() || (!b.content?.trim() && !b.image_asset_id))
          throw new DemoError('请填写标题与消息');
        if (b.image_asset_id && !d.images[b.image_asset_id]) throw new DemoError('本地图片不存在');
        if (!Array.isArray(b.conversation_ids) || !b.conversation_ids.length)
          throw new DemoError('请选择目标群');
        if (
          b.scheduled_at &&
          (!Number.isFinite(Date.parse(b.scheduled_at)) || Date.parse(b.scheduled_at) <= Date.now())
        )
          throw new DemoError('请选择未来时间');
        const deliveries = b.conversation_ids.map((id: string) =>
          this.send(
            d,
            this.group(id),
            { text: b.content, image_asset_id: b.image_asset_id, scheduled_at: b.scheduled_at },
            b.scheduled_at ? 'pending' : 'succeeded',
          ),
        );
        const row = {
          id: uid(),
          title: b.title,
          content: b.content,
          image_asset_id: b.image_asset_id,
          scheduled_at: b.scheduled_at ?? now(),
          created_at: now(),
          deliveries,
        };
        d.announcements.unshift(row);
        this.log(d, 'announcement.created', b.title);
        return row;
      });
    const detail = path.match(/^\/deliveries\/([^/]+)(?:\/(retry|reconcile))?$/);
    if (detail) {
      const row = s.deliveries.find((v: Row) => v.id === detail[1]);
      if (!row) throw new DemoError('演示任务不存在', 404);
      if (method === 'GET') return structuredClone(row);
      return this.update((d) => {
        const r = d.deliveries.find((v: Row) => v.id === row.id);
        if (detail[2] === 'retry' && r.status !== 'failed') throw new DemoError('仅失败任务可重试');
        if (detail[2] === 'reconcile' && r.status !== 'unknown') throw new DemoError('此任务无需人工核对');
        if (detail[2] === 'reconcile' && (!b.evidence || b.evidence.trim().length < 10))
          throw new DemoError('请填写至少 10 字的核对依据');
        r.status = detail[2] === 'reconcile' && b.outcome === 'no_effect' ? 'failed' : 'succeeded';
        r.retryable = r.status === 'failed';
        r.last_error = null;
        if (r.action === 'message.send' && r.status === 'succeeded') this.materialize(d, r);
        this.log(d, 'delivery.succeeded', r.id);
      });
    }
    const cancel = path.match(/^\/announcements\/([^/]+)\/cancel$/);
    if (cancel)
      return this.update((d) => {
        const a = d.announcements.find((a: Row) => a.id === cancel[1]);
        if (!a) throw new DemoError('通知不存在', 404);
        for (const target of a.deliveries) {
          const job = d.deliveries.find((j: Row) => j.id === target.id);
          if (job?.status === 'pending') {
            job.status = 'cancelled';
            target.status = 'cancelled';
          }
        }
        this.log(d, 'announcement.cancelled', a.title!);
      });
    const verify = path.match(/^\/verifications\/([^/]+)\/(approve|resend)$/);
    if (verify)
      return this.update((d) => {
        const v = d.verifications.find((v: Row) => v.id === verify[1]);
        if (!v) throw new DemoError('验证不存在', 404);
        v.status = verify[2] === 'approve' ? 'passed' : 'pending';
        v.expires_at = new Date(Date.now() + 60000).toISOString();
        this.log(d, 'verification.approved', v.user_id!);
      });
    if (method === 'POST' && path === '/accounts')
      return this.update((d) => {
        const kind = ['telegram', 'qq', 'binance', 'custom'].includes(b.kind) ? b.kind : 'custom';
        const a = {
          id: uid(),
          platform: kind,
          kind,
          name: String(b.name || '新演示连接'),
          external_id: 'demo-' + uid(),
          status: 'online',
          is_demo: false,
          settings: { group_ids: [] },
          created_at: now(),
        };
        d.accounts.push(a);
        this.log(d, 'account.created', a.name);
        return {
          id: a.id,
          account: a,
          binance_bridge: { demo: true },
          credentials: { demo: true },
        };
      });
    if (method === 'POST' && path === '/blacklists')
      return this.update((d) => {
        const g = this.group(b.conversation_id),
          r = { ...b, id: uid(), conversation_name: g.name, created_at: now() };
        d.blacklists.push(r);
        this.log(d, 'blacklist.added', b.user_id);
        return r;
      });
    const remove = path.match(/^\/(blacklists|routes)\/([^/]+)$/);
    if (method === 'DELETE' && remove)
      return this.update((d) => {
        d[remove[1]!] = d[remove[1]!].filter((v: Row) => v.id !== remove[2]);
      });
    if (method === 'POST' && path === '/projects')
      return this.update((d) => {
        const r = {
          id: uid(),
          name: b.name,
          conversation_ids: b.conversation_ids ?? [],
          scopes: b.scopes ?? [],
          created_at: now(),
          revoked_at: null,
        };
        d.projects.push(r);
        this.log(d, 'project.created', r.name);
        return { ...r, key: 'DEMO_ONLY_NOT_A_REAL_KEY' };
      });
    const revoke = path.match(/^\/projects\/([^/]+)\/revoke$/);
    if (revoke)
      return this.update((d) => {
        const r = d.projects.find((v: Row) => v.id === revoke[1]);
        if (!r) throw new DemoError('演示项目不存在', 404);
        r.revoked_at = now();
      });
    if (method === 'POST' && path === '/routes')
      return this.update((d) => {
        const source = this.group(b.source_id!),
          target = this.group(b.target_id!);
        if (source.id === target.id) throw new DemoError('来源与目标不能相同');
        d.routes.push({
          id: uid(),
          ...b,
          source_name: source.name,
          target_name: target.name,
          enabled: true,
        });
      });
    if (method === 'POST' && path === '/lotteries')
      return this.update((d) => {
        const g = this.group(b.conversation_id),
          row = {
            ...b,
            id: uid(),
            conversation_name: g.name,
            entries_count: 0,
            winners: [],
            status: 'open',
            created_at: now(),
          };
        d.lotteries.push(row);
        return row;
      });
    const draw = path.match(/^\/lotteries\/([^/]+)\/draw$/);
    if (draw)
      return this.update((d) => {
        const l = d.lotteries.find((v: Row) => v.id === draw[1]);
        if (!l) throw new DemoError('抽奖不存在', 404);
        if (Date.parse(l.closes_at) > Date.now()) throw new DemoError('活动尚未到期');
        if (l.status === 'drawn') return l;
        l.status = 'drawn';
        l.winners = l.entries_count ? ['演示成员 · 小羽'] : [];
        return l;
      });
    throw new DemoError('此流程需要真实平台服务，纯本地演示暂不执行。可自托管完整项目体验。', 400);
  }
  writeOnce(options: Row, path: string, fn: (s: Row) => any) {
    const key = options.key ? `${path}:${options.key}` : null,
      body = JSON.stringify(options.body);
    if (key && this.state.idempotency[key]) {
      const existing = this.state.idempotency[key];
      if (existing.body !== body) throw new DemoError('相同请求编号不能提交不同内容', 409);
      return structuredClone(existing.result);
    }
    return this.update((s) => {
      const result = fn(s);
      if (key) s.idempotency[key] = { body, result };
      return result;
    });
  }
  simulate(id = 'demo-telegram-0') {
    const g = this.group(id);
    if (!this.enabled(id)) throw new DemoError('此演示群已取消同步');
    return this.update((s) => {
      const text = [
        '这条新消息由浏览器本地生成。',
        '今晚的分享会我来参加！',
        '示例广告：这条消息用于体验规则命中。',
      ][Math.floor(Math.random() * 3)]!;
      const blocked = g.policy.keywords.some((word: string) => text.includes(word));
      const message = {
        id: uid(),
        external_id: 'demo-' + uid(),
        conversation_id: id,
        sender_id: '100004',
        sender_name: '星辰',
        content: text,
        segments: [{ type: 'text', text }],
        direction: 'incoming',
        verdict: blocked ? (g.policy.mode === 'enforce' ? 'blocked' : 'observed') : 'allowed',
        reason: blocked ? '演示关键词命中' : null,
        deleted: blocked && g.policy.mode === 'enforce',
        created_at: now(),
        moderation_jobs: [],
      };
      s.messages.push(message);
      this.log(s, 'message.queued', '模拟新消息');
      return message;
    });
  }
}
