import { useState } from 'react';
import { FileText, MessageSquareQuote, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, mediaUrl } from '../../api';
import { ActionForm, Empty, Loading, Modal, date, useApp, useData } from '../../console/shared';
import type { Data } from '../../console/shared';

const kinds = {
  broadcast: { label: '群发模板', icon: FileText, hint: '新建群发时一键填入标题、正文和图片' },
  reply: { label: '聊天常用语', icon: MessageSquareQuote, hint: '在工作台输入框旁一键插入，只支持文字' },
} as const;
type Kind = keyof typeof kinds;

export default function Templates() {
  const [kind, setKind] = useState<Kind>('broadcast');
  const { data, loading, error } = useData<Data[]>(`/templates?kind=${kind}`);
  const [editing, setEditing] = useState<Data | null>(null);
  const [busy, setBusy] = useState('');
  const { refresh, toast } = useApp();
  const Icon = kinds[kind].icon;
  return (
    <div className="templates">
      <div className="toolbar">
        <div className="segmented">
          {(Object.keys(kinds) as Kind[]).map((key) => (
            <button key={key} className={kind === key ? 'active' : ''} onClick={() => setKind(key)}>
              {kinds[key].label}
            </button>
          ))}
        </div>
        <span className="muted">{kinds[kind].hint}</span>
        <span className="spacer" />
        <button className="btn primary sm" onClick={() => setEditing({ kind })}>
          <Plus size={14} />
          新建{kind === 'broadcast' ? '模板' : '常用语'}
        </button>
      </div>
      <Loading loading={loading && !data} error={error}>
        {data?.length ? (
          <ul className="template-list">
            {data.map((t) => (
              <li key={t.id}>
                <Icon size={16} />
                <div>
                  <strong>{t.title}</strong>
                  <p>{t.content || '[图片]'}</p>
                  <small>更新于 {date(t.updated_at)}</small>
                </div>
                {t.image_asset_id && (
                  <img
                    src={mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(t.image_asset_id)}`)}
                    alt=""
                  />
                )}
                <div className="template-actions">
                  <button className="icon-btn sm" aria-label={`编辑${t.title}`} onClick={() => setEditing(t)}>
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn sm"
                    aria-label={`删除${t.title}`}
                    disabled={busy === t.id}
                    onClick={async () => {
                      if (!window.confirm(`删除“${t.title}”？`)) return;
                      setBusy(t.id);
                      try {
                        await api(`/templates/${t.id}`, { method: 'DELETE' });
                        refresh();
                        toast('已删除');
                      } catch (err: any) {
                        toast(err.message, true);
                      } finally {
                        setBusy('');
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            icon={Icon}
            title={`还没有${kinds[kind].label}`}
            text={
              kind === 'broadcast'
                ? '常发的通知存成模板，下次群发直接套用。'
                : '把常用的回复存起来，聊天时一键插入。'
            }
          />
        )}
      </Loading>
      {editing && (
        <Modal
          title={editing.id ? '编辑' : `新建${kinds[editing.kind as Kind].label}`}
          close={() => setEditing(null)}
        >
          <ActionForm
            className="stack-form"
            cancel={() => setEditing(null)}
            onSubmit={async (f) => {
              const body = {
                kind: editing.kind,
                title: f.get('title'),
                content: f.get('content'),
                image_asset_id: editing.image_asset_id ?? null,
              };
              await api(editing.id ? `/templates/${editing.id}` : '/templates', {
                method: editing.id ? 'PUT' : 'POST',
                body,
              });
              toast('已保存');
              setEditing(null);
            }}
          >
            <label>
              名称
              <input name="title" required maxLength={80} defaultValue={editing.title ?? ''} data-autofocus />
            </label>
            <label>
              内容
              <textarea
                name="content"
                rows={6}
                maxLength={8000}
                required={!editing.image_asset_id}
                defaultValue={editing.content ?? ''}
              />
              {editing.image_asset_id && <small>附带一张图片，可在新建群发时更换</small>}
            </label>
          </ActionForm>
        </Modal>
      )}
    </div>
  );
}
