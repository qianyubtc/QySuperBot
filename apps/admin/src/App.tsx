import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity,
  Bot,
  CheckCircle2,
  ExternalLink,
  Gift,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  ShieldX,
  Sun,
  Users,
  Webhook,
  X,
} from 'lucide-react';
import { api, RequestError, setCsrf } from './api';
import Inbox from './Inbox';
import { QuickNavigate } from './ConsoleTools';
import { Context, Empty, Modal, accountState, date } from './console/shared';
import type { Data } from './console/shared';
import { useConsoleTheme } from './ui/theme';
import Auth from './pages/Auth';
import Overview from './pages/Overview';
import GroupPage from './pages/group/GroupPage';
import Groups from './pages/groups/Groups';
import Broadcasts from './pages/broadcasts/Broadcasts';
import Safety from './pages/safety/Safety';
import Integrations from './pages/integrations/Integrations';
import Lotteries from './pages/more/Lotteries';
import Audit from './pages/more/Audit';
import Accounts from './pages/accounts/Accounts';
import './ui/theme.css';
import './ui/components.css';
import './ui/layout.css';

const nav = [
  { path: '/dashboard', label: '概览', icon: LayoutDashboard, section: '' },
  { path: '/inbox', label: '工作台', icon: MessagesSquare, section: '' },
  { path: '/groups', label: '群组', icon: Users, section: '' },
  { path: '/announcements', label: '群发', icon: Send, section: '' },
  { path: '/moderation', label: '安全中心', icon: ShieldCheck, section: '' },
  { path: '/accounts', label: '连接账号', icon: Radio, section: '连接' },
  { path: '/integrations', label: '接口与同步', icon: Webhook, section: '连接' },
  { path: '/lotteries', label: '社群抽奖', icon: Gift, section: '更多' },
  { path: '/audit', label: '操作日志', icon: Activity, section: '更多' },
];
const dock = ['/inbox', '/groups', '/announcements', '/accounts'];
export default function App() {
  const [theme, setTheme] = useConsoleTheme();
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
  const [compactNav, setCompactNav] = useState(() => {
    try {
      return localStorage.getItem('superbot:compact-nav') === 'true';
    } catch {
      return false;
    }
  });
  const sidebar = useRef<HTMLElement>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [smallScreen, setSmallScreen] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const location = useLocation();
  useEffect(() => {
    try {
      localStorage.setItem('superbot:compact-nav', String(compactNav));
    } catch {
      /* Optional preference. */
    }
  }, [compactNav]);
  useEffect(() => {
    if (!user || !mobile || !smallScreen) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebar.current?.querySelector<HTMLElement>('a, button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? [],
      ).filter((item) => item.getClientRects().length);
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [mobile, smallScreen, user]);
  useEffect(() => {
    if (!location.pathname.startsWith('/inbox')) window.scrollTo(0, 0);
  }, [location.pathname]);
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
            controller.signal.aborted ? '连接状态读取超时，请检查后台网络后重试' : (error as Error).message,
          );
      } finally {
        clearTimeout(timeout);
        if (pending === controller) pending = null;
      }
    };
    void loadAccounts();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadAccounts();
    }, 10_000);
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
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
  const ThemeIcon = theme === 'dark' ? Sun : Moon;
  const themeButton = (
    <button
      className="icon-btn"
      aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
      title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      <ThemeIcon size={17} />
    </button>
  );
  if (fatal)
    return (
      <div className="console">
        <div className="auth-page">
          <div className="auth-state">
            <span className="brand-mark">
              <Bot size={20} />
            </span>
            <h1>服务暂时无法连接</h1>
            <p>{fatal}</p>
            <button className="btn primary" onClick={() => window.location.reload()}>
              <RefreshCw size={15} />
              重新连接
            </button>
          </div>
        </div>
      </div>
    );
  if (user === undefined || !state)
    return (
      <div className="console">
        <div className="auth-page">
          <LoaderCircle className="spin" />
        </div>
      </div>
    );
  if (!user)
    return (
      <div className="console">
        <Auth
          setup={state.setup_required}
          needsToken={state.setup_token_required}
          themeButton={themeButton}
          done={(me) => {
            setCsrf(me.csrf);
            setUser(me);
            setState({ setup_required: false });
          }}
        />
      </div>
    );
  const current = nav.find((v) =>
    v.path === '/dashboard' ? location.pathname === '/dashboard' : location.pathname.startsWith(v.path),
  );
  const pendingVerifications = groups.reduce((sum, g) => sum + Number(g.pending_verifications ?? 0), 0);
  const attention =
    !!accountsError || accounts.some((a) => !a.is_demo && !['online', 'paused'].includes(accountState(a)));
  const environment =
    import.meta.env.MODE === 'demo'
      ? '单机演示'
      : ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
        ? '本地环境'
        : '生产环境';
  return (
    <Context.Provider
      value={{ groups, accounts, revision, refresh, toast, accountsError, accountsCheckedAt }}
    >
      <div
        className={`console shell ${mobile ? 'menu-open' : ''} ${compactNav ? 'nav-compact' : ''} ${location.pathname.startsWith('/inbox') ? 'is-inbox' : ''}`}
      >
        <a className="skip-link" href="#workspace-main">
          跳到页面内容
        </a>
        {mobile && <button className="nav-scrim" aria-label="关闭菜单" onClick={() => setMobile(false)} />}
        <aside
          ref={sidebar}
          className="sidebar"
          aria-label="主导航"
          inert={smallScreen && !mobile}
          aria-hidden={smallScreen && !mobile}
        >
          <button
            className="icon-btn nav-mobile-close"
            aria-label="关闭主导航"
            onClick={() => setMobile(false)}
          >
            <X size={18} />
          </button>
          <Link to="/dashboard" className="brand" aria-label="千羽 Superbot 概览">
            <span className="brand-mark">
              <Bot size={18} />
            </span>
            <span>
              千羽 Superbot<small>COMMUNITY CONSOLE</small>
            </span>
          </Link>
          <nav>
            {nav.map(({ path, label, icon: Icon, section }, index) => (
              <Fragment key={path}>
                {section && section !== nav[index - 1]?.section && <div className="nav-label">{section}</div>}
                <NavLink
                  to={path}
                  end={path === '/dashboard'}
                  title={compactNav ? label : undefined}
                  aria-label={label}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                  {path === '/groups' && groups.length > 0 && <b>{groups.length}</b>}
                  {path === '/moderation' && pendingVerifications > 0 && (
                    <b className="alert" title={`${pendingVerifications} 位成员待验证`}>
                      {pendingVerifications}
                    </b>
                  )}
                </NavLink>
              </Fragment>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <Link to="/accounts" className="system-state" title="查看连接账号">
              <span className={`dot ${attention ? 'warning' : 'online'}`} />
              <span>
                {accountsError
                  ? '连接状态更新异常'
                  : accountsCheckedAt
                    ? `${accounts.filter((a) => accountState(a) === 'online').length}/${accounts.length} 个账号在线`
                    : '正在读取连接状态'}
                <small>{accountsCheckedAt ? `更新于 ${date(accountsCheckedAt)}` : '请稍候'}</small>
              </span>
            </Link>
            <div className="profile">
              <span className="avatar sm">{(user.name ?? user.username ?? '千').slice(0, 1)}</span>
              <div>
                {user.name ?? user.username}
                <small>管理员</small>
              </div>
              <button
                className="icon-btn sm"
                aria-label={compactNav ? '展开导航栏' : '收起导航栏'}
                title={compactNav ? '展开导航栏' : '收起导航栏'}
                onClick={() => setCompactNav((value) => !value)}
              >
                {compactNav ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
              <button
                className="icon-btn sm"
                aria-label="退出登录"
                title="退出登录"
                onClick={() =>
                  import.meta.env.MODE === 'demo'
                    ? window.location.assign('/')
                    : void api('/auth/logout', { method: 'POST' }).then(() => {
                        setCsrf('');
                        setUser(null);
                      })
                }
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </aside>
        <div className="main-shell" inert={smallScreen && mobile}>
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-btn mobile-menu"
                onClick={() => setMobile(true)}
                aria-label="打开菜单"
                aria-expanded={mobile}
              >
                <Menu size={19} />
              </button>
              <strong>{current?.label ?? '群详情'}</strong>
            </div>
            <div className="topbar-actions">
              <button
                className="quick-open"
                onClick={() => setQuickOpen(true)}
                title="快速查找页面或社群（Ctrl / ⌘ + K）"
              >
                <Search size={15} />
                <span>搜索群、页面…</span>
                <kbd>⌘K</kbd>
              </button>
              <span className="environment" title="当前运行环境">
                <span />
                {environment}
              </span>
              <button
                className="icon-btn hide-mobile"
                aria-label="刷新数据"
                title="刷新数据"
                onClick={() => {
                  refresh();
                  toast('已刷新');
                }}
              >
                <RefreshCw size={16} />
              </button>
              <Link to="/" className="icon-btn hide-mobile" aria-label="查看产品官网" title="产品官网">
                <ExternalLink size={16} />
              </Link>
              {themeButton}
            </div>
          </header>
          <main id="workspace-main" tabIndex={-1}>
            <Routes>
              <Route path="/dashboard" element={<Overview />} />
              <Route path="/groups" element={<Groups />} />
              <Route path="/groups/:id" element={<GroupPage />} />
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
              <Route path="/moderation" element={<Safety />} />
              <Route path="/announcements" element={<Broadcasts />} />
              <Route path="/lotteries" element={<Lotteries />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/audit" element={<Audit />} />
              <Route
                path="*"
                element={
                  <div className="page">
                    <Empty title="页面不存在" text="请通过左侧导航继续操作。" />
                  </div>
                }
              />
            </Routes>
          </main>
        </div>
        <nav className="mobile-dock" aria-label="常用页面" inert={smallScreen && mobile}>
          {nav
            .filter((item) => dock.includes(item.path))
            .map(({ path, label, icon: Icon }) => (
              <NavLink key={path} to={path}>
                <Icon size={19} />
                <span>{label}</span>
              </NavLink>
            ))}
          <button onClick={() => setMobile(true)} aria-label="打开全部功能">
            <Menu size={19} />
            <span>更多</span>
          </button>
        </nav>
        {notice && (
          <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>
            {notice.error ? <ShieldX size={17} /> : <CheckCircle2 size={17} />} {notice.text}
            <button className="icon-btn sm" aria-label="关闭提示" onClick={() => setNotice(undefined)}>
              <X size={14} />
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
