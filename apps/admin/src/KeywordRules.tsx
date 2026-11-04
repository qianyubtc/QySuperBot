import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ImagePlus, Plus, RefreshCw, Tags, Trash2, X } from 'lucide-react';
import { date } from './console/shared';
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
  const hitState = (hit: Record<string, any>) =>
    hit.job_status === 'failed' && ['KEYWORD_PROTECTED', 'KEYWORD_SELF'].includes(hit.error_code)
      ? { tone: 'plain', label: '已豁免 · 未执行' }
      : { tone: hit.job_status ?? hit.status, label: states[hit.job_status ?? hit.status] ?? hit.status };
  return (
    <div className="keyword-rules">
      <header className="keyword-head">
        <div>
          <h3>关键词规则{data?.rules.length ? <span className="count">{data.rules.length}</span> : null}</h3>
          <p>按顺序匹配，每条消息只触发第一条命中的启用规则。</p>
        </div>
        <div className="keyword-head-actions">
          <button
            type="button"
            className="icon-btn"
            disabled={busy}
            onClick={() => void load()}
            aria-label="刷新关键词规则"
            title="刷新"
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={busy || uploading}
            onClick={() => edit(blank())}
          >
            <Plus size={15} /> 新建规则
          </button>
        </div>
      </header>
      <details className="keyword-notes">
        <summary>生效范围</summary>
        <ul>
          <li>新规则默认观察模式，只记录命中，不执行动作。</li>
          <li>只处理新的入站文字和图片说明；历史导入、编辑、机器人回执和跨群转发不触发。</li>
          <li>广告屏蔽、黑名单和入群验证优先；同一成员按规则冷却，群内另有 3 秒防刷屏间隔。</li>
        </ul>
      </details>
      {platform === 'binance' && (
        <p className="keyword-platform-note">币安只支持回复与警告；禁言等处罚请在成员管理中手动处理。</p>
      )}
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
      {!data && !loadError && (
        <p className="muted" role="status">
          正在读取关键词规则…
        </p>
      )}
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
          <header className="keyword-editor-head">
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
              <X size={16} />
            </button>
          </header>
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
                <small>数字越小越先匹配</small>
              </label>
              <label>
                运行模式
                <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
                  <option value="observe">观察 · 只记录命中</option>
                  <option value="enforce">自动执行</option>
                </select>
              </label>
              <label>
                匹配方式
                <select value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value })}>
                  <option value="contains">包含任意关键词</option>
                  <option value="exact">整条消息等于关键词</option>
                </select>
              </label>
              <label className="full">
                关键词
                <textarea
                  required
                  rows={4}
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                  placeholder="每行一个，最多 100 个"
                />
                <small>忽略大小写、全半角和零宽字符；不支持正则。</small>
              </label>
            </div>
            <div className="keyword-section-title">命中后</div>
            <div className="form-grid">
              <label>
                动作
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
                {data?.availability[draft.action]?.reason && (
                  <small>{data.availability[draft.action]!.reason}</small>
                )}
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
                  <small>到期由平台解除，不覆盖已有禁言</small>
                </label>
              )}
              {send && (
                <label className="full">
                  {draft.action === 'warn' ? '警告内容' : '回复内容'}
                  <textarea
                    rows={3}
                    required={!draft.image_asset_id}
                    maxLength={draft.image_asset_id ? 1000 : platform === 'binance' ? 2000 : 4000}
                    value={draft.response}
                    onChange={(e) => setDraft({ ...draft, response: e.target.value })}
                    placeholder={
                      draft.action === 'warn' ? '请遵守群规，停止发送此类消息。' : '命中后引用回复的内容'
                    }
                  />
                  {draft.action === 'warn' && <small>警告发送成功后才计入警告次数，不自动升级处罚</small>}
                </label>
              )}
            </div>
            {send &&
              (draft.image_asset_id ? (
                <div className="keyword-image">
                  <img
                    src={mediaUrl(`/api/v1/uploads/images/${encodeURIComponent(draft.image_asset_id)}`)}
                    alt="关键词回复图片预览"
                  />
                  <button
                    className="btn sm"
                    type="button"
                    onClick={() => setDraft({ ...draft, image_asset_id: null })}
                  >
                    <Trash2 size={14} /> 移除图片
                  </button>
                </div>
              ) : (
                <label className="keyword-upload">
                  <ImagePlus size={16} />{' '}
                  {uploading ? '正在上传图片…' : '附加一张图片（JPG / PNG，8 MiB 内）'}
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
                        setDraft((current) => (current ? { ...current, image_asset_id: image.id } : current));
                      } catch (e: any) {
                        setError(e.message);
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                </label>
              ))}
            <div className="keyword-switches">
              <label className="settings-row">
                <div>
                  <strong>启用这条规则</strong>
                  <small>{draft.enabled ? '保存后立即参与匹配' : '保存为停用状态'}</small>
                </div>
                <span className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.enabled}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  />
                  <span />
                </span>
              </label>
              <label className="settings-row">
                <div>
                  <strong>管理员豁免</strong>
                  <small>
                    {draft.action !== 'reply'
                      ? '警告和处罚始终不作用于群主、管理员和机器人'
                      : '先核对发言人角色，无法核对时不回复'}
                  </small>
                </div>
                <span className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.exempt_admins}
                    disabled={draft.action !== 'reply'}
                    onChange={(e) => setDraft({ ...draft, exempt_admins: e.target.checked })}
                  />
                  <span />
                </span>
              </label>
            </div>
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
            <div className="keyword-editor-foot">
              <span className="muted">修改不追溯历史消息</span>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  if (window.confirm('放弃当前未保存的编辑？')) setDraft(null);
                }}
              >
                取消
              </button>
              <button className="btn primary" disabled={!!unavailable || !!conflict} type="submit">
                {busy ? '正在保存…' : '保存规则'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {data && (
        <>
          {!data.rules.length ? (
            !draft && (
              <div className="empty keyword-empty">
                <Tags />
                <h3>还没有关键词规则</h3>
                <p>先用观察模式确认命中准确，再开启自动执行。</p>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || uploading}
                  onClick={() => edit(blank())}
                >
                  <Plus size={15} /> 创建第一条规则
                </button>
              </div>
            )
          ) : (
            <ul className="keyword-list">
              {data.rules.map((rule) => {
                const blocked =
                  rule.mode === 'enforce' && rule.enabled && !data.availability[rule.action]?.available;
                return (
                  <li key={rule.id} className={`keyword-rule ${rule.enabled ? '' : 'is-disabled'}`}>
                    <div className="keyword-rule-head">
                      <span className="keyword-order" title="匹配顺序">
                        {rule.priority}
                      </span>
                      <strong>{rule.name}</strong>
                      <span
                        className={`badge ${!rule.enabled ? 'plain' : rule.mode === 'observe' ? 'info' : 'success'}`}
                      >
                        <i />
                        {!rule.enabled ? '已停用' : rule.mode === 'observe' ? '观察中' : '自动执行'}
                      </span>
                      <div className="keyword-rule-actions">
                        <button
                          type="button"
                          className="text-button"
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
                          className="icon-btn sm"
                          aria-label={`删除规则 ${rule.name}`}
                          disabled={busy || uploading}
                          onClick={() => {
                            if (
                              window.confirm(`删除「${rule.name}」？命中及执行记录会保留，待执行任务会取消。`)
                            )
                              void run(async () => {
                                await api(`${endpoint}/${rule.id}`, { method: 'DELETE' });
                                if (draft?.id === rule.id) setDraft(null);
                              }, '规则已删除，历史记录已保留。');
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="keyword-words">
                      {rule.keywords.slice(0, 12).map((word) => (
                        <span key={word}>{word}</span>
                      ))}
                      {rule.keywords.length > 12 && (
                        <span className="more">+{rule.keywords.length - 12}</span>
                      )}
                    </div>
                    <p className="keyword-rule-meta">
                      {actions[rule.action]}
                      {rule.action === 'mute' ? ` ${rule.duration_seconds / 60} 分钟` : ''} ·{' '}
                      {rule.match === 'exact' ? '整条匹配' : '包含匹配'} · 冷却 {rule.cooldown_seconds} 秒
                      {['reply', 'warn'].includes(rule.action) && (
                        <span className="keyword-reply">
                          {rule.image_asset_id && <ImagePlus size={12} />}
                          {rule.response || '仅图片'}
                        </span>
                      )}
                    </p>
                    {blocked && (
                      <p className="error-text">暂不可执行：{data.availability[rule.action]?.reason}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <section className="keyword-test">
            <form
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
              <input
                required
                aria-label="测试已保存的关键词规则"
                maxLength={8000}
                value={sample}
                onChange={(e) => {
                  setSample(e.target.value);
                  setPreview('');
                }}
                placeholder="输入一段消息，测试会命中哪条规则"
              />
              <button className="btn" disabled={busy} type="submit">
                测试匹配
              </button>
            </form>
            {preview && (
              <p className="keyword-test-result" role="status">
                {preview}
                <small>实际执行还会核对广告规则、验证、冷却、权限和成员角色。</small>
              </p>
            )}
            {import.meta.env.MODE === 'demo' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => api(`${endpoint}/simulate`, { method: 'POST', body: { text: simulatedText } }),
                    '已在当前浏览器模拟成员发言，可查看下方命中记录及实时消息；未连接真实平台。',
                  );
                }}
              >
                <input
                  required
                  aria-label="模拟成员发言"
                  maxLength={8000}
                  value={simulatedText}
                  onChange={(e) => setSimulatedText(e.target.value)}
                  placeholder="模拟成员发言，例如：帮助"
                />
                <button className="btn" type="submit" disabled={busy}>
                  模拟触发
                </button>
              </form>
            )}
          </section>
          <section className="keyword-hits">
            <header>
              <h4>最近命中</h4>
              <small>最近 100 条 · 结果待核对的任务不会自动重发</small>
            </header>
            {!data.hits.length ? (
              <p className="muted">暂无命中记录。</p>
            ) : (
              <ul>
                {data.hits.map((hit) => {
                  const state = hitState(hit);
                  return (
                    <li key={hit.id} className="keyword-hit">
                      <div className="keyword-hit-main">
                        <strong>
                          {hit.rule_name} · {actions[hit.action]}
                        </strong>
                        <small>
                          {hit.sender_name ?? hit.user_id} ·{' '}
                          <time dateTime={hit.created_at}>{date(hit.created_at)}</time> · 命中{' '}
                          <code>{hit.keyword}</code>
                        </small>
                        {(hit.last_error || hit.detail) && (
                          <small className={hit.last_error ? 'error-text' : ''}>
                            {hit.last_error || hit.detail}
                          </small>
                        )}
                      </div>
                      <div className="keyword-hit-state">
                        <span className={`badge ${state.tone}`}>
                          <i />
                          {state.label}
                        </span>
                        {hit.job_id && (
                          <Link to={`/announcements?delivery=${encodeURIComponent(hit.job_id)}`}>回执</Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
