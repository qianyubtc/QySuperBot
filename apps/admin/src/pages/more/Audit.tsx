import { useState } from 'react';
import { Activity, Search } from 'lucide-react';
import { Empty, Loading, actionLabel, date, useData } from '../../console/shared';
import type { Data } from '../../console/shared';
import './more.css';

const systemActors = new Set([
  '系统任务',
  '定时任务',
  '定时刷新',
  '连接器',
  '自动验证权限刷新',
  '关键词规则',
]);
const isSystem = (actor: string) => systemActors.has(actor) || /^binance-|^test$/.test(actor);

export default function Audit() {
  const { data: rows, loading, error } = useData<Data[]>('/audit', true);
  const [q, setQ] = useState('');
  const [who, setWho] = useState<'all' | 'admin' | 'system'>('all');
  const [open, setOpen] = useState('');
  const visible = rows?.filter(
    (a) =>
      (who === 'all' || (who === 'system') === isSystem(a.actor)) &&
      `${a.actor} ${a.action} ${actionLabel(a.action)} ${a.target}`
        .toLowerCase()
        .includes(q.trim().toLowerCase()),
  );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>操作日志</h1>
          <p>最近 200 条管理员操作、规则命中和任务执行记录。</p>
        </div>
      </div>
      <div className="card">
        <div className="toolbar">
          <label className="search">
            <Search size={15} />
            <input placeholder="搜索动作、操作者或对象" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="segmented">
            {(
              [
                ['all', '全部'],
                ['admin', '管理员'],
                ['system', '系统'],
              ] as const
            ).map(([key, name]) => (
              <button key={key} className={who === key ? 'active' : ''} onClick={() => setWho(key)}>
                {name}
              </button>
            ))}
          </div>
        </div>
        <Loading loading={loading && !rows} error={error}>
          {visible?.length ? (
            <ul className="audit-list">
              {visible.map((a) => (
                <li key={a.id}>
                  <button
                    className="audit-row"
                    aria-expanded={open === a.id}
                    onClick={() => setOpen(open === a.id ? '' : a.id)}
                  >
                    <span className={`dot ${isSystem(a.actor) ? '' : 'online'}`} />
                    <span className="audit-main">
                      <strong>{actionLabel(a.action)}</strong>
                      <small>
                        {a.actor} · <code>{a.action}</code>
                      </small>
                    </span>
                    <time>{date(a.created_at, true)}</time>
                  </button>
                  {open === a.id && (
                    <pre className="code-line">
                      {JSON.stringify({ target: a.target, ...a.detail }, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              icon={Activity}
              title={rows?.length ? '没有匹配的记录' : '还没有操作记录'}
              text="开始管理社群后，重要操作会记录在这里。"
            />
          )}
        </Loading>
      </div>
    </div>
  );
}
