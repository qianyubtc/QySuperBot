import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { RefreshCw, Search } from 'lucide-react';
import { date } from './console/shared';
import './qq-requests.css';
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
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(endpoint, { method: 'PUT', body: { auto_approve: enabled } });
      await load();
      setNotice(enabled ? '已开启自动通过，新申请将按规则处理。' : '已关闭自动通过，后续申请由管理员处理。');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const refreshPermissions = async () => {
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
  };
  return (
    <section className="qq-requests">
      <header className="qq-requests-head">
        <h3>入群申请</h3>
        {data && (
          <button className="text-button" disabled={busy} onClick={() => void refreshPermissions()}>
            <RefreshCw size={13} />
            刷新管理权限
          </button>
        )}
      </header>
      {[error, loadError].filter(Boolean).map((text) => (
        <div key={text} className="form-error" role="alert">
          {text}
        </div>
      ))}
      {notice && (
        <div className="info-box" role="status">
          {notice}
        </div>
      )}
      {!data ? (
        <p className="muted">正在读取入群审核设置…</p>
      ) : (
        <>
          <label className="settings-row">
            <div>
              <strong>自动通过新的入群申请</strong>
              <small>
                {busy
                  ? '正在保存…'
                  : data.auto_approve
                    ? '已开启 · 黑名单成员不会通过'
                    : '已关闭 · 由管理员在 QQ 中处理'}
              </small>
            </div>
            <span className="switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="自动通过新的入群申请"
                checked={data.auto_approve}
                disabled={busy || (!data.available && !data.auto_approve)}
                onChange={(e) => void toggle(e.target.checked)}
              />
              <span />
            </span>
          </label>
          {!data.available && <p className="error-text">暂不可开启：{data.unavailable_reason}</p>}
          <p className="qq-requests-note">
            处理前复查管理权限、同步范围和黑名单，结果未知时不自动重试；重新开启不补处理旧申请。入群验证
            {data.verification_enabled ? '已开启' : '未开启'}，
            <Link to={`/groups/${id}?verification=settings`}>去设置</Link>
          </p>
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
                  placeholder="搜索 QQ 号或留言"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>
          )}
          {visibleRequests?.length ? (
            <ul className="request-rows">
              {visibleRequests.map((r: any) => (
                <li key={r.id} className="request-row">
                  <span className="avatar sm">{String(r.user_id).slice(0, 1)}</span>
                  <div className="request-main">
                    <div>
                      <code>{r.user_id}</code>
                      <time>{date(r.source_at)}</time>
                    </div>
                    <small>{r.comment || '未填写验证信息'}</small>
                    {r.job_id
                      ? r.last_error && <small className="error-text">{r.last_error}</small>
                      : r.reason && <small>{r.reason}</small>}
                  </div>
                  <div className="request-result">
                    {r.job_id ? (
                      <Link
                        className={`badge ${r.job_status}`}
                        to={`/announcements?delivery=${encodeURIComponent(r.job_id)}`}
                      >
                        <i />
                        {statuses[r.job_status] ?? r.job_status}
                      </Link>
                    ) : (
                      <span className="badge">
                        <i />
                        未自动处理
                      </span>
                    )}
                    <small>
                      {r.verification ? (
                        <Link to={`/groups/${id}?verification=${encodeURIComponent(r.verification.id)}`}>
                          验证：{r.verification.display_label}
                        </Link>
                      ) : r.verification_expected ? (
                        '等待入群后验证'
                      ) : (
                        '无需验证'
                      )}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted qq-requests-empty">
              {data.requests.length ? '没有符合筛选条件的申请。' : '还没有收到新的入群申请。'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
