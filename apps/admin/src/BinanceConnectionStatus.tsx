import { CircleAlert, Clock3, ShieldCheck } from 'lucide-react';
import './binance-connection.css';

const time = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Asia/Shanghai',
      })
    : '等待首次检查';
export default function BinanceConnectionStatus({ account }: { account: Record<string, any> }) {
  const connection = account.connection;
  if (!connection) return <div className="info-box">正在获取币安连接状态…</div>;
  const direct = account.settings?.transport === 'direct';
  const healthy = connection.state === 'connected';
  const danger = connection.needs_relogin;
  const Icon = healthy ? ShieldCheck : connection.state === 'connecting' ? Clock3 : CircleAlert;
  return (
    <div className={`binance-connection ${healthy ? 'healthy' : danger ? 'needs-login' : 'needs-check'}`}>
      <div className="binance-connection-summary" role="status">
        <Icon size={17} />
        <div>
          <strong>{connection.title}</strong>
          <p>{connection.message}</p>
          {connection.issue_group_id && !danger && <small>涉及群 ID：{connection.issue_group_id}</small>}
        </div>
      </div>
      {direct && (
        <div className="binance-connection-times">
          <div>
            <span>最近登录验证</span>
            <time>{time(connection.verified_at)}</time>
          </div>
          <div>
            <span>最近同步检查</span>
            <time>{time(connection.synced_at)}</time>
          </div>
          <div>
            <span>令牌有效期</span>
            <span>{connection.expires_at ? time(connection.expires_at) : '平台未提供，以实际验证为准'}</span>
          </div>
        </div>
      )}
      {danger && (
        <p className="binance-relogin-hint">
          点击“重新登录币安” → 完成扫码或验证 → 点击“连接此账号”。原同步群无需重新勾选。
        </p>
      )}
      {danger && !connection.login_available && (
        <p className="binance-relogin-hint">此服务器未启用登录窗口，请在“连接方式”更新登录凭据。</p>
      )}
      {!healthy && account.last_error && (
        <details className="binance-connection-detail">
          <summary>查看最近异常</summary>
          <p>{account.last_error}</p>
        </details>
      )}
    </div>
  );
}
