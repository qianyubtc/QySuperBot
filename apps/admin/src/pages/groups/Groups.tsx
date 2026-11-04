import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, MessagesSquare, Plus, Search, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { Badge, Empty, PlatformIcon, groupAccountOnline, labels, n, useApp } from '../../console/shared';
import type { Data } from '../../console/shared';
import { sortDirectory } from '../../workbench';
import BulkSettings from './BulkSettings';
import './groups.css';

const platforms = [
  ['all', '全部'],
  ['telegram', 'Telegram'],
  ['qq', 'QQ'],
  ['binance', '币安'],
  ['custom', '自有'],
] as const;
const actionNames: Record<string, string> = { delete: '删除消息', remove: '删除并移出', ban: '删除并封禁' };

export default function Groups() {
  const { groups, accounts } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const search = params.get('q') ?? '';
  const platform = params.get('platform') ?? 'all';
  const scope = params.get('scope') ?? 'all';
  const account = params.get('account') ?? 'all';
  const order = params.get('sort') ?? 'activity';
  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const attention = (g: Data) => g.sync_enabled !== false && !groupAccountOnline(g, accounts);
  const counts = {
    all: groups.length,
    enabled: groups.filter((g) => g.sync_enabled !== false).length,
    disabled: groups.filter((g) => g.sync_enabled === false).length,
    attention: groups.filter(attention).length,
  };
  const filtered = sortDirectory(
    groups.filter(
      (g) =>
        (platform === 'all' || g.platform === platform) &&
        (scope === 'all' ||
          (scope === 'enabled'
            ? g.sync_enabled !== false
            : scope === 'attention'
              ? attention(g)
              : g.sync_enabled === false)) &&
        (account === 'all' || g.executor_account_id === account) &&
        `${g.name} ${g.external_id} ${g.account_name}`.toLowerCase().includes(search.trim().toLowerCase()),
    ) as (Data & { id: string; name: string })[],
    order,
  );
  const visibleSelected = filtered.filter((g) => selected.has(g.id));
  const allVisible = filtered.length > 0 && visibleSelected.length === filtered.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const filtering = !!search || platform !== 'all' || scope !== 'all' || account !== 'all';
  const targets = groups.filter((g) => selected.has(g.id));
  return (
    <div className="page groups-page">
      <div className="page-head">
        <div>
          <h1>群组</h1>
          <p>
            {n(groups.length)} 个社群 · {n(counts.enabled)} 个同步中 · 勾选多个群可以批量设置规则
          </p>
        </div>
        <div className="head-actions">
          <Link className="btn primary" to="/accounts">
            <Plus size={15} />
            连接社群
          </Link>
        </div>
      </div>
      <div className="card">
        <div className="toolbar">
          <label className="search">
            <Search size={15} />
            <input
              aria-label="搜索社群"
              placeholder="搜索群名、ID 或账号"
              value={search}
              onChange={(e) => updateFilter('q', e.target.value)}
            />
          </label>
          <div className="segmented" aria-label="按平台筛选">
            {platforms.map(([key, name]) => (
              <button
                key={key}
                className={platform === key ? 'active' : ''}
                aria-pressed={platform === key}
                onClick={() => updateFilter('platform', key)}
              >
                {name}
                <span className="count">
                  {key === 'all' ? groups.length : groups.filter((g) => g.platform === key).length}
                </span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          <select
            className="toolbar-select"
            aria-label="按同步状态筛选"
            value={scope}
            onChange={(e) => updateFilter('scope', e.target.value)}
          >
            <option value="all">全部状态 ({counts.all})</option>
            <option value="enabled">同步中 ({counts.enabled})</option>
            <option value="disabled">未同步 ({counts.disabled})</option>
            <option value="attention">连接异常 ({counts.attention})</option>
          </select>
          <select
            className="toolbar-select"
            aria-label="按连接账号筛选"
            value={account}
            onChange={(e) => updateFilter('account', e.target.value)}
          >
            <option value="all">全部账号</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className="toolbar-select"
            aria-label="排序"
            value={order}
            onChange={(e) => updateFilter('sort', e.target.value)}
          >
            <option value="activity">按活跃度</option>
            <option value="members">按成员数</option>
            <option value="name">按名称</option>
          </select>
        </div>
        {filtering && (
          <div className="filter-summary">
            找到 {filtered.length} 个社群
            <button className="text-button" onClick={() => setParams({}, { replace: true })}>
              <X size={13} />
              清除筛选
            </button>
          </div>
        )}
        {filtered.length ? (
          <div className="table-wrap">
            <table className="groups-table">
              <thead>
                <tr>
                  <th className="check-cell">
                    <input
                      type="checkbox"
                      aria-label="选择当前列表中的全部群"
                      checked={allVisible}
                      ref={(el) => {
                        if (el) el.indeterminate = visibleSelected.length > 0 && !allVisible;
                      }}
                      onChange={(e) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const g of filtered) {
                            if (e.target.checked) next.add(g.id);
                            else next.delete(g.id);
                          }
                          return next;
                        })
                      }
                    />
                  </th>
                  <th>社群</th>
                  <th>连接账号</th>
                  <th className="num">成员</th>
                  <th className="num">24h 消息</th>
                  <th>广告规则</th>
                  <th>入群验证</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((g) => {
                  const synced = g.sync_enabled !== false;
                  const online = groupAccountOnline(g, accounts);
                  const open = () => navigate(synced ? `/inbox/${g.id}` : `/groups/${g.id}`);
                  return (
                    <tr
                      key={g.id}
                      className={selected.has(g.id) ? 'selected' : ''}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('a, button, input, label')) return;
                        open();
                      }}
                    >
                      <td className="check-cell">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${g.name}`}
                          checked={selected.has(g.id)}
                          onChange={(e) => toggle(g.id, e.target.checked)}
                        />
                      </td>
                      <td>
                        <div className="group-cell">
                          <PlatformIcon value={g.is_demo ? 'demo' : g.platform} large />
                          <span>
                            <strong>{g.name}</strong>
                            <small>
                              {g.is_demo ? '演示' : labels[g.platform]} ·{' '}
                              {g.kind === 'channel' ? '频道' : '群组'} · {g.external_id}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td className="muted-cell">{g.account_name}</td>
                      <td className="num">{g.member_count == null ? '—' : n(g.member_count)}</td>
                      <td className="num">{n(g.messages_24h)}</td>
                      <td>
                        {g.policy?.mode === 'enforce' ? (
                          <Badge value="online">{actionNames[g.policy.action] ?? '自动处理'}</Badge>
                        ) : (
                          <Badge value="paused">观察中</Badge>
                        )}
                      </td>
                      <td>
                        {g.policy?.verification_enabled ? (
                          <span className="verify-cell">
                            <Badge value="online">开启</Badge>
                            {g.pending_verifications > 0 && (
                              <span className="pending-note">{g.pending_verifications} 待验证</span>
                            )}
                          </span>
                        ) : (
                          <Badge value="paused">关闭</Badge>
                        )}
                      </td>
                      <td>
                        {!synced ? (
                          <Badge value="paused">未同步</Badge>
                        ) : online ? (
                          <Badge value="online">同步中</Badge>
                        ) : (
                          <Badge value="error">连接异常</Badge>
                        )}
                      </td>
                      <td>
                        <div className="table-row-actions">
                          {synced && (
                            <Link
                              className="icon-btn sm"
                              to={`/inbox/${g.id}`}
                              title="打开聊天"
                              aria-label={`打开${g.name}的聊天`}
                            >
                              <MessagesSquare size={15} />
                            </Link>
                          )}
                          <Link
                            className="icon-btn sm"
                            to={synced ? `/inbox/${g.id}?panel=rules` : `/groups/${g.id}?tab=rules`}
                            title="群设置"
                            aria-label={`${g.name}的群设置`}
                          >
                            <Settings2 size={15} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : groups.length ? (
          <Empty icon={Search} title="没有符合条件的社群" text="换个关键词，或清除平台和状态筛选。" />
        ) : (
          <div className="empty">
            <Empty title="还没有连接社群" text="添加 Telegram 机器人、QQ 或币安账号，然后勾选要管理的群。" />
            <Link className="btn primary" to="/accounts">
              去连接账号 <ArrowRight size={14} />
            </Link>
          </div>
        )}
        <div className="table-foot">
          <span>共 {filtered.length} 个</span>
          <span>成员数以平台最近一次返回为准</span>
        </div>
      </div>
      {selected.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="批量操作">
          <strong>已选 {selected.size} 个群</strong>
          <button className="text-button" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setBulk(true)}>
            <SlidersHorizontal size={15} />
            批量设置
          </button>
        </div>
      )}
      {bulk && <BulkSettings targets={targets} close={() => setBulk(false)} />}
    </div>
  );
}
