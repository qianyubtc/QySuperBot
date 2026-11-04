import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, CircleHelp, Pencil, Plus, Search, Send, X } from 'lucide-react';
import { api, mediaUrl } from '../../api';
import {
  Badge,
  Empty,
  Loading,
  PlatformIcon,
  commandLabels,
  date,
  labels,
  useApp,
  useData,
} from '../../console/shared';
import type { Data } from '../../console/shared';
import Compose from './Compose';
import DeliveryDetail from './DeliveryDetail';
import Templates from './Templates';
import './broadcasts.css';

const statusFilters = [
  ['all', '全部'],
  ['pending', '待发送 / 执行中'],
  ['succeeded', '已成功'],
  ['failed', '失败'],
  ['unknown', '待核对'],
] as const;

export default function Broadcasts() {
  const [search, setSearch] = useSearchParams();
  const compose = search.get('compose') === '1';
  const tab = search.get('tab') ?? (search.get('delivery') ? 'deliveries' : 'announcements');
  const detail = search.get('delivery') ?? '';
  const query = search.get('q') ?? '';
  const statusFilter = search.get('status') ?? 'all';
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<Data | null>(null);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    setSearch(next, { replace: key === 'q' });
  };
  const setTab = (value: string) => {
    const next = new URLSearchParams(search);
    next.set('tab', value);
    next.delete('delivery');
    next.delete('status');
    setSearch(next);
  };
  const listTab = tab === 'templates' ? null : tab;
  const {
    data: rows,
    loading,
    error,
  } = useData<Data[]>(listTab === 'deliveries' ? '/deliveries' : '/announcements', true);
  const { refresh, toast, groups } = useApp();
  const matchesStatus = (row: Data, value: string) => {
    if (value === 'all') return true;
    const statuses: string[] =
      listTab === 'deliveries' ? [row.status] : (row.deliveries ?? []).map((d: Data) => d.status);
    return value === 'pending'
      ? statuses.some((v) => ['pending', 'in_flight', 'accepted'].includes(v))
      : value === 'succeeded'
        ? !!statuses.length && statuses.every((v) => v === value)
        : statuses.includes(value);
  };
  const filteredRows = rows?.filter(
    (row) =>
      matchesStatus(row, statusFilter) &&
      `${row.title ?? ''} ${row.content ?? ''} ${row.conversation_name ?? ''} ${(row.deliveries ?? []).map((d: Data) => d.name).join(' ')}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  async function act(path: string, done: string) {
    if (busy) return;
    setBusy(path);
    try {
      await api(path, { method: 'POST' });
      refresh();
      toast(done);
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setBusy('');
    }
  }
  const editable = (a: Data) =>
    !!a.deliveries?.length &&
    a.deliveries.every((d: Data) => d.status === 'pending') &&
    new Date(a.scheduled_at).getTime() > Date.now();
  return (
    <div className="page broadcasts">
      <div className="page-head">
        <div>
          <h1>群发</h1>
          <p>通知、活动和广告一次发到多个群，每个群单独记录结果。</p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={() => change('compose', '1')}>
            <Plus size={15} />
            新建群发
          </button>
        </div>
      </div>
      <div className="card">
        <nav className="tabs card-tabs">
          {[
            ['announcements', '群发记录'],
            ['deliveries', '投递任务'],
            ['templates', '模板与常用语'],
          ].map(([key, name]) => (
            <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key!)}>
              {name}
            </button>
          ))}
        </nav>
        {tab === 'templates' ? (
          <Templates />
        ) : (
          <>
            <div className="toolbar">
              <label className="search">
                <Search size={15} />
                <input
                  aria-label="搜索记录"
                  placeholder="搜索标题、内容或群名"
                  value={query}
                  onChange={(e) => change('q', e.target.value)}
                />
              </label>
              <div className="segmented" aria-label="按状态筛选">
                {statusFilters.map(([key, label]) => (
                  <button
                    key={key}
                    className={statusFilter === key ? 'active' : ''}
                    aria-pressed={statusFilter === key}
                    onClick={() => change('status', key)}
                  >
                    {label}
                    <span className="count">
                      {rows?.filter((row) => matchesStatus(row, key)).length ?? 0}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <Loading loading={loading && !rows} error={error}>
              {filteredRows?.length ? (
                listTab === 'announcements' ? (
                  <div className="broadcast-list">
                    {filteredRows.map((a) => {
                      const future = new Date(a.scheduled_at).getTime() > Date.now();
                      const counts = (a.deliveries ?? []).reduce((acc: Data, d: Data) => {
                        acc[d.status] = (acc[d.status] ?? 0) + 1;
                        return acc;
                      }, {});
                      return (
                        <article key={a.id} className="broadcast-item">
                          <header>
                            <span className={`broadcast-icon ${future ? 'scheduled' : ''}`}>
                              {future ? <CalendarClock size={16} /> : <Send size={16} />}
                            </span>
                            <div>
                              <h3>{a.title}</h3>
                              <time>
                                {future ? '计划于 ' : ''}
                                {date(a.scheduled_at)}
                                {' · '}
                                {a.deliveries?.length ?? 0} 个群
                                {counts.succeeded ? ` · ${counts.succeeded} 成功` : ''}
                                {counts.failed ? ` · ${counts.failed} 失败` : ''}
                                {counts.unknown ? ` · ${counts.unknown} 待核对` : ''}
                              </time>
                            </div>
                            <div className="broadcast-actions">
                              {editable(a) && (
                                <button className="btn sm" onClick={() => setEditing(a)}>
                                  <Pencil size={13} />
                                  修改
                                </button>
                              )}
                              {a.deliveries?.some((d: Data) => d.status === 'pending') && (
                                <button
                                  className="btn sm ghost"
                                  disabled={!!busy}
                                  onClick={() => {
                                    if (window.confirm('取消这条群发中还没发出的任务？'))
                                      void act(`/announcements/${a.id}/cancel`, '已取消待发任务');
                                  }}
                                >
                                  取消待发
                                </button>
                              )}
                            </div>
                          </header>
                          <div className="broadcast-body">
                            {a.content && <p>{a.content}</p>}
                            {a.image_asset_id && (
                              <a
                                href={mediaUrl(
                                  `/api/v1/uploads/images/${encodeURIComponent(a.image_asset_id)}`,
                                )}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <img
                                  src={mediaUrl(
                                    `/api/v1/uploads/images/${encodeURIComponent(a.image_asset_id)}`,
                                  )}
                                  alt="群发图片"
                                  loading="lazy"
                                />
                              </a>
                            )}
                          </div>
                          <div className="broadcast-targets">
                            {a.deliveries?.map((d: Data) => (
                              <button
                                key={d.id}
                                onClick={() => change('delivery', d.id)}
                                title="查看投递详情"
                              >
                                <PlatformIcon value={d.is_demo ? 'demo' : d.platform} />
                                {d.name}
                                <Badge value={d.status} />
                              </button>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>目标群</th>
                          <th>动作</th>
                          <th>状态</th>
                          <th>创建时间</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows.map((d) => (
                          <tr key={d.id}>
                            <td>
                              <strong>{d.conversation_name}</strong>
                              <small>
                                {d.is_demo ? '演示' : (labels[d.platform] ?? d.platform)} ·{' '}
                                {d.conversation_external_id}
                              </small>
                            </td>
                            <td>{commandLabels[d.action] ?? d.action}</td>
                            <td>
                              <Badge value={d.status} />
                              {d.last_error && <small className="error-text">{d.last_error}</small>}
                            </td>
                            <td className="numeric">{date(d.created_at)}</td>
                            <td>
                              <div className="table-row-actions">
                                {d.status === 'failed' &&
                                  d.receipt?.error?.retryable &&
                                  !d.review_ref?.purpose?.startsWith('qq-verification-') &&
                                  new Date(d.expires_at).getTime() > Date.now() &&
                                  groups.some(
                                    (g) => g.id === d.conversation_id && g.sync_enabled !== false,
                                  ) && (
                                    <button
                                      className="btn sm"
                                      disabled={!!busy}
                                      onClick={() =>
                                        void act(`/deliveries/${d.id}/retry`, '已重新加入发送队列')
                                      }
                                    >
                                      重试
                                    </button>
                                  )}
                                {d.status === 'failed' &&
                                  d.review_ref?.purpose?.startsWith('qq-verification-') && (
                                    <Link className="btn sm" to={`/groups/${d.conversation_id}?tab=join`}>
                                      去验证处理
                                    </Link>
                                  )}
                                <button className="btn sm ghost" onClick={() => change('delivery', d.id)}>
                                  详情
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : rows?.length ? (
                <div className="empty">
                  <Empty icon={Search} title="没有符合条件的记录" text="换个关键词，或清除状态筛选。" />
                  <button
                    className="btn"
                    onClick={() => {
                      const next = new URLSearchParams(search);
                      next.delete('q');
                      next.delete('status');
                      setSearch(next, { replace: true });
                    }}
                  >
                    <X size={14} />
                    清除筛选
                  </button>
                </div>
              ) : (
                <Empty
                  icon={Send}
                  title="还没有群发记录"
                  text="新建一条群发，每个群的发送进度都会在这里实时更新。"
                />
              )}
            </Loading>
            <div className="table-foot">
              <span>
                显示 {filteredRows?.length ?? 0} / {rows?.length ?? 0} 条
              </span>
              <span>最近 100 条 · 每 10 秒更新</span>
            </div>
          </>
        )}
      </div>
      <p className="page-note">
        <CircleHelp size={14} />
        超时或断线时结果会标为“待核对”，不会自动重发。请先到目标平台核对，再在投递详情里记录结果。
      </p>
      {compose && <Compose close={() => change('compose', '')} />}
      {editing && <Compose editing={editing} close={() => setEditing(null)} />}
      {detail && <DeliveryDetail id={detail} close={() => change('delivery', '')} />}
    </div>
  );
}
