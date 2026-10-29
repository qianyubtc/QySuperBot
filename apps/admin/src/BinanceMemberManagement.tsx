import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import './member-management.css';
type Data = Record<string, any>;
const names: Record<string, string> = { mute: '禁言成员', unmute: '解除单独禁言', remove: '踢出本群' };
const roles: Record<number, string> = { 0: '普通成员', 1: '管理员', 2: '子管理员', 3: '群主' };
const statuses: Record<string, string> = {
  pending: '等待处理',
  in_flight: '处理中',
  accepted: '平台已接收',
  succeeded: '处理成功',
  failed: '处理失败',
  unknown: '结果待核对',
  cancelled: '已取消',
};
const valid = (value: string) => /^[1-9]\d{0,18}$/.test(value) && Number.isSafeInteger(Number(value));
export default function BinanceMemberManagement({ id, member }: { id: string; member?: string | null }) {
  const [user, setUser] = useState(member ?? '');
  const [selected, setSelected] = useState(valid(member ?? '') ? member! : '');
  const [action, setAction] = useState('mute');
  const [reason, setReason] = useState('');
  const [data, setData] = useState<Data>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [confirm, setConfirm] = useState<{ user_id: string; action: string; reason: string }>();
  const serial = useRef(0),
    lock = useRef(false),
    request = useRef({ body: '', key: '' });
  useEffect(() => {
    setUser(member ?? '');
    setSelected(valid(member ?? '') ? member! : '');
    setConfirm(undefined);
    setData(undefined);
  }, [id, member]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const token = ++serial.current;
      setLoading(true);
      try {
        const value = await api(
          `/conversations/${id}/binance-members${selected ? '?user_id=' + encodeURIComponent(selected) : ''}`,
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) },
        );
        if (!controller.signal.aborted && token === serial.current) {
          setData(value);
          setError('');
        }
      } catch (error: any) {
        if (!controller.signal.aborted && token === serial.current) {
          setData(undefined);
          setError(error.message || '暂时无法读取币安成员信息');
        }
      } finally {
        if (!controller.signal.aborted && token === serial.current) {
          setLoading(false);
          timer = setTimeout(() => void load(), 10000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      serial.current++;
    };
  }, [id, selected, revision]);
  const target = data?.selected_user_id === user ? data.target : null;
  const option = data?.availability[action];
  const ready = !!target && valid(user) && !!option?.available && !busy && !loading;
  const submit = async () => {
    if (
      !confirm ||
      lock.current ||
      !ready ||
      confirm.user_id !== user ||
      confirm.action !== action ||
      confirm.reason !== reason.trim()
    )
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const body = JSON.stringify(confirm);
    if (request.current.body !== body) request.current = { body, key: crypto.randomUUID() };
    try {
      await api(`/conversations/${id}/binance-member-actions`, {
        method: 'POST',
        body: confirm,
        key: request.current.key,
        signal: AbortSignal.timeout(20000),
      });
      request.current = { body: '', key: '' };
      setConfirm(undefined);
      setNotice('已提交成员操作。请查看下方真实执行结果；结果待核对时不会自动重试。');
      setRevision((v) => v + 1);
    } catch (e: any) {
      setError(e.message || '提交结果尚未确认，请保留本次操作并查看下方记录，勿重复创建');
      setRevision((v) => v + 1);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="member-management binance-members">
      <h3>币安成员管理</h3>
      <p>
        仅服务器直连可用。提交前、执行前实时核对当前账号、目标成员及所选群；群主、管理成员和机器人自身受保护。
      </p>
      {data?.paid_group && (
        <p className="info-box">
          此群为付费群：支持单独禁言与手动解禁；踢人涉及付费成员处理，请在币安官方页面操作。
        </p>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="info-box" role="status">
          {notice}
        </div>
      )}
      {data?.pending_action && (
        <div className="info-box" role="status">
          该成员已有{data.pending_action.status === 'unknown' ? '结果待核对' : '正在处理'}的任务。
          <Link to={`/announcements?delivery=${encodeURIComponent(data.pending_action.id)}`}>
            查看执行结果 →
          </Link>
        </div>
      )}
      <div className="info-box">
        当前群：{data?.group_name ?? '正在读取…'} · {data?.group_id ?? '—'}
        <br />
        执行账号：{data?.account_name ?? '—'} · {data?.actor ? roles[data.actor.role] : '身份待核对'}
        {data?.checked_at && (
          <small className="block">
            最近核对 {new Date(data.checked_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
          </small>
        )}
      </div>
      <button
        className="btn"
        disabled={busy || loading || !data?.account_id}
        onClick={async () => {
          if (!data?.account_id) return;
          setBusy(true);
          setError('');
          setConfirm(undefined);
          try {
            await api(`/accounts/${data.account_id}/permissions-refresh`, { method: 'POST' });
            setRevision((v) => v + 1);
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        刷新当前账号权限
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && reason.trim()) setConfirm({ user_id: user, action, reason: reason.trim() });
        }}
      >
        <fieldset disabled={busy || !!confirm} style={{ border: 0, padding: 0, margin: 0 }}>
          <label>
            目标聊天 UID
            <input
              aria-label="币安目标聊天 UID"
              required
              value={user}
              pattern="[1-9][0-9]{0,18}"
              onChange={(e) => {
                setUser(e.target.value.trim());
                setConfirm(undefined);
              }}
              placeholder="从聊天消息的“管理”入口带入，或填写聊天 UID"
            />
            <small>这里使用币安聊天 UID，与交易账户 UID 可能不同。</small>
          </label>
          <button
            type="button"
            className="btn"
            disabled={!valid(user) || loading}
            onClick={() => {
              setSelected(user);
              setRevision((v) => v + 1);
              setConfirm(undefined);
              setData(undefined);
            }}
          >
            查询成员
          </button>
          {target && (
            <p role="status">
              目标：<strong>{target.name}</strong> · {target.user_id} · {roles[target.role]} ·{' '}
              {target.active ? '在群内' : '已不在群内'} · {target.muted ? '已被单独禁言' : '未查到单独禁言'}
            </p>
          )}
          <label>
            管理操作
            <select
              aria-label="币安管理操作"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setConfirm(undefined);
              }}
            >
              {Object.entries(names).map(([key, label]) => (
                <option key={key} value={key} disabled={!data?.availability[key]?.available}>
                  {label}
                  {data?.availability[key]?.available ? '' : '（不可用）'}
                </option>
              ))}
            </select>
          </label>
          <p className={action === 'remove' ? 'error-text' : 'muted'}>
            {action === 'mute'
              ? '本次禁言持续至手动解禁，不设置自动恢复时间。'
              : action === 'unmute'
                ? '仅解除该成员的单独禁言，不改变全群禁言、系统限制或封禁状态。'
                : '只移出当前群，不拉黑、不封禁，也不删除历史消息。成员重新加入仍受币安及群设置约束。'}
          </p>
          <label>
            操作原因
            <textarea
              aria-label="币安操作原因"
              required
              maxLength={500}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：重复发布广告；仅记录在后台操作日志中"
            />
          </label>
        </fieldset>
        {!option?.available && (
          <p className="error-text">当前操作不可用：{option?.reason ?? '正在核对权限'}</p>
        )}
        {user !== selected && <p className="muted">请先查询当前填写的成员，再提交操作。</p>}
        {confirm ? (
          <div className="info-box" role="group" aria-label="确认币安成员操作">
            <strong>确认{names[confirm.action]}</strong>
            <p>
              {data?.group_name}（{data?.group_id}） · {target?.name}（{confirm.user_id}）
            </p>
            <p>原因：{confirm.reason}</p>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(undefined)}>
              返回修改
            </button>{' '}
            <button type="button" className="btn primary" disabled={!ready} onClick={() => void submit()}>
              {busy ? '正在核对并提交…' : `确认${names[confirm.action]}`}
            </button>
          </div>
        ) : (
          <button className="btn primary" disabled={!ready || !reason.trim()}>
            核对并{names[action]}
          </button>
        )}
      </form>
      <h3>最近成员操作</h3>
      <p className="muted">
        只有平台返回成功且回读匹配的成员状态后才显示“处理成功”；超时或无法确认结果时需人工核对，不会自动重试。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>成员</th>
              <th>操作与原因</th>
              <th>执行结果</th>
              <th>操作人 / 时间</th>
            </tr>
          </thead>
          <tbody>
            {data?.actions.map((row: Data) => (
              <tr key={row.id}>
                <td>{row.user_id}</td>
                <td>
                  {names[row.action] ?? row.action}
                  <small>{row.reason}</small>
                </td>
                <td>
                  <Link
                    className={`badge ${row.job_status}`}
                    to={`/announcements?delivery=${encodeURIComponent(row.job_id)}`}
                  >
                    {statuses[row.job_status] ?? '等待核对'}
                  </Link>
                  {row.receipt?.result?.member && (
                    <small>
                      状态回读确认：
                      {
                        (
                          { muted: '已禁言', unmuted: '已解除单独禁言', removed: '已移出本群' } as Record<
                            string,
                            string
                          >
                        )[row.receipt.result.member.state]
                      }
                    </small>
                  )}
                  {row.last_error && <small className="error-text">{row.last_error}</small>}
                </td>
                <td>
                  {row.actor}
                  <small>
                    {new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.actions.length && <p className="muted">暂无币安成员操作记录。</p>}
      </div>
      <Link to={`/inbox/${id}`}>返回本群实时聊天 →</Link>
    </div>
  );
}
