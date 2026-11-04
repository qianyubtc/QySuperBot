import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { api } from '../../api';
import {
  ActionForm,
  Badge,
  Empty,
  Loading,
  PlatformIcon,
  date,
  labels,
  n,
  useApp,
  useData,
} from '../../console/shared';
import type { Data } from '../../console/shared';
import { CopyButton } from '../../ConsoleTools';
import KeywordRules from '../../KeywordRules';
import Members from './Members';
import QQRequests from '../../QQRequests';
import VerificationList from '../../VerificationList';
import ModerationResult from '../../ModerationResult';
import PolicyForm from './PolicyForm';
import './group.css';

export type PanelTab = 'overview' | 'members' | 'rules' | 'keywords' | 'join' | 'records';
const legacy: Record<string, PanelTab> = {
  policy: 'rules',
  permissions: 'overview',
  messages: 'records',
  'qq-requests': 'join',
  'qq-verifications': 'join',
};
/** Accepts current tab names and the older /groups/:id?tab= values used by saved links. */
export const panelTab = (value: string | null | undefined): PanelTab | undefined =>
  value
    ? ((legacy[value] ??
        (['overview', 'members', 'rules', 'keywords', 'join', 'records'].includes(value)
          ? value
          : undefined)) as PanelTab | undefined)
    : undefined;
const openVerification = ['pending', 'failed', 'expired', 'manual_review', 'cooldown'];

export default function GroupPanel({
  id,
  tab: requested,
  setTab,
  member,
  variant,
  onClose,
  actions,
}: {
  id: string;
  tab?: PanelTab;
  setTab: (tab: PanelTab) => void;
  member?: string | null;
  variant: 'panel' | 'page';
  onClose?: () => void;
  actions?: ReactNode;
}) {
  const { data: g, loading, error } = useData(`/conversations/${id}`, true);
  const { groups } = useApp();
  const summary = groups.find((group) => group.id === id);
  const pending = (g?.verifications ?? []).filter((v: Data) => openVerification.includes(v.status)).length;
  const tabs: [PanelTab, string, number?][] = [
    ['overview', '概况'],
    ['members', '成员'],
    ['rules', '规则'],
    ['keywords', '关键词'],
    ['join', '入群', pending],
    ['records', '记录'],
  ];
  const tab = tabs.some(([key]) => key === requested) ? requested! : 'overview';
  return (
    <div className={`group-panel ${variant}`}>
      {variant === 'panel' && (
        <header className="group-panel-head">
          {g ? (
            <>
              <PlatformIcon value={g.is_demo ? 'demo' : g.platform} large />
              <div>
                <h2>{g.name}</h2>
                <p>
                  {g.kind === 'channel' ? '频道' : '群组'} · {g.account_name}
                </p>
              </div>
            </>
          ) : (
            <div className="skeleton" style={{ height: 36, flex: 1 }} />
          )}
          {onClose && (
            <button className="icon-btn" aria-label="收起群面板" title="收起群面板" onClick={onClose}>
              <X size={17} />
            </button>
          )}
        </header>
      )}
      {variant === 'page' && actions}
      <nav className="tabs group-panel-tabs" role="tablist" aria-label="群管理">
        {tabs.map(([key, name, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {name}
            {!!count && <span className="count">{count}</span>}
          </button>
        ))}
      </nav>
      <div className="group-panel-body">
        <Loading loading={loading && !g} error={error}>
          {g && (
            <>
              {tab === 'overview' && <Overview g={g} summary={summary} pending={pending} setTab={setTab} />}
              {tab === 'members' && <Members key={g.id} g={g} member={member} />}
              {tab === 'rules' && <PolicyForm key={g.id} group={g} />}
              {tab === 'keywords' && <KeywordRules key={g.id} id={g.id} platform={g.platform} />}
              {tab === 'join' && (
                <div className="stack">
                  {g.platform === 'qq' && g.kind === 'group' && <QQRequests key={`r-${g.id}`} id={g.id} />}
                  <VerificationList key={`v-${g.id}`} groupId={g.id} openSettings={() => setTab('rules')} />
                </div>
              )}
              {tab === 'records' && <Records g={g} />}
            </>
          )}
        </Loading>
      </div>
    </div>
  );
}

function Overview({
  g,
  summary,
  pending,
  setTab,
}: {
  g: Data;
  summary?: Data;
  pending: number;
  setTab: (tab: PanelTab) => void;
}) {
  const { refresh, toast } = useApp();
  const [checking, setChecking] = useState(false);
  const binding = g.bindings?.[0];
  const synced = summary?.sync_enabled !== false;
  const permissions = binding?.snapshot?.permissions ?? [];
  return (
    <div className="stack">
      <dl className="facts">
        <div>
          <dt>平台</dt>
          <dd>{g.is_demo ? '本地演示' : labels[g.platform]}</dd>
        </div>
        <div>
          <dt>连接账号</dt>
          <dd>
            {g.account_name} <Badge value={g.account_status} />
          </dd>
        </div>
        <div>
          <dt>群 ID</dt>
          <dd className="mono-row">
            <code>{g.external_id}</code>
            <CopyButton value={g.external_id} label="复制群 ID" />
          </dd>
        </div>
        <div>
          <dt>同步</dt>
          <dd>
            {synced ? (
              <Badge value="online">同步中</Badge>
            ) : (
              <Link
                className="text-link"
                to={`/accounts?groups=${encodeURIComponent(g.executor_account_id)}`}
              >
                未同步，去勾选 <ArrowRight size={13} />
              </Link>
            )}
          </dd>
        </div>
      </dl>
      <div className="stat-grid">
        <div className="stat">
          <span>成员</span>
          <strong>{g.member_count === null || g.member_count === undefined ? '—' : n(g.member_count)}</strong>
        </div>
        <div className="stat">
          <span>24 小时消息</span>
          <strong>{n(summary?.messages_24h)}</strong>
        </div>
        <div className="stat">
          <span>待验证</span>
          <strong className={pending ? 'text-warning' : ''}>{n(pending)}</strong>
        </div>
        <div className="stat">
          <span>累计命中规则</span>
          <strong>{n(summary?.blocked_count)}</strong>
        </div>
      </div>
      <div className="setting-links">
        <button onClick={() => setTab('rules')}>
          <ShieldCheck size={16} />
          <span>
            <strong>广告规则</strong>
            <small>
              {g.policy.mode === 'enforce'
                ? `自动处理 · ${({ delete: '删除消息', remove: '删除并移出', ban: '删除并封禁' } as Data)[g.policy.action] ?? g.policy.action}`
                : '观察模式 · 只记录命中'}
              {' · '}
              {g.policy.keywords.length} 个关键词 · {g.policy.blocked_domains.length} 个域名
            </small>
          </span>
          <Badge value={g.policy.mode === 'enforce' ? 'online' : 'pending'}>
            {g.policy.mode === 'enforce' ? '已启用' : '观察中'}
          </Badge>
        </button>
        <button onClick={() => setTab('rules')}>
          <UserCheck size={16} />
          <span>
            <strong>入群验证</strong>
            <small>
              {g.policy.verification_enabled ? `开启 · ${g.policy.verification_timeout} 秒内完成` : '关闭'}
            </small>
          </span>
          <Badge value={g.policy.verification_enabled ? 'online' : 'paused'}>
            {g.policy.verification_enabled ? '开启' : '关闭'}
          </Badge>
        </button>
        <button onClick={() => setTab('keywords')}>
          <MessageSquareText size={16} />
          <span>
            <strong>关键词触发</strong>
            <small>自动回复、警告与处罚规则</small>
          </span>
          <ArrowRight size={14} />
        </button>
      </div>
      <section className="panel-section">
        <header>
          <h3>
            <KeyRound size={15} />
            平台能力与权限
          </h3>
          <button
            className="btn sm"
            disabled={checking || g.account_status === 'paused' || g.is_demo}
            onClick={async () => {
              setChecking(true);
              try {
                await api(`/accounts/${g.executor_account_id}/permissions-refresh`, { method: 'POST' });
                refresh();
                toast('群权限已刷新');
              } catch (err: any) {
                toast(err.message, true);
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
            刷新
          </button>
        </header>
        <p className="muted">
          执行前会同时检查连接器能力和账号权限，快照超过 5 分钟会要求刷新。最近更新{' '}
          {date(binding?.snapshot?.observed_at)}。
        </p>
        <ul className="capability-list">
          {(binding?.snapshot?.capabilities ?? []).map((c: Data) => {
            const permission = permissions.find((p: Data) => p.capability === c.capability);
            const ok = c.state === 'supported' && permission?.permission === 'granted';
            return (
              <li key={c.capability} title={permission?.reason ?? undefined}>
                <span className={`dot ${ok ? 'online' : c.state === 'unsupported' ? '' : 'warning'}`} />
                <code>{c.capability}</code>
                <small>
                  {c.state !== 'supported'
                    ? c.state === 'unsupported'
                      ? '平台不支持'
                      : '能力未知'
                    : permission?.permission === 'granted'
                      ? '可用'
                      : permission?.permission === 'denied'
                        ? '无权限'
                        : '权限未知'}
                </small>
              </li>
            );
          })}
        </ul>
      </section>
      {g.is_demo && <Simulator id={g.id} />}
    </div>
  );
}

function Simulator({ id }: { id: string }) {
  const { toast } = useApp();
  return (
    <section className="panel-section">
      <header>
        <h3>
          <Bot size={15} />
          演示群测试
        </h3>
      </header>
      <p className="muted">模拟成员发言或入群，体验规则、验证和消息同步。</p>
      <ActionForm
        label="发送模拟事件"
        onSubmit={async (f) => {
          await api(`/conversations/${id}/simulate`, {
            method: 'POST',
            body: {
              user_id: f.get('user_id'),
              type: f.get('type'),
              ...(f.get('text') ? { text: f.get('text') } : {}),
            },
          });
          toast('模拟事件已处理');
        }}
      >
        <div className="form-grid">
          <label>
            成员 ID
            <input name="user_id" required defaultValue="demo-member" pattern="[\w-]{1,64}" />
          </label>
          <label>
            事件
            <select name="type">
              <option value="message">发送消息</option>
              <option value="join">重新入群</option>
            </select>
          </label>
          <label className="wide">
            消息内容
            <input name="text" placeholder="普通讨论，或你设置的广告关键词" maxLength={8000} />
          </label>
        </div>
      </ActionForm>
    </section>
  );
}

function Records({ g }: { g: Data }) {
  return g.messages.length ? (
    <div className="record-list">
      <p className="muted">最近收到的消息与规则判定、处理结果。</p>
      {g.messages.map((m: Data) => (
        <article key={m.id} className={`record ${m.direction}`}>
          <span className="avatar sm">
            {m.direction === 'outgoing' ? <Bot size={13} /> : String(m.sender_name).slice(0, 1)}
          </span>
          <div>
            <div className="record-meta">
              <strong>{m.sender_name}</strong>
              <code>{m.sender_id}</code>
              <time>{date(m.source_at)}</time>
            </div>
            <p className={m.deleted ? 'deleted' : ''}>{m.content}</p>
            <div className="record-meta">
              <Badge value={m.verdict} />
              {m.reason && <small>{m.reason}</small>}
            </div>
            <ModerationResult message={m} demo={g.is_demo} />
          </div>
        </article>
      ))}
    </div>
  ) : (
    <Empty
      icon={Users}
      title="还没有消息记录"
      text="接收的新消息和规则判定会显示在这里；接入前的平台历史不会导入。"
    />
  );
}

export function SyncNotice({ g }: { g: Data }) {
  return (
    <div className="info-box warning">
      <CircleAlert size={15} />
      <span>
        此群未启用同步，收发消息和群管理任务都已暂停。
        <Link className="text-link" to={`/accounts?groups=${encodeURIComponent(g.executor_account_id)}`}>
          在连接账号中勾选 <ArrowRight size={13} />
        </Link>
      </span>
    </div>
  );
}
