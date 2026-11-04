import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Check,
  Copy,
  FlaskConical,
  Hexagon,
  LoaderCircle,
  MessageCircle,
  MessageSquare,
  Send,
  Webhook,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../api';

export type Data = Record<string, any>;
export const labels: Record<string, string> = {
  online: '在线',
  configuring: '待连接',
  paused: '已暂停',
  expired: '已过期',
  error: '连接异常',
  pending: '待处理',
  in_flight: '执行中',
  accepted: '平台已接收',
  succeeded: '已完成',
  failed: '失败',
  unknown: '待核对',
  cancelled: '已取消',
  allowed: '已放行',
  blocked: '规则命中',
  observed: '规则命中（观察）',
  historical: '历史快照',
  official: '官方消息',
  passed: '已通过',
  left: '已退群',
  superseded: '已换批次',
  open: '报名中',
  drawn: '已开奖',
  telegram: 'Telegram',
  qq: 'QQ',
  binance: '币安聊天',
  custom: '自有聊天',
  demo: '本地演示',
};
export const date = (v: any, full = false) =>
  v
    ? new Date(v).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
        ...(full ? { year: 'numeric' } : {}),
      })
    : '—';
export const n = (v: any) => Number(v ?? 0).toLocaleString('zh-CN');
export const commandLabels: Record<string, string> = {
  'message.send': '发送消息',
  'message.delete': '删除消息',
  'member.remove': '移出成员',
  'member.ban': '封禁成员',
  'member.mute': '禁言成员',
  'member.set_mute': '调整成员单独禁言',
  'membership.review': '审核入群申请',
  'interaction.ack': '确认交互',
};
export const Context = createContext<{
  groups: Data[];
  accounts: Data[];
  refresh: () => void;
  revision: number;
  toast: (message: string, error?: boolean) => void;
  accountsError: string;
  accountsCheckedAt: string | null;
}>({
  groups: [],
  accounts: [],
  refresh: () => {},
  revision: 0,
  toast: () => {},
  accountsError: '',
  accountsCheckedAt: null,
});
export const useApp = () => useContext(Context);
export function useData<T = any>(path: string, poll = false) {
  const { revision } = useApp();
  const [result, setResult] = useState<{ path: string; data?: T; error: string; loading: boolean }>({
    path,
    error: '',
    loading: true,
  });
  const current = result.path === path ? result : { path, data: undefined, error: '', loading: true };
  useEffect(() => {
    // An empty path means "nothing to load" for callers that fetch conditionally.
    if (!path) {
      setResult({ path, error: '', loading: false });
      return;
    }
    let controller: AbortController | undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult((previous) => ({
      path,
      data: previous.path === path ? previous.data : undefined,
      error: '',
      loading: true,
    }));
    const load = async () => {
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 15_000);
      try {
        const data = await api<T>(path, { signal: request.signal });
        if (active) setResult({ path, data, error: '', loading: false });
      } catch (err: any) {
        if (active)
          setResult((previous) => ({
            ...previous,
            error: request.signal.aborted ? '读取数据超时，请稍后重试' : err.message,
            loading: false,
          }));
      } finally {
        window.clearTimeout(timeout);
        if (active && poll)
          timer = setTimeout(function next() {
            if (document.visibilityState === 'visible') void load();
            else timer = setTimeout(next, 10_000);
          }, 10_000);
      }
    };
    void load();
    return () => {
      active = false;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [path, revision, poll]);
  return { data: current.data, error: current.error, loading: current.loading };
}
export function Badge({ value, children }: { value?: string; children?: ReactNode }) {
  return (
    <span className={`badge ${value ?? ''}`}>
      <i />
      {children ?? labels[value ?? ''] ?? value}
    </span>
  );
}
export function accountState(account: Data) {
  const state = account.connection?.state;
  return account.status === 'paused'
    ? 'paused'
    : !state
      ? account.status
      : state === 'paused'
        ? 'paused'
        : state === 'connected'
          ? 'online'
          : ['awaiting_groups', 'connecting'].includes(state)
            ? 'configuring'
            : account.connection.needs_relogin
              ? 'expired'
              : 'error';
}
export function AccountBadge({ account }: { account: Data }) {
  return (
    <Badge value={accountState(account)}>
      {account.status === 'paused' ? '已暂停' : account.connection?.title}
    </Badge>
  );
}
export function groupAccountOnline(group: Data, accounts: Data[]) {
  return (
    accountState(
      accounts.find((account) => account.id === group.executor_account_id) ?? {
        status: group.account_status,
      },
    ) === 'online'
  );
}
const platformIcons: Record<string, LucideIcon> = {
  telegram: Send,
  qq: MessageCircle,
  binance: Hexagon,
  custom: Webhook,
  demo: FlaskConical,
};
export function PlatformIcon({ value, large = false }: { value: string; large?: boolean }) {
  const Icon = platformIcons[value] ?? MessageSquare;
  return (
    <span className={`platform-icon ${value}${large ? ' lg' : ''}`} aria-hidden="true">
      <Icon size={large ? 18 : 12} />
    </span>
  );
}
export function Platform({ value, demo = false }: { value: string; demo?: boolean }) {
  const Icon = platformIcons[value] ?? MessageSquare;
  return (
    <span className={`platform ${value}`}>
      <span>
        <Icon size={12} />
      </span>
      {demo ? '本地演示' : (labels[value] ?? value)}
    </span>
  );
}

export function Empty({
  icon: Icon = MessageSquare,
  title = '还没有记录',
  text = '完成相关操作后，记录会显示在这里。',
}: {
  icon?: LucideIcon;
  title?: string;
  text?: string;
}) {
  return (
    <div className="empty">
      <Icon size={28} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function Loading({
  error,
  loading,
  children,
}: {
  error: string;
  loading: boolean;
  children: ReactNode;
}) {
  return loading ? (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={18} />
      正在加载
    </div>
  ) : (
    <>
      {error && (
        <div className="error-panel" role="alert">
          {error}。已保留上次的结果，请稍后刷新。
        </div>
      )}
      {children}
    </>
  );
}

export function Head({
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </div>
  );
}

export function Modal({
  title,
  description,
  close,
  children,
  wide = false,
  dismissDisabled = false,
}: {
  title: string;
  description?: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  dismissDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    (element.querySelector<HTMLElement>('[data-autofocus]') ?? element).focus();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className={`modal${wide ? ' modal-wide' : ''}`}
      ref={ref}
      aria-label={title}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (!dismissDisabled) close();
      }}
      onClick={(event) => {
        if (dismissDisabled || event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close();
      }}
    >
      <button
        className="icon-btn close"
        type="button"
        onClick={close}
        disabled={dismissDisabled}
        aria-label="关闭"
      >
        <X size={18} />
      </button>
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {children}
    </dialog>
  );
}
/** Side sheet for focused editing without leaving the page. */
export function Drawer({
  title,
  description,
  close,
  children,
  footer,
  dismissDisabled = false,
}: {
  title: string;
  description?: ReactNode;
  close: () => void;
  children: ReactNode;
  footer?: ReactNode;
  dismissDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    (element.querySelector<HTMLElement>('[data-autofocus]') ?? element).focus();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className="drawer"
      ref={ref}
      aria-label={title}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (!dismissDisabled) close();
      }}
      onClick={(event) => {
        if (!dismissDisabled && event.target === event.currentTarget) close();
      }}
    >
      <div className="drawer-frame">
        <div className="drawer-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button
            className="icon-btn"
            type="button"
            onClick={close}
            disabled={dismissDisabled}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </dialog>
  );
}
export function ActionForm({
  onSubmit,
  children,
  label = '保存',
  cancel,
  disabled = false,
  className,
  summary,
  submitHidden = false,
}: {
  onSubmit: (data: FormData) => Promise<unknown>;
  children: ReactNode;
  label?: string;
  cancel?: () => void;
  disabled?: boolean;
  className?: string;
  summary?: ReactNode;
  submitHidden?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { refresh } = useApp();
  return (
    <form
      className={className}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || disabled) return;
        const data = new FormData(e.currentTarget);
        setBusy(true);
        setError('');
        try {
          await onSubmit(data);
          refresh();
        } catch (err: any) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        {summary && <div className="form-actions-summary">{summary}</div>}
        {cancel && (
          <button type="button" className="btn" disabled={busy} onClick={cancel}>
            取消
          </button>
        )}
        <button hidden={submitHidden} disabled={busy || disabled} className="btn primary" type="submit">
          {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} {label}
        </button>
      </div>
    </form>
  );
}
export function GroupChoices({
  name = 'groups',
  sendable = false,
  value,
  onChange,
  allowOffline = false,
}: {
  name?: string;
  sendable?: boolean;
  value?: string[];
  onChange?: (value: string[]) => void;
  allowOffline?: boolean;
}) {
  const { groups, accounts } = useApp();
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('all');
  const [localSelected, setLocalSelected] = useState<string[]>([]);
  const selected = value ?? localSelected;
  const setSelected = (next: string[] | ((current: string[]) => string[])) =>
    (onChange ?? setLocalSelected)(typeof next === 'function' ? next(selected) : next);
  const choices = sendable ? groups.filter((g) => g.sync_enabled !== false) : groups;
  const visible = choices.filter(
    (g) =>
      (platform === 'all' || g.platform === platform) &&
      `${g.name} ${labels[g.platform]}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="group-choices">
      {sendable && (
        <div className="group-choice-tools">
          <input
            aria-label="搜索群发目标"
            placeholder="搜索群名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select aria-label="筛选群发平台" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="all">全部平台</option>
            {['telegram', 'qq', 'binance', 'custom'].map((p) => (
              <option key={p} value={p}>
                {labels[p]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setSelected((current) => [
                ...new Set([
                  ...current,
                  ...visible.filter((g) => allowOffline || groupAccountOnline(g, accounts)).map((g) => g.id),
                ]),
              ])
            }
          >
            全选当前结果
          </button>
          <button type="button" className="text-button" onClick={() => setSelected([])}>
            清空
          </button>
          <small>已选 {selected.filter((id) => choices.some((g) => g.id === id)).length} 个群</small>
        </div>
      )}
      {sendable &&
        selected
          .filter((id) => choices.some((g) => g.id === id))
          .map((id) => <input key={id} type="hidden" name={name} value={id} />)}
      {visible.length ? (
        visible.map((g) => (
          <label key={g.id} className="check-row">
            <input
              type="checkbox"
              name={sendable ? undefined : name}
              value={g.id}
              checked={sendable ? selected.includes(g.id) : undefined}
              disabled={
                sendable && !allowOffline && !groupAccountOnline(g, accounts) && !selected.includes(g.id)
              }
              onChange={
                sendable
                  ? (e) =>
                      setSelected((current) =>
                        e.target.checked ? [...current, g.id] : current.filter((id) => id !== g.id),
                      )
                  : undefined
              }
            />
            <span>
              {g.name}
              <small>
                {g.is_demo ? '演示群' : labels[g.platform]} · {g.external_id}
                {sendable && !groupAccountOnline(g, accounts)
                  ? allowOffline
                    ? ' · 发送前需恢复连接'
                    : ' · 请先恢复账号连接'
                  : ''}
              </small>
            </span>
          </label>
        ))
      ) : (
        <p className="muted">{sendable ? '没有符合筛选条件且已启用同步的群。' : '请先连接账号并发现群。'}</p>
      )}
    </div>
  );
}
export function GroupSelect({ name = 'conversation_id' }: { name?: string }) {
  const { groups } = useApp();
  return (
    <select required name={name} defaultValue="">
      <option value="" disabled>
        选择群或频道
      </option>
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
          {g.is_demo ? '（演示）' : ''}
        </option>
      ))}
    </select>
  );
}
export function Secret({ value, close }: { value: string; close: () => void }) {
  const { toast } = useApp();
  return (
    <Modal
      title="请保存连接凭据"
      description="完整密钥仅显示这一次。关闭前请复制到安全的位置。"
      close={close}
    >
      <pre className="secret">{value}</pre>
      <div className="form-actions">
        <button
          className="btn primary"
          onClick={() =>
            void navigator.clipboard
              .writeText(value)
              .then(() => toast('已复制凭据'))
              .catch(() => toast('复制失败，请手动选择文字', true))
          }
        >
          <Copy size={16} />
          复制凭据
        </button>
        <button className="btn" onClick={close}>
          已保存，关闭
        </button>
      </div>
    </Modal>
  );
}
export const actionLabel = (value: string) =>
  (
    ({
      'account.created': '添加了平台连接',
      'account.refreshed': '刷新了社群连接',
      'account.paused': '暂停了连接账号',
      'conversation.connected': '连接了新社群',
      'policy.updated': '更新了群管理规则',
      'message.queued': '提交了消息投递',
      'announcement.created': '创建了社群通知',
      'announcement.cancelled': '取消了待发送通知',
      'delivery.succeeded': '完成了消息任务',
      'member.mute': '提交了成员禁言任务',
      'member.ban': '提交了成员封禁任务',
      'member.warn': '记录了成员警告',
      'member.warnings': '查询了成员警告',
      'member.clearwarnings': '清除了成员警告',
      'member.commands.updated': '更新了群内管理员命令设置',
      'member.command.rejected': '拒绝了一条未执行的管理命令',
      'qq.login.qr_refreshed': '刷新了 VPS QQ 登录二维码',
      'qq.login.quick_requested': '请求恢复 QQ 登录',
      'qq.login.identity_bound': '绑定了 VPS QQ 登录身份',
      'qq.login.api_secured': '配置了 VPS QQ 接口认证',
      'qq.login.connected': '连接了 VPS 上的 QQ',
      'qq.join.settings_updated': '更新了 QQ 入群审核设置',
      'qq.join.queued': '提交了 QQ 入群自动审核',
      'qq.join.observed': '记录了未自动处理的 QQ 入群申请',
      'qq.verification.created': '创建了 QQ 入群验证',
      'qq.verification.resent': '重新发送了 QQ 入群验证',
      'qq.verification.timeout': '记录了 QQ 入群验证超时',
      'qq.verification.removed': '移出了验证超时的 QQ 成员',
      'qq.verification.muted': '记录了 QQ 验证禁言的执行结果',
      'qq.verification.cycle_stopped': '停止了 QQ 自动验证循环',
      'delivery.retry_requested': '请求重试失败任务',
      'binance.member.requested': '提交了币安成员管理操作',
      'delivery.reconciled': '人工核对了平台执行结果',
      'blacklist.added': '添加了群黑名单',
      'blacklist.removed': '移除了群黑名单',
      'verification.approved': '人工通过成员验证',
      'verification.passed': '成员完成了活人验证',
      'project.created': '创建了项目 API Key',
      'project.revoked': '撤销了项目授权',
      'route.updated': '更新了同步路线',
      'route.removed': '删除了同步路线',
      'lottery.created': '创建了社群抽奖',
      'lottery.drawn': '完成了抽奖开奖',
      'moderation.matched': '规则命中并创建了处理任务',
      'keyword.rule.saved': '保存了关键词触发规则',
      'keyword.rule.deleted': '删除了关键词触发规则',
      'keyword.matched': '关键词命中并提交了执行任务',
      'event.quarantined': '隔离了异常平台事件',
    }) as Data
  )[value] ?? value;
