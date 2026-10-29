const status = document.getElementById('status');
const notice = document.getElementById('notice');
const configInput = document.getElementById('config');
const savedConfig = document.getElementById('saved-config');
const savedAddress = document.getElementById('saved-address');
const localHint = document.getElementById('local-hint');
const retryButton = document.getElementById('retry');
const disconnectButton = document.getElementById('disconnect');
const saveButton = document.getElementById('save');
const directButton = document.getElementById('authorize-direct');
const directConsent = document.getElementById('direct-consent');
const directTarget = document.getElementById('direct-target');
const directStatus = document.getElementById('direct-status');
let current = {},
  busy = false,
  refreshing = false;
function showNotice(text, error = false) {
  notice.textContent = text;
  notice.hidden = !text;
  notice.className = error ? 'notice error' : 'notice success';
}
function controls() {
  const locked = busy || current.direct?.busy || current.direct?.phase === 'authorizing';
  saveButton.disabled = locked;
  retryButton.disabled = locked || !current.saved;
  disconnectButton.disabled = locked || !current.saved;
  directConsent.disabled = locked || !current.saved;
  directButton.disabled = locked || !current.saved || !directConsent.checked;
}
function render(value) {
  if (current.server_url !== value.server_url || current.account_id !== value.account_id)
    directConsent.checked = false;
  current = value;
  status.textContent = value.state + (value.groups?.length ? ` · 授权群：${value.groups.join('、')}` : '');
  status.dataset.phase = value.phase ?? 'idle';
  savedConfig.textContent = value.saved
    ? '配对配置已保存在本机，无需重复粘贴。'
    : '尚未保存配对配置。示例灰字不是真实配置。';
  savedAddress.textContent = value.saved ? `后台地址：${value.server_url}` : '';
  savedAddress.hidden = !value.saved;
  localHint.hidden = !(
    value.saved && /^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/.test(value.server_url)
  );
  document.getElementById('version').textContent = 'v' + (value.version ?? '0.1.11');
  directTarget.textContent = value.saved
    ? `接收后台：${new URL(value.server_url).origin.replace(/^ws/, 'http')} · 连接账号：${value.account_id}`
    : '先保存配对配置，再授权。';
  directStatus.textContent = value.direct?.message ?? '';
  directStatus.hidden = !directStatus.textContent;
  directStatus.dataset.phase = value.direct?.phase ?? 'idle';
  controls();
}
async function send(message) {
  let timer;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('扩展后台暂未响应，请在扩展管理页点击重新加载后再试')),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  try {
    const value = await send({ type: 'status' });
    if (!value || value.ok === false) throw new Error(value?.error || '无法获取桥接状态');
    render(value);
  } catch {
    status.textContent = '无法读取扩展后台状态，请在 chrome://extensions 重新加载此扩展。';
    status.dataset.phase = 'error';
  } finally {
    refreshing = false;
  }
}
async function action(message) {
  busy = true;
  controls();
  showNotice(message.type === 'configure' ? '正在保存配对配置…' : '正在处理…');
  try {
    const result = await send(message);
    if (!result?.ok) throw new Error(result?.error || '扩展后台未确认操作，请重试');
    render(result);
    if (message.type === 'configure') {
      configInput.value = '';
      showNotice('配对配置已保存。下面的连接状态会继续更新。');
    } else if (message.type === 'disconnect') showNotice('已清除本机配对配置。');
    else showNotice('已使用保存的配置重新尝试连接，请查看下方连接状态。');
  } catch (error) {
    showNotice(error.message || '操作未完成，请重试', true);
  } finally {
    busy = false;
    controls();
  }
}
document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = configInput.value.trim();
  if (!raw) {
    if (current.saved) {
      await action({ type: 'retry' });
      return;
    }
    showNotice('请先粘贴后台生成的完整配对 JSON，输入框里的灰色示例不能用于连接。', true);
    return;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    showNotice('配对配置不是有效 JSON。请从后台完整复制，不能使用带省略号的示例。', true);
    return;
  }
  await action({ type: 'configure', config });
});
retryButton.addEventListener('click', () => void action({ type: 'retry' }));
disconnectButton.addEventListener('click', () => void action({ type: 'disconnect' }));
directConsent.addEventListener('change', controls);
directButton.addEventListener('click', async () => {
  if (
    busy ||
    !current.saved ||
    !directConsent.checked ||
    current.direct?.busy ||
    current.direct?.phase === 'authorizing'
  )
    return;
  const destination = { server_url: current.server_url, account_id: current.account_id };
  let mayHaveStarted = false,
    cleanup = true;
  busy = true;
  controls();
  try {
    // Still inside the click gesture, before any awaited work; synchronous API errors are handled too.
    if (!(await chrome.permissions.request({ permissions: ['cookies'] }))) {
      showNotice('未授予 Cookie 读取权限，原连接保持不变。', true);
      return;
    }
    mayHaveStarted = true;
    const result = await send({ type: 'authorize-direct', consent: true, ...destination });
    if (!result?.ok) {
      if (result?.ok === false) mayHaveStarted = false;
      throw new Error('授权状态未确认');
    }
    render(result);
    showNotice('授权验证已开始，可关闭弹窗后再打开查看结果。');
  } catch {
    if (mayHaveStarted) {
      try {
        const latest = await send({ type: 'status' });
        if (!latest || latest.ok === false) throw new Error();
        render(latest);
      } catch {
        cleanup = false;
      }
      showNotice('授权状态未确认，请重新打开弹窗或到后台查看连接方式；请勿重复提交。', true);
    } else showNotice('授权未开始，请检查 Chrome 权限与配对配置，原连接保持不变。', true);
  } finally {
    directConsent.checked = false;
    busy = false;
    controls();
    // The background owns cleanup after a started operation. Do not revoke it midway through reading.
    if (cleanup && !current.direct?.busy && current.direct?.phase !== 'authorizing') {
      try {
        await chrome.permissions.remove({ permissions: ['cookies'] });
      } catch {
        /* Optional permission. */
      }
    }
  }
});
void refresh();
const timer = setInterval(() => void refresh(), 2000);
window.addEventListener('pagehide', () => clearInterval(timer));
