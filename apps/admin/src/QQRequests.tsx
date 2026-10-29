import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { Search } from 'lucide-react';
import './member-management.css';
const statuses: Record<string, string> = {
  pending: '等待处理',
  in_flight: '处理中',
  accepted: '平台已接收',
  succeeded: '已通过',
  failed: '处理失败',
  unknown: '结果待核对',
  cancelled: '已取消',
};
export default function QQRequests({ id }: { id: string }) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const matchesFilter = (r: any, value: string) =>
    value === 'all' ||
    (value === 'attention'
      ? !r.job_id || ['failed', 'unknown'].includes(r.job_status)
      : value === 'pending'
        ? ['pending', 'in_flight', 'accepted'].includes(r.job_status)
        : r.job_status === 'succeeded');
  const visibleRequests = data?.requests.filter(
    (r: any) =>
      matchesFilter(r, filter) &&
      `${r.user_id} ${r.comment ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const sequence = useRef(0);
  const endpoint = `/conversations/${id}/qq-requests`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const current = ++sequence.current;
      try {
        const value = await api(endpoint, { signal });
        if (current === sequence.current && !signal?.aborted) {
          setData(value);
          setLoadError('');
        }
      } catch (error) {
        if (current === sequence.current && !signal?.aborted) throw error;
      }
    },
    [endpoint],
  );
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const get = async () => {
      try {
        await load(ctrl.signal);
      } catch (e: any) {
        if (!ctrl.signal.aborted) setLoadError(e.message);
      } finally {
        if (!ctrl.signal.aborted) timer = setTimeout(() => void get(), 5000);
      }
    };
    void get();
    return () => {
      clearTimeout(timer);
      ctrl.abort();
      sequence.current++;
    };
  }, [load]);
  return (
    <div className="member-management">
      <h3>QQ 入群申请</h3>
      <p>
        开启后，自动通过本群新的普通入群申请；群黑名单中的成员不会自动通过。邀请机器人加入其他群仍需手动处理。
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {loadError && (
        <div className="form-error" role="alert">
          {loadError}
        </div>
      )}
      {notice && (
        <div className="info-box" role="status">
          {notice}
        </div>
      )}
      {!data ? (
        <p>正在读取入群审核设置…</p>
      ) : (
        <>
          <label className="check-row verification-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={data.auto_approve}
              disabled={busy || (!data.available && !data.auto_approve)}
              onChange={async (e) => {
                const enabled = e.target.checked;
                setBusy(true);
                setError('');
                setNotice('');
                try {
                  await api(endpoint, { method: 'PUT', body: { auto_approve: enabled } });
                  await load();
                  setNotice(
                    enabled
                      ? '自动审核已开启，新的普通入群申请将按规则处理。'
                      : '自动审核已关闭，后续申请需要管理员处理。',
                  );
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            />
            <span>
              <strong>自动通过新的入群申请</strong>
              <small>
                {busy
                  ? '正在保存…'
                  : data.auto_approve
                    ? '已开启，处理前仍会核对管理权限与黑名单'
                    : '已关闭，由管理员处理入群申请'}
              </small>
            </span>
          </label>
          {!data.available && <p className="form-error">当前不可开启：{data.unavailable_reason}</p>}
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await api(`/accounts/${data.account_id}/permissions-refresh`, { method: 'POST' });
                await load();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            刷新 QQ 管理权限
          </button>
          <p className="muted">
            关闭会停止尚未执行的自动审核任务，重新开启不补处理旧申请。每次处理前复查 QQ
            身份、群权限、同步范围和黑名单；结果未知时不自动重试。
          </p>
          <p className="muted">
            入群审核与活人验证分别记录。当前入群验证：{data.verification_enabled ? '已开启' : '未开启'}。
            <Link to={`/groups/${id}?verification=settings`}> 查看活人验证 →</Link>
          </p>
          <h3>最近申请</h3>
          {!!data.requests.length && (
            <div className="request-toolbar">
              <div className="segmented" aria-label="筛选入群审核状态">
                {(
                  [
                    ['all', '全部'],
                    ['attention', '需要处理'],
                    ['pending', '处理中'],
                    ['succeeded', '已通过'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={filter === key ? 'active' : ''}
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                  >
                    {label}
                    <span>{data.requests.filter((r: any) => matchesFilter(r, key)).length}</span>
                  </button>
                ))}
              </div>
              <label className="search">
                <Search size={16} />
                <input
                  aria-label="搜索入群申请"
                  placeholder="搜索 QQ 号或申请留言"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>申请成员</th>
                  <th>验证信息</th>
                  <th>处理结果</th>
                  <th>入群后的验证</th>
                  <th>申请时间</th>
                </tr>
              </thead>
              <tbody>
                {visibleRequests?.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.user_id}</td>
                    <td>{r.comment || '未填写'}</td>
                    <td>
                      {r.job_id ? (
                        <>
                          <Link
                            className={`badge ${r.job_status}`}
                            to={`/announcements?delivery=${encodeURIComponent(r.job_id)}`}
                          >
                            {statuses[r.job_status] ?? r.job_status}
                          </Link>
                          {r.last_error && <small className="error-text">{r.last_error}</small>}
                        </>
                      ) : (
                        <>
                          <span>未自动处理</span>
                          <small>{r.reason}</small>
                        </>
                      )}
                    </td>
                    <td>
                      {r.verification ? (
                        <Link to={`/groups/${id}?verification=${encodeURIComponent(r.verification.id)}`}>
                          {r.verification.display_label}
                        </Link>
                      ) : r.verification_expected ? (
                        '等待真实入群通知'
                      ) : (
                        '此次入群未要求验证'
                      )}
                    </td>
                    <td>{new Date(r.source_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visibleRequests?.length && (
              <p className="muted">
                {data.requests.length ? '没有符合筛选条件的申请。' : '还没有接收到新的入群申请。'}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
