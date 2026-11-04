import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessagesSquare, Settings2 } from 'lucide-react';
import { PlatformIcon, useApp } from '../../console/shared';
import GroupPanel, { SyncNotice, panelTab } from './GroupPanel';
import type { PanelTab } from './GroupPanel';

/** Standalone group settings. Synced groups open in the workspace with the group panel instead. */
export default function GroupPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { groups } = useApp();
  const g = groups.find((group) => group.id === id);
  const member = params.get('member');
  const tab =
    panelTab(params.get('tab')) ?? (params.has('verification') ? 'join' : member ? 'members' : undefined);
  if (!id) return <Navigate replace to="/groups" />;
  if (g && g.sync_enabled !== false) {
    const next = new URLSearchParams({ panel: tab ?? 'overview' });
    if (member) next.set('member', member);
    return <Navigate replace to={`/inbox/${id}?${next}`} />;
  }
  const setTab = (next: PanelTab) => {
    const updated = new URLSearchParams(params);
    updated.set('tab', next);
    if (next !== 'members') updated.delete('member');
    setParams(updated);
  };
  return (
    <div className="page narrow">
      <Link className="back-link" to="/groups">
        <ArrowLeft size={14} />
        群组
      </Link>
      <div className="page-head">
        <div className="group-page-title">
          {g && <PlatformIcon value={g.is_demo ? 'demo' : g.platform} large />}
          <div>
            <h1>{g?.name ?? '群详情'}</h1>
            {g && (
              <p>
                {g.kind === 'channel' ? '频道' : '群组'} · {g.account_name}
              </p>
            )}
          </div>
        </div>
        {g && (
          <div className="head-actions">
            {g.sync_enabled === false ? (
              <Link
                className="btn primary"
                to={`/accounts?groups=${encodeURIComponent(g.executor_account_id)}`}
              >
                <Settings2 size={15} />
                恢复同步
              </Link>
            ) : (
              <Link className="btn primary" to={`/inbox/${id}`}>
                <MessagesSquare size={15} />
                打开工作台
              </Link>
            )}
          </div>
        )}
      </div>
      {g?.sync_enabled === false && <SyncNotice g={g} />}
      <div className="card group-page-card">
        <GroupPanel id={id} tab={tab} setTab={setTab} member={member} variant="page" />
      </div>
    </div>
  );
}
