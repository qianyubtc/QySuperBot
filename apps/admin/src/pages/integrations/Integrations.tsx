import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, KeyRound, Plus, Shuffle, Trash2, Webhook } from 'lucide-react';
import { api } from '../../api';
import {
  ActionForm,
  Badge,
  Empty,
  GroupChoices,
  GroupSelect,
  Loading,
  Modal,
  Secret,
  date,
  useApp,
  useData,
} from '../../console/shared';
import type { Data } from '../../console/shared';
import { CopyButton } from '../../ConsoleTools';
import './integrations.css';

const scopeNames: Record<string, string> = {
  'conversations.read': '读取群信息',
  'messages.send': '发送通知',
  'deliveries.read': '查询投递',
  'lotteries.write': '创建抽奖',
};
const sample = `POST /api/v1/messages
Authorization: Bearer qsb_…
Idempotency-Key: your-unique-request-id
Content-Type: application/json

{
  "conversation_ids": ["后台中的群 ID"],
  "text": "你的项目通知"
}`;

export default function Integrations() {
  const { data: projects, loading, error } = useData<Data[]>('/projects');
  const { data: routes } = useData<Data[]>('/routes');
  const [add, setAdd] = useState(false),
    [route, setRoute] = useState(false),
    [secret, setSecret] = useState('');
  const { refresh, toast } = useApp();
  async function act(path: string, method: string, confirm: string) {
    if (!window.confirm(confirm)) return;
    try {
      await api(path, { method });
      refresh();
      toast('已完成');
    } catch (err: any) {
      toast(err.message, true);
    }
  }
  return (
    <div className="page integrations">
      <div className="page-head">
        <div>
          <h1>接口与同步</h1>
          <p>让其他项目通过 API 往群里发通知，或把一个群的新消息同步到另一个群。</p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={() => setAdd(true)}>
            <Plus size={15} />
            创建 API Key
          </button>
        </div>
      </div>
      <section className="card">
        <div className="card-head">
          <div>
            <h2>项目 API Key</h2>
            <p>按群和操作授权，可随时撤销；撤销后还没执行的任务会一起取消。</p>
          </div>
        </div>
        <Loading loading={loading && !projects} error={error}>
          {projects?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>Key 前缀</th>
                    <th>权限</th>
                    <th>最近使用</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                        <small>授权 {p.conversation_ids.length} 个群</small>
                      </td>
                      <td>
                        <code>{p.prefix}…</code>
                      </td>
                      <td>
                        <div className="chip-list">
                          {p.scopes.map((scope: string) => (
                            <span key={scope} className="tag">
                              {scopeNames[scope] ?? scope}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="numeric">{date(p.last_used_at)}</td>
                      <td>
                        <div className="table-row-actions">
                          {p.revoked_at ? (
                            <Badge value="cancelled">已撤销</Badge>
                          ) : (
                            <button
                              className="btn sm danger"
                              onClick={() =>
                                void act(
                                  `/projects/${p.id}/revoke`,
                                  'POST',
                                  `撤销“${p.name}”的 API Key？未执行的任务会一起取消。`,
                                )
                              }
                            >
                              撤销
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={KeyRound}
              title="还没有 API Key"
              text="为你的其他项目创建一个只授权指定群的 Key，用来发送项目通知。"
            />
          )}
        </Loading>
      </section>
      <section className="card">
        <div className="card-head">
          <div>
            <h2>消息同步</h2>
            <p>审核通过的新文字消息，从来源群单向转发到目标群。</p>
          </div>
          <button className="btn sm" onClick={() => setRoute(true)}>
            <Plus size={14} />
            添加同步
          </button>
        </div>
        {routes?.length ? (
          <ul className="route-list">
            {routes.map((r) => (
              <li key={r.id}>
                <span className="route-end">{r.source_name}</span>
                <ArrowRight size={16} />
                <span className="route-end">{r.target_name}</span>
                <Badge value={r.enabled ? 'online' : 'paused'}>{r.enabled ? '启用中' : '已停用'}</Badge>
                <button
                  className="icon-btn sm"
                  aria-label="删除同步路线"
                  onClick={() => void act(`/routes/${r.id}`, 'DELETE', '删除这条同步路线？')}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            icon={Shuffle}
            title="还没有同步路线"
            text="添加后，来源群的新消息通过两边的规则检查才会转发。"
          />
        )}
        <div className="card-note">只同步一跳文字；机器人发出的消息、编辑、删除和图片都不会转发。</div>
      </section>
      <section className="card integration-doc">
        <div className="card-body">
          <Webhook size={20} />
          <h2>接入你自己的聊天项目</h2>
          <p className="muted">
            创建“自有聊天”连接，实现群发现、事件签名、心跳和执行回执，你的群就会和其他平台一起出现在后台。
          </p>
          <Link className="text-link" to="/accounts">
            创建自有聊天连接 <ArrowRight size={14} />
          </Link>
        </div>
        <div className="card-body integration-sample">
          <div className="label-row">
            <strong>发送项目通知</strong>
            <CopyButton value={sample} label="复制示例" />
          </div>
          <pre className="code-line">{sample}</pre>
          <p className="muted">
            返回 delivery_ids，用 GET /api/v1/deliveries/:id 查询结果；群 ID 可用 GET /api/v1/conversations
            获取。
          </p>
        </div>
      </section>
      {add && (
        <Modal
          title="创建 API Key"
          description="只授权需要的群和操作。完整 Key 只显示一次。"
          close={() => setAdd(false)}
        >
          <ActionForm
            className="stack-form"
            label="创建"
            cancel={() => setAdd(false)}
            onSubmit={async (f) => {
              const ids = f.getAll('groups'),
                scopes = f.getAll('scopes');
              if (!ids.length || !scopes.length) throw new Error('请至少选择一个群和一个权限');
              const p = await api('/projects', {
                method: 'POST',
                body: { name: f.get('name'), conversation_ids: ids, scopes },
              });
              setAdd(false);
              setSecret(p.key);
            }}
          >
            <label>
              项目名称
              <input required name="name" maxLength={100} placeholder="例如：行情提醒机器人" data-autofocus />
            </label>
            <div className="field">
              授权的群
              <div className="choice-box">
                <GroupChoices />
              </div>
            </div>
            <div className="field">
              允许的操作
              <div className="scope-choices">
                {Object.entries(scopeNames).map(([key, name]) => (
                  <label key={key} className="check-row">
                    <input type="checkbox" name="scopes" value={key} />
                    <span>
                      {name}
                      <small>{key}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </ActionForm>
        </Modal>
      )}
      {route && (
        <Modal title="添加消息同步" close={() => setRoute(false)}>
          <ActionForm
            className="stack-form"
            label="启用同步"
            cancel={() => setRoute(false)}
            onSubmit={async (f) => {
              await api('/routes', {
                method: 'POST',
                body: { source_id: f.get('source'), target_id: f.get('target'), enabled: true },
              });
              setRoute(false);
              toast('同步已启用');
            }}
          >
            <label>
              来源群
              <GroupSelect name="source" />
            </label>
            <label>
              目标群
              <GroupSelect name="target" />
            </label>
            <p className="info-box">启用后开始同步新消息。请确认目标群可以看到来源群名称和成员 ID。</p>
          </ActionForm>
        </Modal>
      )}
      {secret && <Secret value={secret} close={() => setSecret('')} />}
    </div>
  );
}
