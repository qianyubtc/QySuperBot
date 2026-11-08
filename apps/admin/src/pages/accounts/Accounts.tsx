import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import { api } from '../../api';
import {
  AccountBadge,
  ActionForm,
  Empty,
  Head,
  Modal,
  PlatformIcon,
  Secret,
  accountState,
  date,
  labels,
  useApp,
  useData,
} from '../../console/shared';
import type { Data } from '../../console/shared';
import BinanceLogin from '../../BinanceLogin';
import BinanceConnectionStatus from '../../BinanceConnectionStatus';
import QQLogin from '../../QQLogin';
import { BinanceAuthenticationModal, BinanceGroupsModal } from './AccountModals';
import './accounts.css';

export default function Accounts() {
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
            (result.connection?.state === 'connected' || result.connection?.state === 'awaiting_groups')
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
    <div className="page accounts">
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
      <div className="connection-overview">
        <div>
          <span className="connection-overview-icon">
            <Radio size={18} />
          </span>
          <div>
            <h2>
              {accounts.filter(needsAttention).length
                ? `${accounts.filter(needsAttention).length} 个连接需要处理`
                : accounts.length
                  ? '社群连接尽在掌握'
                  : '先连接你的第一个社群'}
            </h2>
            <p>
              {accounts.filter(needsAttention).length
                ? '优先恢复异常账号，原来的同步群选择会保留。'
                : '添加账号 → 选择同步社群 → 开始收发与管理'}
            </p>
          </div>
        </div>
        <button
          className="btn"
          onClick={() => setStatusFilter(statusFilter === 'attention' ? 'all' : 'attention')}
        >
          {statusFilter === 'attention' ? '查看全部连接' : '查看需要处理'}
          <ArrowRight size={16} />
        </button>
      </div>
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
            <button className="icon-btn" type="button" aria-label="清空账号搜索" onClick={() => setQuery('')}>
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
          {accountsCheckedAt ? ` 最近更新 ${date(accountsCheckedAt)}` : accountsError ? '' : ' 正在获取状态…'}
        </span>
        {accountsError && (
          <button className="text-button" onClick={refresh}>
            重新加载状态
          </button>
        )}
      </div>
      <div className="account-grid">
        {filteredAccounts.map((a) => (
          <section
            key={a.id}
            className={`card account-card ${needsAttention(a) ? 'account-needs-attention' : ''}`}
          >
            <div className="account-card-top">
              <PlatformIcon value={a.is_demo ? 'demo' : a.platform} large />
              <div className="account-title">
                <h2>{a.name}</h2>
                <small>{a.is_demo ? '本地演示' : labels[a.platform]}</small>
              </div>
              <AccountBadge account={a} />
            </div>
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
              <div className={`account-state-note ${a.status === 'online' ? 'healthy' : 'needs-check'}`}>
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
                    {(a.status !== 'online' && a.last_error) ||
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
                  {busy === a.id ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                  {a.status === 'paused' ? '恢复连接' : a.kind === 'binance' ? '检查连接' : '连接 / 刷新'}
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
                  <button
                    className={`btn ${accountState(a) === 'online' ? 'primary' : ''}`}
                    onClick={() => setBinanceGroups(a.id)}
                  >
                    <Settings2 size={15} />
                    管理同步群
                  </button>
                )}
                {a.kind === 'binance' && (a.connection?.needs_relogin || a.status !== 'online') && (
                  <button
                    className="btn primary"
                    disabled={
                      busy === a.id || a.status === 'paused' || a.connection?.login_available === false
                    }
                    title={
                      a.connection?.login_available === false
                        ? '此服务器未启用登录窗口，请在连接方式更新凭据'
                        : undefined
                    }
                    onClick={() => void openBinanceLogin(a)}
                  >
                    {busy === a.id ? <LoaderCircle size={15} className="spin" /> : <ExternalLink size={15} />}
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
                  {a.kind === 'binance' && a.status === 'online' && !a.connection?.needs_relogin && (
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
                        import.meta.env.MODE === 'demo' ? void openBinanceLogin(a) : setBinanceAuth(a)
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
            <Plus size={20} />
          </span>
          <h3>连接新平台</h3>
          <p>Telegram · QQ · 币安聊天 · 自有聊天</p>
        </button>
      </div>
      {!filteredAccounts.length && accounts.length > 0 && (
        <div className="card">
          <Empty icon={Search} title="没有符合条件的账号" text="调整关键词或状态筛选，查看其他连接。" />
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
      <details className="card roadmap connection-help">
        <summary>
          <CircleHelp size={18} />
          平台接入与能力说明
          <ChevronDown size={16} />
        </summary>
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
      </details>
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
                  JSON.stringify(kind === 'binance' ? result.binance_bridge : result.credentials, null, 2),
                );
            }}
          >
            <div className="connection-type-grid" role="group" aria-label="选择连接平台">
              {[
                ['telegram', 'Telegram', '官方 Bot Token'],
                ['qq-local', 'QQ 扫码', localQQ?.available ? 'VPS 扫码登录' : '服务器未配置'],
                ['binance', '币安聊天', '服务器登录 / 桥接'],
                ['custom', '自有聊天', '签名 HTTP 接入'],
              ].map(([key, label, hint]) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={kind === key}
                  className={kind === key ? 'selected' : ''}
                  disabled={key === 'qq-local' && !localQQ?.available}
                  onClick={() => setKind(key!)}
                >
                  <PlatformIcon value={key === 'qq-local' ? 'qq' : key!} large />
                  <strong>{label}</strong>
                  <small>{hint}</small>
                  {kind === key && <CheckCircle2 size={16} className="type-check" />}
                </button>
              ))}
            </div>
            <details className="advanced-connection">
              <summary>已有 OneBot 服务？使用手动桥接</summary>
              <button
                type="button"
                className={`btn ${kind === 'qq' ? 'primary' : ''}`}
                aria-pressed={kind === 'qq'}
                onClick={() => setKind('qq')}
              >
                QQ · OneBot HTTP 桥接
              </button>
            </details>
            <label>
              连接名称
              <input name="name" required maxLength={100} placeholder="例如：千羽官方机器人" />
            </label>
            {import.meta.env.MODE !== 'demo' &&
              kind !== 'telegram' &&
              kind !== 'binance' &&
              kind !== 'qq-local' && (
                <label>
                  连接器地址
                  <input name="endpoint" type="url" required placeholder="https://chat.example.com" />
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
                  placeholder={kind === 'telegram' ? '从 BotFather 获取' : '用于访问 OneBot HTTP 服务'}
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
              : '这是服务器上的独立浏览器，请在画面内由你本人完成登录和验证。连接后它会保持运行并负责同步，关闭窗口不影响同步。'
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
              toast(warning || '币安登录验证通过，服务器浏览器已开始同步，原群选择已保留', !!warning);
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
    </div>
  );
}
