import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  CircleAlert,
  FlaskConical,
  MessagesSquare,
  Plus,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  AccountBadge,
  Empty,
  Loading,
  PlatformIcon,
  accountState,
  actionLabel,
  date,
  labels,
  n,
  useApp,
  useData,
} from '../console/shared';
import type { Data } from '../console/shared';
import './overview.css';

const relative = (value: string) => {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`;
  return date(value);
};

export default function Overview() {
  const { data: d, loading, error } = useData('/overview', true);
  const { groups, accounts, accountsCheckedAt } = useApp();
  const synced = groups.filter((g) => g.sync_enabled !== false);
  const troubled = accounts.filter((a) => !a.is_demo && !['online', 'paused'].includes(accountState(a)));
  const active = [...synced]
    .sort((a, b) => Number(b.messages_24h ?? 0) - Number(a.messages_24h ?? 0))
    .slice(0, 6);
  const attention = d
    ? [
        d.unknown_deliveries > 0 && {
          to: '/announcements',
          icon: CircleAlert,
          tone: 'warning',
          title: `${n(d.unknown_deliveries)} 条投递结果待核对`,
          text: '平台没有给出最终结果，请先核对再决定是否重发',
        },
        troubled.length > 0 && {
          to: '/accounts',
          icon: ShieldAlert,
          tone: 'danger',
          title: `${troubled.length} 个账号连接异常`,
          text: troubled.map((a) => a.name).join('、'),
        },
        d.pending_verifications > 0 && {
          to: '/moderation',
          icon: UserCheck,
          tone: 'info',
          title: `${n(d.pending_verifications)} 位成员等待验证`,
          text: '可在安全中心人工通过或查看验证进度',
        },
      ].filter(Boolean)
    : [];
  return (
    <div className="page overview">
      <div className="page-head">
        <div>
          <h1>概览</h1>
          <p>
            {new Date().toLocaleDateString('zh-CN', {
              month: 'long',
              day: 'numeric',
              weekday: 'long',
              timeZone: 'Asia/Shanghai',
            })}
            {' · '}
            {synced.length} 个社群正在同步
          </p>
        </div>
        <div className="head-actions">
          <Link className="btn" to="/inbox">
            <MessagesSquare size={15} />
            打开工作台
          </Link>
          <Link className="btn primary" to="/announcements?compose=1">
            <Plus size={15} />
            新建群发
          </Link>
        </div>
      </div>
      <Loading loading={loading && !d} error={error}>
        {d && (
          <>
            {d.demo_accounts > 0 && (
              <div className="info-box accent overview-demo">
                <FlaskConical size={16} />
                <span>
                  <strong>正在使用演示数据。</strong>
                  演示群的收发只在本地模拟，连接真实账号后即可管理实际社群。
                </span>
                <Link className="text-link" to="/accounts">
                  连接账号 <ArrowRight size={14} />
                </Link>
              </div>
            )}
            {attention.length > 0 && (
              <section className="attention" aria-label="需要处理">
                {attention.map((item: any) => (
                  <Link key={item.to} to={item.to} className={`attention-item ${item.tone}`}>
                    <item.icon size={18} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.text}</small>
                    </span>
                    <ArrowRight size={15} />
                  </Link>
                ))}
              </section>
            )}
            <div className="metrics">
              <div className="metric">
                <span>
                  同步中的社群 <Users size={15} />
                </span>
                <strong>{n(synced.length)}</strong>
                <small>
                  已发现 {n(d.conversations)} 个 · {n(d.accounts)} 个连接
                </small>
              </div>
              <div className="metric">
                <span>
                  今日消息 <MessagesSquare size={15} />
                </span>
                <strong>{n(d.messages_today)}</strong>
                <small>北京时间 00:00 起</small>
              </div>
              <div className={`metric ${d.blocked_today > 0 ? 'attention' : ''}`}>
                <span>
                  今日命中规则 <ShieldCheck size={15} />
                </span>
                <strong>{n(d.blocked_today)}</strong>
                <small>规则判定，平台处理结果见消息记录</small>
              </div>
              <div className={`metric ${d.pending_verifications > 0 ? 'attention' : ''}`}>
                <span>
                  待验证成员 <UserCheck size={15} />
                </span>
                <strong>{n(d.pending_verifications)}</strong>
                <small>入群后尚未完成验证</small>
              </div>
            </div>
            <div className="grid-2">
              <section className="card">
                <div className="card-head">
                  <div>
                    <h2>消息趋势</h2>
                    <p>最近 7 天 · 北京时间</p>
                  </div>
                  <div className="chart-legend">
                    <span className="messages">接收消息</span>
                    <span className="blocked">命中规则</span>
                  </div>
                </div>
                <Chart series={d.series} />
              </section>
              <section className="card">
                <div className="card-head">
                  <div>
                    <h2>连接状态</h2>
                    <p>
                      {accountsCheckedAt
                        ? `${accounts.filter((a) => accountState(a) === 'online').length} / ${accounts.length} 在线`
                        : '正在读取'}
                    </p>
                  </div>
                  <Link className="text-link" to="/accounts">
                    管理 <ArrowRight size={14} />
                  </Link>
                </div>
                <div className="overview-list">
                  {accounts.length ? (
                    accounts.map((a) => (
                      <Link key={a.id} to="/accounts" className="overview-row">
                        <PlatformIcon value={a.is_demo ? 'demo' : a.platform} large />
                        <span className="overview-row-main">
                          <strong>{a.name}</strong>
                          <small>{a.is_demo ? '本地演示连接器' : labels[a.platform]}</small>
                        </span>
                        <AccountBadge account={a} />
                      </Link>
                    ))
                  ) : (
                    <Empty
                      title="还没有连接账号"
                      text="添加 Telegram 机器人、QQ 或币安账号后开始管理社群。"
                    />
                  )}
                </div>
              </section>
            </div>
            <div className="grid-2">
              <section className="card">
                <div className="card-head">
                  <div>
                    <h2>活跃社群</h2>
                    <p>按最近 24 小时消息数排序</p>
                  </div>
                  <Link className="text-link" to="/groups">
                    全部群组 <ArrowRight size={14} />
                  </Link>
                </div>
                <div className="overview-list">
                  {active.length ? (
                    active.map((g) => (
                      <Link key={g.id} to={`/inbox/${g.id}`} className="overview-row">
                        <PlatformIcon value={g.is_demo ? 'demo' : g.platform} large />
                        <span className="overview-row-main">
                          <strong>{g.name}</strong>
                          <small>
                            {g.account_name} · {g.policy?.mode === 'enforce' ? '规则自动处理' : '规则观察中'}
                            {g.pending_verifications > 0 ? ` · ${g.pending_verifications} 人待验证` : ''}
                          </small>
                        </span>
                        <span className="overview-count">
                          <strong>{n(g.messages_24h)}</strong>
                          <small>条 / 24h</small>
                        </span>
                      </Link>
                    ))
                  ) : (
                    <Empty title="还没有同步中的社群" text="在连接账号里勾选要同步的群后，会显示在这里。" />
                  )}
                </div>
              </section>
              <section className="card">
                <div className="card-head">
                  <div>
                    <h2>最近操作</h2>
                    <p>管理员与系统的变更记录</p>
                  </div>
                  <Link className="text-link" to="/audit">
                    操作日志 <ArrowRight size={14} />
                  </Link>
                </div>
                {d.recent_activity.length ? (
                  <ol className="timeline">
                    {d.recent_activity.slice(0, 7).map((a: Data) => (
                      <li key={a.id}>
                        <span className="timeline-dot" />
                        <span>
                          <strong>{actionLabel(a.action)}</strong>
                          <small>
                            {a.actor} · <time title={date(a.created_at, true)}>{relative(a.created_at)}</time>
                          </small>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Empty
                    icon={Activity}
                    title="还没有操作记录"
                    text="连接账号、调整规则或发布通知后会记录在这里。"
                  />
                )}
              </section>
            </div>
          </>
        )}
      </Loading>
    </div>
  );
}

function Chart({ series }: { series: Data[] }) {
  const max = Math.max(4, ...series.map((s) => s.messages));
  const w = 640,
    h = 200,
    left = 34,
    right = 12,
    top = 14,
    bottom = 26;
  const x = (i: number) => left + (i * (w - left - right)) / Math.max(1, series.length - 1);
  const y = (v: number) => top + (1 - v / max) * (h - top - bottom);
  const line = (key: string) => series.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v[key])}`).join(' ');
  const total = series.reduce((a, s) => a + s.messages, 0);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`最近七天接收 ${total} 条消息`}>
        <defs>
          <linearGradient id="overview-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop className="chart-fill-top" offset="0" />
            <stop className="chart-fill-bottom" offset="1" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              className="chart-grid"
              x1={left}
              x2={w - right}
              y1={y((max * i) / 4)}
              y2={y((max * i) / 4)}
            />
            <text className="chart-axis" x={left - 8} y={y((max * i) / 4) + 4} textAnchor="end">
              {Math.round((max * i) / 4)}
            </text>
          </g>
        ))}
        <path
          d={`${line('messages')} L${x(series.length - 1)},${y(0)} L${x(0)},${y(0)} Z`}
          fill="url(#overview-chart-fill)"
        />
        <path className="chart-line" d={line('messages')} />
        <path className="chart-line blocked" d={line('blocked')} />
        {series.map((v, i) => (
          <g key={v.date}>
            <circle className="chart-point" cx={x(i)} cy={y(v.messages)} r="3.5">
              <title>
                {v.date}：{v.messages} 条消息，{v.blocked} 条命中规则
              </title>
            </circle>
            <text className="chart-axis" x={x(i)} y={h - 6} textAnchor="middle">
              {v.date.slice(5).replace('-', '/')}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
