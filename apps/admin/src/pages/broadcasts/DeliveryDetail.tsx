import { useState } from 'react';
import { mediaUrl } from '../../api';
import { api } from '../../api';
import {
  ActionForm,
  Badge,
  Drawer,
  Loading,
  commandLabels,
  date,
  labels,
  useApp,
  useData,
} from '../../console/shared';
import type { Data } from '../../console/shared';

const outcomes: Record<string, string> = {
  succeeded: '平台已确认成功',
  failed: '执行失败',
  unknown: '结果待核对',
  pending: '等待执行',
  in_flight: '等待平台处理',
  accepted: '平台已接收，等待最终结果',
  cancelled: '已取消',
};

export default function DeliveryDetail({ id, close }: { id: string; close: () => void }) {
  const { data, loading, error } = useData(`/deliveries/${id}`, true);
  return (
    <Drawer
      title="投递详情"
      description={
        data
          ? `${data.conversation_name}${data.platform ? ` · ${labels[data.platform] ?? data.platform}` : ''}`
          : undefined
      }
      close={close}
    >
      <Loading loading={loading && !data} error={error}>
        {data && (
          <div className="stack">
            <div className={`result-banner ${data.status}`} role="status">
              <Badge value={data.status} />
              <div>
                <strong>{outcomes[data.status] ?? data.status}</strong>
                <p>
                  {data.last_error ||
                    (data.status === 'unknown'
                      ? '请先到目标平台核对实际记录，再在下方记录结果。此任务不会自动重发。'
                      : data.status === 'succeeded'
                        ? '可以到目标平台查看实际消息或成员状态。'
                        : '')}
                </p>
              </div>
            </div>
            <dl className="facts">
              <div>
                <dt>操作</dt>
                <dd>{commandLabels[data.action] ?? data.action}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{date(data.created_at, true)}</dd>
              </div>
              <div>
                <dt>计划时间</dt>
                <dd>{date(data.due_at, true)}</dd>
              </div>
              {data.is_demo && (
                <div>
                  <dt>类型</dt>
                  <dd>演示任务</dd>
                </div>
              )}
            </dl>
            {data.receipt?.result?.member && (
              <div className="info-box">
                成员 {data.receipt.result.member.user_id}：
                {
                  (
                    {
                      muted: '已禁言，直到手动解禁',
                      unmuted: '已解除单独禁言',
                      removed: '已移出本群',
                    } as Data
                  )[data.receipt.result.member.state]
                }
                （平台状态回读确认于 {date(data.receipt.result.member.verified_at, true)}）
              </div>
            )}
            {data.action === 'message.send' && (
              <div className="delivery-preview">
                {data.params.segments
                  .filter((part: Data) => part.type === 'text')
                  .map((part: Data, index: number) => (
                    <p key={index}>{part.text}</p>
                  ))}
                {data.params.segments
                  .filter(
                    (part: Data) =>
                      part.type === 'image' && /^upload-image-[a-f0-9]{64}$/.test(part.asset_id),
                  )
                  .map((part: Data) => (
                    <a
                      key={part.asset_id}
                      href={mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(part.asset_id)}`)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(part.asset_id)}`)}
                        alt="本次投递图片"
                      />
                    </a>
                  ))}
              </div>
            )}
            {data.status === 'unknown' && <ManualReconcile job={data} />}
            <details className="disclosure">
              <summary>执行记录与任务编号</summary>
              <code className="code-line">{data.id}</code>
              {data.attempts.length ? (
                data.attempts.map((a: Data) => (
                  <div className="attempt" key={a.id}>
                    <div>
                      第 {a.number} 次 <Badge value={a.status} />
                      <time>{date(a.created_at)}</time>
                    </div>
                    {a.receipt && <pre className="code-line">{JSON.stringify(a.receipt, null, 2)}</pre>}
                  </div>
                ))
              ) : (
                <p className="muted">任务尚未开始执行。</p>
              )}
            </details>
          </div>
        )}
      </Loading>
    </Drawer>
  );
}

function ManualReconcile({ job }: { job: Data }) {
  const { toast } = useApp();
  const [outcome, setOutcome] = useState('succeeded');
  return (
    <section className="panel-section">
      <header>
        <h3>人工核对结果</h3>
      </header>
      <ActionForm
        className="stack-form"
        label="记录核对结果"
        onSubmit={async (f) => {
          await api(`/deliveries/${job.id}/reconcile`, {
            method: 'POST',
            body: {
              outcome,
              evidence: f.get('evidence'),
              ...(f.get('message_id') ? { message_id: f.get('message_id') } : {}),
            },
          });
          toast('核对结果已记录');
        }}
      >
        <label>
          平台实际结果
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="succeeded">确认已执行成功</option>
            <option value="no_effect">确认完全未执行，可重新尝试</option>
          </select>
        </label>
        {outcome === 'succeeded' && job.action === 'message.send' && (
          <label>
            平台消息 ID
            <input name="message_id" required maxLength={256} />
          </label>
        )}
        <label>
          核对依据
          <textarea
            name="evidence"
            required
            minLength={10}
            maxLength={1000}
            rows={3}
            placeholder="记录查看的平台记录、时间和结果，至少 10 个字"
          />
        </label>
        <label className="check-row">
          <input type="checkbox" required />
          <span>我已检查目标平台的实际记录，确认以上结果</span>
        </label>
      </ActionForm>
    </section>
  );
}
