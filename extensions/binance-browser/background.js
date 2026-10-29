let connection, settings, selectedTab, reconnect, connectionDeadline, connectingGeneration;
let groupIds = [],
  diagnostic,
  directMode = false,
  authorizing = false,
  directState = { phase: 'idle', message: '' },
  generation = 0,
  phase = 'idle',
  state = '尚未保存配对配置';

function chatUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      url.origin === 'https://www.binance.com' &&
      /\/(?:chatroom|square\/chat|chatWidgetEntrance)\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
function validateConfig(input) {
  const config = input?.binance_bridge ?? input;
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('请粘贴后台生成的完整配对 JSON');
  for (const name of ['server_url', 'account_id', 'pairing_secret']) {
    if (typeof config[name] !== 'string' || !config[name].trim())
      throw new Error(`配对配置缺少 ${name}，请从后台完整复制`);
  }
  let url;
  try {
    url = new URL(config.server_url.trim());
  } catch {
    throw new Error('后台连接地址格式不正确');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/api/v1/connectors/binance/socket' ||
    (url.protocol !== 'wss:' &&
      !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error('后台地址必须使用 WSS；只有同一台机器可以使用本机 WS 地址');
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(config.account_id.trim()))
    throw new Error('account_id 格式不正确，请使用后台生成的账号 ID');
  if (!/^[\w-]{40,128}$/.test(config.pairing_secret.trim()))
    throw new Error('pairing_secret 格式不正确，请完整复制配对密钥');
  return {
    server_url: url.toString(),
    account_id: config.account_id.trim(),
    pairing_secret: config.pairing_secret.trim(),
  };
}
function snapshot() {
  return {
    state,
    phase,
    groups: groupIds,
    saved: !!settings,
    ...(settings ? { server_url: settings.server_url, account_id: settings.account_id } : {}),
    version: chrome.runtime.getManifest().version,
    direct: { ...directState, enabled: directMode, busy: authorizing },
    ...(diagnostic ? { diagnostic } : {}),
  };
}
function resetConnection() {
  generation++;
  clearTimeout(reconnect);
  clearTimeout(connectionDeadline);
  const old = connection;
  connection = undefined;
  old?.close();
  groupIds = [];
  diagnostic = undefined;
  connectingGeneration = undefined;
}
function retryLater(epoch) {
  clearTimeout(reconnect);
  if (settings && !directMode && generation === epoch) reconnect = setTimeout(() => void connect(), 5000);
}
async function proof(secret, input) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
async function digest(input) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
function directProof(purpose, nonce, config, id, hash) {
  return proof(
    config.pairing_secret,
    `qsb-binance-direct-${purpose}-v1:${nonce}:${config.account_id}:${id}${hash ? ':' + hash : ''}`,
  );
}
function directFailure(message) {
  return Object.assign(new Error(message), { directSafe: true });
}
function cookieValue(value, required, limit = 16384) {
  if (!value?.value && !required) return undefined;
  if (
    !value?.value ||
    value.value.length > limit ||
    !/^[\x21-\x7e]+$/.test(value.value) ||
    /[;,]/.test(value.value)
  )
    throw directFailure('未读取到有效登录字段，请在此 Chrome 登录币安后重试');
  return value.value;
}
async function directCredentials(config, epoch) {
  const allowed = await chrome.permissions.contains({ permissions: ['cookies'] });
  if (!allowed || settings !== config || generation !== epoch)
    throw directFailure('授权或配对状态已变化，请重试');
  const tab = await findTab();
  if (!tab) throw directFailure('请在此 Chrome 打开并登录币安聊天页，再点击授权');
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find((value) => value.tabIds.includes(tab.id));
  if (!store) throw directFailure('无法确定聊天页登录会话，请刷新币安聊天页后重试');
  const get = (name) =>
    chrome.cookies.get({
      name,
      storeId: store.id,
      url: 'https://www.binance.com/bapi/c2c/v3/private/binance-chat/user/get-my-profile',
    });
  // Never enumerate cookie values. These are the only three names this feature may read.
  const [web, csrf, device] = await Promise.all([get('p20t'), get('cr00'), get('BNC_FV_KEY')]);
  if (settings !== config || generation !== epoch) throw directFailure('配对状态已变化，请重试');
  const web_token = cookieValue(web, true),
    csrf_cookie = cookieValue(csrf, true);
  const device_id = cookieValue(device, false, 1024);
  return { mode: 'direct', web_token, csrf_cookie, ...(device_id ? { device_id } : {}) };
}
async function authorizeDirect(config, epoch) {
  const id = crypto.randomUUID();
  let socket,
    deadline,
    submitted = false,
    finished = false;
  try {
    const result = await new Promise((resolve, reject) => {
      socket = new WebSocket(config.server_url);
      deadline = setTimeout(
        () =>
          reject(
            directFailure(
              submitted
                ? '凭据已提交，但验证结果未确认。请到后台查看连接方式，不会自动重复提交'
                : '授权连接超时，请检查后台版本和网络后重试',
            ),
          ),
        180000,
      );
      let nonce,
        receiving = false,
        sent = false;
      socket.onmessage = async (event) => {
        try {
          if (settings !== config || generation !== epoch) throw directFailure('配对状态已变化，请重试');
          const value = JSON.parse(event.data);
          if (value.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (receiving) throw directFailure('后台授权协议不兼容，请更新后台后重试');
          receiving = true;
          if (value.type === 'challenge' && !nonce) {
            if (!/^[\w-]{40,128}$/.test(value.nonce) || !value.features?.includes('direct_authorization_v1'))
              throw directFailure('后台尚不支持一键直连授权，请先更新后台');
            nonce = value.nonce;
            const signature = await directProof('client', nonce, config, id);
            if (socket.readyState !== WebSocket.OPEN) throw directFailure('授权连接已断开，请重试');
            socket.send(
              JSON.stringify({ type: 'direct_hello', id, account_id: config.account_id, proof: signature }),
            );
          } else if (value.type === 'direct_ready' && nonce && value.id === id && !sent) {
            if (value.proof !== (await directProof('server', nonce, config, id)))
              throw directFailure('后台未通过配对身份核验，未读取或发送登录凭据');
            sent = true;
            const credentials = await directCredentials(config, epoch);
            const signature = await directProof(
              'submit',
              nonce,
              config,
              id,
              await digest(JSON.stringify(credentials)),
            );
            if (settings !== config || generation !== epoch || socket.readyState !== WebSocket.OPEN)
              throw directFailure('授权连接已变化，未提交凭据');
            socket.send(
              JSON.stringify({
                type: 'direct_credentials',
                id,
                consent: true,
                credentials,
                proof: signature,
              }),
            );
            submitted = true;
            directState = {
              phase: 'authorizing',
              message: '已提交给配对后台，正在验证身份、群资料和聊天心跳…',
            };
          } else if (value.type === 'direct_result' && value.id === id) {
            if (
              value.ok === true &&
              submitted &&
              value.result?.mode === 'direct' &&
              value.result?.verified === true
            ) {
              finished = true;
              resolve(value.result);
            } else {
              const codes = [
                'BINANCE_DIRECT_AUTH',
                'BINANCE_IDENTITY_CHANGED',
                'BINANCE_TOKEN_EXPIRED',
                'BINANCE_CONNECTION_CHANGED',
                'BINANCE_BUSY',
                'ACCOUNT_PAUSED',
                'BINANCE_AUTH_CANCELLED',
              ];
              // Fixed diagnostics only; no response text, arbitrary exception or credential is displayed.
              const code = codes.includes(value.error?.code) ? value.error.code : '';
              const labels = {
                BINANCE_DIRECT_AUTH: '币安登录或聊天接口验证未通过，请检查登录状态及 VPS 网络；原连接保留',
                BINANCE_IDENTITY_CHANGED: '当前币安登录账号与后台连接不一致，请切回对应账号',
                BINANCE_TOKEN_EXPIRED: '登录令牌已过期，请重新登录币安后再授权',
                BINANCE_CONNECTION_CHANGED: '验证期间连接或群选择有变化，请重新授权',
                BINANCE_BUSY: '后台正在验证此账号，请稍后再试',
                ACCOUNT_PAUSED: '后台账号已暂停，请先恢复连接',
                BINANCE_AUTH_CANCELLED: '此次授权已取消，原连接保留',
              };
              finished = true;
              reject(directFailure(labels[code] ?? '后台拒绝此次授权，请检查配对和后台版本；原连接保留'));
            }
          } else throw directFailure('后台授权协议不兼容，请更新后台后重试');
          receiving = false;
        } catch (error) {
          reject(error);
        }
      };
      socket.onerror = () =>
        reject(
          directFailure(
            submitted
              ? '提交后连接断开，结果未确认，请到后台查看；不会自动重试'
              : '无法连接配对后台，未提交登录凭据',
          ),
        );
      socket.onclose = () => {
        if (!finished)
          reject(
            directFailure(
              submitted
                ? '提交后连接断开，结果未确认，请到后台查看；不会自动重试'
                : '授权连接已关闭，未提交登录凭据',
            ),
          );
      };
    });
    if (settings !== config || generation !== epoch) return;
    directMode = true;
    resetConnection();
    phase = 'direct';
    state = '服务器直连已启用，可关闭币安页面和此扩展；令牌失效时需重新授权';
    directState = {
      phase: 'active',
      message: result.warning
        ? '直连已保存，请在后台刷新并检查连接状态'
        : '后台验证通过，服务器已接管同步，无需保持浏览器运行',
    };
    try {
      await chrome.storage.local.set({
        bridge_direct: { server_url: config.server_url, account_id: config.account_id },
      });
    } catch {
      directState.message = '后台已启用直连，Chrome 未保存模式标记；请以后台状态为准';
    }
  } catch (error) {
    if (settings === config && generation === epoch)
      directState = {
        phase: submitted && !finished ? 'unknown' : 'error',
        message:
          error?.directSafe === true ? error.message : '授权未完成，请检查 Chrome 权限、登录和后台版本后重试',
      };
  } finally {
    clearTimeout(deadline);
    socket?.close();
    try {
      await chrome.permissions.remove({ permissions: ['cookies'] });
    } catch {
      /* No credential is stored locally. */
    }
    authorizing = false;
  }
}
const pageStages = {
  profile: '聊天身份',
  groups: '已加入聊天室',
  image: '图片地址',
  upload: '图片上传',
  group: '群资料',
  member: '群成员权限',
  history: '消息列表',
  token: '聊天令牌',
  restriction: '账号发送限制',
  domain: '聊天服务器',
  socket: '消息连接',
  send: '发送确认',
  validation: '页面桥接',
};
const historyDetails = {
  DATA_NULL: '消息响应数据为空',
  DATA_ARRAY: '消息响应直接返回数组',
  DATA_TYPE: '消息响应数据类型不兼容',
  MESSAGES_MISSING: '消息响应缺少 messages 字段',
  MESSAGES_NULL: 'messages 字段为空值',
  MESSAGES_TYPE: 'messages 字段不是数组',
  MESSAGES_LIMIT: '消息条数超过处理上限',
  MESSAGE_ITEM: '消息列表包含无效条目',
  MEMBER_UNKNOWN: '当前成员身份或权限尚未确认',
  MEMBER_DENIED: '当前成员或群的发送权限受限',
  RESTRICTION_UNKNOWN: '账号文字发送限制尚未确认',
  DOMAIN_INVALID: '聊天服务器地址不兼容',
  TOKEN_IDENTITY: '聊天令牌与连接账号不一致',
  TOKEN_FORMAT: '聊天令牌格式不兼容',
  TOKEN_EXPIRED: '聊天令牌已过期',
  SOCKET_TIMEOUT: '聊天连接未通过心跳确认',
  SOCKET_CLOSED: '聊天连接已关闭',
  SEND_REJECTED: '币安拒绝了该次发送',
  SEND_EXPIRED: '本次发送窗口已过期',
  SEND_TIMEOUT: '消息发送确认超时，需核对结果',
};
function pageDiagnostic(value, operation) {
  return {
    code: [
      'HTTP',
      'API',
      'NETWORK',
      'TIMEOUT',
      'NON_JSON',
      'FORMAT',
      'PAGE',
      'PERMISSION',
      'SOCKET',
    ].includes(value?.code)
      ? value.code
      : 'FORMAT',
    stage: Object.hasOwn(pageStages, value?.stage)
      ? value.stage
      : Object.hasOwn(pageStages, operation)
        ? operation
        : 'validation',
    ...(Number.isInteger(value?.http_status) && value.http_status >= 100 && value.http_status <= 599
      ? { http_status: value.http_status }
      : {}),
    ...(typeof value?.api_code === 'string' && /^\d{1,20}$/.test(value.api_code)
      ? { api_code: value.api_code }
      : {}),
    ...(Object.hasOwn(historyDetails, value?.detail) ? { detail: value.detail } : {}),
    ...(['none', 'possible'].includes(value?.effect) ? { effect: value.effect } : {}),
  };
}
function pageErrorText(value) {
  const details = [
    value.code,
    value.http_status ? `HTTP ${value.http_status}` : '',
    value.api_code ? `币安码 ${value.api_code}` : '',
    value.detail ? historyDetails[value.detail] : '',
  ]
    .filter(Boolean)
    .join('，');
  const hint =
    value.http_status === 401 || value.api_code === '100001005'
      ? '请在此 Chrome 重新登录币安，再在后台点击“连接 / 刷新”。'
      : value.code === 'PAGE'
        ? '请刷新币安聊天页，再使用已保存配置连接。'
        : '请按币安页面提示检查登录或网络，再在后台点击“连接 / 刷新”。';
  return `币安${pageStages[value.stage]}请求失败（${details}）。${hint}`;
}
async function findTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.binance.com/*' });
  return (
    tabs.find((tab) => tab.id === selectedTab && chatUrl(tab.url)) ?? tabs.find((tab) => chatUrl(tab.url))
  );
}
async function connect() {
  const epoch = generation,
    config = settings;
  if (
    !config ||
    directMode ||
    connectingGeneration === epoch ||
    [WebSocket.OPEN, WebSocket.CONNECTING].includes(connection?.readyState)
  )
    return;
  connectingGeneration = epoch;
  try {
    const tab = await findTab();
    if (generation !== epoch) return;
    if (!tab) {
      phase = 'waiting_tab';
      state =
        '配置已保存，未找到币安聊天标签。请在此 Chrome 打开 /square/chat 或 /chatroom 并登录，随后刷新一次。';
      retryLater(epoch);
      return;
    }
    selectedTab = tab.id;
    const socket = new WebSocket(config.server_url);
    connection = socket;
    phase = 'connecting';
    state = '配置已保存，正在连接后台…';
    connectionDeadline = setTimeout(() => {
      if (connection === socket && generation === epoch && phase === 'connecting') {
        phase = 'unreachable';
        state = '连接后台超时。请检查后台地址、端口和 WebSocket 转发；127.0.0.1 指当前 Chrome 所在机器。';
        socket.close();
      }
    }, 12_000);
    socket.onmessage = async (event) => {
      try {
        if (socket !== connection || generation !== epoch) return;
        const value = JSON.parse(event.data);
        if (value.type === 'challenge') {
          const signature = await proof(
            config.pairing_secret,
            `qsb-binance-v1:${value.nonce}:${config.account_id}`,
          );
          if (connection === socket && generation === epoch && socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: 'auth',
                account_id: config.account_id,
                proof: signature,
                version: chrome.runtime.getManifest().version,
              }),
            );
        } else if (value.type === 'ready') {
          if (
            !Array.isArray(value.group_ids) ||
            !value.group_ids.every((id) => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id))
          )
            throw new Error('群范围无效');
          clearTimeout(connectionDeadline);
          groupIds = value.group_ids;
          diagnostic = undefined;
          phase = 'connected';
          state = '桥接已连接后台，等待币安登录和群资料核对。';
        } else if (value.type === 'scope') {
          if (
            !Array.isArray(value.group_ids) ||
            value.group_ids.length > 20 ||
            !value.group_ids.every((id) => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id))
          )
            throw new Error('群范围无效');
          groupIds = value.group_ids;
        } else if (value.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        } else if (value.type === 'request') {
          if (
            ![
              'profile',
              'groups',
              'image_url',
              'group',
              'history',
              'send',
              'send_image',
              'send_check',
            ].includes(value.operation)
          )
            throw new Error('不支持的操作');
          if (value.group_ids !== undefined) {
            if (
              !Array.isArray(value.group_ids) ||
              value.group_ids.length > 20 ||
              !value.group_ids.every((id) => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id))
            )
              throw new Error('群范围无效');
            groupIds = value.group_ids;
          }
          let reply;
          try {
            const current = await chrome.tabs.get(selectedTab);
            if (!chatUrl(current.url)) throw new Error('聊天标签已关闭或退出');
            reply = await chrome.tabs.sendMessage(selectedTab, {
              type: 'qsb-binance-request',
              operation: value.operation,
              params: value.params,
              group_ids: groupIds,
            });
            if (connection !== socket || generation !== epoch) return;
            if (!reply?.ok) {
              diagnostic = pageDiagnostic(reply?.error, value.operation);
              phase = 'page_error';
              state = pageErrorText(diagnostic);
            } else if (['group', 'history', 'send_check'].includes(value.operation)) {
              diagnostic = undefined;
              phase = 'connected';
              state =
                value.operation === 'send_check'
                  ? '发送连接自检通过，尚未发送群消息。请保持聊天标签打开。'
                  : '桥接已连接，币安群请求成功。请保持聊天标签打开。';
            }
          } catch {
            reply = { ok: false, error: { code: 'PAGE', stage: 'validation' } };
            if (connection !== socket || generation !== epoch) return;
            phase = 'page_error';
            diagnostic = pageDiagnostic(reply.error, value.operation);
            state =
              '已找到聊天标签，但页面桥接未就绪。更新扩展后请刷新一次币安聊天页，再点击“使用已保存配置连接”。';
          }
          if (socket === connection && generation === epoch && socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: 'result',
                id: value.id,
                ok: reply?.ok === true,
                ...(reply?.ok
                  ? { data: reply.data }
                  : { error: pageDiagnostic(reply?.error, value.operation) }),
              }),
            );
        }
      } catch {
        if (connection === socket && generation === epoch) {
          phase = 'protocol_error';
          state = '后台桥接协议不匹配，请确认后台为支持币安桥接的版本。';
          socket.close();
        }
      }
    };
    socket.onerror = () => {
      if (connection !== socket || generation !== epoch) return;
      phase = 'unreachable';
      state =
        '配置已保存，但后台不可达。请检查地址和服务；127.0.0.1 指当前 Chrome 所在机器，远程后台需使用可访问的 WSS 地址。';
    };
    socket.onclose = (event) => {
      if (connection !== socket || generation !== epoch) return;
      clearTimeout(connectionDeadline);
      connection = undefined;
      groupIds = [];
      if (event.code === 1008) {
        phase = 'auth_failed';
        state = '后台拒绝配对，可能是密钥已失效或账号已暂停。请在后台恢复账号或重新生成配对配置。';
        return;
      }
      if (!['unreachable', 'protocol_error'].includes(phase)) {
        phase = 'disconnected';
        state = '桥接已断开，正在重连。';
      }
      retryLater(epoch);
    };
  } catch {
    if (generation === epoch) {
      phase = 'unreachable';
      state = '连接未完成，请检查 Chrome 聊天标签和后台地址。';
      retryLater(epoch);
    }
  } finally {
    if (connectingGeneration === epoch) connectingGeneration = undefined;
  }
}
const initialized = (async () => {
  // A terminated MV3 worker cannot run finally. Revoke any permission left by that interrupted run
  // before publishing saved state or accepting the next explicit authorization.
  try {
    if (await chrome.permissions?.contains({ permissions: ['cookies'] }))
      await chrome.permissions.remove({ permissions: ['cookies'] });
  } catch {
    /* No cookie values are read during startup. */
  }
  return chrome.storage.local.get(['bridge', 'bridge_direct']);
})()
  .then((result) => {
    if (!result.bridge) return;
    try {
      settings = validateConfig(result.bridge);
      directMode =
        result.bridge_direct?.server_url === settings.server_url &&
        result.bridge_direct?.account_id === settings.account_id;
      if (directMode) {
        phase = 'direct';
        state = '已授权服务器直连，令牌失效时请重新登录并点击一键授权';
        directState = { phase: 'active', message: '本机已完成直连授权，实际运行状态请查看后台' };
      } else void connect();
    } catch {
      phase = 'invalid_config';
      state = '已保存的配对配置格式不正确，请从后台重新复制。';
    }
  })
  .catch(() => {
    phase = 'storage_error';
    state = '无法读取 Chrome 扩展存储，请重新打开扩展。';
  });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (!['status', 'configure', 'retry', 'disconnect', 'authorize-direct'].includes(message.type)) return;
  void (async () => {
    try {
      await initialized;
      if (message.type === 'status') {
        respond(snapshot());
        return;
      }
      if (authorizing || directState.phase === 'authorizing')
        throw new Error('正在验证直连或回收权限，请等待完成后再操作');
      if (message.type === 'authorize-direct') {
        if (
          sender.url !== chrome.runtime.getURL('popup.html') ||
          message.consent !== true ||
          !settings ||
          message.server_url !== settings.server_url ||
          message.account_id !== settings.account_id
        )
          throw new Error('请在扩展弹窗核对后台地址并勾选授权后重试');
        const config = settings,
          epoch = generation;
        if (!(await chrome.permissions.contains({ permissions: ['cookies'] })))
          throw new Error('尚未授予本次 Cookie 读取权限，请点击一键授权并按 Chrome 提示允许');
        if (settings !== config || generation !== epoch || authorizing || directState.phase === 'authorizing')
          throw new Error('配对或授权状态已变化，请重新核对后重试');
        directState = { phase: 'authorizing', message: '正在核验配对后台，随后读取指定登录字段…' };
        authorizing = true;
        void authorizeDirect(settings, generation);
        respond({ ok: true, ...snapshot() });
        return;
      }
      if (message.type === 'disconnect') {
        await chrome.storage.local.remove(['bridge', 'bridge_direct']);
        resetConnection();
        settings = undefined;
        directMode = false;
        directState = { phase: 'idle', message: '' };
        phase = 'idle';
        state = '已断开并清除本机配对配置';
      } else if (message.type === 'configure') {
        const config = validateConfig(message.config);
        await chrome.storage.local.remove('bridge_direct');
        await chrome.storage.local.set({ bridge: config });
        resetConnection();
        settings = config;
        directMode = false;
        directState = { phase: 'idle', message: '' };
        await connect();
      } else {
        if (!settings) throw new Error('尚未保存配对配置，请先从后台完整复制配对 JSON');
        await chrome.storage.local.remove('bridge_direct');
        directMode = false;
        directState = { phase: 'idle', message: '' };
        resetConnection();
        await connect();
      }
      respond({ ok: true, ...snapshot() });
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : '操作未完成，请重试' });
    }
  })();
  return true;
});
