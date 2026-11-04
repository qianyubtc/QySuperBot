import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Bot, FileText, ImagePlus, LoaderCircle, Send, Trash2, X } from 'lucide-react';
import { api, RequestError, exampleImage, mediaUrl, uploadImage } from '../../api';
import { GroupChoices, Modal, Platform, groupAccountOnline, useApp } from '../../console/shared';
import type { Data } from '../../console/shared';
import { selectedAvailableIds } from '../../workbench';

const beijingInput = (iso: string) =>
  new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 16);

/** One-screen broadcast composer. With `editing`, it replaces a scheduled broadcast that has not started. */
export default function Compose({ close, editing }: { close: () => void; editing?: Data }) {
  const { toast, groups, accounts, refresh } = useApp();
  const request = useRef<{ intent: string; key: string } | undefined>(undefined);
  const [image, setImage] = useState<Data | undefined>(
    editing?.image_asset_id ? { id: editing.image_asset_id } : undefined,
  );
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [title, setTitle] = useState(editing?.title ?? '');
  const [content, setContent] = useState(editing?.content ?? '');
  const [targets, setTargets] = useState<string[]>(
    editing ? (editing.targets ?? editing.deliveries?.map((d: Data) => d.conversation_id) ?? []) : [],
  );
  const [timing, setTiming] = useState(editing ? 'scheduled' : 'now');
  const [scheduled, setScheduled] = useState(editing ? beijingInput(editing.scheduled_at) : '');
  const [discard, setDiscard] = useState(false);
  const [templates, setTemplates] = useState<Data[] | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const initial = useRef(JSON.stringify([title, content, image?.id, targets, timing, scheduled]));
  const dirty = JSON.stringify([title, content, image?.id, targets, timing, scheduled]) !== initial.current;
  const closeCompose = () => (dirty ? setDiscard(true) : close());
  useEffect(() => {
    if (!dirty || submitting) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, submitting]);
  useEffect(() => {
    if (!templatesOpen || templates) return;
    api<Data[]>('/templates?kind=broadcast')
      .then(setTemplates)
      .catch((err) => {
        setTemplates([]);
        toast(err.message, true);
      });
  }, [templatesOpen]);
  const selectedGroups = groups.filter((g) => targets.includes(g.id) && g.sync_enabled !== false);
  const textLimit = Math.min(
    8000,
    ...selectedGroups.map((g) =>
      g.platform === 'telegram' ? (image ? 1024 : 4096) : g.platform === 'binance' ? 2000 : 8000,
    ),
  );
  const offlineTargets = selectedGroups.filter((g) => !groupAccountOnline(g, accounts));
  const tooLong = content.trim().length > textLimit;
  const scheduleTime = scheduled ? new Date(`${scheduled}+08:00`) : null;
  const invalidSchedule =
    timing === 'scheduled' &&
    (!scheduleTime || !Number.isFinite(scheduleTime.getTime()) || scheduleTime.getTime() <= Date.now());
  const blockReason = uploading
    ? '正在上传图片…'
    : uploadError
      ? '请先处理图片上传错误'
      : !title.trim()
        ? '填写任务标题'
        : !content.trim() && !image
          ? '填写正文或添加图片'
          : !selectedGroups.length
            ? '至少选择一个目标群'
            : offlineTargets.length && timing === 'now'
              ? '有目标群离线，可取消选择或改为定时发送'
              : tooLong
                ? `正文超出上限 ${textLimit} 字`
                : invalidSchedule
                  ? '选择一个未来的北京时间'
                  : '';
  const minSchedule = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16);
  const imageUrl = image && mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(image.id)}`);

  async function submit() {
    if (blockReason || submitting) return;
    setError('');
    const ids = selectedAvailableIds(targets, groups as { id: string; sync_enabled?: boolean }[]).sort();
    const at = timing === 'scheduled' ? new Date(`${scheduled}+08:00`) : null;
    const body = {
      title,
      content,
      ...(image ? { image_asset_id: image.id } : {}),
      conversation_ids: ids,
      ...(at ? { scheduled_at: at.toISOString() } : {}),
    };
    const intent = JSON.stringify(body);
    if (!request.current || request.current.intent !== intent)
      request.current = { intent, key: crypto.randomUUID() };
    setSubmitting(true);
    try {
      if (editing) await api(`/announcements/${editing.id}`, { method: 'PUT', body });
      else
        await api('/announcements', {
          method: 'POST',
          body,
          key: request.current.key,
          signal: AbortSignal.timeout(15_000),
        });
      toast(
        editing
          ? '定时群发已更新'
          : timing === 'scheduled'
            ? '定时群发已创建'
            : '群发已加入发送队列，可在记录中查看每个群的结果',
      );
      refresh();
      close();
    } catch (err) {
      setError(
        err instanceof RequestError
          ? err.message
          : '提交结果暂未确认。请先查看群发记录，确认没有创建后再重试，以免重复发送。',
      );
    } finally {
      setSubmitting(false);
    }
  }
  async function saveTemplate() {
    if (!title.trim() || (!content.trim() && !image)) {
      toast('先填写标题和正文（或图片）再保存为模板', true);
      return;
    }
    setSavingTemplate(true);
    try {
      const saved = await api('/templates', {
        method: 'POST',
        body: { kind: 'broadcast', title: title.trim(), content, image_asset_id: image?.id ?? null },
      });
      setTemplates((current) => (current ? [saved, ...current] : current));
      toast('已保存为群发模板');
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setSavingTemplate(false);
    }
  }
  return (
    <Modal
      wide
      title={editing ? '修改定时群发' : '新建群发'}
      description={
        editing
          ? '保存后，原来的定时任务会被新的内容、目标和时间替换。'
          : '一次发送到多个群，每个群分别记录发送结果。'
      }
      close={closeCompose}
      dismissDisabled={submitting}
    >
      {discard && (
        <div className="discard-prompt" role="alert">
          <span>
            <strong>放弃这次编辑？</strong>已填写的内容还没有提交。
          </span>
          <button type="button" className="btn sm" onClick={() => setDiscard(false)}>
            继续编辑
          </button>
          <button type="button" className="btn sm danger" onClick={close}>
            放弃
          </button>
        </div>
      )}
      <div className="compose" inert={submitting || discard}>
        <section className="compose-main">
          <label className="field">
            任务标题
            <input
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：周五社群活动通知（只在后台显示）"
              data-autofocus
            />
          </label>
          <div className="field">
            <span className="label-row">
              正文
              <span className="compose-tools">
                <span className="menu-anchor">
                  <button type="button" className="btn sm ghost" onClick={() => setTemplatesOpen((v) => !v)}>
                    <FileText size={13} />
                    使用模板
                  </button>
                  {templatesOpen && (
                    <div className="menu" role="menu">
                      {!templates ? (
                        <div className="menu-empty">
                          <LoaderCircle className="spin" size={14} /> 正在读取
                        </div>
                      ) : templates.length ? (
                        templates.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              if (!title.trim()) setTitle(t.title);
                              setContent(t.content);
                              setImage(t.image_asset_id ? { id: t.image_asset_id } : undefined);
                              setTemplatesOpen(false);
                            }}
                          >
                            <strong>{t.title}</strong>
                            <small>{t.content || '[图片]'}</small>
                          </button>
                        ))
                      ) : (
                        <div className="menu-empty">还没有模板。写好内容后点“存为模板”。</div>
                      )}
                    </div>
                  )}
                </span>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={savingTemplate}
                  onClick={() => void saveTemplate()}
                >
                  <BookmarkPlus size={13} />
                  存为模板
                </button>
              </span>
            </span>
            <textarea
              rows={9}
              maxLength={8000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={image ? '图片说明，可以留空只发图片' : '要发送到群里的消息…'}
            />
            <small className={tooLong ? 'error-text' : ''}>
              {content.trim().length} / {textLimit}
              {selectedGroups.length ? ' · 按所选平台中最小的上限计算' : ' · 选好群后按平台计算上限'}
            </small>
          </div>
          <div className="compose-image">
            {image ? (
              <div className="compose-image-preview">
                <img src={imageUrl} alt="群发图片预览" />
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label="移除图片"
                  onClick={() => setImage(undefined)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ) : (
              <label className="compose-upload">
                {uploading ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
                {uploading ? '正在上传…' : '添加图片'}
                <small>
                  {import.meta.env.MODE === 'demo' ? 'JPG / PNG，不超过 1 MiB' : 'JPG / PNG，不超过 8 MiB'}
                </small>
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  disabled={uploading}
                  aria-label="上传群发图片"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    setUploading(true);
                    setUploadError('');
                    try {
                      setImage(await uploadImage(file));
                    } catch (err: any) {
                      setUploadError(err.message || '图片上传失败');
                    } finally {
                      setUploading(false);
                    }
                  }}
                />
              </label>
            )}
            {import.meta.env.MODE === 'demo' && !image && (
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  void exampleImage()
                    .then(setImage)
                    .catch((e) => setUploadError(e.message))
                }
              >
                使用示例海报
              </button>
            )}
            {uploadError && (
              <p className="error-text" role="alert">
                {uploadError}{' '}
                <button type="button" className="text-button" onClick={() => setUploadError('')}>
                  知道了
                </button>
              </p>
            )}
          </div>
          <div className="compose-preview" aria-label="消息预览">
            <span className="eyebrow">预览</span>
            <div className="compose-preview-line">
              <span className="avatar sm">
                <Bot size={13} />
              </span>
              <div className={`compose-preview-bubble ${!content.trim() && !image ? 'placeholder' : ''}`}>
                {content.trim() ? <p>{content}</p> : !image && <p>消息内容会显示在这里</p>}
                {image && <img src={imageUrl} alt="" />}
              </div>
            </div>
          </div>
        </section>
        <aside className="compose-side">
          <div className="field">
            <span className="label-row">
              目标群
              <small>{selectedGroups.length} 个已选</small>
            </span>
            <GroupChoices sendable value={targets} onChange={setTargets} allowOffline />
          </div>
          {!!selectedGroups.length && (
            <div className="chip-list">
              {selectedGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="chip"
                  aria-label={`取消选择${g.name}`}
                  onClick={() => setTargets((current) => current.filter((id) => id !== g.id))}
                >
                  {g.name}
                  <X size={12} />
                </button>
              ))}
            </div>
          )}
          {!!offlineTargets.length && (
            <p className={timing === 'scheduled' ? 'info-box' : 'info-box warning'} role="status">
              {offlineTargets.map((g) => g.name).join('、')} 当前离线
              {timing === 'scheduled' ? '，请在发送时间前恢复连接。' : '。可取消选择，或改为定时发送。'}
            </p>
          )}
          <div className="field">
            发送时间
            <div className="segmented">
              <button
                type="button"
                className={timing === 'now' ? 'active' : ''}
                onClick={() => setTiming('now')}
              >
                立即发送
              </button>
              <button
                type="button"
                className={timing === 'scheduled' ? 'active' : ''}
                onClick={() => setTiming('scheduled')}
              >
                定时发送
              </button>
            </div>
            {timing === 'scheduled' && (
              <>
                <input
                  type="datetime-local"
                  required
                  min={minSchedule}
                  value={scheduled}
                  onChange={(e) => setScheduled(e.target.value)}
                  aria-label="北京时间"
                />
                <small>北京时间（UTC+8），每个群生成独立的定时任务</small>
              </>
            )}
          </div>
          {!!selectedGroups.length && (
            <div className="compose-targets">
              {['telegram', 'qq', 'binance', 'custom'].map((p) => {
                const count = selectedGroups.filter((g) => g.platform === p).length;
                return count ? (
                  <span key={p}>
                    <Platform value={p} />
                    <b>{count}</b>
                  </span>
                ) : null;
              })}
            </div>
          )}
        </aside>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions compose-actions">
        <span className="form-actions-summary">
          {blockReason ||
            `${timing === 'scheduled' ? '定时' : '立即'}向 ${selectedGroups.length} 个群发送${
              image ? (content.trim() ? '图文' : '图片') : '文字'
            }`}
        </span>
        <button type="button" className="btn" onClick={closeCompose} disabled={submitting}>
          取消
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!!blockReason || submitting}
          onClick={() => void submit()}
        >
          {submitting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
          {editing
            ? '保存修改'
            : timing === 'scheduled'
              ? '创建定时群发'
              : `发送到 ${selectedGroups.length} 个群`}
        </button>
      </div>
    </Modal>
  );
}
