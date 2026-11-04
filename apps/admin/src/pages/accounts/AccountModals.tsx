import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from '../../api';
import { ActionForm, Modal, date, n, useApp } from '../../console/shared';
import type { Data } from '../../console/shared';

export function BinanceGroupsModal({
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
      !initial && data && JSON.stringify([...selected].sort()) !== JSON.stringify([...data.group_ids].sort());
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
            setSelected((current) => current.filter((id) => !visible.some((g: Data) => g.id === id)))
          }
        >
          取消当前结果
        </button>
        <label>
          <input type="checkbox" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} />
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
                busy || (!selected.includes(group.id) && (selected.length >= limit || group.unavailable))
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

export function BinanceAuthenticationModal({
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
                    ...(form.get('device_id') ? { device_id: String(form.get('device_id')).trim() } : {}),
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
                支持 JWT 和不透明令牌，格式本身不代表验证成功。验证失败会保留当前连接；验证过程不发送群消息。
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
