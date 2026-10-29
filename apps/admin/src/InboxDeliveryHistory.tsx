import { ChevronDown, ChevronRight, CircleAlert, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';

type Data = Record<string, any>;
export default function InboxDeliveryHistory({
  jobs,
  canSend,
  retrying,
  onRetry,
}: {
  jobs: Data[];
  canSend: boolean;
  retrying: string;
  onRetry: (job: Data) => void;
}) {
  if (!jobs.length) return null;
  return (
    <details className="inbox-delivery-history">
      <summary>
        <CircleAlert size={14} />
        <span>历史发送记录</span>
        <span className="inbox-delivery-count">{jobs.length} 条失败 / 取消</span>
        <ChevronDown size={14} className="inbox-delivery-chevron" />
      </summary>
      <div className="inbox-delivery-records" role="region" aria-label="历史失败与取消的发送任务">
        <p className="inbox-delivery-help">
          这里保留之前任务的结果，不代表当前连接异常。恢复连接后不会自动重发。
        </p>
        {jobs.map((job) => (
          <article className="inbox-delivery-record" key={job.id}>
            <header>
              <strong>{job.status === 'cancelled' ? '已取消' : '发送失败'}</strong>
              <time dateTime={job.created_at}>
                {new Date(job.created_at).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'Asia/Shanghai',
                })}
              </time>
            </header>
            <p className="inbox-delivery-content">{job.content || '[图片]'}</p>
            {job.last_error && <p className="inbox-delivery-reason">当时的原因：{job.last_error}</p>}
            <div className="inbox-delivery-actions">
              {job.status === 'failed' && job.retryable && (
                <button
                  className="chat-reply"
                  disabled={!canSend || retrying === job.id}
                  title={!canSend ? '请先恢复当前群的发送权限' : '重新提交这条失败任务'}
                  onClick={() => onRetry(job)}
                >
                  <RefreshCw size={12} />
                  {retrying === job.id ? '正在提交…' : '重试此任务'}
                </button>
              )}
              <Link className="chat-reply" to={`/announcements?delivery=${encodeURIComponent(job.id)}`}>
                查看记录 <ChevronRight size={12} />
              </Link>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}
