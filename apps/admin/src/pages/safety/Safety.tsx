import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Ban, Plus, Search, ShieldCheck, ShieldOff, UserCheck } from 'lucide-react';
import { api } from '../../api';
import {
  ActionForm,
  Empty,
  GroupSelect,
  Loading,
  Modal,
  date,
  n,
  useApp,
  useData,
} from '../../console/shared';
import type { Data } from '../../console/shared';
import VerificationList from '../../VerificationList';
import './safety.css';

export default function Safety() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'blacklists' ? 'blacklists' : 'verifications';
  const [add, setAdd] = useState(false);
  const { refresh, toast, groups } = useApp();
  const { data: blacklist, loading, error } = useData<Data[]>('/blacklists', true);
  const synced = groups.filter((g) => g.sync_enabled !== false);
  const enforce = synced.filter((g) => g.policy?.mode === 'enforce').length;
  const verifying = synced.filter((g) => g.policy?.verification_enabled).length;
  const unprotected = synced.filter((g) => g.policy?.mode !== 'enforce' && !g.policy?.verification_enabled);
  const pending = groups.reduce((sum, g) => sum + Number(g.pending_verifications ?? 0), 0);
  const setTab = (value: string) =>
    setParams(value === 'verifications' ? {} : { tab: value }, { replace: true });
  return (
    <div className="page safety">
      <div className="page-head">
        <div>
          <h1>安全中心</h1>
          <p>跨群处理入群验证和黑名单。广告与验证规则在每个群的群面板里设置，也可以在群组页批量设置。</p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={() => setAdd(true)}>
            <Plus size={15} />
            添加黑名单
          </button>
        </div>
      </div>
      <div className="metrics">
        <button className={`metric ${pending ? 'attention' : ''}`} onClick={() => setTab('verifications')}>
          <span>
            待验证成员 <UserCheck size={15} />
          </span>
          <strong>{n(pending)}</strong>
          <small>入群后还没完成验证</small>
        </button>
        <Link to="/groups" className="metric">
          <span>
            自动处理广告 <ShieldCheck size={15} />
          </span>
          <strong>
            {enforce}
            <small> / {synced.length}</small>
          </strong>
          <small>其余群为观察模式，只记录命中</small>
        </Link>
        <Link to="/groups" className="metric">
          <span>
            开启入群验证 <UserCheck size={15} />
          </span>
          <strong>
            {verifying}
            <small> / {synced.length}</small>
          </strong>
          <small>同步中的群</small>
        </Link>
        <button className="metric" onClick={() => setTab('blacklists')}>
          <span>
            黑名单 <Ban size={15} />
          </span>
          <strong>{n(blacklist?.length ?? 0)}</strong>
          <small>按群生效</small>
        </button>
      </div>
      {unprotected.length > 0 && (
        <div className="info-box warning safety-coverage">
          <ShieldOff size={15} />
          <span>
            {unprotected.length} 个同步中的群没有开启自动处理，也没有开启入群验证：
            {unprotected
              .slice(0, 4)
              .map((g) => g.name)
              .join('、')}
            {unprotected.length > 4 ? ` 等` : ''}
          </span>
          <Link className="text-link" to="/groups">
            去批量设置 <ArrowRight size={13} />
          </Link>
        </div>
      )}
      <div className="card">
        <nav className="tabs card-tabs">
          <button className={tab === 'verifications' ? 'active' : ''} onClick={() => setTab('verifications')}>
            成员验证
            {pending > 0 && <span className="count">{pending}</span>}
          </button>
          <button className={tab === 'blacklists' ? 'active' : ''} onClick={() => setTab('blacklists')}>
            黑名单
            {!!blacklist?.length && <span className="count">{blacklist.length}</span>}
          </button>
        </nav>
        {tab === 'verifications' ? (
          <div className="card-body">
            <VerificationList />
          </div>
        ) : (
          <Loading loading={loading && !blacklist} error={error}>
            <Blacklist
              rows={blacklist ?? []}
              remove={async (id) => {
                if (!window.confirm('从黑名单移除这位成员？')) return;
                try {
                  await api(`/blacklists/${id}`, { method: 'DELETE' });
                  refresh();
                  toast('已移出黑名单');
                } catch (err: any) {
                  toast(err.message, true);
                }
              }}
            />
          </Loading>
        )}
      </div>
      {add && (
        <Modal
          title="添加黑名单"
          description="只对所选的群生效，成员之后的发言会被自动处理。"
          close={() => setAdd(false)}
        >
          <ActionForm
            className="stack-form"
            label="加入黑名单"
            cancel={() => setAdd(false)}
            onSubmit={async (f) => {
              await api('/blacklists', {
                method: 'POST',
                body: {
                  conversation_id: f.get('conversation_id'),
                  user_id: f.get('user_id'),
                  reason: f.get('reason'),
                  ...(f.get('expires')
                    ? { expires_at: new Date(String(f.get('expires'))).toISOString() }
                    : {}),
                },
              });
              setAdd(false);
              setTab('blacklists');
              toast('已加入黑名单');
            }}
          >
            <label>
              群
              <GroupSelect />
            </label>
            <label>
              成员 ID
              <input required name="user_id" maxLength={256} placeholder="平台上的成员 ID，不是昵称" />
            </label>
            <label>
              原因
              <input required name="reason" maxLength={500} placeholder="例如：多次发广告" />
            </label>
            <label>
              到期时间
              <input type="datetime-local" name="expires" />
              <small>留空表示长期有效</small>
            </label>
          </ActionForm>
        </Modal>
      )}
    </div>
  );
}

function Blacklist({ rows, remove }: { rows: Data[]; remove: (id: string) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const visible = rows.filter((v) =>
    `${v.user_id} ${v.conversation_name} ${v.reason}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  if (!rows.length)
    return (
      <Empty
        icon={Ban}
        title="黑名单是空的"
        text="把成员加入某个群的黑名单后，他在该群之后的发言会被自动处理。"
      />
    );
  return (
    <>
      <div className="toolbar">
        <label className="search">
          <Search size={15} />
          <input
            placeholder="搜索成员 ID、群或原因"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>成员 ID</th>
              <th>群</th>
              <th>原因</th>
              <th>到期</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((v) => (
              <tr key={v.id}>
                <td>
                  <code>{v.user_id}</code>
                </td>
                <td>{v.conversation_name}</td>
                <td>{v.reason}</td>
                <td className="numeric">{v.expires_at ? date(v.expires_at) : '长期有效'}</td>
                <td>
                  <div className="table-row-actions">
                    <button className="btn sm ghost" onClick={() => void remove(v.id)}>
                      移除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
