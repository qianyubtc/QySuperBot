import { CircleAlert, Clock3, ShieldCheck } from 'lucide-react';
import './binance-connection.css';

const time = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
      })
    : null;
export default function BinanceConnectionStatus({ account }: { account: Record<string, any> }) {
  const connection = account.connection;
  if (!connection) return <div className="account-state-note">正在获取币安连接状态…</div>;
  const direct = account.settings?.transport === 'direct';
  const healthy = connection.state === 'connected';
  const danger = connection.needs_relogin;
  const Icon = healthy ? ShieldCheck : connection.state === 'connecting' ? Clock3 : CircleAlert;
  const times = [
    ['登录验证', time(connection.verified_at) ?? '待检查', time(connection.verified_at)],
    ['同步检查', time(connection.synced_at) ?? '待检查', time(connection.synced_at)],
    // A hosted browser keeps its own Binance session, so the copied token's expiry does not apply.
    connection.hosted
      ? ['同步方式', '服务器浏览器', '由服务器上已通过验证的浏览器收发消息']
      : [
          '令牌到期',
          time(connection.expires_at) ?? '未提供',
          connection.expires_at ? null : '平台未提供有效期，以实际验证为准',
        ],
  ] as const;
  return (
    <div
      className={`account-state-note binance-connection ${healthy ? 'healthy' : danger ? 'needs-login' : 'needs-check'}`}
      role="status"
    >
      <Icon size={17} />
      <div>
        <strong>{connection.title}</strong>
        <p>{connection.message}</p>
        {connection.issue_group_id && !danger && <p>涉及群 ID：{connection.issue_group_id}</p>}
        {danger && (
          <p className="binance-relogin-hint">
            {connection.login_available
              ? '重新登录币安后点“连接此账号”，原同步群保留。'
              : '此服务器未启用登录窗口，请在“连接方式”更新登录凭据。'}
          </p>
        )}
        {direct && (
          <dl className="binance-connection-times">
            {times.map(([label, value, title]) => (
              <div key={label} title={title ?? undefined}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {!healthy && account.last_error && (
          <details className="binance-connection-detail">
            <summary>最近异常</summary>
            <p>{account.last_error}</p>
          </details>
        )}
      </div>
    </div>
  );
}
