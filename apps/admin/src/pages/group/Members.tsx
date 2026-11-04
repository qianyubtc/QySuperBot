import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  LoaderCircle,
  MessageSquareOff,
  Search,
  ShieldAlert,
  UserX,
  VolumeX,
  Volume2,
} from 'lucide-react';
import { api, mediaUrl } from '../../api';
import { Badge, Empty, Loading, date, n, useApp, useData } from '../../console/shared';
import type { Data } from '../../console/shared';
import { CopyButton } from '../../ConsoleTools';
import MemberManagement from '../../MemberManagement';
import BinanceMemberManagement from '../../BinanceMemberManagement';

const verdicts: Record<string, string> = {
  blocked: '命中规则',
  observed: '命中（观察）',
  pending: '待验证',
  historical: '历史',
};
const verificationNames: Record<string, string> = {
  pending: '待验证',
  passed: '已通过',
  failed: '未通过',
  expired: '已超时',
  manual_review: '待人工处理',
  cooldown: '冷却中',
  left: '已退群',
  superseded: '已换批次',
  removed: '已移出',
};
const actionNames: Record<string, string> = {
  mute: '禁言',
  unmute: '解除禁言',
  ban: '封禁',
  remove: '移出',
  warn: '警告',
  clearwarnings: '清除警告',
  warnings: '查询警告',
};

/** The member's platform avatar through the admin proxy, over their initial while it loads or if it is missing. */
function MemberAvatar({ g, m, small }: { g: Data; m: Data; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const proxied =
    !failed && !g.is_demo && m.avatar_message_id && ['telegram', 'qq', 'binance'].includes(g.platform);
  return (
    <span className={small ? 'avatar sm' : 'avatar'}>
      {String(m.name).slice(0, 1)}
      {proxied && (
        <img
          src={mediaUrl(
            `/api/v1/conversations/${encodeURIComponent(g.id)}/messages/${encodeURIComponent(m.avatar_message_id)}/avatar`,
          )}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function Tags({ m }: { m: Data }) {
  return (
    <>
      {m.blacklist && <span className="tag danger">黑名单</span>}
      {m.warnings > 0 && <span className="tag warning">{m.warnings} 次警告</span>}
      {['pending', 'manual_review', 'failed', 'expired', 'cooldown'].includes(m.verification_status) && (
        <span className="tag warning">{verificationNames[m.verification_status]}</span>
      )}
      {m.membership_status === 'left' && <span className="tag">已退群</span>}
    </>
  );
}

export default function Members({ g, member }: { g: Data; member?: string | null }) {
  const [selected, setSelected] = useState<string | null>(member ?? null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (member) setSelected(member);
  }, [member]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const { data, loading, error } = useData(
    `/conversations/${g.id}/members${search ? `?q=${encodeURIComponent(search)}` : ''}`,
    true,
  );
  if (selected) return <MemberDetail g={g} userId={selected} back={() => setSelected(null)} />;
  return (
    <div className="members">
      <label className="search">
        <Search size={15} />
        <input placeholder="搜索昵称或成员 ID" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p className="muted">
        后台见过的成员：发过言、入过群，或有处理和验证记录。平台本身的完整成员名单暂不同步。
      </p>
      <Loading loading={loading && !data} error={error}>
        {data?.members.length ? (
          <ul className="member-list">
            {data.members.map((m: Data) => (
              <li key={m.user_id}>
                <button onClick={() => setSelected(m.user_id)}>
                  <MemberAvatar g={g} m={m} small />
                  <span className="member-main">
                    <strong>{m.name}</strong>
                    <small>
                      {m.message_count ? `${n(m.message_count)} 条发言 · ` : ''}
                      {m.last_activity_at ? `最近 ${date(m.last_activity_at)}` : m.user_id}
                    </small>
                  </span>
                  <span className="member-tags">
                    <Tags m={m} />
                  </span>
                </button>
              </li>
            ))}
            {data.truncated && (
              <li className="muted member-more">只显示最近活跃的 200 位，可用搜索查找其他成员</li>
            )}
          </ul>
        ) : (
          <Empty title={search ? '没有匹配的成员' : '还没有成员记录'} text="成员发言或入群后会出现在这里。" />
        )}
      </Loading>
      {g.platform === 'telegram' && g.kind === 'group' && (
        <details className="disclosure members-advanced">
          <summary>群内管理员命令与全部处理记录</summary>
          <MemberManagement id={g.id} member={null} />
        </details>
      )}
      {g.platform === 'binance' && g.kind === 'group' && (
        <details className="disclosure members-advanced">
          <summary>全部处理记录与币安权限</summary>
          <BinanceMemberManagement id={g.id} member={null} />
        </details>
      )}
    </div>
  );
}

function MemberDetail({ g, userId, back }: { g: Data; userId: string; back: () => void }) {
  const { data, loading, error } = useData(
    `/conversations/${g.id}/members/${encodeURIComponent(userId)}`,
    true,
  );
  const m = data?.member;
  return (
    <div className="member-detail">
      <button className="back-link" onClick={back}>
        <ArrowLeft size={14} />
        全部成员
      </button>
      <Loading loading={loading && !data} error={error}>
        {m && (
          <div className="stack">
            <header className="member-head">
              <MemberAvatar g={g} m={m} />
              <div>
                <h3>{m.name}</h3>
                <span className="mono-row">
                  <code>{m.user_id}</code>
                  <CopyButton value={m.user_id} label="复制成员 ID" />
                </span>
              </div>
            </header>
            <div className="chip-list">
              <Tags m={m} />
              {m.membership_status === 'active' && <span className="tag accent">在群内</span>}
            </div>
            <div className="stat-grid">
              <div className="stat">
                <span>发言</span>
                <strong>{n(m.message_count)}</strong>
              </div>
              <div className="stat">
                <span>命中规则</span>
                <strong className={m.flagged_count ? 'text-warning' : ''}>{n(m.flagged_count)}</strong>
              </div>
              <div className="stat">
                <span>有效警告</span>
                <strong>{n(m.warnings)}</strong>
              </div>
              <div className="stat">
                <span>入群记录</span>
                <strong className="stat-small">{m.membership_at ? date(m.membership_at) : '—'}</strong>
              </div>
            </div>
            <MemberActions g={g} m={m} />
            <section className="panel-section">
              <header>
                <h3>最近发言</h3>
              </header>
              {data.messages.length ? (
                <ul className="member-messages">
                  {data.messages.map((msg: Data) => (
                    <li key={msg.id}>
                      <p className={msg.deleted ? 'deleted' : ''}>{msg.content}</p>
                      <small>
                        {date(msg.created_at)}
                        {verdicts[msg.verdict] && (
                          <span className="tag warning">{verdicts[msg.verdict]}</span>
                        )}
                        {msg.deleted && <span className="tag">已删除</span>}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">还没有发言记录。</p>
              )}
            </section>
            {(data.actions.length > 0 || data.keyword_hits.length > 0 || data.verifications.length > 0) && (
              <section className="panel-section">
                <header>
                  <h3>处理记录</h3>
                </header>
                <ul className="member-history">
                  {data.actions.map((a: Data) => (
                    <li key={a.id}>
                      <strong>{actionNames[a.action] ?? a.action}</strong>
                      <span>{a.reason}</span>
                      <small>
                        {a.actor} · {date(a.created_at)}
                        {a.job_status && <Badge value={a.job_status} />}
                      </small>
                    </li>
                  ))}
                  {data.keyword_hits.map((h: Data) => (
                    <li key={h.id}>
                      <strong>关键词 · {h.rule_name}</strong>
                      <span>命中“{h.keyword}”</span>
                      <small>
                        {date(h.created_at)} · {h.status}
                      </small>
                    </li>
                  ))}
                  {data.verifications.map((v: Data) => (
                    <li key={v.id}>
                      <strong>入群验证</strong>
                      <span>{verificationNames[v.status] ?? v.status}</span>
                      <small>{date(v.created_at)}</small>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </Loading>
    </div>
  );
}

const muteDurations = [
  [600, '10 分钟'],
  [3600, '1 小时'],
  [86400, '1 天'],
  [7 * 86400, '7 天'],
] as const;

function MemberActions({ g, m }: { g: Data; m: Data }) {
  const { toast, refresh } = useApp();
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState(3600);
  const [busy, setBusy] = useState('');
  const numeric = /^[1-9]\d{0,18}$/.test(m.user_id);
  const telegram = g.platform === 'telegram' && g.kind === 'group' && !g.is_demo;
  const binance = g.platform === 'binance' && g.kind === 'group' && !g.is_demo;
  const overview = useData(
    telegram && numeric
      ? `/conversations/${g.id}/member-management?user_id=${m.user_id}`
      : binance && numeric
        ? `/conversations/${g.id}/binance-members?user_id=${m.user_id}`
        : '',
  ).data;
  const availability: Data = telegram || binance ? (overview?.availability ?? {}) : {};
  async function run(key: string, task: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await task();
      toast(done);
      refresh();
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setBusy('');
    }
  }
  const memberAction = (action: string, extra: Data = {}) =>
    run(
      action,
      () =>
        api(`/conversations/${g.id}/${binance ? 'binance-member-actions' : 'member-actions'}`, {
          method: 'POST',
          key: crypto.randomUUID(),
          body: { user_id: m.user_id, action, reason: reason.trim(), ...extra },
        }),
      `已提交${actionNames[action]}，结果见处理记录`,
    );
  const platformActions: [string, string, typeof Ban, Data?][] = telegram
    ? [
        ['mute', '禁言', VolumeX, { duration_seconds: duration }],
        ['warn', '警告', ShieldAlert],
        ['clearwarnings', '清除警告', MessageSquareOff],
        ['ban', '封禁', Ban],
      ]
    : binance
      ? [
          ['mute', '禁言', VolumeX],
          ['unmute', '解除禁言', Volume2],
          ['remove', '移出', UserX],
        ]
      : [];
  return (
    <section className="panel-section member-actions">
      <header>
        <h3>处理</h3>
      </header>
      <label className="field">
        原因
        <input
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="会记录在处理记录和操作日志里"
        />
      </label>
      {platformActions.length > 0 && numeric ? (
        <>
          {telegram && (
            <div className="segmented mute-duration" aria-label="禁言时长">
              {muteDurations.map(([seconds, label]) => (
                <button
                  key={seconds}
                  type="button"
                  className={duration === seconds ? 'active' : ''}
                  onClick={() => setDuration(seconds)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="button-row">
            {platformActions.map(([action, label, Icon, extra]) => {
              const state = availability[action];
              const blocked = !reason.trim() || !!busy || (state && !state.available);
              return (
                <button
                  key={action}
                  className={`btn sm ${['ban', 'remove'].includes(action) ? 'danger' : ''}`}
                  disabled={blocked}
                  title={state && !state.available ? state.reason : !reason.trim() ? '先填写原因' : undefined}
                  onClick={() => {
                    if (['ban', 'remove'].includes(action) && !window.confirm(`确定要${label} ${m.name}？`))
                      return;
                    void memberAction(action, extra);
                  }}
                >
                  {busy === action ? <LoaderCircle className="spin" size={13} /> : <Icon size={13} />}
                  {label}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="muted">
          {g.is_demo
            ? '演示群只支持黑名单。'
            : g.platform === 'qq'
              ? 'QQ 成员的禁言和移出由入群验证与关键词规则自动执行，暂不支持手动操作。'
              : platformActions.length && !numeric
                ? '此成员 ID 不是平台数字 ID，无法直接处罚。'
                : '此平台暂不支持手动处罚，可以使用黑名单。'}
        </p>
      )}
      <div className="button-row">
        {m.blacklist ? (
          <button
            className="btn sm"
            disabled={!!busy}
            onClick={() =>
              void run(
                'unblock',
                () => api(`/blacklists/${m.blacklist.id}`, { method: 'DELETE' }),
                '已移出黑名单',
              )
            }
          >
            移出黑名单
          </button>
        ) : (
          <button
            className="btn sm danger"
            disabled={!!busy || !reason.trim()}
            title={!reason.trim() ? '先填写原因' : '之后在本群的发言会被自动处理'}
            onClick={() =>
              void run(
                'block',
                () =>
                  api('/blacklists', {
                    method: 'POST',
                    body: { conversation_id: g.id, user_id: m.user_id, reason: reason.trim() },
                  }),
                '已加入本群黑名单',
              )
            }
          >
            <Ban size={13} />
            加入黑名单
          </button>
        )}
        {m.blacklist && <small className="muted">原因：{m.blacklist.reason}</small>}
      </div>
    </section>
  );
}
