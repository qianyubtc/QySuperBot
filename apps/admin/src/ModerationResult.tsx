import { Link } from 'react-router-dom';
import './moderation.css';

const actions: Record<string, string> = {
  'message.delete': '删除消息',
  'member.remove': '移出成员',
  'member.ban': '封禁成员',
};
const states: Record<string, string> = {
  pending: '等待处理',
  in_flight: '处理中',
  accepted: '平台已接收，等待最终结果',
  succeeded: '处理成功',
  failed: '处理失败',
  unknown: '结果待核对',
  cancelled: '已取消',
};
export default function ModerationResult({
  message,
  demo = false,
}: {
  message: Record<string, any>;
  demo?: boolean;
}) {
  if (message.direction === 'outgoing')
    return message.deleted ? (
      <div className="moderation-results">
        <small>消息已标记删除。</small>
      </div>
    ) : null;
  const jobs: Record<string, any>[] = message.moderation_jobs ?? [];
  return (
    <div className="moderation-results">
      {jobs.map((job) => (
        <div key={job.id} className={`moderation-result ${job.status}`}>
          <Link to={`/announcements?delivery=${encodeURIComponent(job.id)}`}>
            {actions[job.action] ?? job.action}：
            {demo && job.status === 'succeeded' ? '演示处理成功' : (states[job.status] ?? job.status)}
          </Link>
          {job.current_version === false && <small>旧版本消息的处理任务</small>}
          {job.last_error && <small>{job.last_error}</small>}
        </div>
      ))}
      {message.deleted &&
        !jobs.some((job) => job.action === 'message.delete' && job.status === 'succeeded') && (
          <small>消息已标记删除，未关联到本系统的成功处理回执。</small>
        )}
      {!jobs.length && !message.deleted && message.verdict === 'observed' && (
        <small>仅记录规则命中，未执行平台处罚。</small>
      )}
      {!jobs.length && !message.deleted && ['blocked', 'pending'].includes(message.verdict) && (
        <small>尚无关联的处理任务，不能据此确认平台已处理。</small>
      )}
    </div>
  );
}
