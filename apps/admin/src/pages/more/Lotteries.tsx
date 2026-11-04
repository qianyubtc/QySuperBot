import { useState } from 'react';
import { Clock3, Gift, Plus } from 'lucide-react';
import { api } from '../../api';
import {
  ActionForm,
  Badge,
  Empty,
  GroupSelect,
  Loading,
  Modal,
  date,
  useApp,
  useData,
} from '../../console/shared';
import type { Data } from '../../console/shared';
import { CopyButton } from '../../ConsoleTools';
import './more.css';

export default function Lotteries() {
  const { data: rows, loading, error } = useData<Data[]>('/lotteries', true);
  const [add, setAdd] = useState(false);
  const { refresh, toast } = useApp();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>社群抽奖</h1>
          <p>群内回复指令报名，到期自动开奖。黑名单、已退群和未通过验证的成员不参与。</p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={() => setAdd(true)}>
            <Plus size={15} />
            创建抽奖
          </button>
        </div>
      </div>
      <Loading loading={loading && !rows} error={error}>
        {rows?.length ? (
          <div className="lottery-grid">
            {rows.map((l) => {
              const open = l.status !== 'drawn';
              return (
                <section className="card lottery-card" key={l.id}>
                  <header>
                    <span className="lottery-icon">
                      <Gift size={18} />
                    </span>
                    <div>
                      <h2>{l.title}</h2>
                      <p>{l.conversation_name}</p>
                    </div>
                    <Badge value={l.status} />
                  </header>
                  <div className="stat-row">
                    <div className="stat">
                      <span>报名</span>
                      <strong>{l.entries_count}</strong>
                    </div>
                    <div className="stat">
                      <span>名额</span>
                      <strong>{l.winners_count}</strong>
                    </div>
                  </div>
                  <p className="lottery-deadline">
                    <Clock3 size={13} />
                    截止 {date(l.closes_at, true)}
                  </p>
                  {open ? (
                    <>
                      <div className="lottery-join">
                        <code>/join {l.id}</code>
                        <CopyButton value={`/join ${l.id}`} label="复制报名指令" />
                      </div>
                      <button
                        className="btn block"
                        disabled={Date.parse(l.closes_at) > Date.now()}
                        title={Date.parse(l.closes_at) > Date.now() ? '截止后才能开奖' : undefined}
                        onClick={() =>
                          void api(`/lotteries/${l.id}/draw`, { method: 'POST' })
                            .then(() => {
                              refresh();
                              toast('开奖完成');
                            })
                            .catch((err) => toast(err.message, true))
                        }
                      >
                        开奖
                      </button>
                    </>
                  ) : (
                    <div className="lottery-winners">
                      <strong>中奖成员</strong>
                      <p>{l.winners.length ? l.winners.join('、') : '没有符合条件的参与者'}</p>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="card">
            <Empty
              icon={Gift}
              title="还没有抽奖活动"
              text="创建后机器人会在群里发出报名指令，成员回复即可参加。"
            />
          </div>
        )}
      </Loading>
      <p className="page-note">
        <Gift size={14} />
        开奖用加密随机数，结果固定、不能重抽。奖品由管理员线下发放。
      </p>
      {add && (
        <Modal
          title="创建抽奖"
          description="报名指令会发到所选的群，成员回复指令即可报名。"
          close={() => setAdd(false)}
        >
          <ActionForm
            className="stack-form"
            label="创建并发布报名"
            cancel={() => setAdd(false)}
            onSubmit={async (f) => {
              await api('/lotteries', {
                method: 'POST',
                body: {
                  conversation_id: f.get('conversation_id'),
                  title: f.get('title'),
                  winners_count: Number(f.get('count')),
                  closes_at: new Date(String(f.get('closes'))).toISOString(),
                },
              });
              setAdd(false);
              toast('抽奖已创建，报名通知已加入发送队列');
            }}
          >
            <label>
              活动名称
              <input required name="title" maxLength={120} data-autofocus />
            </label>
            <label>
              群
              <GroupSelect />
            </label>
            <div className="form-grid">
              <label>
                中奖名额
                <input type="number" required name="count" defaultValue={1} min={1} max={100} />
              </label>
              <label>
                报名截止
                <input type="datetime-local" required name="closes" />
              </label>
            </div>
          </ActionForm>
        </Modal>
      )}
    </div>
  );
}
