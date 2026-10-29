import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import './member-management.css';

const actions: Record<string, string> = {
  warn: '记录警告',
  mute: '限时禁言',
  ban: '封禁成员',
  clearwarnings: '清除警告',
  warnings: '查询警告',
  command_rejected: '命令未执行',
};
const statuses: Record<string, string> = {
  pending: '等待处理',
  in_flight: '处理中',
  accepted: '平台已接收，等待结果',
  succeeded: '处理成功',
  failed: '处理失败',
  unknown: '结果待核对',
  cancelled: '已取消',
};
export default function MemberManagement({ id, member }: { id: string; member?: string | null }) {
  const [data, setData] = useState<Record<string, any>>();
  const [user, setUser] = useState(member ?? '');
  const [action, setAction] = useState('warn');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('600');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const request = useRef({ body: '', key: '' });
  const submitLock = useRef(false);
  const endpoint = `/conversations/${id}/member-management${/^[1-9]\d{0,19}$/.test(user) ? '?user_id=' + encodeURIComponent(user) : ''}`;
  async function refresh() {
    setData(await api(endpoint));
  }
  useEffect(() => {
    setUser(member ?? '');
  }, [member, id]);
  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      api(endpoint, { signal: ctrl.signal })
        .then(setData)
        .catch((e) => {
          if (!ctrl.signal.aborted) setError(e.message);
        });
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      clearInterval(timer);
      ctrl.abort();
    };
  }, [endpoint]);
  const count = data?.selected_user_id === user ? data.selected_warning_count : '—';
  const option = data?.availability[action];
  return (
    <div className="member-management">
      <div className="section-intro">
        <div>
          <h3>Telegram 成员管理</h3>
          <p>提交前和执行前实时核对机器人、目标成员及命令发送者权限。</p>
        </div>
      </div>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="info-box" role="status">
          {notice}
        </div>
      )}
      {!data ? (
        <p>正在读取成员管理信息…</p>
      ) : (
        <>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (submitLock.current || busy || !option?.available) return;
              submitLock.current = true;
              setBusy(true);
              setError('');
              setNotice('');
              const body = {
                user_id: user,
                action,
                reason,
                ...(action === 'mute' ? { duration_seconds: Number(duration) } : {}),
              };
              const serialized = JSON.stringify(body);
              if (request.current.body !== serialized)
                request.current = { body: serialized, key: crypto.randomUUID() };
              try {
                const result = await api(`/conversations/${id}/member-actions`, {
                  method: 'POST',
                  body,
                  key: request.current.key,
                });
                request.current = { body: '', key: '' };
                setNotice(
                  result.job_id
                    ? `请求已提交，实际结果见下方操作记录。操作编号：${result.id}`
                    : `已记录，成员 ${user} 当前有 ${result.warning_count} 次有效警告。`,
                );
                await refresh();
              } catch (e: any) {
                setError(e.message);
              } finally {
                submitLock.current = false;
                setBusy(false);
              }
            }}
          >
            <div className="form-grid">
              <label>
                目标用户 ID
                <input
                  aria-label="目标用户 ID"
                  required
                  pattern="[1-9][0-9]{0,19}"
                  value={user}
                  onChange={(e) => setUser(e.target.value.trim())}
                  placeholder="可从聊天消息的“管理”入口自动带入"
                />
                <small>当前有效警告：{count} 次</small>
              </label>
              <label>
                管理操作
                <select aria-label="管理操作" value={action} onChange={(e) => setAction(e.target.value)}>
                  {Object.entries(actions)
                    .filter(([key]) => key !== 'command_rejected')
                    .map(([key, label]) => (
                      <option key={key} value={key} disabled={!data.availability[key]?.available}>
                        {label}
                        {data.availability[key]?.available ? '' : '（不可用）'}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {action === 'mute' && (
              <label className="short-field">
                禁言时长
                <select aria-label="禁言时长" value={duration} onChange={(e) => setDuration(e.target.value)}>
                  {[
                    [300, '5 分钟'],
                    [600, '10 分钟'],
                    [3600, '1 小时'],
                    [86400, '1 天'],
                    [604800, '7 天'],
                    [2592000, '30 天'],
                  ].map(([v, label]) => (
                    <option value={v} key={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action === 'ban' && (
              <p className="error-text">
                Telegram 超级群封禁会禁止重新加入并撤回该成员的消息；普通群不保证阻止重新加入。请核对目标用户
                ID。
              </p>
            )}
            {action === 'warn' && (
              <p className="muted">网页操作将警告记录在后台；群内使用 /warn 时还会公开提醒该成员。</p>
            )}
            <label>
              操作原因
              <textarea
                aria-label="操作原因"
                required
                maxLength={500}
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例如：重复发布广告；记录在操作日志中"
              />
            </label>
            {!option?.available && <p className="error-text">当前操作不可用：{option?.reason}</p>}
            <p className="muted">
              禁言到期由 Telegram
              自动恢复；已有成员限制时停止追加禁言。群主、管理员与机器人受保护。提前解除禁言或解封请在
              Telegram 中处理。
            </p>
            <button className="btn primary" disabled={busy || !option?.available}>
              {busy ? '正在核对并提交…' : actions[action]}
            </button>
          </form>
          <div className="member-command-settings">
            <h3>群内管理员命令</h3>
            <label className="check-row">
              <input
                type="checkbox"
                checked={data.commands_enabled}
                disabled={busy}
                onChange={async (e) => {
                  const enabled = e.target.checked;
                  setBusy(true);
                  setError('');
                  try {
                    await api(`/conversations/${id}/member-management`, {
                      method: 'PUT',
                      body: { commands_enabled: enabled },
                    });
                    await refresh();
                    setNotice(
                      enabled ? '本群管理员命令已开启。' : '本群管理员命令已关闭，旧命令任务会停止。',
                    );
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <span>允许本群管理员通过回复消息管理成员</span>
            </label>
            <p>回复目标成员的一条消息后发送：</p>
            <div className="member-command-list">
              <code>/mute 10m 原因</code>
              <code>/ban 原因</code>
              <code>/warn 原因</code>
              <code>/warnings</code>
              <code>/clearwarns 原因</code>
            </div>
            <p className="muted">
              支持
              @机器人用户名；普通成员、匿名身份和发给其他机器人的命令不会执行。警告逐条记录，累计次数可查看和清除，当前不按次数自动处罚。
            </p>
          </div>
          <h3>最近操作</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>成员</th>
                  <th>操作与原因</th>
                  <th>状态</th>
                  <th>操作人</th>
                </tr>
              </thead>
              <tbody>
                {data.actions.map((a: any) => (
                  <tr key={a.id}>
                    <td>
                      <button className="text-link" onClick={() => setUser(a.user_id)}>
                        {a.user_id}
                      </button>
                    </td>
                    <td>
                      {actions[a.action] ?? a.action}
                      <small>{a.reason}</small>
                    </td>
                    <td>
                      {a.job_id ? (
                        <>
                          <Link
                            className={`badge ${a.job_status}`}
                            to={`/announcements?delivery=${encodeURIComponent(a.job_id)}`}
                          >
                            {statuses[a.job_status] ?? a.job_status}
                          </Link>
                          {a.last_error && <small className="error-text">{a.last_error}</small>}
                        </>
                      ) : (
                        <span>
                          {a.action === 'warn'
                            ? a.warning_active
                              ? '警告已记录'
                              : '警告已清除'
                            : a.action === 'clearwarnings'
                              ? '警告已清除'
                              : a.action === 'command_rejected'
                                ? '命令未执行'
                                : '已查询'}
                        </span>
                      )}
                    </td>
                    <td>
                      {a.actor}
                      <small>{new Date(a.created_at).toLocaleString('zh-CN')}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.actions.length && <p className="muted">还没有成员管理记录。</p>}
          </div>
        </>
      )}
    </div>
  );
}
