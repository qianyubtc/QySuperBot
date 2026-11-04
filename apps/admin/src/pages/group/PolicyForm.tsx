import { useEffect, useState } from 'react';
import { CircleAlert, ShieldCheck, UserCheck } from 'lucide-react';
import { api } from '../../api';
import { ActionForm, useApp } from '../../console/shared';
import type { Data } from '../../console/shared';

const actions: Record<string, string> = {
  delete: '删除消息',
  remove: '删除并移出成员',
  ban: '删除并封禁（禁止重新加入）',
};

export default function PolicyForm({ group }: { group: Data }) {
  const { toast } = useApp();
  const p = group.policy;
  const [mode, setMode] = useState(p.mode);
  const [action, setAction] = useState(p.action);
  const [verification, setVerification] = useState(p.verification_enabled);
  const [timeoutAction, setTimeoutAction] = useState(p.verification_timeout_action ?? 'manual');
  const [failedAction, setFailedAction] = useState(p.verification_failed_action ?? 'manual');
  const [keywords, setKeywords] = useState(p.keywords.join('\n'));
  const [domains, setDomains] = useState(p.blocked_domains.join('\n'));
  const [timeout, setVerificationTimeout] = useState(String(p.verification_timeout));
  const qq = group.platform === 'qq';
  const splitLines = (value: string) =>
    value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  const fingerprint = JSON.stringify([
    mode,
    action,
    splitLines(keywords),
    splitLines(domains),
    verification,
    Number(timeout),
    qq ? timeoutAction : null,
    qq ? failedAction : null,
  ]);
  const serverFingerprint = JSON.stringify([
    p.mode,
    p.action,
    p.keywords,
    p.blocked_domains,
    p.verification_enabled,
    p.verification_timeout,
    qq ? (p.verification_timeout_action ?? 'manual') : null,
    qq ? (p.verification_failed_action ?? 'manual') : null,
  ]);
  const [savedPolicy, setSavedPolicy] = useState(serverFingerprint);
  const dirty = fingerprint !== savedPolicy;
  const restore = () => {
    setMode(p.mode);
    setAction(p.action);
    setKeywords(p.keywords.join('\n'));
    setDomains(p.blocked_domains.join('\n'));
    setVerification(p.verification_enabled);
    setVerificationTimeout(String(p.verification_timeout));
    setTimeoutAction(p.verification_timeout_action ?? 'manual');
    setFailedAction(p.verification_failed_action ?? 'manual');
    setSavedPolicy(serverFingerprint);
  };
  useEffect(() => {
    if (!dirty) restore();
  }, [serverFingerprint]);
  const options = group.policy_options ?? {};
  const enforceAvailable = Object.keys(actions).some((key) => options[key]?.available);
  const unavailable = mode === 'enforce' && !options[action]?.available;
  const invalidVerification =
    verification &&
    (!options.verification?.available ||
      (qq && timeoutAction === 'remove' && !options.verification_remove?.available) ||
      (qq && timeoutAction === 'mute_retry' && !options.verification_mute?.available) ||
      (qq && failedAction === 'mute' && !options.verification_mute?.available));
  return (
    <ActionForm
      className="policy-form"
      label={dirty ? '保存规则' : '已保存'}
      disabled={unavailable || invalidVerification || !dirty}
      summary={
        dirty ? (
          <span className="unsaved">
            有未保存的修改
            <button type="button" className="text-button" onClick={restore}>
              还原
            </button>
          </span>
        ) : (
          '所有修改已保存'
        )
      }
      onSubmit={async () => {
        await api(`/conversations/${group.id}/policy`, {
          method: 'PUT',
          body: {
            mode,
            keywords: splitLines(keywords),
            blocked_domains: splitLines(domains),
            action,
            verification_enabled: verification,
            verification_timeout: Number(timeout),
            ...(qq
              ? {
                  verification_timeout_action: timeoutAction,
                  verification_failed_action: failedAction,
                }
              : {}),
          },
        });
        setSavedPolicy(fingerprint);
        toast('规则已保存，旧审核任务将停止执行');
      }}
    >
      {dirty && serverFingerprint !== savedPolicy && fingerprint !== serverFingerprint && (
        <div className="info-box warning">
          <CircleAlert size={15} />
          服务器上的规则刚被更新。这里保留你的编辑，点击“还原”可载入最新配置。
        </div>
      )}
      <section className="settings-section">
        <header>
          <ShieldCheck size={16} />
          <div>
            <h3>广告与违规消息</h3>
            <p>先用观察模式核对命中结果，确认无误后再开启自动处理。</p>
          </div>
        </header>
        <div className="settings-row">
          <div>
            <strong>运行模式</strong>
            <small>{mode === 'enforce' ? '命中后自动执行下方动作' : '只记录命中，不处理成员'}</small>
          </div>
          <div className="segmented" role="radiogroup" aria-label="运行模式">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'observe'}
              className={mode === 'observe' ? 'active' : ''}
              onClick={() => setMode('observe')}
            >
              观察
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'enforce'}
              className={mode === 'enforce' ? 'active' : ''}
              disabled={!enforceAvailable}
              title={enforceAvailable ? undefined : '当前账号没有可用的处理权限'}
              onClick={() => setMode('enforce')}
            >
              自动处理
            </button>
          </div>
        </div>
        <label className="settings-row">
          <div>
            <strong>命中后的动作</strong>
            <small>
              {options[action]?.available ? '当前权限可用' : (options[action]?.reason ?? '尚未获取权限')}
            </small>
          </div>
          <select name="action" value={action} onChange={(e) => setAction(e.target.value)}>
            {Object.entries(actions).map(([key, label]) => (
              <option key={key} value={key} disabled={!options[key]?.available}>
                {label}
                {!options[key]?.available ? '（不可用）' : ''}
              </option>
            ))}
          </select>
        </label>
        {unavailable && (
          <p className="form-error" role="alert">
            当前动作不可用：{options[action]?.reason ?? '请刷新群管理权限'}。请更换动作或切回观察模式。
          </p>
        )}
        <div className="form-grid">
          <label>
            广告关键词
            <textarea
              name="keywords"
              rows={5}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="每行一个，按文字匹配"
            />
            <small>{splitLines(keywords).length} 个 · 不支持正则，图片暂不识别</small>
          </label>
          <label>
            屏蔽域名
            <textarea
              name="domains"
              rows={5}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder={'每行一个，例如\nspam.example.com'}
            />
            <small>{splitLines(domains).length} 个 · 同时匹配子域名</small>
          </label>
        </div>
        <details className="disclosure">
          <summary>各动作的权限与说明</summary>
          <ul className="plain-list">
            {Object.entries(actions).map(([key, label]) => (
              <li key={key}>
                <strong>{label}</strong>：
                {options[key]?.available ? '可用' : (options[key]?.reason ?? '尚未获取权限')}
              </li>
            ))}
            <li>观察模式只记录广告命中；群黑名单仍会提交处理任务。</li>
            <li>移出或封禁会先核对成员的入群批次，不是任意成员都可直接处理。</li>
          </ul>
        </details>
      </section>
      <section className="settings-section">
        <header>
          <UserCheck size={16} />
          <div>
            <h3>入群验证</h3>
            <p>
              {qq
                ? '新成员入群后 @ 发送计算题，绑定本人和本次入群记录。'
                : '新成员入群或首次发言时发送验证码，绑定本人和本次入群记录。'}
            </p>
          </div>
        </header>
        <div className="settings-row">
          <div>
            <strong>开启验证</strong>
            <small>{verification ? '新成员需要先完成验证' : '关闭中，新成员无需验证'}</small>
          </div>
          <label className="switch" aria-label="开启入群验证">
            <input
              type="checkbox"
              name="verification"
              role="switch"
              checked={verification}
              disabled={!verification && !options.verification?.available}
              onChange={(e) => setVerification(e.target.checked)}
            />
            <span />
          </label>
        </div>
        {!options.verification?.available && (
          <p className="error-text">
            验证暂不可用：{options.verification?.reason ?? '尚未获取发送权限'}。可先关闭验证后保存。
          </p>
        )}
        <label className="settings-row">
          <div>
            <strong>验证时限</strong>
            <small>30 – 3600 秒</small>
          </div>
          <span className="input-suffix">
            <input
              type="number"
              name="timeout"
              required
              min={30}
              max={3600}
              value={timeout}
              onChange={(e) => setVerificationTimeout(e.target.value)}
            />
            <span>秒</span>
          </span>
        </label>
        {qq && (
          <label className="settings-row">
            <div>
              <strong>超时未答</strong>
              <small>
                {timeoutAction === 'mute_retry'
                  ? '禁言 10 分钟，到期后重新出题，直到通过或退群'
                  : timeoutAction === 'remove'
                    ? '超时后移出本群'
                    : '记录超时，由管理员处理'}
              </small>
            </div>
            <select value={timeoutAction} onChange={(e) => setTimeoutAction(e.target.value)}>
              <option value="manual">交给管理员</option>
              <option value="mute_retry" disabled={!options.verification_mute?.available}>
                禁言 10 分钟后重试{!options.verification_mute?.available ? '（无权限）' : ''}
              </option>
              <option value="remove" disabled={!options.verification_remove?.available}>
                移出本群{!options.verification_remove?.available ? '（无权限）' : ''}
              </option>
            </select>
          </label>
        )}
        {qq && timeoutAction === 'remove' && !options.verification_remove?.available && (
          <p className="error-text">{options.verification_remove?.reason ?? '请先刷新群管理权限'}</p>
        )}
        {qq && timeoutAction === 'mute_retry' && !options.verification_mute?.available && (
          <p className="error-text">{options.verification_mute?.reason ?? '请先刷新群管理权限'}</p>
        )}
        {qq && (
          <label className="settings-row">
            <div>
              <strong>连续答错 3 次</strong>
              <small>禁言到期由 QQ 自动解除；人工通过不会自动解禁</small>
            </div>
            <select value={failedAction} onChange={(e) => setFailedAction(e.target.value)}>
              <option value="manual">交给管理员</option>
              <option value="mute" disabled={!options.verification_mute?.available}>
                禁言 10 分钟{!options.verification_mute?.available ? '（无权限）' : ''}
              </option>
            </select>
          </label>
        )}
        {qq && failedAction === 'mute' && !options.verification_mute?.available && (
          <p className="error-text">{options.verification_mute?.reason ?? '请刷新群管理权限'}</p>
        )}
        <details className="disclosure">
          <summary>验证方式说明</summary>
          <p className="muted">
            {qq
              ? 'QQ 会 @ 新成员发送计算题，成员 @ 机器人回复数字，或引用验证题只发数字即可。确认发送后才开始计时；自动审核通过入群后仍须完成验证。发送失败或结果待核对时不会自动移出。群主、管理员和机器人自身受保护。'
              : '使用数字验证码或 Telegram 按钮验证。超时进入人工处理，不会自动解除管理员设置的禁言。'}{' '}
            自动处理模式下，未验证成员的发言会被删除。
          </p>
        </details>
      </section>
    </ActionForm>
  );
}
