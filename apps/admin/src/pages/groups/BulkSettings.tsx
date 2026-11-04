import { useState } from 'react';
import { CheckCircle2, CircleAlert, CircleMinus, Copy, LoaderCircle, SlidersHorizontal } from 'lucide-react';
import { api, RequestError } from '../../api';
import { Drawer, PlatformIcon, useApp } from '../../console/shared';
import type { Data } from '../../console/shared';

type Result = { id: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; note?: string };
type Policy = Data;
const lines = (value: string) =>
  value
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
const unique = (values: string[]) => [...new Set(values)];

/** The policy endpoint takes the whole policy; QQ-only verification fields are sent to QQ groups only. */
function policyBody(policy: Policy, platform: string) {
  return {
    mode: policy.mode,
    keywords: policy.keywords ?? [],
    blocked_domains: policy.blocked_domains ?? [],
    action: policy.action,
    verification_enabled: !!policy.verification_enabled,
    verification_timeout: Number(policy.verification_timeout ?? 120),
    ...(platform === 'qq'
      ? {
          verification_timeout_action: policy.verification_timeout_action ?? 'manual',
          verification_failed_action: policy.verification_failed_action ?? 'manual',
        }
      : {}),
  };
}
const ruleFields = [
  'name',
  'enabled',
  'mode',
  'priority',
  'match',
  'keywords',
  'action',
  'response',
  'image_asset_id',
  'duration_seconds',
  'cooldown_seconds',
  'exempt_admins',
] as const;

export default function BulkSettings({ targets, close }: { targets: Data[]; close: () => void }) {
  const { groups, refresh, toast } = useApp();
  const [tab, setTab] = useState<'unify' | 'copy'>('unify');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  // Unify
  const [applyAds, setApplyAds] = useState(true);
  const [mode, setMode] = useState('observe');
  const [action, setAction] = useState('delete');
  const [keywords, setKeywords] = useState('');
  const [keywordMode, setKeywordMode] = useState<'append' | 'replace'>('append');
  const [domains, setDomains] = useState('');
  const [domainMode, setDomainMode] = useState<'append' | 'replace'>('append');
  const [applyVerification, setApplyVerification] = useState(false);
  const [verification, setVerification] = useState(true);
  const [timeout, setVerificationTimeout] = useState('120');
  const [qqTimeoutAction, setQqTimeoutAction] = useState('manual');
  const [qqFailedAction, setQqFailedAction] = useState('manual');
  // Copy
  const [sourceId, setSourceId] = useState('');
  const [copyAds, setCopyAds] = useState(true);
  const [copyVerification, setCopyVerification] = useState(true);
  const [copyKeywordRules, setCopyKeywordRules] = useState(true);
  const source = groups.find((g) => g.id === sourceId);
  const copyTargets = targets.filter((g) => g.id !== sourceId);
  const list = tab === 'copy' ? copyTargets : targets;
  const qqTargets = list.filter((g) => g.platform === 'qq').length;
  const nothing =
    tab === 'unify'
      ? !applyAds && !applyVerification
      : !source || (!copyAds && !copyVerification && !copyKeywordRules);
  const setResult = (id: string, patch: Partial<Result>) =>
    setResults((current) => current && current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function run() {
    setRunning(true);
    setResults(list.map((g) => ({ id: g.id, status: 'pending' })));
    let sourceDetail: Data | undefined,
      sourceRules: Data[] = [];
    try {
      if (tab === 'copy') {
        sourceDetail = await api(`/conversations/${sourceId}`);
        if (copyKeywordRules)
          sourceRules = (await api(`/conversations/${sourceId}/keyword-rules`)).rules ?? [];
      }
    } catch (err: any) {
      toast(`读取来源群失败：${err.message}`, true);
      setRunning(false);
      setResults(null);
      return;
    }
    for (const target of list) {
      setResult(target.id, { status: 'running' });
      const notes: string[] = [];
      try {
        const detail = await api(`/conversations/${target.id}`);
        let policy: Policy = { ...detail.policy };
        let changed = false;
        if (tab === 'unify') {
          if (applyAds) {
            policy = {
              ...policy,
              mode,
              action,
              keywords: unique(
                keywordMode === 'replace'
                  ? lines(keywords)
                  : [...(policy.keywords ?? []), ...lines(keywords)],
              ),
              blocked_domains: unique(
                domainMode === 'replace'
                  ? lines(domains)
                  : [...(policy.blocked_domains ?? []), ...lines(domains)],
              ),
            };
            changed = true;
          }
          if (applyVerification) {
            policy = {
              ...policy,
              verification_enabled: verification,
              verification_timeout: Number(timeout),
              ...(detail.platform === 'qq'
                ? { verification_timeout_action: qqTimeoutAction, verification_failed_action: qqFailedAction }
                : {}),
            };
            changed = true;
          }
        } else if (sourceDetail) {
          const from = sourceDetail.policy;
          if (copyAds) {
            policy = {
              ...policy,
              mode: from.mode,
              action: from.action,
              keywords: from.keywords,
              blocked_domains: from.blocked_domains,
            };
            changed = true;
          }
          if (copyVerification) {
            policy = {
              ...policy,
              verification_enabled: from.verification_enabled,
              verification_timeout: from.verification_timeout,
              ...(detail.platform === 'qq' && sourceDetail.platform === 'qq'
                ? {
                    verification_timeout_action: from.verification_timeout_action ?? 'manual',
                    verification_failed_action: from.verification_failed_action ?? 'manual',
                  }
                : {}),
            };
            if (detail.platform === 'qq' && sourceDetail.platform !== 'qq')
              notes.push('QQ 专属的超时处理保持原样');
            changed = true;
          }
        }
        if (changed)
          await api(`/conversations/${target.id}/policy`, {
            method: 'PUT',
            body: policyBody(policy, detail.platform),
          });
        if (tab === 'copy' && copyKeywordRules && sourceRules.length) {
          const existing = new Set(
            ((await api(`/conversations/${target.id}/keyword-rules`)).rules ?? []).map((r: Data) => r.name),
          );
          let copied = 0,
            skipped = 0,
            observed = 0;
          for (const rule of sourceRules) {
            if (existing.has(rule.name)) {
              skipped++;
              continue;
            }
            const body = Object.fromEntries(ruleFields.map((key) => [key, rule[key]]));
            try {
              await api(`/conversations/${target.id}/keyword-rules`, { method: 'POST', body });
              copied++;
            } catch (err) {
              // Platforms without the punishment permission still get the rule, in observe mode.
              if (err instanceof RequestError && err.status === 409 && body.mode === 'enforce') {
                await api(`/conversations/${target.id}/keyword-rules`, {
                  method: 'POST',
                  body: { ...body, mode: 'observe' },
                });
                observed++;
              } else throw err;
            }
          }
          notes.push(
            `关键词规则复制 ${copied + observed} 条${observed ? `（${observed} 条因权限改为观察模式）` : ''}${skipped ? `，${skipped} 条同名已跳过` : ''}`,
          );
        }
        setResult(target.id, { status: 'done', note: notes.join('；') || undefined });
      } catch (err: any) {
        setResult(target.id, { status: 'failed', note: err.message });
      }
    }
    setRunning(false);
    refresh();
  }

  const done = results && !running;
  const failed = results?.filter((r) => r.status === 'failed').length ?? 0;
  return (
    <Drawer
      title="批量设置"
      description={`${list.length} 个群${qqTargets ? `，其中 ${qqTargets} 个 QQ 群` : ''}`}
      close={close}
      dismissDisabled={running}
      footer={
        done ? (
          <>
            <span className="drawer-foot-note">
              {failed ? `${failed} 个群未成功，原因见上方` : '全部完成'}
            </span>
            <button className="btn" onClick={() => setResults(null)}>
              继续设置
            </button>
            <button className="btn primary" onClick={close}>
              完成
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={close} disabled={running}>
              取消
            </button>
            <button
              className="btn primary"
              disabled={running || nothing || !list.length}
              onClick={() => void run()}
            >
              {running ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}
              {running ? '正在应用…' : `应用到 ${list.length} 个群`}
            </button>
          </>
        )
      }
    >
      {results ? (
        <ul className="bulk-results" aria-live="polite">
          {results.map((r) => {
            const g = groups.find((group) => group.id === r.id);
            return (
              <li key={r.id} className={r.status}>
                {r.status === 'running' ? (
                  <LoaderCircle className="spin" size={16} />
                ) : r.status === 'done' ? (
                  <CheckCircle2 size={16} />
                ) : r.status === 'failed' ? (
                  <CircleAlert size={16} />
                ) : (
                  <CircleMinus size={16} />
                )}
                <PlatformIcon value={g?.is_demo ? 'demo' : (g?.platform ?? 'custom')} />
                <span>
                  <strong>{g?.name ?? r.id}</strong>
                  {r.note && <small>{r.note}</small>}
                </span>
                <em>
                  {
                    { pending: '等待', running: '应用中', done: '已完成', failed: '失败', skipped: '跳过' }[
                      r.status
                    ]
                  }
                </em>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="stack-form">
          <div className="segmented bulk-mode" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'unify'}
              className={tab === 'unify' ? 'active' : ''}
              onClick={() => setTab('unify')}
            >
              <SlidersHorizontal size={13} />
              统一设置
            </button>
            <button
              role="tab"
              aria-selected={tab === 'copy'}
              className={tab === 'copy' ? 'active' : ''}
              onClick={() => setTab('copy')}
            >
              <Copy size={13} />
              从某个群复制
            </button>
          </div>
          {tab === 'unify' ? (
            <>
              <fieldset className={`bulk-section ${applyAds ? '' : 'off'}`}>
                <label className="bulk-section-toggle">
                  <input type="checkbox" checked={applyAds} onChange={(e) => setApplyAds(e.target.checked)} />
                  <span>
                    <strong>广告规则</strong>
                    <small>运行模式、命中动作、关键词和域名</small>
                  </span>
                </label>
                {applyAds && (
                  <>
                    <div className="form-grid">
                      <label>
                        运行模式
                        <select value={mode} onChange={(e) => setMode(e.target.value)}>
                          <option value="observe">观察 · 只记录命中</option>
                          <option value="enforce">自动处理</option>
                        </select>
                      </label>
                      <label>
                        命中后的动作
                        <select value={action} onChange={(e) => setAction(e.target.value)}>
                          <option value="delete">删除消息</option>
                          <option value="remove">删除并移出成员</option>
                          <option value="ban">删除并封禁</option>
                        </select>
                      </label>
                    </div>
                    <label>
                      <span className="label-row">
                        广告关键词
                        <Choice value={keywordMode} onChange={setKeywordMode} />
                      </span>
                      <textarea
                        rows={4}
                        value={keywords}
                        onChange={(e) => setKeywords(e.target.value)}
                        placeholder="每行一个"
                      />
                      <small>
                        {keywordMode === 'replace'
                          ? lines(keywords).length
                            ? `每个群的关键词都会替换为这 ${lines(keywords).length} 个`
                            : '留空会清空所选群的广告关键词'
                          : '追加到每个群现有的关键词后，重复的自动去掉'}
                      </small>
                    </label>
                    <label>
                      <span className="label-row">
                        屏蔽域名
                        <Choice value={domainMode} onChange={setDomainMode} />
                      </span>
                      <textarea
                        rows={3}
                        value={domains}
                        onChange={(e) => setDomains(e.target.value)}
                        placeholder="每行一个，例如 spam.example.com"
                      />
                      {domainMode === 'replace' && !lines(domains).length && (
                        <small className="text-warning">留空会清空所选群的屏蔽域名</small>
                      )}
                    </label>
                  </>
                )}
              </fieldset>
              <fieldset className={`bulk-section ${applyVerification ? '' : 'off'}`}>
                <label className="bulk-section-toggle">
                  <input
                    type="checkbox"
                    checked={applyVerification}
                    onChange={(e) => setApplyVerification(e.target.checked)}
                  />
                  <span>
                    <strong>入群验证</strong>
                    <small>开关和验证时限；QQ 群还可设置超时与答错的处理</small>
                  </span>
                </label>
                {applyVerification && (
                  <>
                    <div className="form-grid">
                      <label>
                        入群验证
                        <select
                          value={verification ? 'on' : 'off'}
                          onChange={(e) => setVerification(e.target.value === 'on')}
                        >
                          <option value="on">开启</option>
                          <option value="off">关闭</option>
                        </select>
                      </label>
                      <label>
                        验证时限（秒）
                        <input
                          type="number"
                          min={30}
                          max={3600}
                          value={timeout}
                          onChange={(e) => setVerificationTimeout(e.target.value)}
                        />
                      </label>
                    </div>
                    {qqTargets > 0 && (
                      <div className="form-grid">
                        <label>
                          QQ 群 · 超时未答
                          <select
                            value={qqTimeoutAction}
                            onChange={(e) => setQqTimeoutAction(e.target.value)}
                          >
                            <option value="manual">交给管理员</option>
                            <option value="mute_retry">禁言 10 分钟后重试</option>
                            <option value="remove">移出本群</option>
                          </select>
                        </label>
                        <label>
                          QQ 群 · 连续答错 3 次
                          <select value={qqFailedAction} onChange={(e) => setQqFailedAction(e.target.value)}>
                            <option value="manual">交给管理员</option>
                            <option value="mute">禁言 10 分钟</option>
                          </select>
                        </label>
                      </div>
                    )}
                  </>
                )}
              </fieldset>
              <p className="muted">逐个群保存。某个群缺少对应权限时会跳过并显示原因，其他群不受影响。</p>
            </>
          ) : (
            <>
              <label>
                来源群
                <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">选择要复制配置的群</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}（
                      {g.is_demo
                        ? '演示'
                        : g.platform === 'telegram'
                          ? 'TG'
                          : g.platform === 'binance'
                            ? '币安'
                            : g.platform.toUpperCase()}
                      ）
                    </option>
                  ))}
                </select>
              </label>
              {source && targets.some((g) => g.id === sourceId) && (
                <p className="muted">来源群本身不会被修改，将应用到其余 {copyTargets.length} 个群。</p>
              )}
              <fieldset className="bulk-section">
                <legend>复制内容</legend>
                <label className="check-row">
                  <input type="checkbox" checked={copyAds} onChange={(e) => setCopyAds(e.target.checked)} />
                  <span>
                    广告规则<small>运行模式、动作、关键词和域名，整体覆盖目标群</small>
                  </span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={copyVerification}
                    onChange={(e) => setCopyVerification(e.target.checked)}
                  />
                  <span>
                    入群验证<small>开关与时限；QQ 专属选项只在 QQ 群之间复制</small>
                  </span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={copyKeywordRules}
                    onChange={(e) => setCopyKeywordRules(e.target.checked)}
                  />
                  <span>
                    关键词触发规则
                    <small>追加到目标群，同名规则跳过；目标平台没有处罚权限时按观察模式复制</small>
                  </span>
                </label>
              </fieldset>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

function Choice({
  value,
  onChange,
}: {
  value: 'append' | 'replace';
  onChange: (value: 'append' | 'replace') => void;
}) {
  return (
    <span className="segmented mini">
      <button type="button" className={value === 'append' ? 'active' : ''} onClick={() => onChange('append')}>
        追加
      </button>
      <button
        type="button"
        className={value === 'replace' ? 'active' : ''}
        onClick={() => onChange('replace')}
      >
        替换
      </button>
    </span>
  );
}
