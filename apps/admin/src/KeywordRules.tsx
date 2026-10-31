import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ImagePlus, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api, uploadImage, mediaUrl } from './api';
import { keywordRulePayload as payload } from './keyword-form';
import type { KeywordRule as Rule } from './keyword-form';
import './keyword-rules.css';

const actions: Record<string, string> = {
  reply: '自动回复',
  warn: '警告并回复',
  delete: '删除消息',
  mute: '限时禁言',
  remove: '移出成员',
  ban: '封禁成员',
};
const states: Record<string, string> = {
  observed: '命中 · 仅观察',
  cooldown: '命中 · 冷却中',
  pending: '命中 · 等待执行',
  in_flight: '执行中',
  accepted: '平台已接收，等待结果',
  succeeded: '执行成功',
  failed: '执行失败',
  unknown: '结果待核对',
  cancelled: '已取消',
};
type Overview = {
  availability: Record<string, { available: boolean; reason: string | null }>;
  rules: Rule[];
  hits: Record<string, any>[];
};
const blank = (): Rule => ({
  name: '',
  enabled: true,
  mode: 'observe',
  priority: 50,
  match: 'contains',
  keywords: [],
  action: 'reply',
  response: '',
  image_asset_id: null,
  duration_seconds: 600,
  cooldown_seconds: 60,
  exempt_admins: true,
});
export default function KeywordRules({ id, platform }: { id: string; platform: string }) {
  const endpoint = `/conversations/${id}/keyword-rules`;
  const [data, setData] = useState<Overview>();
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [draft, setDraft] = useState<Rule | null>(null);
  const [words, setWords] = useState('');
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState('');
  const [simulatedText, setSimulatedText] = useState('');
  const sequence = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const seq = ++sequence.current;
      try {
        const value = await api<Overview>(endpoint, { signal });
        if (seq === sequence.current && !signal?.aborted) {
          setData(value);
          setLoadError('');
        }
      } catch (e: any) {
        if (seq === sequence.current && !signal?.aborted) setLoadError(e.message);
      }
    },
    [endpoint],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      sequence.current++;
    };
  }, [load]);
  const edit = (rule: Rule) => {
    if (draft && !window.confirm('放弃当前未保存的编辑？')) return;
    setDraft({ ...rule });
    setWords(rule.keywords.join('\n'));
    setError('');
    setNotice('');
  };
  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(success);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const send = draft && ['reply', 'warn'].includes(draft.action);
  const unavailable =
    draft?.mode === 'enforce' && draft.enabled && !data?.availability[draft.action]?.available;
  const conflict = draft?.id && data?.rules.find((r) => r.id === draft.id)?.revision !== draft.revision;
  return (
    <div className="keyword-rules">
      <div className="keyword-heading">
        <div>
          <h3>关键词触发</h3>
          <p>按数字从小到大匹配，每条消息只触发第一条命中的启用规则。</p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => void load()}
            aria-label="刷新关键词规则"
          >
            <RefreshCw size={16} /> 刷新
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || uploading}
            onClick={() => edit(blank())}
          >
            <Plus size={16} /> 新建规则
          </button>
        </div>
      </div>
      <div className="info-box keyword-help">
        默认使用观察模式，只记录命中。自动处理仅作用于新的入站文字及图片说明；历史导入、编辑、机器人回执和跨群转发不会触发。
        原有广告屏蔽、黑名单和活人验证优先处理。同一成员按规则冷却，群内另有 3 秒防刷屏间隔。
        {platform === 'binance' && (
          <p>币安支持回复与警告；限时禁言及其他关键词自动处罚暂不开放，可在「成员管理」手动处理。</p>
        )}
      </div>
      {loadError && (
        <p className="form-error" role="alert">
          {loadError}{' '}
          <button type="button" className="text-button" onClick={() => void load()}>
            重新加载
          </button>
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="info-box" role="status">
          {notice}
        </p>
      )}
      {!data && !loadError && <p role="status">正在读取关键词规则…</p>}
      {draft && (
        <form
          className="keyword-editor"
          onSubmit={(e) => {
            e.preventDefault();
            const value = {
              ...draft,
              keywords: words
                .split('\n')
                .map((w) => w.trim())
                .filter(Boolean),
            };
            if (
              value.enabled &&
              value.mode === 'enforce' &&
              !['reply', 'warn'].includes(value.action) &&
              !window.confirm(
                `启用「${actions[value.action]}」后，新消息命中规则会自动执行此操作。确认保存？`,
              )
            )
              return;
            void run(async () => {
              await api(value.id ? `${endpoint}/${value.id}` : endpoint, {
                method: value.id ? 'PUT' : 'POST',
                body: payload(value),
              });
              setDraft(null);
              setPreview('');
            }, '规则已保存，后续新消息将按新配置匹配；旧规则的待执行任务已取消。');
          }}
        >
          <div className="keyword-heading">
            <h4>{draft.id ? '编辑规则' : '新建规则'}</h4>
            <button
              className="icon-btn"
              type="button"
              aria-label="关闭规则编辑"
              disabled={busy || uploading}
              onClick={() => {
                if (window.confirm('放弃当前未保存的编辑？')) setDraft(null);
              }}
            >
              <X size={18} />
            </button>
          </div>
          <fieldset disabled={busy || uploading}>
            <div className="form-grid">
              <label>
                规则名称
                <input
                  required
                  maxLength={80}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="例如：帮助菜单、广告警告"
                />
              </label>
              <label>
                匹配顺序
                <input
                  type="number"
                  required
                  min={1}
                  max={100}
                  value={draft.priority}
                  onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                />
                <small>数字越小越优先；相同数字按创建顺序。</small>
              </label>
              <label>
                运行模式
                <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
                  <option value="observe">观察模式 · 不执行动作</option>
                  <option value="enforce">自动执行</option>
                </select>
              </label>
              <label>
                匹配方式
                <select value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value })}>
                  <option value="contains">包含任意关键词</option>
                  <option value="exact">整条文字等于任意关键词</option>
                </select>
              </label>
            </div>
            <label>
              关键词
              <textarea
                required
                rows={4}
                value={words}
                onChange={(e) => setWords(e.target.value)}
                placeholder="每行一个，最多 100 个"
              />
              <small>忽略英文大小写、全角半角及常见零宽字符；暂不支持正则或图片识别。</small>
            </label>
            <div className="form-grid">
              <label>
                命中动作
                <select
                  value={draft.action}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      action: e.target.value,
                      response: '',
                      image_asset_id: null,
                      exempt_admins: e.target.value !== 'reply' || draft.exempt_admins,
                    })
                  }
                >
                  {Object.entries(actions).map(([key, label]) => (
                    <option key={key} value={key} disabled={!data?.availability[key]?.available}>
                      {label}
                      {!data?.availability[key]?.available ? '（不可用）' : ''}
                    </option>
                  ))}
                </select>
                <small>
                  {data?.availability[draft.action]?.reason ?? '执行时再次核对在线状态、权限及成员身份。'}
                </small>
              </label>
              <label>
                同一成员冷却（秒）
                <input
                  type="number"
                  required
                  min={5}
                  max={86400}
                  value={draft.cooldown_seconds}
                  onChange={(e) => setDraft({ ...draft, cooldown_seconds: Number(e.target.value) })}
                />
              </label>
              {draft.action === 'mute' && (
                <label>
                  禁言时长（分钟）
                  <input
                    type="number"
                    required
                    min={1}
                    max={43200}
                    step={1}
                    value={draft.duration_seconds / 60}
                    onChange={(e) => setDraft({ ...draft, duration_seconds: Number(e.target.value) * 60 })}
                  />
                  <small>TG、QQ 使用平台限时禁言，到期由平台解除；不覆盖成员已有禁言。</small>
                </label>
              )}
            </div>
            {send && (
              <>
                <label>
                  回复内容
                  <textarea
                    rows={4}
                    required={!draft.image_asset_id}
                    maxLength={draft.image_asset_id ? 1000 : platform === 'binance' ? 2000 : 4000}
                    value={draft.response}
                    onChange={(e) => setDraft({ ...draft, response: e.target.value })}
                    placeholder={
                      draft.action === 'warn'
                        ? '请遵守群规，停止发送此类消息。'
                        : '输入命中后引用回复的固定内容'
                    }
                  />
                  <small>
                    {draft.action === 'warn'
                      ? '平台确认警告消息发送成功后，才计入警告记录；不自动升级处罚。'
                      : '支持纯文字、单张图片及图文回复。'}
                  </small>
                </label>
                {draft.image_asset_id ? (
                  <div className="keyword-image">
                    <img
                      src={mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(draft.image_asset_id)}`)}
                      alt="关键词回复图片预览"
                    />
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => setDraft({ ...draft, image_asset_id: null })}
                    >
                      <Trash2 size={15} /> 移除图片
                    </button>
                  </div>
                ) : (
                  <label className="keyword-upload">
                    <ImagePlus size={18} /> 添加回复图片（JPG / PNG，最多 8 MiB）
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setUploading(true);
                        setError('');
                        try {
                          const image = await uploadImage(file);
                          setDraft((current) =>
                            current ? { ...current, image_asset_id: image.id } : current,
                          );
                        } catch (e: any) {
                          setError(e.message);
                        } finally {
                          setUploading(false);
                        }
                      }}
                    />
                  </label>
                )}
              </>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              启用这条规则
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.exempt_admins}
                disabled={draft.action !== 'reply'}
                onChange={(e) => setDraft({ ...draft, exempt_admins: e.target.checked })}
              />
              管理员豁免
              <small>
                {draft.action !== 'reply'
                  ? '警告和处罚始终保护群主、管理员及机器人自身。'
                  : '开启后先核对角色；无法核对时不自动回复。'}
              </small>
            </label>
            {conflict && (
              <p className="form-error" role="alert">
                此规则已被修改或删除。请关闭编辑后重新打开，避免覆盖新配置。
              </p>
            )}
            {unavailable && (
              <p className="form-error" role="alert">
                当前动作不可用，可切回观察模式或停用规则后保存。
              </p>
            )}
            <div className="button-row">
              <button className="btn primary" disabled={!!unavailable || !!conflict} type="submit">
                {busy ? '正在保存…' : '保存规则'}
              </button>
              <span className="muted">{uploading ? '正在上传图片…' : '修改不会追溯执行历史消息。'}</span>
            </div>
          </fieldset>
        </form>
      )}
      {data && (
        <>
          <div className="keyword-list">
            {!data.rules.length && (
              <div className="keyword-empty">
                <h4>还没有关键词规则</h4>
                <p>先创建一条观察规则，确认命中准确后再开启自动执行。</p>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy || uploading}
                  onClick={() => edit(blank())}
                >
                  创建第一条规则
                </button>
              </div>
            )}
            {data.rules.map((rule) => (
              <article key={rule.id} className={`keyword-rule ${rule.enabled ? '' : 'is-disabled'}`}>
                <div className="keyword-heading">
                  <div>
                    <strong>{rule.name}</strong>
                    <span className="keyword-tag">
                      {!rule.enabled ? '已停用' : rule.mode === 'observe' ? '观察中' : '自动执行'}
                    </span>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy || uploading}
                      onClick={() => edit(rule)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || uploading || (rule.enabled && draft?.id === rule.id)}
                      onClick={() =>
                        void run(
                          () =>
                            api(`${endpoint}/${rule.id}`, {
                              method: 'PUT',
                              body: payload({ ...rule, enabled: !rule.enabled }),
                            }),
                          rule.enabled ? '规则已停用，待执行任务已取消。' : '规则已启用。',
                        )
                      }
                    >
                      {rule.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`删除规则 ${rule.name}`}
                      disabled={busy || uploading}
                      onClick={() => {
                        if (window.confirm(`删除「${rule.name}」？命中及执行记录会保留，待执行任务会取消。`))
                          void run(async () => {
                            await api(`${endpoint}/${rule.id}`, { method: 'DELETE' });
                            if (draft?.id === rule.id) setDraft(null);
                          }, '规则已删除，历史记录已保留。');
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <p>
                  {actions[rule.action]} · {rule.match === 'exact' ? '整条匹配' : '包含匹配'} · 顺序{' '}
                  {rule.priority} · 成员冷却 {rule.cooldown_seconds} 秒
                  {rule.action === 'mute' ? ` · 禁言 ${rule.duration_seconds / 60} 分钟` : ''}
                </p>
                <div className="keyword-words">
                  {rule.keywords.map((word) => (
                    <span key={word}>{word}</span>
                  ))}
                </div>
                {['reply', 'warn'].includes(rule.action) && (
                  <div className="keyword-reply-preview">
                    {rule.image_asset_id && <span>含图片</span>}
                    <p>{rule.response || '仅回复图片'}</p>
                  </div>
                )}
                {rule.mode === 'enforce' && rule.enabled && !data.availability[rule.action]?.available && (
                  <p className="error-text">暂不可执行：{data.availability[rule.action]?.reason}</p>
                )}
              </article>
            ))}
          </div>
          <form
            className="keyword-preview"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api(`${endpoint}/preview`, { method: 'POST', body: { text: sample } });
                setPreview(
                  result.matched
                    ? `命中「${result.name}」：${result.keyword} → ${actions[result.action]}（${result.mode === 'observe' ? '观察模式' : '自动执行'}）`
                    : '未命中任何启用的关键词规则',
                );
              }, '匹配预览完成，未向平台发送消息或执行处罚。');
            }}
          >
            <label>
              测试已保存的关键词规则
              <input
                required
                maxLength={8000}
                value={sample}
                onChange={(e) => {
                  setSample(e.target.value);
                  setPreview('');
                }}
                placeholder="输入一段消息，仅检查关键词匹配"
              />
            </label>
            <button className="btn secondary" disabled={busy} type="submit">
              检查匹配
            </button>
            {preview && (
              <p role="status">{preview}。实际执行还会核对广告规则、验证状态、冷却、权限和成员角色。</p>
            )}
          </form>
          <h4>最近命中与执行结果</h4>
          {import.meta.env.MODE === 'demo' && (
            <form
              className="keyword-preview"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  () => api(`${endpoint}/simulate`, { method: 'POST', body: { text: simulatedText } }),
                  '已在当前浏览器模拟成员发言，可查看下方命中记录及实时消息；未连接真实平台。',
                );
              }}
            >
              <label>
                模拟成员发言
                <input
                  required
                  maxLength={8000}
                  value={simulatedText}
                  onChange={(e) => setSimulatedText(e.target.value)}
                  placeholder="例如：帮助（仅生成虚拟消息）"
                />
              </label>
              <button className="btn secondary" type="submit" disabled={busy}>
                模拟触发规则
              </button>
            </form>
          )}
          <p className="muted">最多显示最近 100 条。命中不代表执行成功；结果待核对的任务不会自动重发。</p>
          <div className="keyword-hits">
            {!data.hits.length && <p>暂无命中记录。</p>}
            {data.hits.map((hit) => (
              <article key={hit.id} className={`keyword-hit ${hit.job_status ?? hit.status}`}>
                <div className="keyword-heading">
                  <strong>
                    {hit.rule_name} · {actions[hit.action]}
                  </strong>
                  <span>
                    {hit.job_status === 'failed' &&
                    ['KEYWORD_PROTECTED', 'KEYWORD_SELF'].includes(hit.error_code)
                      ? '已豁免 · 未执行'
                      : (states[hit.job_status ?? hit.status] ?? hit.status)}
                  </span>
                </div>
                <p>
                  {hit.sender_name ?? hit.user_id} ·{' '}
                  <time dateTime={hit.created_at}>{new Date(hit.created_at).toLocaleString()}</time>
                </p>
                <p>
                  命中：<code>{hit.keyword}</code>
                </p>
                {(hit.last_error || hit.detail) && <p>{hit.last_error || hit.detail}</p>}
                {hit.job_id && (
                  <Link to={`/announcements?delivery=${encodeURIComponent(hit.job_id)}`}>查看执行回执</Link>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
