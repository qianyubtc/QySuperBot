import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { Search, X } from 'lucide-react';
import './verification.css';

type Data = Record<string, any>;
const date = (value: any) =>
  value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
const jobLabels: Record<string, string> = {
  pending: '等待执行',
  in_flight: '执行中',
  accepted: '平台已接收',
  succeeded: '已成功',
  failed: '失败',
  unknown: '待核对',
  cancelled: '已取消',
};
export default function VerificationList({
  groupId,
  openSettings,
}: {
  groupId?: string;
  openSettings?: () => void;
}) {
  const [rows, setRows] = useState<Data[]>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const matchesFilter = (v: Data, value: string) =>
    value === 'all' ||
    (value === 'attention'
      ? v.status === 'manual_review' || /failed|unknown/.test(v.display_state ?? v.status)
      : value === 'cooldown'
        ? v.status === 'cooldown'
        : value === 'pending'
          ? v.status === 'pending'
          : ['passed', 'left', 'superseded', 'cancelled', 'removed'].includes(v.status));
  const visible = rows?.filter(
    (v) =>
      matchesFilter(v, filter) &&
      `${v.user_id} ${v.conversation_name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const serial = useRef(0);
  const endpoint = groupId ? `/conversations/${groupId}/verifications` : '/verifications';
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const seq = ++serial.current;
      try {
        const value = await api<Data[]>(endpoint, { signal });
        if (seq === serial.current && !signal?.aborted) {
          setRows(value);
          setError('');
        }
      } catch (e) {
        if (seq === serial.current && !signal?.aborted) throw e;
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
        if (!ctrl.signal.aborted) setError(e.message);
      } finally {
        if (!ctrl.signal.aborted) timer = setTimeout(() => void get(), 5000);
      }
    };
    void get();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      serial.current++;
    };
  }, [load]);
  const act = async (row: Data, action: 'approve' | 'resend') => {
    setBusy(row.id);
    setError('');
    setNotice('');
    try {
      await api(`/verifications/${row.id}/${action}`, {
        method: 'POST',
        ...(action === 'resend' ? { key: crypto.randomUUID() } : {}),
      });
      await load();
      setNotice(action === 'approve' ? '已人工通过当前入群批次的验证' : '已提交重新发送；确认送达后重新计时');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="verification-list">
      <div className="verification-intro">
        <h3>入群后的活人验证</h3>
        <p>
          {groupId
            ? 'QQ 自动审核放人后，收到真实入群通知才创建验证。只验证开启后的新成员，不补发老成员挑战。'
            : '集中查看各平台的成员验证记录。QQ 在真实入群通知后出题，不补发老成员挑战。'}
        </p>
        <p>
          提示确认发送后开始计时。超时按群设置处理，可选择人工处理或循环禁言；发送失败、权限未知和结果待核对会单独显示。
        </p>
        {openSettings && (
          <button className="btn" onClick={openSettings}>
            配置验证方式与超时处理
          </button>
        )}
      </div>
      {!!rows?.length && (
        <div className="verification-toolbar">
          <div className="segmented" aria-label="筛选成员验证状态">
            {(
              [
                ['all', '全部'],
                ['attention', '需要处理'],
                ['pending', '等待验证'],
                ['cooldown', '禁言循环'],
                ['finished', '已结束'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? 'active' : ''}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
                <span>{rows.filter((v) => matchesFilter(v, key)).length}</span>
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索成员验证"
              placeholder="搜索成员 ID 或社群"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="icon-btn"
                aria-label="清空验证搜索"
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </label>
        </div>
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
      {!rows ? (
        <p>正在读取验证记录…</p>
      ) : !rows.length ? (
        <p className="muted verification-empty">暂无验证记录。开启后，新的真实入群通知会生成验证。</p>
      ) : (
        <div className="table-wrap">
          <table className="verification-table">
            <thead>
              <tr>
                <th>成员 / 社群</th>
                <th>验证状态</th>
                <th>提示与截止</th>
                <th>超时处理</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible?.map((v) => (
                <tr key={v.id}>
                  <td>
                    <code>{v.user_id}</code>
                    <small>
                      <Link
                        to={`/groups/${v.conversation_id}${v.is_qq_verification ? '?verification=' + encodeURIComponent(v.id) : ''}`}
                      >
                        {v.conversation_name}
                      </Link>
                    </small>
                    <small>
                      {({ telegram: 'Telegram', qq: 'QQ', binance: '币安', custom: '自有聊天' } as Data)[
                        v.platform
                      ] ?? v.platform}
                    </small>
                    {v.join_request_id && <small>来自入群审核</small>}
                    {v.is_qq_verification && <small>第 {v.verification_round ?? 1} 轮验证</small>}
                  </td>
                  <td>
                    <span className={`verification-state ${v.display_state}`}>
                      {v.display_label ?? v.status}
                    </span>
                    {v.detail_reason && <small>{v.detail_reason}</small>}
                    {v.challenge_error && (
                      <small className="error-text">提示发送记录：{v.challenge_error}</small>
                    )}
                    {v.timeout_error && (
                      <small className="error-text">
                        {v.timeout_command === 'member.mute' ? '超时禁言记录' : '移出任务记录'}：
                        {v.timeout_error}
                      </small>
                    )}
                    {v.failure_error && <small className="error-text">禁言任务记录：{v.failure_error}</small>}
                    <small>已作答 {v.attempts} / 3 次</small>
                  </td>
                  <td>
                    {v.is_qq_verification && !v.challenge_sent_at ? '确认发送后开始计时' : date(v.expires_at)}
                    {v.challenge_sent_at && <small>提示送达：{date(v.challenge_sent_at)}</small>}
                    {v.challenge_job_id && (
                      <small>
                        <Link to={`/announcements?delivery=${encodeURIComponent(v.challenge_job_id)}`}>
                          查看提示发送回执
                        </Link>
                      </small>
                    )}
                  </td>
                  <td>
                    {v.timeout_action === 'remove'
                      ? '超时自动移出'
                      : v.timeout_action === 'mute_retry'
                        ? '超时禁言 10 分钟并循环验证'
                        : '交由管理员处理'}
                    {v.retry_after && (
                      <small>预计重新出题：{date(v.retry_after)}，届时核对已解除禁言再发送</small>
                    )}
                    {v.failed_action === 'mute' && <small>连续答错 3 次禁言 10 分钟</small>}
                    {v.muted_until && <small>禁言预计到期：{date(v.muted_until)}，由 QQ 自动解除</small>}
                    {v.failure_job_id && (
                      <small>
                        <Link to={`/announcements?delivery=${encodeURIComponent(v.failure_job_id)}`}>
                          查看答错禁言回执（{jobLabels[v.failure_status] ?? v.failure_status}）
                        </Link>
                      </small>
                    )}
                    {v.timeout_job_id && (
                      <small>
                        <Link to={`/announcements?delivery=${encodeURIComponent(v.timeout_job_id)}`}>
                          {v.timeout_command === 'member.mute' ? '查看超时禁言回执' : '查看移出任务回执'}
                        </Link>
                      </small>
                    )}
                  </td>
                  <td>
                    <div className="verification-actions">
                      {v.can_approve && (
                        <button className="btn" disabled={!!busy} onClick={() => void act(v, 'approve')}>
                          人工通过
                        </button>
                      )}
                      {v.can_resend && (
                        <button className="btn" disabled={!!busy} onClick={() => void act(v, 'resend')}>
                          重新发送验证
                        </button>
                      )}
                      {!v.can_approve && !v.can_resend && <span className="muted">—</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible?.length && (
            <p className="verification-empty muted">
              没有符合条件的验证记录。
              <button
                className="text-button"
                onClick={() => {
                  setFilter('all');
                  setQuery('');
                }}
              >
                重置筛选
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
