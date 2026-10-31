import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  Gift,
  Hash,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  ShieldX,
  Shuffle,
  SlidersHorizontal,
  Trash2,
  Users,
  Webhook,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, RequestError, setCsrf, uploadImage, mediaUrl, exampleImage } from './api';
import Inbox from './Inbox';
import BinanceLogin from './BinanceLogin';
import BinanceConnectionStatus from './BinanceConnectionStatus';
import ModerationResult from './ModerationResult';
import MemberManagement from './MemberManagement';
import BinanceMemberManagement from './BinanceMemberManagement';
import QQLogin from './QQLogin';
import QQRequests from './QQRequests';
import VerificationList from './VerificationList';
import KeywordRules from './KeywordRules';
import { CopyButton, QuickNavigate } from './ConsoleTools';

type Data = Record<string, any>;
const labels: Record<string, string> = {
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
const date = (v: any, full = false) =>
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
const n = (v: any) => Number(v ?? 0).toLocaleString('zh-CN');
const commandLabels: Record<string, string> = {
  'message.send': '发送消息',
  'message.delete': '删除消息',
  'member.remove': '移出成员',
  'member.ban': '封禁成员',
  'member.mute': '禁言成员',
  'member.set_mute': '调整成员单独禁言',
  'membership.review': '审核入群申请',
  'interaction.ack': '确认交互',
};
const Context = createContext<{
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
const useApp = () => useContext(Context);
function useData<T = any>(path: string, poll = false) {
  const { revision } = useApp();
  const [result, setResult] = useState<{ path: string; data?: T; error: string; loading: boolean }>(
    {
      path,
      error: '',
      loading: true,
    },
  );
  const current =
    result.path === path ? result : { path, data: undefined, error: '', loading: true };
  useEffect(() => {
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
        if (active && poll) timer = setTimeout(() => void load(), 10_000);
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
function Badge({ value, children }: { value?: string; children?: ReactNode }) {
  return (
    <span className={`badge ${value ?? ''}`}>
      <i />
      {children ?? labels[value ?? ''] ?? value}
    </span>
  );
}
function accountState(account: Data) {
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
function AccountBadge({ account }: { account: Data }) {
  return (
    <Badge value={accountState(account)}>
      {account.status === 'paused' ? '已暂停' : account.connection?.title}
    </Badge>
  );
}
function groupAccountOnline(group: Data, accounts: Data[]) {
  return (
    accountState(
      accounts.find((account) => account.id === group.executor_account_id) ?? {
        status: group.account_status,
      },
    ) === 'online'
  );
}
function Platform({ value, demo = false }: { value: string; demo?: boolean }) {
  return (
    <span className={`platform ${value}`}>
      <span>
        {value === 'telegram' ? (
          <Send size={13} />
        ) : value === 'qq' || value === 'binance' ? (
          <MessageSquare size={13} />
        ) : (
          <Webhook size={13} />
        )}
      </span>
      {demo ? '本地演示' : (labels[value] ?? value)}
    </span>
  );
}
function Empty({
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
function Loading({
  error,
  loading,
  children,
}: {
  error: string;
  loading: boolean;
  children: ReactNode;
}) {
  return loading ? (
    <div className="loading">
      <LoaderCircle className="spin" size={22} />
      正在加载
    </div>
  ) : (
    <>
      {error && (
        <div className="error-panel" role="alert">
          {error}。页面保留已有结果，请稍后刷新。
        </div>
      )}
      {children}
    </>
  );
}
function Head({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="head-actions">{children}</div>
    </div>
  );
}
function Modal({
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
        <X size={20} />
      </button>
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {children}
    </dialog>
  );
}
function ActionForm({
  onSubmit,
  children,
  label = '保存',
  cancel,
  disabled = false,
  className,
  summary,
}: {
  onSubmit: (data: FormData) => Promise<unknown>;
  children: ReactNode;
  label?: string;
  cancel?: () => void;
  disabled?: boolean;
  className?: string;
  summary?: ReactNode;
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
        <button disabled={busy || disabled} className="btn primary" type="submit">
          {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} {label}
        </button>
      </div>
    </form>
  );
}
function GroupChoices({
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
          <select
            aria-label="筛选群发平台"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
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
                  ...visible
                    .filter((g) => allowOffline || groupAccountOnline(g, accounts))
                    .map((g) => g.id),
                ]),
              ])
            }
          >
            全选当前结果
          </button>
          <button type="button" className="text-button" onClick={() => setSelected([])}>
            清空
          </button>
          <small>
            已选 {selected.filter((id) => choices.some((g) => g.id === id)).length} 个群
          </small>
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
                sendable &&
                !allowOffline &&
                !groupAccountOnline(g, accounts) &&
                !selected.includes(g.id)
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
        <p className="muted">
          {sendable ? '没有符合筛选条件且已启用同步的群。' : '请先连接账号并发现群。'}
        </p>
      )}
    </div>
  );
}
function GroupSelect({ name = 'conversation_id' }: { name?: string }) {
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
function Secret({ value, close }: { value: string; close: () => void }) {
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

const nav = [
  { path: '/dashboard', label: '工作概览', icon: LayoutDashboard },
  { path: '/inbox', label: '实时消息', icon: MessageSquare },
  { path: '/groups', label: '群与频道', icon: Users },
  { path: '/moderation', label: '安全与验证', icon: ShieldCheck },
  { path: '/announcements', label: '群发与通知', icon: Send },
  { path: '/lotteries', label: '社群抽奖', icon: Gift },
  { path: '/accounts', label: '连接账号', icon: Radio },
  { path: '/integrations', label: '项目与同步', icon: Shuffle },
  { path: '/audit', label: '操作日志', icon: Activity },
];
export default function App() {
  const [user, setUser] = useState<Data | null>();
  const [state, setState] = useState<Data>();
  const [fatal, setFatal] = useState('');
  const [groups, setGroups] = useState<Data[]>([]);
  const [accounts, setAccounts] = useState<Data[]>([]);
  const [accountsError, setAccountsError] = useState('');
  const [accountsCheckedAt, setAccountsCheckedAt] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [mobile, setMobile] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [smallScreen, setSmallScreen] = useState(
    () => window.matchMedia('(max-width: 760px)').matches,
  );
  const location = useLocation();
  useEffect(() => {
    const previous = document.title;
    document.title = '千羽 Superbot · 社群管理';
    return () => {
      document.title = previous;
    };
  }, []);
  useEffect(() => {
    const expired = () => {
      setCsrf('');
      setUser(null);
    };
    window.addEventListener('superbot:unauthorized', expired);
    return () => window.removeEventListener('superbot:unauthorized', expired);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setSmallScreen(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobile(false);
    };
    if (mobile) document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [mobile]);
  const refresh = () => setRevision((v) => v + 1);
  useEffect(() => {
    if (import.meta.env.MODE !== 'demo') return;
    window.addEventListener('superbot:demo-changed', refresh);
    return () => window.removeEventListener('superbot:demo-changed', refresh);
  }, []);
  const toast = (text: string, error = false) => setNotice({ text, error });
  useEffect(() => {
    void api('/auth/state')
      .then(async (value) => {
        setState(value);
        if (value.setup_required) {
          setUser(null);
          return;
        }
        try {
          const me = await api('/auth/me');
          setCsrf(me.csrf);
          setUser(me);
        } catch (err) {
          if (err instanceof RequestError && err.status === 401) setUser(null);
          else throw err;
        }
      })
      .catch((err) => setFatal(err.message));
  }, []);
  useEffect(() => {
    if (!user) return;
    let live = true;
    let pending: AbortController | null = null;
    const loadAccounts = async () => {
      if (pending) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const a = await api('/accounts', { signal: controller.signal });
        if (!Array.isArray(a)) throw new Error('连接状态响应无效，请重试');
        if (live) {
          setAccounts(a);
          setAccountsError('');
          setAccountsCheckedAt(new Date().toISOString());
        }
      } catch (error) {
        if (live)
          setAccountsError(
            controller.signal.aborted
              ? '连接状态读取超时，请检查后台网络后重试'
              : (error as Error).message,
          );
      } finally {
        clearTimeout(timeout);
        if (pending === controller) pending = null;
      }
    };
    void loadAccounts();
    const timer = setInterval(() => void loadAccounts(), 10_000);
    const onFocus = () => void loadAccounts();
    window.addEventListener('focus', onFocus);
    api('/conversations')
      .then((g) => {
        if (live) {
          setGroups(g);
        }
      })
      .catch((err) => {
        if (err.status === 401) {
          setUser(null);
          setCsrf('');
        } else toast(err.message, true);
      });
    return () => {
      live = false;
      pending?.abort();
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [user, revision]);
  useEffect(() => {
    setMobile(false);
    setQuickOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!user) return;
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.isComposing
      ) {
        if (!quickOpen && document.querySelector('[aria-modal="true"], dialog[open]')) return;
        event.preventDefault();
        setQuickOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [user, quickOpen]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), notice.error ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (fatal)
    return (
      <div className="auth-page">
        <div className="auth-card">
          <Bot />
          <h1>服务暂时无法连接</h1>
          <p>{fatal}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            重新连接
          </button>
        </div>
      </div>
    );
  if (user === undefined || !state)
    return (
      <div className="auth-page">
        <LoaderCircle className="spin" />
      </div>
    );
  if (!user)
    return (
      <Auth
        setup={state.setup_required}
        needsToken={state.setup_token_required}
        done={(me) => {
          setCsrf(me.csrf);
          setUser(me);
          setState({ setup_required: false });
        }}
      />
    );
  const current = nav.find((v) =>
    v.path === '/dashboard'
      ? location.pathname === '/dashboard'
      : location.pathname.startsWith(v.path),
  );
  return (
    <Context.Provider
      value={{ groups, accounts, revision, refresh, toast, accountsError, accountsCheckedAt }}
    >
      <div
        className={`shell ${mobile ? 'menu-open' : ''} ${location.pathname.startsWith('/inbox') ? 'is-inbox' : ''}`}
      >
        {mobile && (
          <button className="nav-scrim" aria-label="关闭菜单" onClick={() => setMobile(false)} />
        )}
        <aside
          className="sidebar"
          inert={smallScreen && !mobile}
          aria-hidden={smallScreen && !mobile}
        >
          <Link to="/dashboard" className="brand">
            <span className="brand-mark">
              <Bot size={25} />
            </span>
            <span>
              千羽 Superbot<small>COMMUNITY CONSOLE</small>
            </span>
          </Link>
          <div className="workspace">
            <span className="workspace-icon">千</span>
            <div>
              千羽工作空间<small>社群运营中心</small>
            </div>
            <span className="workspace-plan">管理台</span>
          </div>
          <div className="nav-label">管理空间</div>
          <nav>
            {nav.map(({ path, label, icon: Icon }) => (
              <NavLink key={path} to={path} end={path === '/dashboard'}>
                <Icon size={18} />
                <span>{label}</span>
                {path === '/groups' && <b>{groups.length}</b>}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="system-state">
              <span className="live-dot" />
              <span>
                {accountsError
                  ? '连接状态更新异常'
                  : accountsCheckedAt
                    ? `${accounts.filter((a) => accountState(a) === 'online').length} 个账号在线`
                    : '正在读取连接状态'}
                <small>
                  {accountsCheckedAt ? `状态更新于 ${date(accountsCheckedAt)}` : '正在读取连接状态'}
                </small>
              </span>
            </div>
            <div className="profile">
              <span className="avatar">{user.name?.slice(0, 1) ?? user.username?.slice(0, 1)}</span>
              <div>
                {user.name ?? user.username}
                <small>工作空间管理员</small>
              </div>
              <button
                className="icon-btn"
                aria-label="退出登录"
                onClick={() =>
                  import.meta.env.MODE === 'demo'
                    ? window.location.assign('/')
                    : void api('/auth/logout', { method: 'POST' }).then(() => {
                        setCsrf('');
                        setUser(null);
                      })
                }
              >
                <LogOut size={17} />
              </button>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-btn mobile-menu"
                onClick={() => setMobile(true)}
                aria-label="打开菜单"
              >
                <Menu size={20} />
              </button>
              <span>工作空间</span>
              <ChevronRight size={13} />
              <strong>{current?.label ?? '群详情'}</strong>
            </div>
            <div className="topbar-actions">
              <button
                className="quick-open"
                onClick={() => setQuickOpen(true)}
                title="快速查找页面或社群（Ctrl / ⌘ + K）"
              >
                <Search size={16} />
                <span>搜索页面或社群</span>
                <kbd>⌘ K</kbd>
              </button>
              <span className="environment">
                <span />
                {import.meta.env.MODE === 'demo'
                  ? true
                  : ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
                    ? import.meta.env.MODE === 'demo'
                      ? '单机演示'
                      : '本地环境'
                    : '已部署环境'}
              </span>
              <Link to="/" className="icon-btn" aria-label="查看产品官网">
                <ExternalLink size={17} />
              </Link>
              <button
                className="icon-btn"
                aria-label="刷新数据"
                title="刷新当前工作台数据"
                onClick={() => {
                  refresh();
                  toast('正在刷新工作台数据');
                }}
              >
                <RefreshCw size={17} />
              </button>
              <Link to="/audit" className="icon-btn" aria-label="查看操作日志">
                <Activity size={18} />
              </Link>
              <span className="top-avatar">{(user.name ?? user.username ?? '千').slice(0, 1)}</span>
            </div>
          </header>
          <main>
            <Routes>
              <Route path="/dashboard" element={<Overview />} />
              <Route path="/groups" element={<Groups />} />
              <Route path="/groups/:id" element={<GroupDetail />} />
              <Route
                path="/inbox/:id?"
                element={
                  <Inbox
                    initialGroups={groups}
                    toast={toast}
                    draftScope={String(user.id ?? user.username ?? user.name)}
                  />
                }
              />
              <Route path="/moderation" element={<Moderation />} />
              <Route path="/announcements" element={<Announcements />} />
              <Route path="/lotteries" element={<Lotteries />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/audit" element={<Audit />} />
              <Route
                path="*"
                element={<Empty title="页面不存在" text="请通过左侧导航继续操作。" />}
              />
            </Routes>
            <footer className="page-footer">
              <span>千羽 Superbot</span>
              <span>让社群有序，让连接发生。</span>
              <span>v0.1.0</span>
            </footer>
          </main>
        </div>
        {notice && (
          <div
            className={`toast ${notice.error ? 'error' : ''}`}
            role={notice.error ? 'alert' : 'status'}
          >
            {notice.error ? <ShieldX size={18} /> : <CheckCircle2 size={18} />} {notice.text}
            <button className="icon-btn" aria-label="关闭提示" onClick={() => setNotice(undefined)}>
              <X size={16} />
            </button>
          </div>
        )}
        {quickOpen && (
          <Modal title="快速查找" close={() => setQuickOpen(false)}>
            <QuickNavigate groups={groups} pages={nav} close={() => setQuickOpen(false)} />
          </Modal>
        )}
      </div>
    </Context.Provider>
  );
}
function Auth({
  setup,
  needsToken,
  done,
}: {
  setup: boolean;
  needsToken: boolean;
  done: (v: Data) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      done(
        await api(setup ? '/auth/setup' : '/auth/login', {
          method: 'POST',
          body: {
            username: form.get('username'),
            password: form.get('password'),
            ...(setup && needsToken ? { setup_token: form.get('setup_token') } : {}),
          },
        }),
      );
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-art">
        <div className="auth-art-grid" />
        <div className="auth-wordmark">
          <span className="brand-mark">
            <Bot size={28} />
          </span>
          千羽 Superbot
        </div>
        <div className="auth-art-content">
          <span className="eyebrow">ONE CONSOLE. EVERY COMMUNITY.</span>
          <h1>
            每一个社群，
            <br />
            都在掌握之中。
          </h1>
          <p>
            连接群聊、守护讨论、发布消息。
            <br />
            把社群运营的日常，收进一个工作台。
          </p>
          <div className="orbit">
            <Users />
            <span />
            <ShieldCheck />
            <span />
            <Send />
          </div>
        </div>
        <div className="auth-art-foot">
          社群管理，从这里开始。<span>v0.1</span>
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">WELCOME TO SUPERBOT</span>
          <h1>{setup ? '创建你的工作空间' : '欢迎回来'}</h1>
          <p>
            {setup ? '设置第一个管理员，开始连接你的社群。' : '登录管理台，继续今天的社群工作。'}
          </p>
          <form onSubmit={submit}>
            <label>
              管理员用户名
              <input
                name="username"
                required
                minLength={2}
                maxLength={64}
                autoComplete="username"
                placeholder="输入用户名"
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                required
                minLength={setup ? 10 : 1}
                maxLength={256}
                autoComplete={setup ? 'new-password' : 'current-password'}
                placeholder={setup ? '至少 10 个字符' : '输入密码'}
              />
            </label>
            {setup && needsToken && (
              <label>
                初始化凭据
                <input
                  type="password"
                  name="setup_token"
                  required
                  autoComplete="off"
                  placeholder="服务器配置的 ADMIN_SETUP_TOKEN"
                />
              </label>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn primary wide" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}{' '}
              {setup ? '创建并进入管理台' : '进入管理台'}
            </button>
          </form>
          <div className="auth-hint">
            <ShieldCheck size={15} />
            账号凭据加密存储于当前服务
          </div>
        </div>
      </div>
    </div>
  );
}

function Overview() {
  const { data: d, loading, error } = useData('/overview', true);
  const { groups, accounts, accountsCheckedAt } = useApp();
  const [compose, setCompose] = useState(false);
  return (
    <>
      <Head
        eyebrow="YOUR COMMUNITY, AT A GLANCE"
        title="社群工作概览"
        description="所有连接、消息与社群动态，一处掌握。"
      >
        <span className="date-pill">
          <CalendarDays size={15} />
          {new Date().toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </span>
        <button className="btn primary" onClick={() => setCompose(true)}>
          <Plus size={17} />
          发布通知
        </button>
      </Head>
      <Loading loading={loading && !d} error={error}>
        {d && (
          <>
            {d.demo_accounts > 0 && (
              <div className="demo-banner">
                <span className="banner-icon">
                  <Bot size={20} />
                </span>
                <div>
                  <strong>从演示社群开始，试一试你的工作台</strong>
                  <p>当前包含明确标记的本地演示数据。连接真实账号后，即可管理实际社群。</p>
                </div>
                <Link to="/accounts">
                  连接账号 <ArrowRight size={16} />
                </Link>
              </div>
            )}
            <div className="metrics">
              {[
                {
                  label: '已发现社群',
                  value: d.conversations,
                  icon: Users,
                  note: `${groups.filter((g) => g.sync_enabled !== false).length} 个已选同步 · ${d.accounts} 个连接`,
                  color: 'green',
                },
                {
                  label: '今日消息',
                  value: d.messages_today,
                  icon: MessageSquare,
                  note: '北京时间 00:00 起',
                  color: 'blue',
                },
                {
                  label: '今日判定违规',
                  value: d.blocked_today,
                  icon: ShieldCheck,
                  note: '规则判定违规，不代表平台处理成功',
                  color: 'orange',
                },
                {
                  label: '待验证成员',
                  value: d.pending_verifications,
                  icon: Users,
                  note: '需要关注的入群验证',
                  color: 'purple',
                },
              ].map((m) => (
                <div className="metric" key={m.label}>
                  <div>
                    <span>{m.label}</span>
                    <span className={`metric-icon ${m.color}`}>
                      <m.icon size={19} />
                    </span>
                  </div>
                  <strong>{n(m.value)}</strong>
                  <small>{m.note}</small>
                </div>
              ))}
            </div>
            <div className="overview-grid">
              <section className="card chart-card">
                <div className="card-head">
                  <div>
                    <h2>消息动态</h2>
                    <p>查看消息接收与违规判定趋势，实际处理结果见消息记录</p>
                  </div>
                  <span className="period">
                    <CalendarDays size={13} />
                    最近 7 天
                  </span>
                </div>
                <Chart series={d.series} />
                <div className="chart-legend">
                  <span>
                    <i />
                    接收消息
                  </span>
                  <span>
                    <i />
                    判定违规
                  </span>
                  <small>
                    {d.demo_accounts > 0 ? '按北京时间统计 · 含演示数据' : '按北京时间统计'}
                  </small>
                </div>
              </section>
              <section className="card connection-card">
                <div className="card-head">
                  <h2>连接状态</h2>
                  <Link className="text-link" to="/accounts">
                    管理 <ArrowUpRight size={15} />
                  </Link>
                </div>
                <div className="connection-total">
                  <strong>
                    {accountsCheckedAt
                      ? accounts.filter((a) => accountState(a) === 'online').length
                      : '—'}
                    <small> / {d.accounts}</small>
                  </strong>
                  <span>账号在线</span>
                </div>
                <div className="connection-list">
                  {accounts.map((a) => (
                    <div key={a.id}>
                      <span className={`connection-icon ${a.platform}`}>
                        <Radio size={17} />
                      </span>
                      <div>
                        <strong>{a.name}</strong>
                        <small>{a.is_demo ? '本地演示连接器' : labels[a.platform]}</small>
                      </div>
                      <AccountBadge account={a} />
                    </div>
                  ))}
                </div>
                <div className="connection-tip">
                  <CircleHelp size={15} />
                  <span>每个平台的可用操作取决于连接能力与账号权限。</span>
                </div>
              </section>
            </div>
            <div className="overview-grid lower-grid">
              <section className="card">
                <div className="card-head">
                  <div>
                    <h2>
                      我的社群 <span className="count-label">{groups.length}</span>
                    </h2>
                    <p>最近 24 小时的社群状态</p>
                  </div>
                  <Link className="text-link" to="/groups">
                    查看全部 <ArrowRight size={15} />
                  </Link>
                </div>
                <GroupTable groups={groups.slice(0, 5)} compact />
              </section>
              <section className="card activity-card">
                <div className="card-head">
                  <h2>最近动态</h2>
                  <Link className="text-link" to="/audit">
                    <MoreHorizontal size={19} />
                  </Link>
                </div>
                {d.recent_activity.length ? (
                  <div className="activity-list">
                    {d.recent_activity.slice(0, 5).map((a: Data) => (
                      <div key={a.id}>
                        <span className="activity-dot">
                          <Activity size={13} />
                        </span>
                        <div>
                          <strong>{actionLabel(a.action)}</strong>
                          <p>{a.actor}</p>
                          <time>{date(a.created_at)}</time>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    icon={Activity}
                    title="工作台已就绪"
                    text="连接账号、调整规则或发布通知，操作动态会记录在这里。"
                  />
                )}
              </section>
            </div>
            {d.unknown_deliveries > 0 && (
              <Link className="unknown-banner" to="/announcements">
                <CircleHelp size={18} />
                {d.unknown_deliveries} 条投递结果待核对，请检查平台实际发送情况。
                <ArrowRight size={16} />
              </Link>
            )}
          </>
        )}
      </Loading>
      {compose && <Compose close={() => setCompose(false)} />}
    </>
  );
}
function Chart({ series }: { series: Data[] }) {
  const max = Math.max(4, ...series.map((s) => s.messages));
  const w = 680,
    h = 185,
    x = (i: number) => 38 + (i * (w - 58)) / 6,
    y = (v: number) => h - 22 - (v / max) * (h - 42);
  const line = (key: string) =>
    series.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v[key])}`).join(' ');
  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${w} ${h + 12}`}
        role="img"
        aria-label={`最近七天接收 ${series.reduce((a, s) => a + s.messages, 0)} 条消息`}
      >
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#52b391" stopOpacity=".18" />
            <stop offset="1" stopColor="#52b391" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1="38"
              x2={w - 20}
              y1={y((max * i) / 4)}
              y2={y((max * i) / 4)}
              stroke="#e9eeeb"
              strokeDasharray="3 4"
            />
            <text x="26" y={y((max * i) / 4) + 4} textAnchor="end">
              {Math.round((max * i) / 4)}
            </text>
          </g>
        ))}
        <path
          d={`${line('messages')} L${x(6)},${y(0)} L${x(0)},${y(0)} Z`}
          fill="url(#chartFill)"
        />
        <path
          d={line('messages')}
          fill="none"
          stroke="#349c79"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d={line('blocked')}
          fill="none"
          stroke="#e2a55d"
          strokeWidth="2"
          strokeDasharray="4 4"
        />
        {series.map((v, i) => (
          <g key={v.date}>
            <circle
              cx={x(i)}
              cy={y(v.messages)}
              r="3.5"
              stroke="#349c79"
              strokeWidth="2"
              fill="white"
            >
              <title>
                {v.date}：{v.messages} 条消息，{v.blocked} 条判定违规
              </title>
            </circle>
            <text x={x(i)} y={h + 5} textAnchor="middle">
              {v.date.slice(5).replace('-', '/')}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
function GroupTable({ groups, compact = false }: { groups: Data[]; compact?: boolean }) {
  return groups.length ? (
    <div className="table-wrap">
      <table className="group-directory-table">
        <thead>
          <tr>
            <th>社群名称</th>
            <th>平台</th>
            <th>消息 / 24h</th>
            {!compact && <th>成员</th>}
            <th>同步与规则</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id}>
              <td>
                <Link className="group-name" to={`/groups/${g.id}`}>
                  <span className={`group-avatar ${g.kind === 'channel' ? 'channel' : ''}`}>
                    {g.kind === 'channel' ? <Radio size={18} /> : <Users size={18} />}
                  </span>
                  <span>
                    <strong>{g.name}</strong>
                    <small>
                      {g.kind === 'channel' ? '频道' : '群组'}
                      {g.is_demo ? ' · 演示' : ` · ${g.external_id}`}
                    </small>
                  </span>
                </Link>
              </td>
              <td data-label="平台">
                <Platform value={g.platform} demo={g.is_demo} />
              </td>
              <td className="numeric" data-label="消息 / 24h">
                {n(g.messages_24h)}
              </td>
              {!compact && (
                <td className="numeric" data-label="成员">
                  {g.member_count === null ? '未知' : n(g.member_count)}
                </td>
              )}
              <td data-label="同步与规则">
                <Badge
                  value={
                    g.sync_enabled === false
                      ? 'paused'
                      : g.account_status === 'online'
                        ? 'online'
                        : 'pending'
                  }
                >
                  {g.sync_enabled === false
                    ? '未启用同步'
                    : g.account_status === 'online'
                      ? '同步已开启'
                      : '连接待恢复'}
                </Badge>
                <small className="block muted">
                  {g.policy.mode === 'enforce' ? '规则自动处理' : '规则观察模式'}
                  {g.pending_verifications > 0 ? ` · ${g.pending_verifications} 人待验证` : ''}
                </small>
              </td>
              <td>
                <div className="table-row-actions">
                  {g.sync_enabled !== false && (
                    <Link
                      className="text-link"
                      to={`/inbox/${g.id}`}
                      aria-label={`打开${g.name}的聊天`}
                    >
                      <MessageSquare size={15} />
                      聊天
                    </Link>
                  )}
                  <Link
                    className="text-link"
                    aria-label={`管理${g.name}`}
                    to={`/groups/${g.id}?tab=policy`}
                  >
                    <Settings2 size={15} />
                    设置
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="还没有连接社群" text="前往连接账号，添加机器人并同步群信息。" />
  );
}
function Groups() {
  const { groups } = useApp();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const platform = params.get('platform') ?? 'all';
  const scope = params.get('scope') ?? 'all';
  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const selectedCount = groups.filter((g) => g.sync_enabled !== false).length;
  const filtered = groups.filter(
    (g) =>
      (platform === 'all' || g.platform === platform) &&
      (scope === 'all' ||
        (scope === 'enabled' ? g.sync_enabled !== false : g.sync_enabled === false)) &&
      `${g.name} ${g.external_id} ${g.account_name}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <>
      <Head
        eyebrow="COMMUNITY DIRECTORY"
        title="群与频道"
        description="查看社群信息、审核消息，为每个群设置独立的管理规则。"
      >
        <Link className="btn primary" to="/accounts">
          <Plus size={17} />
          连接社群
        </Link>
      </Head>
      <div className="directory-summary">
        <div>
          <Users size={19} />
          <span>
            全部社群<strong>{groups.length}</strong>
          </span>
        </div>
        <div>
          <Radio size={19} />
          <span>
            已选同步<strong>{selectedCount}</strong>
          </span>
        </div>
        <div>
          <ShieldCheck size={19} />
          <span>
            待验证成员
            <strong>
              {n(groups.reduce((sum, g) => sum + Number(g.pending_verifications ?? 0), 0))}
            </strong>
          </span>
        </div>
        <div>
          <MessageSquare size={19} />
          <span>
            24h 消息
            <strong>{n(groups.reduce((sum, g) => sum + Number(g.messages_24h ?? 0), 0))}</strong>
          </span>
        </div>
      </div>
      <div className="card">
        <div className="filter-bar">
          <div className="tabs">
            {[
              ['all', '全部社群'],
              ['telegram', 'Telegram'],
              ['qq', 'QQ'],
              ['binance', '币安聊天'],
              ['custom', '自有聊天'],
            ].map(([key, name]) => (
              <button
                key={key}
                className={platform === key ? 'active' : ''}
                onClick={() => updateFilter('platform', key!)}
                aria-pressed={platform === key}
              >
                {name}
                <span>
                  {key === 'all' ? groups.length : groups.filter((g) => g.platform === key).length}
                </span>
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索社群"
              placeholder="搜索群名、ID 或连接账号"
              value={search}
              onChange={(e) => updateFilter('q', e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="icon-btn"
                aria-label="清空社群搜索"
                onClick={() => updateFilter('q', '')}
              >
                <X size={14} />
              </button>
            )}
          </label>
        </div>
        <div className="directory-toolbar">
          <div className="segmented" aria-label="筛选同步范围">
            {(
              [
                ['all', '全部'],
                ['enabled', '已选同步'],
                ['disabled', '未同步'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={scope === key ? 'active' : ''}
                aria-pressed={scope === key}
                onClick={() => updateFilter('scope', key)}
              >
                {label}
                <span>
                  {key === 'all'
                    ? groups.length
                    : key === 'enabled'
                      ? selectedCount
                      : groups.length - selectedCount}
                </span>
              </button>
            ))}
          </div>
          <span>显示 {filtered.length} 个社群</span>
        </div>
        {filtered.length || !groups.length ? (
          <GroupTable groups={filtered} />
        ) : (
          <div>
            <Empty
              icon={Search}
              title="没有符合条件的社群"
              text="试试其他关键词，或重置平台和同步范围筛选。"
            />
            <div className="empty-action">
              <button className="btn" onClick={() => setParams({}, { replace: true })}>
                重置所有筛选
              </button>
            </div>
          </div>
        )}
        <div className="table-foot">
          共 {filtered.length} 个社群 <span>成员数量以平台最近一次返回为准</span>
        </div>
      </div>
    </>
  );
}
function GroupDetail() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: g, loading, error } = useData(`/conversations/${id}`, true);
  const requestedTab =
    searchParams.get('tab') ??
    (searchParams.has('verification')
      ? 'qq-verifications'
      : searchParams.has('member')
        ? 'members'
        : 'messages');
  const tabs = [
    ['messages', '消息记录'],
    ['policy', '管理规则'],
    ['keywords', '关键词触发'],
    ['permissions', '平台能力'],
    ...(['telegram', 'binance'].includes(g?.platform) && g.kind === 'group'
      ? [['members', '成员管理']]
      : []),
    ...(g?.platform === 'qq' && g.kind === 'group'
      ? [
          ['qq-requests', '入群审核'],
          ['qq-verifications', '活人验证'],
        ]
      : []),
  ];
  const tab = tabs.some(([key]) => key === requestedTab) ? requestedTab : 'messages';
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    if (next !== 'members') params.delete('member');
    if (next !== 'qq-verifications') params.delete('verification');
    setSearchParams(params);
  };
  const { toast, refresh, groups } = useApp();
  const syncEnabled = groups.find((group) => group.id === id)?.sync_enabled !== false;
  const [checkingPermissions, setCheckingPermissions] = useState(false);
  return (
    <>
      <Link className="back-link" to="/groups">
        ← 返回群与频道
      </Link>
      <Loading loading={loading && !g} error={error}>
        {g && (
          <>
            <Head
              eyebrow="COMMUNITY DETAILS"
              title={g.name}
              description={`${g.kind === 'channel' ? '频道' : '群组'} · ${g.external_id} · ${g.account_name}`}
            >
              <Platform value={g.platform} demo={g.is_demo} />
              <Badge value={g.account_status} />
              <CopyButton value={g.external_id} label="复制群 ID" />
              <Link
                className="btn primary"
                to={
                  syncEnabled
                    ? `/inbox/${id}`
                    : `/accounts?groups=${encodeURIComponent(g.executor_account_id)}`
                }
              >
                {syncEnabled ? <MessageSquare size={16} /> : <Settings2 size={16} />}
                {syncEnabled ? '实时聊天' : '恢复群同步'}
              </Link>
            </Head>
            <div className="detail-stats">
              <span>
                <Users size={17} />
                成员 <strong>{g.member_count ?? '未知'}</strong>
              </span>
              <span>
                <ShieldCheck size={17} />
                广告规则 <strong>{g.policy.mode === 'enforce' ? '自动处理' : '观察模式'}</strong>
              </span>
              <span>
                <Clock3 size={17} />
                权限更新 <strong>{date(g.bindings[0]?.snapshot.observed_at)}</strong>
              </span>
            </div>
            <div className="card">
              <div className="tabs padded">
                {tabs.map(([key, name]) => (
                  <button
                    key={key}
                    className={tab === key ? 'active' : ''}
                    aria-pressed={tab === key}
                    onClick={() => setTab(key!)}
                  >
                    {name}
                    {key === 'qq-verifications' &&
                      g.verifications?.some((v: Data) =>
                        ['pending', 'failed', 'expired', 'manual_review', 'cooldown'].includes(
                          v.status,
                        ),
                      ) && (
                        <span>
                          {
                            g.verifications.filter((v: Data) =>
                              [
                                'pending',
                                'failed',
                                'expired',
                                'manual_review',
                                'cooldown',
                              ].includes(v.status),
                            ).length
                          }
                        </span>
                      )}
                  </button>
                ))}
              </div>
              {tab === 'messages' && (
                <>
                  <div className="message-list">
                    {g.messages.length ? (
                      g.messages.map((m: Data) => (
                        <div key={m.id} className={`message-row ${m.direction}`}>
                          <span className="message-avatar">
                            {m.direction === 'outgoing' ? (
                              <Bot size={18} />
                            ) : (
                              String(m.sender_name).slice(0, 1)
                            )}
                          </span>
                          <div className="message-content">
                            <div>
                              <strong>{m.sender_name}</strong>
                              <span className="muted">{m.sender_id}</span>
                              <time>{date(m.source_at)}</time>
                            </div>
                            <p className={m.deleted ? 'deleted' : ''}>{m.content}</p>
                            <div className="message-meta">
                              <Badge value={m.verdict} />
                              {m.reason && <small>{m.reason}</small>}
                            </div>
                            <ModerationResult message={m} demo={g.is_demo} />
                          </div>
                        </div>
                      ))
                    ) : (
                      <Empty
                        title="等待第一条消息"
                        text="接收的新消息会显示在这里；平台历史记录暂不导入。"
                      />
                    )}
                  </div>
                  {g.is_demo && (
                    <div className="simulator">
                      <h3>
                        <Bot size={17} />
                        演示群测试
                      </h3>
                      <p>模拟成员发言或入群，体验当前规则、验证与消息同步。</p>
                      <ActionForm
                        label="发送模拟事件"
                        onSubmit={async (f) => {
                          await api(`/conversations/${id}/simulate`, {
                            method: 'POST',
                            body: {
                              user_id: f.get('user_id'),
                              type: f.get('type'),
                              ...(f.get('text') ? { text: f.get('text') } : {}),
                            },
                          });
                          toast('模拟事件已处理');
                        }}
                      >
                        <div className="form-grid">
                          <label>
                            成员 ID
                            <input
                              name="user_id"
                              required
                              defaultValue="demo-member"
                              pattern="[\w-]{1,64}"
                            />
                          </label>
                          <label>
                            事件
                            <select name="type">
                              <option value="message">发送消息</option>
                              <option value="join">重新入群</option>
                            </select>
                          </label>
                        </div>
                        <label>
                          消息内容
                          <input
                            name="text"
                            placeholder="例如：普通讨论，或你设置的广告关键词"
                            maxLength={8000}
                          />
                        </label>
                      </ActionForm>
                    </div>
                  )}
                </>
              )}
              {tab === 'policy' && (
                <div className="card-body">
                  <PolicyForm key={g.id} group={g} />
                </div>
              )}
              {tab === 'keywords' && <KeywordRules key={g.id} id={g.id} platform={g.platform} />}
              {tab === 'members' && g.platform === 'telegram' && g.kind === 'group' && (
                <MemberManagement key={g.id} id={g.id} member={searchParams.get('member')} />
              )}
              {tab === 'members' && g.platform === 'binance' && g.kind === 'group' && (
                <BinanceMemberManagement key={g.id} id={g.id} member={searchParams.get('member')} />
              )}
              {tab === 'qq-requests' && g.platform === 'qq' && g.kind === 'group' && (
                <QQRequests key={g.id} id={g.id} />
              )}
              {tab === 'qq-verifications' && g.platform === 'qq' && g.kind === 'group' && (
                <VerificationList key={g.id} groupId={g.id} openSettings={() => setTab('policy')} />
              )}
              {tab === 'permissions' && (
                <div className="card-body">
                  <div className="info-box">
                    实际执行前会同时检查连接器能力与账号权限。权限快照超过 5
                    分钟会停止操作并要求刷新。
                  </div>
                  <button
                    className="btn"
                    disabled={checkingPermissions || g.account_status === 'paused' || g.is_demo}
                    onClick={async () => {
                      setCheckingPermissions(true);
                      try {
                        await api(`/accounts/${g.executor_account_id}/permissions-refresh`, {
                          method: 'POST',
                        });
                        refresh();
                        toast('当前账号的群权限已刷新');
                      } catch (error: any) {
                        toast(error.message, true);
                      } finally {
                        setCheckingPermissions(false);
                      }
                    }}
                  >
                    {checkingPermissions ? '正在核对权限…' : '刷新当前账号权限'}
                  </button>
                  {g.bindings.map((b: Data) => (
                    <div key={b.account_id}>
                      <h3>{b.account_name}</h3>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>能力</th>
                              <th>连接器支持</th>
                              <th>账号权限</th>
                              <th>说明</th>
                            </tr>
                          </thead>
                          <tbody>
                            {b.snapshot.capabilities.map((c: Data) => (
                              <tr key={c.capability}>
                                <td>
                                  <code>{c.capability}</code>
                                </td>
                                <td>
                                  {c.state === 'supported'
                                    ? '支持'
                                    : c.state === 'unsupported'
                                      ? '不支持'
                                      : '未知'}
                                </td>
                                <td>
                                  {
                                    (
                                      {
                                        granted: '已授予',
                                        denied: '未授予',
                                        unknown: '未知',
                                      } as Data
                                    )[
                                      b.snapshot.permissions.find(
                                        (p: Data) => p.capability === c.capability,
                                      )?.permission ?? 'unknown'
                                    ]
                                  }
                                </td>
                                <td>
                                  {b.snapshot.permissions.find(
                                    (p: Data) => p.capability === c.capability,
                                  )?.reason ?? '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </Loading>
    </>
  );
}
function PolicyForm({ group }: { group: Data }) {
  const { toast } = useApp();
  const p = group.policy;
  const [mode, setMode] = useState(p.mode);
  const [action, setAction] = useState(p.action);
  const [verification, setVerification] = useState(p.verification_enabled);
  const [timeoutAction, setTimeoutAction] = useState(p.verification_timeout_action ?? 'manual');
  const [failedAction, setFailedAction] = useState(p.verification_failed_action ?? 'manual');
  const [keywords, setKeywords] = useState(p.keywords.join('\n'));
  const [domains, setDomains] = useState(p.blocked_domains.join('\n'));
  const [timeout, setVerificationTimeout] = useState(String(p.verification_timeout));
  const qq = group.platform === 'qq';
  const splitLines = (value: string) =>
    value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  const fingerprint = JSON.stringify([
    mode,
    action,
    splitLines(keywords),
    splitLines(domains),
    verification,
    Number(timeout),
    qq ? timeoutAction : null,
    qq ? failedAction : null,
  ]);
  const serverFingerprint = JSON.stringify([
    p.mode,
    p.action,
    p.keywords,
    p.blocked_domains,
    p.verification_enabled,
    p.verification_timeout,
    qq ? (p.verification_timeout_action ?? 'manual') : null,
    qq ? (p.verification_failed_action ?? 'manual') : null,
  ]);
  const [savedPolicy, setSavedPolicy] = useState(serverFingerprint);
  const dirty = fingerprint !== savedPolicy;
  const restore = () => {
    setMode(p.mode);
    setAction(p.action);
    setKeywords(p.keywords.join('\n'));
    setDomains(p.blocked_domains.join('\n'));
    setVerification(p.verification_enabled);
    setVerificationTimeout(String(p.verification_timeout));
    setTimeoutAction(p.verification_timeout_action ?? 'manual');
    setFailedAction(p.verification_failed_action ?? 'manual');
    setSavedPolicy(serverFingerprint);
  };
  useEffect(() => {
    if (!dirty) restore();
  }, [serverFingerprint]);
  const options = group.policy_options ?? {};
  const actions: Record<string, string> = {
    delete: '删除消息',
    remove: '删除并移出成员',
    ban: '删除并封禁成员（禁止重新加入）',
  };
  const unavailable = mode === 'enforce' && !options[action]?.available;
  const invalidVerification =
    verification &&
    (!options.verification?.available ||
      (group.platform === 'qq' &&
        timeoutAction === 'remove' &&
        !options.verification_remove?.available) ||
      (group.platform === 'qq' &&
        timeoutAction === 'mute_retry' &&
        !options.verification_mute?.available) ||
      (group.platform === 'qq' &&
        failedAction === 'mute' &&
        !options.verification_mute?.available));
  return (
    <ActionForm
      className="policy-form"
      label={dirty ? '保存规则' : '规则已保存'}
      disabled={unavailable || invalidVerification || !dirty}
      summary={
        <>
          <span className={dirty ? 'unsaved-marker' : 'saved-marker'}>
            {dirty ? '有未保存的修改' : '已保存'}
          </span>
          {dirty && (
            <button type="button" className="text-button" onClick={restore}>
              还原修改
            </button>
          )}
        </>
      }
      onSubmit={async () => {
        await api(`/conversations/${group.id}/policy`, {
          method: 'PUT',
          body: {
            mode,
            keywords: splitLines(keywords),
            blocked_domains: splitLines(domains),
            action,
            verification_enabled: verification,
            verification_timeout: Number(timeout),
            ...(group.platform === 'qq'
              ? {
                  verification_timeout_action: timeoutAction,
                  verification_failed_action: failedAction,
                }
              : {}),
          },
        });
        setSavedPolicy(fingerprint);
        toast('规则已保存，旧审核任务将停止执行');
      }}
    >
      {dirty && serverFingerprint !== savedPolicy && fingerprint !== serverFingerprint && (
        <div className="info-box">
          服务器上的规则已更新。这里保留你的编辑，点击“还原修改”可载入最新配置。
        </div>
      )}
      <div className="section-intro">
        <ShieldCheck size={21} />
        <div>
          <h3>广告与违规消息</h3>
          <p>先用观察模式确认命中结果，再开启自动处理。</p>
        </div>
      </div>
      <div className="form-grid">
        <label>
          运行模式
          <select name="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="observe">观察模式 · 记录命中</option>
            <option
              value="enforce"
              disabled={!Object.keys(actions).some((key) => options[key]?.available)}
            >
              自动处理 · 执行删除或移除
            </option>
          </select>
        </label>
        <label>
          命中后的动作
          <select name="action" value={action} onChange={(e) => setAction(e.target.value)}>
            {Object.entries(actions).map(([key, label]) => (
              <option key={key} value={key} disabled={!options[key]?.available}>
                {label}
                {!options[key]?.available ? '（不可用）' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="info-box policy-availability">
        <summary>查看平台权限与自动处理说明</summary>
        {Object.entries(actions).map(([key, label]) => (
          <p key={key}>
            {label}：
            {options[key]?.available
              ? '当前能力与账号权限可用'
              : (options[key]?.reason ?? '尚未获取权限')}
          </p>
        ))}
        <p>
          观察模式仅记录广告规则命中；群黑名单仍会提交处理任务。规则命中与平台执行结果分别显示。
        </p>
        <p>移出或封禁还需核对原入群批次；支持此动作不代表任意成员都可直接处理。</p>
        {unavailable && <p role="alert">所选动作当前不可用，请更换动作或切回观察模式后保存。</p>}
      </details>
      {unavailable && (
        <p className="form-error" role="alert">
          当前动作不可用：{options[action]?.reason ?? '请刷新群管理权限'}
          。请更换动作或切回观察模式。
        </p>
      )}
      <div className="form-grid">
        <label>
          广告关键词
          <textarea
            name="keywords"
            rows={6}
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="每行一个关键词，按文字匹配"
          />
          <small>不使用正则表达式；图片识别暂未接入。</small>
        </label>
        <label>
          屏蔽域名
          <textarea
            name="domains"
            rows={6}
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder={'每行一个域名，例如\nspam.example.com'}
          />
          <small>同时匹配该域名及其子域名。</small>
        </label>
      </div>
      <div className="section-intro bordered">
        <Users size={21} />
        <div>
          <h3>活人验证</h3>
          <p>
            {group.platform === 'qq'
              ? '只对开启后新入群的成员发送计算验证，绑定本人及本次入群记录。'
              : '新成员或首次发言时发送验证码，绑定本人及本次入群记录。'}
          </p>
        </div>
      </div>
      <label className="check-row verification-toggle">
        <input
          type="checkbox"
          name="verification"
          role="switch"
          checked={verification}
          disabled={!verification && !options.verification?.available}
          onChange={(e) => setVerification(e.target.checked)}
        />
        <span>
          <strong>开启入群验证</strong>
          <small>
            {verification ? '新成员入群后自动发送验证题' : '当前关闭，新的入群成员无需验证'}
          </small>
        </span>
      </label>
      {!options.verification?.available && (
        <p className="error-text">
          成员验证当前不可用：{options.verification?.reason ?? '尚未获取发送权限'}
          。可先关闭验证后保存。
        </p>
      )}
      <label className="short-field">
        验证时限（秒）
        <input
          type="number"
          name="timeout"
          required
          min={30}
          max={3600}
          value={timeout}
          onChange={(e) => setVerificationTimeout(e.target.value)}
        />
      </label>
      {group.platform === 'qq' && (
        <label className="short-field">
          连续答错 3 次后
          <select value={failedAction} onChange={(e) => setFailedAction(e.target.value)}>
            <option value="manual">交由管理员处理</option>
            <option value="mute" disabled={!options.verification_mute?.available}>
              禁言 10 分钟{!options.verification_mute?.available ? '（权限不可用）' : ''}
            </option>
          </select>
          {failedAction === 'mute' && !options.verification_mute?.available && (
            <small className="error-text">
              {options.verification_mute?.reason ?? '请刷新群管理权限'}
            </small>
          )}
          <small>
            只在连续答错 3 次时触发，与单纯超时分别配置。禁言到期由 QQ
            自动解除，人工通过验证不会自动解禁。
          </small>
        </label>
      )}
      {group.platform === 'qq' && (
        <label className="short-field">
          验证超时后
          <select value={timeoutAction} onChange={(e) => setTimeoutAction(e.target.value)}>
            <option value="manual">记录超时，由管理员处理（默认）</option>
            <option value="mute_retry" disabled={!options.verification_mute?.available}>
              禁言 10 分钟，到期重新验证并循环
              {!options.verification_mute?.available ? '（权限不可用）' : ''}
            </option>
            <option value="remove" disabled={!options.verification_remove?.available}>
              自动移出本群{!options.verification_remove?.available ? '（权限不可用）' : ''}
            </option>
          </select>
          {timeoutAction === 'remove' && !options.verification_remove?.available && (
            <small className="error-text">
              {options.verification_remove?.reason ?? '请先刷新群管理权限'}
            </small>
          )}
          {timeoutAction === 'mute_retry' && (
            <small>
              超时禁言 10 分钟，由 QQ 到期自动解除；后台确认已解除后重新 @
              成员出题，未通过则循环。答错三次的禁言也会到期重试；通过、退群、人工通过或关闭验证后停止。
            </small>
          )}
          {timeoutAction === 'mute_retry' && !options.verification_mute?.available && (
            <small className="error-text">
              {options.verification_mute?.reason ?? '请先刷新群管理权限'}
            </small>
          )}
        </label>
      )}
      <div className="info-box">
        {group.platform === 'qq'
          ? 'QQ 会 @ 新成员发送计算题，成员 @本机器人并发送数字答案，或引用回复验证题只发数字，无需复制指令。提示确认发送后才开始计时。自动审核通过后仍须完成验证；发送失败或结果待核对时不自动移出。群主、管理员和机器人自身受保护。'
          : '使用数字挑战或 Telegram 按钮验证。超时进入人工处理；不会自动解除管理员的禁言。'}
        自动处理模式下，未验证成员的发言会提交删除任务。
      </div>
    </ActionForm>
  );
}

function BinanceGroupsModal({
  id,
  kind = 'binance',
  close,
}: {
  id: string;
  kind?: string;
  close: () => void;
}) {
  const path = kind === 'binance' ? 'binance-groups' : 'groups';
  const limit = kind === 'binance' ? 20 : 500;
  const { refresh, toast } = useApp();
  const [data, setData] = useState<Data>();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const selectionRevision = useRef('');
  useEffect(() => {
    alive.current = true;
    void load(true);
    return () => {
      alive.current = false;
    };
  }, [id]);
  async function load(initial = false) {
    const preserveEdits =
      !initial &&
      data &&
      JSON.stringify([...selected].sort()) !== JSON.stringify([...data.group_ids].sort());
    setBusy(true);
    setError('');
    try {
      if (initial) {
        const cached = await api(`/accounts/${id}/${path}`);
        if (!alive.current) return;
        selectionRevision.current = cached.revision;
        setData(cached);
        setSelected(cached.group_ids);
      }
      const latest = await api(`/accounts/${id}/${path}/refresh`, { method: 'POST' });
      if (!alive.current) return;
      setData(latest);
      if (!preserveEdits) {
        selectionRevision.current = latest.revision;
        setSelected(latest.group_ids);
      }
    } catch (err: any) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (!data || busy || selectionRevision.current !== data.revision) return;
    setBusy(true);
    setError('');
    try {
      const result = await api(`/accounts/${id}/${path}`, {
        method: 'PUT',
        body: { group_ids: selected, revision: selectionRevision.current },
      });
      refresh();
      toast(result.warning || `已保存，正在同步 ${selected.length} 个聊天室`, !!result.warning);
      close();
    } catch (err: any) {
      setError(err.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const visible = (data?.groups ?? []).filter(
    (group: Data) =>
      (!selectedOnly || selected.includes(group.id)) &&
      `${group.name} ${group.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const changed =
    !!data && JSON.stringify([...selected].sort()) !== JSON.stringify([...data.group_ids].sort());
  const conflicted = !!data && selectionRevision.current !== data.revision;
  return (
    <Modal
      title="选择同步群"
      description={
        kind === 'telegram'
          ? '勾选机器人已发现或手动添加的群。Telegram Bot 无法列出所有已加入的群；新群先发一条消息或通过“添加群”登记。'
          : '读取账号已加入的群，勾选需要同步到工作台的聊天室。'
      }
      close={close}
    >
      <div className="binance-room-toolbar">
        <input
          aria-label="搜索聊天室"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索群名称或群 ID"
        />
        <button className="btn" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={15} className={busy ? 'spin' : ''} />
          刷新群列表
        </button>
      </div>
      <p className="muted">
        已选 {selected.length} / {limit} ·{' '}
        {data?.discovered_at ? `最近读取 ${date(data.discovered_at)}` : '等待读取群列表'}
        {changed && <strong className="selection-unsaved">有未保存的修改</strong>}
      </p>
      <div className="group-selection-tools">
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            setSelected((current) =>
              [
                ...new Set([
                  ...current,
                  ...visible.filter((g: Data) => !g.unavailable).map((g: Data) => g.id),
                ]),
              ].slice(0, limit),
            )
          }
        >
          选择当前结果
        </button>
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            setSelected((current) =>
              current.filter((id) => !visible.some((g: Data) => g.id === id)),
            )
          }
        >
          取消当前结果
        </button>
        <label>
          <input
            type="checkbox"
            checked={selectedOnly}
            onChange={(e) => setSelectedOnly(e.target.checked)}
          />
          仅看已选
        </label>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {conflicted && (
        <div className="form-error" role="alert">
          同步范围已在其他页面变更。为避免覆盖，请载入最新勾选后重新调整。
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              selectionRevision.current = data.revision;
              setSelected([...data.group_ids]);
              setError('');
            }}
          >
            载入最新勾选
          </button>
        </div>
      )}
      {busy && (
        <p className="muted" role="status">
          <LoaderCircle className="spin" size={15} />
          正在读取或保存，请稍候…
        </p>
      )}
      <div className="binance-room-list">
        {visible.map((group: Data) => (
          <label className="check-row binance-room" key={group.id}>
            <input
              type="checkbox"
              checked={selected.includes(group.id)}
              disabled={
                busy ||
                (!selected.includes(group.id) && (selected.length >= limit || group.unavailable))
              }
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, group.id]
                    : current.filter((value) => value !== group.id),
                )
              }
            />
            <span>
              <strong>{group.name}</strong>
              <small>
                群 ID {group.id}
                {group.member_count != null ? ` · ${n(group.member_count)} 位成员` : ''}
                {group.unavailable ? ' · 未在最新列表中找到，可取消同步' : ''}
              </small>
            </span>
          </label>
        ))}
        {!busy && !visible.length && (
          <p className="muted">
            {query ? '没有匹配的聊天室' : '尚未发现群，请确认账号在线并已加入群后刷新。'}
          </p>
        )}
      </div>
      <div className="info-box">
        取消勾选会停止该群后续收发与管理任务，保留历史。保存后立即生效，新发现的群需再次勾选。
        {kind === 'binance'
          ? '新勾选的群先导入最近消息。'
          : '首次保存前沿用现有同步范围；TG/QQ 不自动补取接入前历史。'}
      </div>
      <div className="form-actions">
        <button className="text-button" disabled={busy} onClick={() => setSelected([])}>
          取消全部勾选
        </button>
        <button className="btn" onClick={close}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={busy || !data || !changed || conflicted}
          onClick={() => void save()}
        >
          {busy ? '处理中…' : `保存 ${selected.length} 个同步群`}
        </button>
      </div>
    </Modal>
  );
}

function BinanceAuthenticationModal({
  account,
  close,
  login,
}: {
  account: Data;
  close: () => void;
  login: () => void;
}) {
  const { toast } = useApp();
  const [mode, setMode] = useState(account.settings?.transport === 'direct' ? 'direct' : 'bridge');
  return (
    <Modal
      title="币安连接方式"
      description="服务器直连为实验功能，先验证身份、群资料、消息读取和聊天心跳，再切换连接。"
      close={close}
    >
      <ActionForm
        label={mode === 'direct' ? '验证并启用直连' : '使用浏览器桥接'}
        cancel={close}
        onSubmit={async (form) => {
          const result = await api(`/accounts/${account.id}/binance-auth`, {
            method: 'PUT',
            body:
              mode === 'direct'
                ? {
                    mode,
                    web_token: String(form.get('web_token') ?? '').trim(),
                    csrf_cookie: String(form.get('csrf_cookie') ?? '').trim(),
                    ...(form.get('device_id')
                      ? { device_id: String(form.get('device_id')).trim() }
                      : {}),
                  }
                : { mode },
          });
          toast(
            result.warning ||
              (mode === 'direct'
                ? '服务器直连验证通过，已切换连接'
                : '直连令牌已删除，请在 Chrome 扩展重新连接'),
            !!result.warning,
          );
          close();
        }}
      >
        <label>
          连接方式
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="bridge">浏览器桥接</option>
            <option value="direct">服务器令牌直连（实验）</option>
          </select>
        </label>
        {mode === 'direct' ? (
          <>
            <div className="info-box">
              推荐在服务器登录窗口完成扫码或验证码，再点击“连接此账号”，无需手动复制下方字段。
              <p>
                <button type="button" className="btn primary" onClick={login}>
                  打开服务器登录窗口
                </button>
              </p>
              也可以从另一台 Chrome
              的扩展主动授权：覆盖原扩展目录并重新加载，刷新已登录的币安聊天页，核对后台地址、勾选授权后点击“读取并授权直连”。
              <p>
                <a className="btn" href="/downloads/binance-bridge-latest.zip" download>
                  下载 Chrome 扩展（含一键授权）
                </a>
              </p>
              下方手动填写方式仍可使用。
            </div>
            <div className="info-box">
              使用网页登录令牌连接后，无需保持 Chrome
              和扩展运行。它属于币安网页登录凭据，权限可能超出聊天范围；提交后会加密保存在本服务器，仅请求固定聊天接口。请使用专用账号。令牌失效时需重新登录更新，目前不支持独立续签。
            </div>
            <label>
              网页登录令牌（p20t）
              <input
                name="web_token"
                type="password"
                required
                maxLength={16384}
                autoComplete="off"
                spellCheck={false}
                placeholder="仅填令牌值，不要填写完整 Cookie"
              />
            </label>
            <label>
              CSRF Cookie（cr00）
              <input
                name="csrf_cookie"
                type="password"
                required
                maxLength={16384}
                autoComplete="off"
                spellCheck={false}
                placeholder="同一登录会话中 cr00 的值"
              />
            </label>
            <label>
              设备标识（BNC_FV_KEY，可选）
              <input
                name="device_id"
                type="password"
                maxLength={1024}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <details>
              <summary>如何获取令牌</summary>
              <p>
                在已登录币安的 Chrome 打开开发者工具：Application → Cookies →
                https://www.binance.com，分别复制 同一会话中 p20t 与 cr00
                的值。只填写上方字段，请勿把令牌发到聊天中。
              </p>
              <p>
                支持 JWT
                和不透明令牌，格式本身不代表验证成功。验证失败会保留当前连接；验证过程不发送群消息。
              </p>
            </details>
            {account.settings?.direct_auth && (
              <p className="muted">
                已保存令牌：{account.settings.direct_auth.format === 'jwt' ? 'JWT' : '不透明格式'} ·
                声明到期时间：
                {account.settings.direct_auth.expires_at
                  ? date(account.settings.direct_auth.expires_at)
                  : '未知，以币安实际验证为准'}
                。更新需重新填写，不回显原令牌。
              </p>
            )}
          </>
        ) : (
          <div className="info-box">
            保持已登录的币安聊天页和 Chrome
            扩展运行。切回此方式会删除服务器保存的直连令牌，历史消息与同步群选择保留；随后在扩展中点击“使用已保存配置连接”。
          </div>
        )}
      </ActionForm>
    </Modal>
  );
}

function Accounts() {
  const { accounts, refresh, toast, accountsError, accountsCheckedAt } = useApp();
  const { data: localQQ } = useData('/qq-local', true);
  const [qqLogin, setQQLogin] = useState<Data | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [add, setAdd] = useState(false),
    [kind, setKind] = useState('telegram'),
    [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tg, setTg] = useState('');
  const [binanceGroups, setBinanceGroups] = useState('');
  const [binanceAuth, setBinanceAuth] = useState<Data | null>(null);
  const [binanceLogin, setBinanceLogin] = useState<Data | null>(null);
  const closingLogin = useRef(new Set<string>());
  const openingFromLink = useRef<string | null>(null);
  const requestedLogin = searchParams.get('relogin');
  const requestedGroups = searchParams.get('groups');
  const needsAttention = (a: Data) => !a.is_demo && !['online', 'paused'].includes(accountState(a));
  const filteredAccounts = accounts.filter(
    (a) =>
      (statusFilter === 'all' || statusFilter === 'attention'
        ? statusFilter === 'all' || needsAttention(a)
        : accountState(a) === statusFilter) &&
      `${a.name} ${a.external_id ?? ''} ${labels[a.platform] ?? a.platform}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  useEffect(() => {
    if (!requestedGroups || !accountsCheckedAt) return;
    const account = accounts.find(
      (a) => a.id === requestedGroups && ['binance', 'qq', 'telegram'].includes(a.kind),
    );
    const params = new URLSearchParams(searchParams);
    params.delete('groups');
    setSearchParams(params, { replace: true });
    if (account) setBinanceGroups(account.id);
    else toast('找不到可管理同步范围的账号，请检查连接列表', true);
  }, [requestedGroups, accountsCheckedAt]);
  useEffect(() => {
    if (!requestedLogin) {
      openingFromLink.current = null;
      return;
    }
    if (!accounts.length || openingFromLink.current === requestedLogin) return;
    openingFromLink.current = requestedLogin;
    const account = accounts.find((a) => a.id === requestedLogin && a.kind === 'binance');
    const params = new URLSearchParams(searchParams);
    params.delete('relogin');
    setSearchParams(params, { replace: true });
    if (account && account.status !== 'paused')
      void openBinanceLogin({
        ...account,
        connection: { ...account.connection, needs_relogin: true },
      });
    else toast('此币安连接不存在或已暂停，请先检查账号状态', true);
  }, [requestedLogin, accounts]);
  function closeBinanceLogin() {
    if (!binanceLogin || closingLogin.current.has(binanceLogin.window_id)) return;
    const windowId = binanceLogin.window_id;
    closingLogin.current.add(windowId);
    setBusy(binanceLogin.id);
    void api(`/accounts/${binanceLogin.id}/binance-browser`, {
      method: 'DELETE',
      body: { window_id: windowId },
    })
      .catch((e) => toast(e.message, true))
      .finally(() => {
        closingLogin.current.delete(windowId);
        setBinanceLogin((current) => (current?.window_id === windowId ? null : current));
        setBusy('');
      });
  }
  async function openBinanceLogin(account: Data) {
    setBusy(account.id);
    try {
      const opened = await api(`/accounts/${account.id}/binance-browser`, { method: 'POST' });
      setBinanceLogin({ ...account, window_id: opened.window_id });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy('');
    }
  }
  async function action(id: string, name: string) {
    setBusy(id);
    try {
      const result = await api(`/accounts/${id}/${name}`, { method: 'POST' });
      if (name === 'binance-pairing') {
        setSecret(JSON.stringify(result, null, 2));
        toast('已生成新配对配置，旧配置立即失效');
      } else if (name === 'binance-check')
        toast(
          !result.failed_groups &&
            (result.connection?.state === 'connected' ||
              result.connection?.state === 'awaiting_groups')
            ? '币安连接检查通过'
            : '检查完成，请查看连接状态和处理建议',
          !!result.failed_groups,
        );
      else toast(name === 'refresh' ? `连接已刷新，发现 ${result.groups} 个社群` : '账号已暂停');
      refresh();
    } catch (err: any) {
      toast(err.message, true);
      refresh();
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <Head
        eyebrow="CONNECT YOUR PLATFORMS"
        title="连接账号"
        description="集中管理机器人账号、登录状态和同步群范围。"
      >
        <button className="btn primary" onClick={() => setAdd(true)}>
          <Plus size={17} />
          添加连接
        </button>
      </Head>
      <div className="account-toolbar">
        <div className="segmented" aria-label="筛选账号连接状态">
          {(
            [
              ['all', '全部连接', accounts.length],
              ['online', '在线', accounts.filter((a) => accountState(a) === 'online').length],
              ['attention', '需要处理', accounts.filter(needsAttention).length],
              ['paused', '已暂停', accounts.filter((a) => accountState(a) === 'paused').length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              aria-pressed={statusFilter === key}
              className={statusFilter === key ? 'active' : ''}
              onClick={() => setStatusFilter(key)}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="搜索连接账号"
            placeholder="搜索账号名称、平台或 ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="icon-btn"
              type="button"
              aria-label="清空账号搜索"
              onClick={() => setQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      <div className={`account-refresh-state ${accountsError ? 'has-error' : ''}`} role="status">
        <span>
          {accountsError
            ? accountsCheckedAt
              ? '状态更新失败，以下保留上次结果。'
              : '暂时无法读取连接状态，请重试。'
            : '连接状态每 10 秒自动更新。'}
          {accountsCheckedAt
            ? ` 最近更新 ${date(accountsCheckedAt)}`
            : accountsError
              ? ''
              : ' 正在获取状态…'}
        </span>
        {accountsError && (
          <button className="text-button" onClick={refresh}>
            重新加载状态
          </button>
        )}
      </div>
      <div className="account-grid">
        {filteredAccounts.map((a) => (
          <section key={a.id} className="card account-card">
            <div className="account-card-top">
              <span className={`large-platform ${a.platform}`}>
                {a.platform === 'telegram' ? <Send size={24} /> : <MessageSquare size={24} />}
              </span>
              <AccountBadge account={a} />
            </div>
            <h2>{a.name}</h2>
            <Platform value={a.platform} demo={a.is_demo} />
            <dl>
              <div>
                <dt>正在同步 / 已发现</dt>
                <dd>
                  {a.settings?.group_ids?.length ?? a.group_count} / {a.group_count} 个
                </dd>
              </div>
              <div>
                <dt>账号标识</dt>
                <dd>{a.external_id ?? '连接后获取'}</dd>
              </div>
              <div>
                <dt>最近活动</dt>
                <dd>{date(a.last_seen_at)}</dd>
              </div>
            </dl>
            {a.kind !== 'binance' && !a.is_demo && (
              <div
                className={`account-state-note ${a.status === 'online' ? 'healthy' : 'needs-check'}`}
              >
                {a.status === 'online' ? <CheckCircle2 size={17} /> : <CircleHelp size={17} />}
                <div>
                  <strong>
                    {a.status === 'online'
                      ? '账号已连接'
                      : a.status === 'paused'
                        ? '收发与管理已暂停'
                        : '连接需要处理'}
                  </strong>
                  <p>
                    {a.last_error ||
                      (a.status === 'online'
                        ? '通过“管理同步群”选择要接收消息和管理的社群。'
                        : a.status === 'paused'
                          ? '恢复连接后，继续使用原来的群选择。'
                          : a.kind === 'qq'
                            ? '请扫码登录或检查 OneBot 连接，再刷新群列表。'
                            : '请检查 Bot Token 和平台连接，再点击“连接 / 刷新”。')}
                  </p>
                </div>
              </div>
            )}
            {a.kind === 'binance' && <BinanceConnectionStatus account={a} />}
            {a.is_demo ? (
              <div className="account-demo">
                <Bot size={15} />
                本地演示，不连接外部平台
              </div>
            ) : (
              <div className="account-actions">
                <button
                  className="btn"
                  disabled={busy === a.id}
                  onClick={() =>
                    void action(
                      a.id,
                      a.kind === 'binance' && a.status !== 'paused' ? 'binance-check' : 'refresh',
                    )
                  }
                >
                  {busy === a.id ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  {a.status === 'paused'
                    ? '恢复连接'
                    : a.kind === 'binance'
                      ? '检查连接'
                      : '连接 / 刷新'}
                </button>
                {a.kind === 'telegram' && (
                  <button className="btn" onClick={() => setTg(a.id)}>
                    添加群
                  </button>
                )}
                {a.kind === 'qq' &&
                  a.status !== 'online' &&
                  localQQ?.available &&
                  localQQ.accounts?.some((q: Data) => q.id === a.id) && (
                    <button className="btn primary" onClick={() => setQQLogin(a)}>
                      VPS 扫码登录 QQ
                    </button>
                  )}
                {['binance', 'qq', 'telegram'].includes(a.kind) && (
                  <button className="btn" onClick={() => setBinanceGroups(a.id)}>
                    <Settings2 size={15} />
                    管理同步群
                  </button>
                )}
                {a.kind === 'binance' && (a.connection?.needs_relogin || a.status !== 'online') && (
                  <button
                    className="btn primary"
                    disabled={
                      busy === a.id ||
                      a.status === 'paused' ||
                      a.connection?.login_available === false
                    }
                    title={
                      a.connection?.login_available === false
                        ? '此服务器未启用登录窗口，请在连接方式更新凭据'
                        : undefined
                    }
                    onClick={() => void openBinanceLogin(a)}
                  >
                    {busy === a.id ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <ExternalLink size={15} />
                    )}
                    {a.connection?.needs_relogin ? '重新登录币安' : '登录币安'}
                  </button>
                )}
              </div>
            )}
            {!a.is_demo && (
              <details className="account-more">
                <summary>
                  更多操作
                  <ChevronDown size={15} />
                </summary>
                <div className="account-more-actions">
                  {a.kind === 'qq' &&
                    a.status === 'online' &&
                    localQQ?.available &&
                    localQQ.accounts?.some((q: Data) => q.id === a.id) && (
                      <button className="btn" onClick={() => setQQLogin(a)}>
                        重新扫码登录 QQ
                      </button>
                    )}
                  {a.kind === 'binance' &&
                    a.status === 'online' &&
                    !a.connection?.needs_relogin && (
                      <button
                        className="btn"
                        disabled={busy === a.id || a.connection?.login_available === false}
                        onClick={() => void openBinanceLogin(a)}
                      >
                        打开币安登录窗口
                      </button>
                    )}
                  {a.kind === 'binance' && (
                    <button
                      className="btn"
                      disabled={busy === a.id || a.status === 'paused'}
                      onClick={() =>
                        import.meta.env.MODE === 'demo'
                          ? void openBinanceLogin(a)
                          : setBinanceAuth(a)
                      }
                    >
                      <KeyRound size={15} />
                      连接方式
                    </button>
                  )}
                  {a.kind === 'binance' && a.settings?.transport !== 'direct' && (
                    <button
                      className="btn"
                      disabled={busy === a.id || a.status === 'paused'}
                      onClick={() => void action(a.id, 'binance-pairing')}
                    >
                      重新配对
                    </button>
                  )}
                  <button
                    className="text-button"
                    disabled={busy === a.id || a.status === 'paused'}
                    onClick={() => void action(a.id, 'pause')}
                  >
                    暂停此账号
                  </button>
                </div>
              </details>
            )}
          </section>
        ))}
        <button className="add-account" onClick={() => setAdd(true)}>
          <span>
            <Plus size={25} />
          </span>
          <h3>连接一个新平台</h3>
          <p>Telegram · QQ · 币安聊天 · 自有聊天</p>
        </button>
      </div>
      {!filteredAccounts.length && accounts.length > 0 && (
        <div className="card">
          <Empty
            icon={Search}
            title="没有符合条件的账号"
            text="调整关键词或状态筛选，查看其他连接。"
          />
          <div className="empty-action">
            <button
              className="btn"
              onClick={() => {
                setQuery('');
                setStatusFilter('all');
              }}
            >
              重置筛选
            </button>
          </div>
        </div>
      )}
      <div className="card roadmap">
        <div>
          <Radio size={23} />
          <div>
            <h3>币安聊天已验证文本收发，X 社群后续接入</h3>
            <p>
              币安支持浏览器桥接和服务器令牌直连；直连模式提供成员禁言、手动解禁及踢人，执行前核对权限。删消息尚未接入；X
              社群的独立适配器待开发。
            </p>
          </div>
        </div>
        <span className="tag">分阶段接入</span>
      </div>
      {add && (
        <Modal
          title="添加平台连接"
          description={
            import.meta.env.MODE === 'demo'
              ? '创建一个虚拟连接；无需填写真实 Token、地址或密码。'
              : '账号 Token 会加密存储。自定义连接器密钥只在创建时显示一次。'
          }
          close={() => setAdd(false)}
        >
          <ActionForm
            label={kind === 'qq-local' ? '打开 VPS 扫码登录' : '创建连接'}
            cancel={() => setAdd(false)}
            onSubmit={async (f) => {
              if (kind === 'qq-local') {
                setAdd(false);
                setQQLogin({ name: String(f.get('name') || 'QQ 机器人') });
                return;
              }
              const result = await api('/accounts', {
                method: 'POST',
                body: {
                  kind,
                  name: f.get('name'),
                  ...(kind === 'telegram'
                    ? { token: f.get('token') }
                    : kind === 'binance'
                      ? { group_ids: [] }
                      : {
                          endpoint: f.get('endpoint'),
                          ...(f.get('token') ? { token: f.get('token') } : {}),
                        }),
                },
              });
              setAdd(false);
              if (kind === 'telegram') toast('连接已创建，请点击连接 / 刷新验证 Token');
              else
                setSecret(
                  JSON.stringify(
                    kind === 'binance' ? result.binance_bridge : result.credentials,
                    null,
                    2,
                  ),
                );
            }}
          >
            <label>
              平台类型
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="telegram">Telegram Bot</option>
                <option value="qq-local" disabled={!localQQ?.available}>
                  QQ · VPS 扫码登录{localQQ?.available ? '（推荐）' : '（服务器未配置）'}
                </option>
                <option value="qq">QQ · OneBot HTTP 桥接</option>
                <option value="binance">币安聊天 · 浏览器会话桥接（实验）</option>
                <option value="custom">自有聊天 · 签名 HTTP 连接器</option>
              </select>
            </label>
            <label>
              连接名称
              <input name="name" required maxLength={100} placeholder="例如：千羽官方机器人" />
            </label>
            {kind === 'binance' && (
              <div className="info-box">
                先创建连接并在浏览器完成配对，再通过“管理同步群”自动读取已加入的聊天室，勾选要同步的群，后续可随时增删。
              </div>
            )}
            {import.meta.env.MODE !== 'demo' &&
              kind !== 'telegram' &&
              kind !== 'binance' &&
              kind !== 'qq-local' && (
                <label>
                  连接器地址
                  <input
                    name="endpoint"
                    type="url"
                    required
                    placeholder="https://chat.example.com"
                  />
                </label>
              )}
            {import.meta.env.MODE !== 'demo' && kind !== 'binance' && kind !== 'qq-local' && (
              <label>
                {kind === 'telegram' ? 'Bot Token' : '桥接访问 Token（可选）'}
                <input
                  name="token"
                  type="password"
                  required={kind === 'telegram'}
                  maxLength={2048}
                  autoComplete="off"
                  placeholder={
                    kind === 'telegram' ? '从 BotFather 获取' : '用于访问 OneBot HTTP 服务'
                  }
                />
              </label>
            )}
            <div className="info-box">
              {kind === 'telegram'
                ? '通过官方 Bot API 轮询收取新消息，无需浏览器插件。将机器人加入群并设为管理员即可接收完整群消息；未设管理员时，需要在 BotFather 关闭隐私模式。已有 Webhook 时会提示冲突，不会自动改动原服务。'
                : kind === 'binance'
                  ? '创建后可点击“登录币安”，在服务器窗口中完成登录并连接；也可使用 Chrome 扩展桥接。支持文字、图片、图文与引用回复，同步群可随时选择。'
                  : kind === 'qq-local'
                    ? '直接用手机 QQ 扫描 VPS 上的二维码，登录后自动登记连接、配置消息上报并读取已加入的群。已有同一 QQ 连接会复用；此 VPS 当前使用一个 QQ 登录实例。'
                    : kind === 'qq'
                      ? '需要运行个人 QQ 的 OneBot v11 桥接服务（如 NapCat），配置 HTTP API 和事件上报；支持 X-Signature 签名或 Bearer Token 认证。同机部署可用 QQ_LOCAL_PORT 指定唯一回环端口；其他私网接入需由服务器另行配置。'
                      : '创建后，请在你的聊天服务实现群发现与命令接收接口，再使用密钥完成握手、心跳和事件上报。'}
            </div>
          </ActionForm>
        </Modal>
      )}
      {binanceGroups && (
        <BinanceGroupsModal
          key={binanceGroups}
          id={binanceGroups}
          kind={accounts.find((a) => a.id === binanceGroups)?.kind}
          close={() => setBinanceGroups('')}
        />
      )}
      {qqLogin && (
        <Modal
          title={`VPS QQ 登录 · ${qqLogin.name}`}
          description={
            import.meta.env.MODE === 'demo'
              ? '本地模拟 QQ 登录步骤，无需手机、二维码或凭据。'
              : '使用手机 QQ 扫码，登录状态保存在 VPS；无需在本地运行 QQ 或手动复制访问 Token。'
          }
          close={() => setQQLogin(null)}
        >
          <QQLogin
            id={qqLogin.id}
            name={qqLogin.name}
            close={() => setQQLogin(null)}
            connected={(result) => {
              setQQLogin(null);
              toast(`QQ 已连接，发现 ${result.groups} 个群，请选择同步范围`);
              void refresh();
            }}
          />
        </Modal>
      )}
      {binanceAuth && (
        <BinanceAuthenticationModal
          account={binanceAuth}
          close={() => setBinanceAuth(null)}
          login={() => {
            const account = binanceAuth;
            setBinanceAuth(null);
            void openBinanceLogin(account);
          }}
        />
      )}
      {binanceLogin && (
        <Modal
          wide
          title={`${binanceLogin.connection?.needs_relogin ? '重新登录币安' : '登录币安'} · ${binanceLogin.name}`}
          description={
            import.meta.env.MODE === 'demo'
              ? '本地模拟连接流程，不打开币安，不采集登录信息。'
              : '这是 VPS 上的独立浏览器，请在画面内完成登录。登录窗口最长保留 15 分钟。'
          }
          close={closeBinanceLogin}
        >
          <BinanceLogin
            id={binanceLogin.id}
            windowId={binanceLogin.window_id}
            close={closeBinanceLogin}
            relogin={!!binanceLogin.connection?.needs_relogin}
            connected={(warning) => {
              setBinanceLogin(null);
              toast(warning || '币安登录验证通过，已恢复服务器同步，原群选择已保留', !!warning);
              void refresh();
            }}
          />
        </Modal>
      )}
      {tg && (
        <Modal
          title="添加 Telegram 群"
          description="机器人必须已加入该群。群 ID 通常以 -100 开头。"
          close={() => setTg('')}
        >
          <ActionForm
            label="读取并连接"
            onSubmit={async (f) => {
              await api(`/accounts/${tg}/telegram-group`, {
                method: 'POST',
                body: { external_id: f.get('external_id') },
              });
              setTg('');
              toast('群信息已读取');
            }}
          >
            <label>
              群或频道 ID
              <input required name="external_id" pattern="-?[0-9]+" placeholder="-1001234567890" />
            </label>
          </ActionForm>
        </Modal>
      )}
      {secret && <Secret value={secret} close={() => setSecret('')} />}
    </>
  );
}

function Compose({ close }: { close: () => void }) {
  const { toast, groups, accounts } = useApp();
  const request = useRef<{ intent: string; key: string } | undefined>(undefined);
  const [image, setImage] = useState<Data>();
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [timing, setTiming] = useState('now');
  const [scheduled, setScheduled] = useState('');
  const selectedGroups = groups.filter((g) => targets.includes(g.id) && g.sync_enabled !== false);
  const textLimit = Math.min(
    8000,
    ...selectedGroups.map((g) =>
      g.platform === 'telegram' ? (image ? 1024 : 4096) : g.platform === 'binance' ? 2000 : 8000,
    ),
  );
  const offlineTargets = selectedGroups.filter((g) => !groupAccountOnline(g, accounts));
  const tooLong = content.trim().length > textLimit;
  const scheduleTime = scheduled ? new Date(`${scheduled}+08:00`) : null;
  const invalidSchedule =
    timing === 'scheduled' &&
    (!scheduleTime ||
      !Number.isFinite(scheduleTime.getTime()) ||
      scheduleTime.getTime() <= Date.now());
  const blockReason = uploading
    ? '正在上传图片…'
    : uploadError
      ? '请处理图片上传错误'
      : !title.trim()
        ? '先填写任务标题'
        : !content.trim() && !image
          ? '填写正文或添加图片'
          : !selectedGroups.length
            ? '至少选择一个目标社群'
            : offlineTargets.length && timing === 'now'
              ? '请处理已离线的目标连接'
              : tooLong
                ? '请缩短正文，满足平台字数上限'
                : invalidSchedule
                  ? '请选择未来的北京时间'
                  : '';
  const blocked = !!blockReason;
  const targetSummary = ['telegram', 'qq', 'binance', 'custom']
    .map((p) => ({ name: labels[p], count: selectedGroups.filter((g) => g.platform === p).length }))
    .filter((p) => p.count);
  const minSchedule = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16);
  return (
    <Modal
      wide
      title="新建群发"
      description="编辑消息、选择社群，确认预览后创建发送任务。"
      close={close}
      dismissDisabled={submitting}
    >
      <ActionForm
        className="broadcast-compose"
        label={
          timing === 'scheduled'
            ? `创建 ${selectedGroups.length} 个定时任务`
            : `发送到 ${selectedGroups.length} 个社群`
        }
        cancel={close}
        disabled={blocked}
        summary={
          <>
            <strong>{selectedGroups.length} 个目标社群</strong>
            <span>
              {blockReason ||
                (timing === 'scheduled' ? '北京时间定时发送' : '确认后立即加入发送队列')}
            </span>
          </>
        }
        onSubmit={async (f) => {
          const ids = f.getAll('groups').map(String).sort();
          if (!ids.length) throw new Error('请至少选择一个目标社群');
          if (content.trim().length > textLimit)
            throw new Error(`当前目标平台的文字上限为 ${textLimit} 字符，请缩短内容`);
          const at = timing === 'scheduled' ? new Date(`${scheduled}+08:00`) : null;
          if (at && (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()))
            throw new Error('请选择未来的北京时间');
          const body = {
            title,
            content,
            ...(image ? { image_asset_id: image.id } : {}),
            conversation_ids: ids,
            ...(at ? { scheduled_at: at.toISOString() } : {}),
          };
          const intent = JSON.stringify(body);
          if (!request.current || request.current.intent !== intent)
            request.current = { intent, key: crypto.randomUUID() };
          setSubmitting(true);
          try {
            await api('/announcements', {
              method: 'POST',
              body,
              key: request.current.key,
              signal: AbortSignal.timeout(15_000),
            });
          } catch (error) {
            if (!(error instanceof RequestError))
              throw new Error('提交结果暂未确认，请查看发布记录，或保持内容后重试本次提交。');
            throw error;
          } finally {
            setSubmitting(false);
          }
          toast(
            timing === 'scheduled'
              ? '定时群发已创建，可在发布记录查看进度'
              : '群发已加入发送队列，请查看各群的实际结果',
          );
          close();
        }}
      >
        <div className="broadcast-compose-grid" inert={submitting}>
          <div className="broadcast-edit">
            <section className="compose-section">
              <div className="compose-section-head">
                <span>1</span>
                <h3>消息内容</h3>
                <small>文字、图片或图文</small>
              </div>
              <label>
                任务标题
                <input
                  name="title"
                  required
                  maxLength={120}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="例如：周五社群活动通知"
                />
                <small>仅在后台显示，不会作为标题发送到群内。</small>
              </label>
              <label>
                正文
                <textarea
                  name="content"
                  required={!image}
                  rows={5}
                  maxLength={8000}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={
                    image ? '填写图片说明，也可以留空仅发送图片' : '输入将发送到群内的消息…'
                  }
                />
              </label>
              <div className={`compose-length ${tooLong ? 'over-limit' : ''}`}>
                <span>
                  {tooLong
                    ? '超出目标平台字数限制，请缩短消息'
                    : selectedGroups.length
                      ? '按已选平台中最小的上限计算'
                      : '选定社群后显示对应字数上限'}
                </span>
                <strong>
                  {content.trim().length} / {textLimit}
                </strong>
              </div>
              <div className="broadcast-image-upload">
                <label className="broadcast-upload-control">
                  <ImagePlus size={18} />
                  {uploading ? '正在上传图片…' : image ? '更换图片' : '添加图片'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png"
                    disabled={uploading}
                    aria-label="上传群发图片"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      setUploading(true);
                      setUploadError('');
                      try {
                        setImage(await uploadImage(file));
                      } catch (error: any) {
                        setUploadError(error.message || '图片上传失败');
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                </label>
                {import.meta.env.MODE === 'demo' && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void exampleImage()
                        .then(setImage)
                        .catch((e) => setUploadError(e.message))
                    }
                  >
                    使用示例海报
                  </button>
                )}
                <small className="muted">
                  {import.meta.env.MODE === 'demo'
                    ? '仅保存在浏览器，JPG / PNG 不超过 1 MiB'
                    : 'JPG / PNG，单张不超过 8 MiB'}
                </small>
                {uploadError && (
                  <p className="form-error" role="alert">
                    {uploadError}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setImage(undefined);
                        setUploadError('');
                      }}
                    >
                      取消图片上传
                    </button>
                  </p>
                )}
                {image && (
                  <div className="broadcast-image-preview">
                    <img
                      src={mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(image.id)}`)}
                      alt="群发图片预览"
                    />
                    <button
                      type="button"
                      className="text-button"
                      disabled={uploading}
                      onClick={() => {
                        setImage(undefined);
                        setUploadError('');
                      }}
                    >
                      <Trash2 size={14} />
                      移除图片
                    </button>
                  </div>
                )}
              </div>
            </section>
            <section className="compose-section">
              <div className="compose-section-head">
                <span>2</span>
                <h3>目标社群</h3>
                <small>仅显示已选同步的社群</small>
              </div>
              <GroupChoices
                sendable
                value={targets}
                onChange={setTargets}
                allowOffline={timing === 'scheduled'}
              />
              {!!offlineTargets.length && (
                <p className={timing === 'scheduled' ? 'info-box' : 'form-error'} role="status">
                  {offlineTargets.map((g) => g.name).join('、')}
                  {timing === 'scheduled'
                    ? '当前离线，请在计划发送时间前恢复连接；执行时会重新核对权限。'
                    : '的连接已离线，请恢复连接或取消选择。'}
                </p>
              )}
            </section>
            <section className="compose-section">
              <div className="compose-section-head">
                <span>3</span>
                <h3>发送时间</h3>
              </div>
              <div className="compose-timing">
                <label>
                  <input
                    type="radio"
                    name="timing"
                    value="now"
                    checked={timing === 'now'}
                    onChange={() => setTiming('now')}
                  />
                  立即发送
                </label>
                <label>
                  <input
                    type="radio"
                    name="timing"
                    value="scheduled"
                    checked={timing === 'scheduled'}
                    onChange={() => setTiming('scheduled')}
                  />
                  定时发送
                </label>
              </div>
              {timing === 'scheduled' && (
                <label>
                  北京时间（UTC+8）
                  <input
                    name="scheduled"
                    type="datetime-local"
                    required
                    min={minSchedule}
                    value={scheduled}
                    onChange={(e) => setScheduled(e.target.value)}
                  />
                  <small>请选择未来的时间；各群会生成独立的定时任务。</small>
                </label>
              )}
            </section>
          </div>
          <aside className="broadcast-preview" aria-label="群发内容预览">
            <div className="broadcast-preview-head">
              <span>
                <MessageSquare size={17} />
                消息预览
              </span>
              <small>各平台样式可能不同</small>
            </div>
            <div className="broadcast-preview-canvas">
              <span className="preview-bot">
                <Bot size={20} />
              </span>
              <div className="preview-message">
                <strong>机器人</strong>
                <div
                  className={`preview-bubble ${!content.trim() && !image ? 'is-placeholder' : ''}`}
                >
                  {content.trim() ? <p>{content}</p> : !image && <p>消息内容会显示在这里</p>}
                  {image && (
                    <img
                      src={mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(image.id)}`)}
                      alt="将发送的群发图片"
                    />
                  )}
                </div>
              </div>
            </div>
            <div className="broadcast-summary">
              <h3>发送概况</h3>
              <dl>
                <div>
                  <dt>目标社群</dt>
                  <dd>{selectedGroups.length} 个</dd>
                </div>
                <div>
                  <dt>消息类型</dt>
                  <dd>{image ? (content.trim() ? '图片 + 文字' : '图片') : '文字'}</dd>
                </div>
                <div>
                  <dt>发送方式</dt>
                  <dd>{timing === 'scheduled' ? '定时发送 · 北京时间' : '立即发送'}</dd>
                </div>
              </dl>
              {targetSummary.length ? (
                <div className="target-summary">
                  {targetSummary.map((p) => (
                    <span key={p.name}>
                      {p.name}
                      <b>{p.count}</b>
                    </span>
                  ))}
                </div>
              ) : (
                <p>先选择目标社群，再创建发送任务。</p>
              )}
              <small>
                创建任务后，成功、失败和待核对会分别记录。未确认结果的消息不会自动重复发送。
              </small>
            </div>
          </aside>
        </div>
      </ActionForm>
    </Modal>
  );
}
function Announcements() {
  const [search, setSearch] = useSearchParams();
  const compose = search.get('compose') === '1';
  const tab = search.get('tab') ?? (search.get('delivery') ? 'deliveries' : 'announcements');
  const detail = search.get('delivery') ?? '';
  const query = search.get('q') ?? '';
  const statusFilter = search.get('status') ?? 'all';
  const [busy, setBusy] = useState('');
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    if (key === 'delivery' && value && !next.has('tab')) next.set('tab', tab);
    setSearch(next, { replace: key === 'q' });
  };
  const setCompose = (value: boolean) => change('compose', value ? '1' : '');
  const setDetail = (value: string) => change('delivery', value);
  const setTab = (value: string) => {
    const next = new URLSearchParams(search);
    next.set('tab', value);
    next.delete('delivery');
    setSearch(next);
  };
  const {
    data: rows,
    loading,
    error,
  } = useData<Data[]>(tab === 'announcements' ? '/announcements' : '/deliveries', true);
  const { refresh, toast, groups } = useApp();
  const matchesStatus = (row: Data, value: string) => {
    if (value === 'all') return true;
    const statuses: string[] =
      tab === 'deliveries' ? [row.status] : (row.deliveries ?? []).map((d: Data) => d.status);
    return value === 'pending'
      ? statuses.some((v) => ['pending', 'in_flight', 'accepted'].includes(v))
      : value === 'succeeded'
        ? !!statuses.length && statuses.every((v) => v === value)
        : statuses.includes(value);
  };
  const filteredRows = rows?.filter(
    (row) =>
      matchesStatus(row, statusFilter) &&
      `${row.title ?? ''} ${row.content ?? ''} ${row.conversation_name ?? ''} ${(row.deliveries ?? []).map((d: Data) => d.name).join(' ')}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  async function act(path: string) {
    if (busy) return;
    setBusy(path);
    try {
      await api(path, { method: 'POST' });
      refresh();
      toast('操作已提交');
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <Head
        eyebrow="PUBLISH WITH CONFIDENCE"
        title="群发与通知"
        description="发布官方通知、活动与广告，跟踪每个目标群的发送结果。"
      >
        <button className="btn primary" onClick={() => setCompose(true)}>
          <Plus size={17} />
          新建群发
        </button>
      </Head>
      <div className="card">
        <div className="tabs padded">
          <button
            className={tab === 'announcements' ? 'active' : ''}
            onClick={() => setTab('announcements')}
          >
            发布记录
          </button>
          <button
            className={tab === 'deliveries' ? 'active' : ''}
            onClick={() => setTab('deliveries')}
          >
            全部投递任务
          </button>
        </div>
        <div className="publish-toolbar">
          <div className="segmented" aria-label="筛选投递状态">
            {(
              [
                ['all', '全部'],
                ['pending', '待发送 / 执行中'],
                ['succeeded', '已成功'],
                ['failed', '失败'],
                ['unknown', '待核对'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={statusFilter === key ? 'active' : ''}
                aria-pressed={statusFilter === key}
                onClick={() => change('status', key)}
              >
                {label}
                <span>{rows?.filter((row) => matchesStatus(row, key)).length ?? 0}</span>
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索发布或投递记录"
              placeholder="搜索标题、内容或社群"
              value={query}
              onChange={(e) => change('q', e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="icon-btn"
                aria-label="清空投递搜索"
                onClick={() => change('q', '')}
              >
                <X size={14} />
              </button>
            )}
          </label>
        </div>
        <Loading loading={loading && !rows} error={error}>
          {filteredRows?.length ? (
            tab === 'announcements' ? (
              <div className="publish-list">
                {filteredRows.map((a) => (
                  <article key={a.id}>
                    <div className="publish-icon">
                      <Send size={20} />
                    </div>
                    <div className="publish-body">
                      <div>
                        <h3>{a.title}</h3>
                        <time>
                          {new Date(a.scheduled_at).getTime() > Date.now()
                            ? '计划发送'
                            : '发送时间'}{' '}
                          {date(a.scheduled_at)}
                        </time>
                      </div>
                      <p>{a.content.length > 240 ? `${a.content.slice(0, 240)}…` : a.content}</p>
                      {a.content.length > 240 && (
                        <details className="publish-full-text">
                          <summary>查看完整内容</summary>
                          <p>{a.content}</p>
                        </details>
                      )}
                      {a.image_asset_id && (
                        <a
                          href={mediaUrl(
                            `/api/v1/uploads/images/${encodeURIComponent(a.image_asset_id)}`,
                          )}
                          target="_blank"
                          rel="noreferrer"
                          className="broadcast-record-image"
                        >
                          <img
                            src={mediaUrl(
                              `/api/v1/uploads/images/${encodeURIComponent(a.image_asset_id)}`,
                            )}
                            alt="群发图片"
                            loading="lazy"
                          />
                        </a>
                      )}
                      <div className="delivery-chips">
                        {a.deliveries?.map((d: Data) => (
                          <button key={d.id} onClick={() => setDetail(d.id)}>
                            <span>
                              {d.name}
                              {d.is_demo ? ' · 演示' : ''}
                              {d.platform && <small>{labels[d.platform] ?? d.platform}</small>}
                            </span>
                            <Badge value={d.status} />
                          </button>
                        ))}
                      </div>
                    </div>
                    {a.deliveries?.some((d: Data) => d.status === 'pending') && (
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() => void act(`/announcements/${a.id}/cancel`)}
                      >
                        取消待发
                      </button>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>目标社群</th>
                      <th>动作</th>
                      <th>状态</th>
                      <th>创建时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <strong>{d.conversation_name}</strong>
                          {d.platform && (
                            <small className="block muted">
                              {labels[d.platform] ?? d.platform} · {d.conversation_external_id}
                            </small>
                          )}
                          {d.is_demo && <small className="block muted">演示任务</small>}
                        </td>
                        <td>
                          <span>{commandLabels[d.action] ?? d.action}</span>
                        </td>
                        <td>
                          <Badge value={d.status} />
                          {d.last_error && (
                            <small className="block error-text">{d.last_error}</small>
                          )}
                        </td>
                        <td>{date(d.created_at)}</td>
                        <td>
                          <button className="text-button" onClick={() => setDetail(d.id)}>
                            详情
                          </button>
                          {d.status === 'failed' &&
                            d.receipt?.error?.retryable &&
                            !d.review_ref?.purpose?.startsWith('qq-verification-') &&
                            new Date(d.expires_at).getTime() > Date.now() &&
                            groups.some(
                              (g) => g.id === d.conversation_id && g.sync_enabled !== false,
                            ) && (
                              <button
                                className="text-button"
                                disabled={!!busy}
                                onClick={() => void act(`/deliveries/${d.id}/retry`)}
                              >
                                重试
                              </button>
                            )}
                          {d.status === 'failed' &&
                            d.review_ref?.purpose?.startsWith('qq-verification-') && (
                              <Link
                                className="text-link"
                                to={`/groups/${d.conversation_id}?verification=${encodeURIComponent(d.review_ref.verification_id)}`}
                              >
                                前往验证处理
                              </Link>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : rows?.length ? (
            <div>
              <Empty
                icon={Search}
                title="没有符合条件的记录"
                text="调整关键词或状态筛选，查看其他发布结果。"
              />
              <div className="empty-action">
                <button
                  className="btn"
                  onClick={() => {
                    const next = new URLSearchParams(search);
                    next.delete('q');
                    next.delete('status');
                    setSearch(next, { replace: true });
                  }}
                >
                  重置筛选
                </button>
              </div>
            </div>
          ) : (
            <Empty
              icon={Send}
              title="准备好发布第一条通知了吗"
              text="选择目标社群并创建消息，投递进度会在这里实时更新。"
            />
          )}
        </Loading>
        <div className="table-foot">
          显示 {filteredRows?.length ?? 0} / {rows?.length ?? 0} 条记录
          <span>筛选基于最近 100 条记录 · 每 10 秒更新</span>
        </div>
      </div>
      <div className="info-box spaced">
        <CircleHelp size={17} />
        超时或断线后的不确定结果标记为“待核对”，不会自动重发。请先到目标平台核对，连接器可提交后续确认回执。
      </div>
      {compose && <Compose close={() => setCompose(false)} />}{' '}
      {detail && <DeliveryDetail id={detail} close={() => setDetail('')} />}
    </>
  );
}
function DeliveryDetail({ id, close }: { id: string; close: () => void }) {
  const { data, loading, error } = useData(`/deliveries/${id}`, true);
  return (
    <Modal title="投递任务详情" close={close}>
      <Loading loading={loading && !data} error={error}>
        {data && (
          <>
            <div className="detail-stats">
              <Badge value={data.status} />
              <span>
                {data.conversation_name}
                {data.is_demo ? ' · 演示' : ''}
                {data.platform ? ` · ${labels[data.platform] ?? data.platform}` : ''}
              </span>
            </div>
            <dl className="delivery-detail-facts">
              <div>
                <dt>操作</dt>
                <dd>{commandLabels[data.action] ?? data.action}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{date(data.created_at, true)}</dd>
              </div>
              <div>
                <dt>计划时间</dt>
                <dd>{date(data.due_at, true)}</dd>
              </div>
            </dl>
            <div className={`delivery-result-note ${data.status}`} role="status">
              <strong>
                {(
                  {
                    succeeded: '平台已确认操作成功',
                    failed: '任务执行失败',
                    unknown: '结果尚未确认，需要核对',
                    pending: '任务等待执行',
                    in_flight: '正在等待平台处理',
                    accepted: '平台已接收，等待最终结果',
                    cancelled: '任务已取消',
                  } as Data
                )[data.status] ?? data.status}
              </strong>
              <p>
                {data.last_error ||
                  (data.status === 'unknown'
                    ? '请先检查目标平台的实际记录，再在下方记录核对结果。此任务不会自动重发。'
                    : data.status === 'succeeded'
                      ? '可到目标平台查看实际消息或成员状态。'
                      : '')}
              </p>
            </div>
            {data.receipt?.result?.member && (
              <div className="info-box">
                成员 {data.receipt.result.member.user_id} · 群 {data.receipt.result.member.group_id}
                ：
                {
                  (
                    {
                      muted: '已禁言，直到手动解禁',
                      unmuted: '已解除单独禁言',
                      removed: '已移出本群',
                    } as Data
                  )[data.receipt.result.member.state]
                }
                <small className="block">
                  平台状态回读确认于 {date(data.receipt.result.member.verified_at, true)}
                </small>
              </div>
            )}
            {data.action === 'message.send' && (
              <div className="delivery-content-preview">
                {data.params.segments
                  .filter((part: Data) => part.type === 'text')
                  .map((part: Data, index: number) => (
                    <p key={index}>{part.text}</p>
                  ))}
                {data.params.segments
                  .filter(
                    (part: Data) =>
                      part.type === 'image' && /^upload-image-[a-f0-9]{64}$/.test(part.asset_id),
                  )
                  .map((part: Data) => (
                    <a
                      key={part.asset_id}
                      href={mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(part.asset_id)}`)}
                      target="_blank"
                      rel="noreferrer"
                      className="broadcast-record-image"
                    >
                      <img
                        src={mediaUrl(
                          `/api/v1/uploads/images/${encodeURIComponent(part.asset_id)}`,
                        )}
                        alt="本次投递图片"
                      />
                    </a>
                  ))}
              </div>
            )}
            {data.status === 'unknown' && <ManualReconcile job={data} />}
            <details className="delivery-technical">
              <summary>执行记录与任务编号</summary>
              <label>
                任务 ID<code className="code-line">{data.id}</code>
              </label>
              {data.attempts.length ? (
                data.attempts.map((a: Data) => (
                  <div className="attempt" key={a.id}>
                    <div>
                      第 {a.number} 次 <Badge value={a.status} />
                      <time>{date(a.created_at)}</time>
                    </div>
                    <code>{a.id}</code>
                    {a.receipt && <pre>{JSON.stringify(a.receipt, null, 2)}</pre>}
                  </div>
                ))
              ) : (
                <p className="muted">任务尚未开始执行。</p>
              )}
            </details>
          </>
        )}
      </Loading>
    </Modal>
  );
}

function BlacklistTable({ act }: { act: (path: string, method: string) => Promise<void> }) {
  const { data: rows, loading, error } = useData<Data[]>('/blacklists', true);
  return (
    <Loading loading={loading && !rows} error={error}>
      {rows?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>成员 ID</th>
                <th>所属社群</th>
                <th>原因</th>
                <th>有效期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td>
                    <code>{v.user_id}</code>
                  </td>
                  <td>{v.conversation_name}</td>
                  <td>{v.reason}</td>
                  <td>{v.expires_at ? date(v.expires_at) : '长期有效'}</td>
                  <td>
                    <button
                      className="text-button danger"
                      onClick={() => void act(`/blacklists/${v.id}`, 'DELETE')}
                    >
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          icon={ShieldCheck}
          title="黑名单为空"
          text="添加成员 ID 后，该成员后续发言会被规则引擎拦截。"
        />
      )}
    </Loading>
  );
}
function Moderation() {
  const [tab, setTab] = useState('verifications'),
    [add, setAdd] = useState(false);
  const { refresh, toast, groups } = useApp();
  async function act(path: string, method: string) {
    try {
      await api(path, { method });
      refresh();
      toast('操作完成');
    } catch (err: any) {
      toast(err.message, true);
    }
  }
  return (
    <>
      <Head
        eyebrow="KEEP THE CONVERSATION HEALTHY"
        title="安全与验证"
        description="审核待验证成员，管理群级黑名单。广告规则在各群详情中设置。"
      >
        <button className="btn primary" onClick={() => setAdd(true)}>
          <Plus size={17} />
          添加黑名单
        </button>
      </Head>
      <div className="info-box spaced">
        <ShieldCheck size={18} />
        <span>
          规则按群独立生效。当前 {groups.filter((g) => g.policy.mode === 'enforce').length}{' '}
          个群开启自动处理，
          {groups.filter((g) => g.policy.verification_enabled).length} 个群开启活人验证。
          <Link to="/groups"> 前往设置 →</Link>
        </span>
      </div>
      <div className="card">
        <div className="tabs padded">
          <button
            className={tab === 'verifications' ? 'active' : ''}
            onClick={() => setTab('verifications')}
          >
            成员验证
          </button>
          <button
            className={tab === 'blacklists' ? 'active' : ''}
            onClick={() => setTab('blacklists')}
          >
            群黑名单
          </button>
        </div>
        {tab === 'verifications' ? <VerificationList /> : <BlacklistTable act={act} />}
      </div>
      {add && (
        <Modal
          title="添加群黑名单"
          description="仅对选中的群生效，后续发言将提交自动处理任务。"
          close={() => setAdd(false)}
        >
          <ActionForm
            label="加入黑名单"
            cancel={() => setAdd(false)}
            onSubmit={async (f) => {
              await api('/blacklists', {
                method: 'POST',
                body: {
                  conversation_id: f.get('conversation_id'),
                  user_id: f.get('user_id'),
                  reason: f.get('reason'),
                  ...(f.get('expires')
                    ? { expires_at: new Date(String(f.get('expires'))).toISOString() }
                    : {}),
                },
              });
              setAdd(false);
              toast('已加入群黑名单');
            }}
          >
            <label>
              目标社群
              <GroupSelect />
            </label>
            <label>
              平台成员 ID
              <input required name="user_id" maxLength={256} placeholder="请填写成员的稳定 ID" />
            </label>
            <label>
              原因
              <input required name="reason" maxLength={500} />
            </label>
            <label>
              过期时间（留空长期有效）
              <input type="datetime-local" name="expires" />
            </label>
          </ActionForm>
        </Modal>
      )}
    </>
  );
}

function Integrations() {
  const { data: projects, loading, error } = useData<Data[]>('/projects');
  const { data: routes } = useData<Data[]>('/routes');
  const [add, setAdd] = useState(false),
    [route, setRoute] = useState(false),
    [secret, setSecret] = useState('');
  const { refresh, toast } = useApp();
  async function act(path: string, method: string) {
    try {
      await api(path, { method });
      refresh();
      toast('操作已完成');
    } catch (err: any) {
      toast(err.message, true);
    }
  }
  return (
    <>
      <Head
        eyebrow="BUILT TO CONNECT"
        title="项目与同步"
        description="让其他项目发送社群消息，或将你的聊天服务接入统一管理。"
      >
        <button className="btn primary" onClick={() => setAdd(true)}>
          <Plus size={17} />
          创建项目 Key
        </button>
      </Head>
      <div className="card">
        <div className="card-head">
          <div>
            <h2>项目 API Key</h2>
            <p>按目标社群和操作授权，可随时撤销。</p>
          </div>
          <KeyRound size={20} />
        </div>
        <Loading loading={loading && !projects} error={error}>
          {projects?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>Key 前缀</th>
                    <th>权限</th>
                    <th>最近使用</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                        <small className="block muted">
                          授权 {p.conversation_ids.length} 个社群
                        </small>
                      </td>
                      <td>
                        <code>{p.prefix}…</code>
                      </td>
                      <td>
                        <div className="scope-tags">
                          {p.scopes.map((scope: string) => (
                            <span key={scope}>{scope}</span>
                          ))}
                        </div>
                      </td>
                      <td>{date(p.last_used_at)}</td>
                      <td>
                        {p.revoked_at ? (
                          <Badge value="cancelled">已撤销</Badge>
                        ) : (
                          <button
                            className="text-button danger"
                            onClick={() => void act(`/projects/${p.id}/revoke`, 'POST')}
                          >
                            撤销授权
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={KeyRound}
              title="为你的其他项目开放接口"
              text="创建受限的 API Key，将项目通知发送到指定社群。"
            />
          )}
        </Loading>
      </div>
      <div className="card spaced">
        <div className="card-head">
          <div>
            <h2>群消息同步</h2>
            <p>将审核通过的新文本消息，从来源群单向发送到目标群。</p>
          </div>
          <button className="btn" onClick={() => setRoute(true)}>
            <Plus size={16} />
            添加路线
          </button>
        </div>
        {routes?.length ? (
          <div className="route-list">
            {routes.map((r) => (
              <div key={r.id}>
                <span>
                  <MessageSquare size={18} />
                  {r.source_name}
                </span>
                <ArrowRight size={20} />
                <span>{r.target_name}</span>
                <Badge value={r.enabled ? 'online' : 'paused'}>
                  {r.enabled ? '已启用' : '已停用'}
                </Badge>
                <button
                  className="icon-btn danger"
                  aria-label="删除同步路线"
                  onClick={() => void act(`/routes/${r.id}`, 'DELETE')}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={Shuffle}
            title="让讨论在社群间流动"
            text="添加同步路线后，新消息通过来源和目标群规则检查才会发送。"
          />
        )}
        <div className="card-note">
          第一版支持单跳文本同步，机器人发出的消息不再转发。编辑与删除不传播；媒体文件暂不发送。
        </div>
      </div>
      <div className="card integration-doc">
        <div>
          <Webhook size={24} />
          <h2>接入你自己的聊天项目</h2>
          <p>
            创建自定义连接账号，实现群发现、命令接收、签名事件、心跳与执行回执。你的聊天群会与其他平台一起出现在管理台。
          </p>
          <Link className="text-link" to="/accounts">
            创建自有聊天连接 <ArrowRight size={16} />
          </Link>
        </div>
        <div>
          <h3>发送项目通知</h3>
          <pre>{`POST /api/v1/messages\nAuthorization: Bearer qsb_…\nIdempotency-Key: your-unique-request-id\nContent-Type: application/json\n\n{\n  "conversation_ids": ["管理台中的群 ID"],\n  "text": "你的项目通知"\n}`}</pre>
          <p className="muted">
            返回 delivery_ids，使用 GET /api/v1/deliveries/:id 查询结果。群 ID 可通过 GET
            /api/v1/conversations 获取。
          </p>
        </div>
      </div>
      {add && (
        <Modal
          title="创建项目 API Key"
          description="仅授权需要的社群与权限。撤销后未执行任务将一并取消。"
          close={() => setAdd(false)}
        >
          <ActionForm
            label="创建密钥"
            cancel={() => setAdd(false)}
            onSubmit={async (f) => {
              const ids = f.getAll('groups'),
                scopes = f.getAll('scopes');
              if (!ids.length || !scopes.length) throw new Error('请至少选择一个社群和一个权限');
              const p = await api('/projects', {
                method: 'POST',
                body: { name: f.get('name'), conversation_ids: ids, scopes },
              });
              setAdd(false);
              setSecret(p.key);
            }}
          >
            <label>
              项目名称
              <input required name="name" maxLength={100} placeholder="例如：我的行情聊天项目" />
            </label>
            <label>授权社群</label>
            <GroupChoices />
            <label>操作权限</label>
            <div className="scope-choices">
              {[
                ['conversations.read', '读取群信息'],
                ['messages.send', '发送通知'],
                ['deliveries.read', '查询本项目投递'],
                ['lotteries.write', '创建抽奖'],
              ].map(([key, name]) => (
                <label key={key} className="check-row">
                  <input type="checkbox" name="scopes" value={key} />
                  {name}
                </label>
              ))}
            </div>
          </ActionForm>
        </Modal>
      )}
      {route && (
        <Modal title="添加消息同步路线" close={() => setRoute(false)}>
          <ActionForm
            label="启用同步"
            cancel={() => setRoute(false)}
            onSubmit={async (f) => {
              await api('/routes', {
                method: 'POST',
                body: { source_id: f.get('source'), target_id: f.get('target'), enabled: true },
              });
              setRoute(false);
              toast('同步路线已启用');
            }}
          >
            <label>
              来源社群
              <GroupSelect name="source" />
            </label>
            <label>
              目标社群
              <GroupSelect name="target" />
            </label>
            <div className="info-box">
              启用后开始同步新消息。请确认目标群允许显示来源群名称与成员 ID。
            </div>
          </ActionForm>
        </Modal>
      )}
      {secret && <Secret value={secret} close={() => setSecret('')} />}
    </>
  );
}

function Lotteries() {
  const { data: rows, loading, error } = useData<Data[]>('/lotteries', true);
  const [add, setAdd] = useState(false);
  const { refresh, toast } = useApp();
  return (
    <>
      <Head
        eyebrow="A LITTLE LUCK, A STRONGER COMMUNITY"
        title="社群抽奖"
        description="创建群内报名活动，到期自动开奖，保留参与快照与结果。"
      >
        <button className="btn primary" onClick={() => setAdd(true)}>
          <Plus size={17} />
          创建抽奖
        </button>
      </Head>
      <Loading loading={loading && !rows} error={error}>
        {rows?.length ? (
          <div className="lottery-grid">
            {rows.map((l) => (
              <section className="card lottery-card" key={l.id}>
                <div>
                  <span className="gift-icon">
                    <Gift size={24} />
                  </span>
                  <Badge value={l.status} />
                </div>
                <h2>{l.title}</h2>
                <p className="muted">{l.conversation_name}</p>
                <div className="lottery-numbers">
                  <span>
                    <strong>{l.entries_count}</strong>报名成员
                  </span>
                  <span>
                    <strong>{l.winners_count}</strong>中奖名额
                  </span>
                </div>
                <div className="lottery-deadline">
                  <Clock3 size={15} />
                  截止 {date(l.closes_at, true)}
                </div>
                {l.status === 'drawn' ? (
                  <div className="winners">
                    <strong>中奖成员</strong>
                    <p>{l.winners.length ? l.winners.join('、') : '无符合条件的参与者'}</p>
                  </div>
                ) : (
                  <>
                    <code className="code-line">/join {l.id}</code>
                    <button
                      className="btn wide"
                      disabled={Date.parse(l.closes_at) > Date.now()}
                      onClick={() =>
                        void api(`/lotteries/${l.id}/draw`, { method: 'POST' })
                          .then(() => {
                            refresh();
                            toast('开奖完成');
                          })
                          .catch((err) => toast(err.message, true))
                      }
                    >
                      到期后核对 / 开奖
                    </button>
                  </>
                )}
              </section>
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty
              icon={Gift}
              title="给社群带来一点惊喜"
              text="创建抽奖后，机器人会在群内发送报名指令，到期自动抽取符合条件的成员。"
            />
          </div>
        )}
      </Loading>
      <div className="info-box spaced">
        <Gift size={18} />
        开奖使用加密随机数，结果固定且不可重抽。黑名单、已退群或未通过所需验证的成员不参与。奖品由管理员线下发放。
      </div>
      {add && (
        <Modal
          title="创建社群抽奖"
          description="报名指令会发送到选中的群。成员回复指令即可报名。"
          close={() => setAdd(false)}
        >
          <ActionForm
            label="创建并发布报名"
            cancel={() => setAdd(false)}
            onSubmit={async (f) => {
              await api('/lotteries', {
                method: 'POST',
                body: {
                  conversation_id: f.get('conversation_id'),
                  title: f.get('title'),
                  winners_count: Number(f.get('count')),
                  closes_at: new Date(String(f.get('closes'))).toISOString(),
                },
              });
              setAdd(false);
              toast('抽奖已创建，报名通知已加入队列');
            }}
          >
            <label>
              活动名称
              <input required name="title" maxLength={120} />
            </label>
            <label>
              目标社群
              <GroupSelect />
            </label>
            <div className="form-grid">
              <label>
                中奖名额
                <input type="number" required name="count" defaultValue={1} min={1} max={100} />
              </label>
              <label>
                报名截止时间
                <input type="datetime-local" required name="closes" />
              </label>
            </div>
          </ActionForm>
        </Modal>
      )}
    </>
  );
}
const actionLabel = (value: string) =>
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
function Audit() {
  const { data: rows, loading, error } = useData<Data[]>('/audit', true);
  const [q, setQ] = useState('');
  return (
    <>
      <Head
        eyebrow="EVERY ACTION, ACCOUNTED FOR"
        title="操作日志"
        description="查看最近 200 条管理操作、规则命中和任务执行记录。"
      />
      <div className="card">
        <div className="filter-bar">
          <h2>工作空间动态</h2>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索操作日志"
              placeholder="搜索动作或操作者"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
        </div>
        <Loading loading={loading && !rows} error={error}>
          {rows?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>动作</th>
                    <th>操作者</th>
                    <th>时间</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {rows
                    .filter((a) =>
                      `${a.actor} ${a.action} ${actionLabel(a.action)}`
                        .toLowerCase()
                        .includes(q.toLowerCase()),
                    )
                    .map((a) => (
                      <tr key={a.id}>
                        <td>
                          <strong>{actionLabel(a.action)}</strong>
                          <small className="block muted">{a.action}</small>
                        </td>
                        <td>{a.actor}</td>
                        <td>{date(a.created_at, true)}</td>
                        <td>
                          <details>
                            <summary>查看详情</summary>
                            <pre>{JSON.stringify({ target: a.target, ...a.detail }, null, 2)}</pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={Activity}
              title="还没有操作记录"
              text="开始管理社群后，重要操作将记录在这里。"
            />
          )}
        </Loading>
      </div>
    </>
  );
}

function ManualReconcile({ job }: { job: Data }) {
  const { toast } = useApp();
  const [outcome, setOutcome] = useState('succeeded');
  return (
    <div className="spaced">
      <h3>人工核对结果</h3>
      <ActionForm
        label="记录核对结果"
        onSubmit={async (f) => {
          await api(`/deliveries/${job.id}/reconcile`, {
            method: 'POST',
            body: {
              outcome,
              evidence: f.get('evidence'),
              ...(f.get('message_id') ? { message_id: f.get('message_id') } : {}),
            },
          });
          toast('核对结果已记录');
        }}
      >
        <label>
          平台实际结果
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="succeeded">确认已执行成功</option>
            <option value="no_effect">确认完全未执行，可重新尝试</option>
          </select>
        </label>
        {outcome === 'succeeded' && job.action === 'message.send' && (
          <label>
            平台消息 ID
            <input name="message_id" required maxLength={256} />
          </label>
        )}
        <label>
          核对依据
          <textarea
            name="evidence"
            required
            minLength={10}
            maxLength={1000}
            rows={3}
            placeholder="记录核对的平台记录、时间及结果，至少 10 个字符"
          />
        </label>
        <label className="check-row">
          <input type="checkbox" required />
          <span>我已检查目标平台实际记录，确认以上结果</span>
        </label>
      </ActionForm>
    </div>
  );
}
