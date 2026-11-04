import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { Search, Settings2, UserCheck, X } from 'lucide-react';
import { Empty, date } from './console/shared';
import './verification.css';

type Data = Record<string, any>;
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
  const platform = (v: Data) =>
    (({ telegram: 'Telegram', qq: 'QQ', binance: '币安', custom: '自有聊天' }) as Data)[v.platform] ??
    v.platform;
  const receipt = (id: string, label: string) => (
    <Link to={`/announcements?delivery=${encodeURIComponent(id)}`}>{label}</Link>
  );
  return (
    <div className={groupId ? 'verification-list compact' : 'verification-list'}>
      <div className="verification-head">
        {groupId && <h3>入群验证</h3>}
        <p className="muted">
          {groupId ? '新成员入群后答题验证，' : '各群新成员的入群验证，'}
          提示送达后开始计时，超时按群设置处理。
        </p>
        {openSettings && (
          <button className="btn sm" onClick={openSettings}>
            <Settings2 size={14} />
            验证设置
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
        <p className="muted verification-empty">正在读取验证记录…</p>
      ) : !rows.length ? (
        <Empty icon={UserCheck} title="暂无验证记录" text="开启入群验证后，新成员入群会出现在这里。" />
      ) : (
        <>
          <ul className="verification-rows">
            {visible?.map((v) => {
              const problems = [
                v.challenge_error && `提示发送：${v.challenge_error}`,
                v.timeout_error &&
                  `${v.timeout_command === 'member.mute' ? '超时禁言' : '超时移出'}：${v.timeout_error}`,
                v.failure_error && `答错禁言：${v.failure_error}`,
              ].filter(Boolean) as string[];
              return (
                <li key={v.id} className="verification-row">
                  <div className="verification-who">
                    <span className="avatar">{String(v.user_id).slice(0, 1)}</span>
                    <div>
                      <code>{v.user_id}</code>
                      <small>
                        <Link
                          to={`/groups/${v.conversation_id}${v.is_qq_verification ? '?verification=' + encodeURIComponent(v.id) : ''}`}
                        >
                          {v.conversation_name}
                        </Link>
                        {' · '}
                        {platform(v)}
                        {v.is_qq_verification && ` · 第 ${v.verification_round ?? 1} 轮`}
                      </small>
                    </div>
                  </div>
                  <div className="verification-status">
                    <span className={`verification-state ${v.display_state}`}>
                      {v.display_label ?? v.status}
                    </span>
                    <small>{v.detail_reason || `已作答 ${v.attempts} / 3 次`}</small>
                    {problems.map((text) => (
                      <small key={text} className="error-text">
                        {text}
                      </small>
                    ))}
                  </div>
                  <div className="verification-deadline">
                    <small>截止</small>
                    <span>
                      {v.is_qq_verification && !v.challenge_sent_at ? '提示送达后计时' : date(v.expires_at)}
                    </span>
                  </div>
                  <div className="verification-actions">
                    {v.can_approve && (
                      <button className="btn sm" disabled={!!busy} onClick={() => void act(v, 'approve')}>
                        人工通过
                      </button>
                    )}
                    {v.can_resend && (
                      <button className="btn sm" disabled={!!busy} onClick={() => void act(v, 'resend')}>
                        重发验证
                      </button>
                    )}
                  </div>
                  <details className="verification-more">
                    <summary>详情</summary>
                    <dl>
                      <dt>超时处理</dt>
                      <dd>
                        {v.timeout_action === 'remove'
                          ? '自动移出'
                          : v.timeout_action === 'mute_retry'
                            ? '禁言 10 分钟后重新出题'
                            : '交由管理员'}
                        {v.failed_action === 'mute' && '；答错 3 次禁言 10 分钟'}
                      </dd>
                      {v.challenge_sent_at && (
                        <>
                          <dt>提示送达</dt>
                          <dd>{date(v.challenge_sent_at)}</dd>
                        </>
                      )}
                      {v.retry_after && (
                        <>
                          <dt>重新出题</dt>
                          <dd>{date(v.retry_after)}（先核对已解除禁言）</dd>
                        </>
                      )}
                      {v.muted_until && (
                        <>
                          <dt>禁言到期</dt>
                          <dd>{date(v.muted_until)}，由 QQ 自动解除</dd>
                        </>
                      )}
                      {v.join_request_id && (
                        <>
                          <dt>来源</dt>
                          <dd>入群审核</dd>
                        </>
                      )}
                      {(v.challenge_job_id || v.failure_job_id || v.timeout_job_id) && (
                        <>
                          <dt>执行回执</dt>
                          <dd className="verification-receipts">
                            {v.challenge_job_id && receipt(v.challenge_job_id, '验证提示')}
                            {v.failure_job_id &&
                              receipt(
                                v.failure_job_id,
                                `答错禁言（${jobLabels[v.failure_status] ?? v.failure_status}）`,
                              )}
                            {v.timeout_job_id &&
                              receipt(
                                v.timeout_job_id,
                                v.timeout_command === 'member.mute' ? '超时禁言' : '超时移出',
                              )}
                          </dd>
                        </>
                      )}
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
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
        </>
      )}
    </div>
  );
}
