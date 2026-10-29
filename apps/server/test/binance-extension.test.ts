import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { binanceGroup } from '../src/binance.ts';
import { testPng } from './image-fixture.ts';

const directory = 'extensions/binance-browser/';
const config = {
  server_url: 'ws://127.0.0.1:3000/api/v1/connectors/binance/socket',
  account_id: randomUUID(),
  pairing_secret: 'a'.repeat(43),
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function imagePage(
  mode: 'confirmed' | 'missing_ack' | 'unsafe_url' | 'rejected' | 'expired',
  caption = '图片说明',
) {
  let socket: any;
  const frames: any[] = [],
    calls: any[] = [];
  const key = 'group-images/object-image-key';
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: any) => void;
    constructor() {
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(text: string) {
      const frame = JSON.parse(text);
      frames.push(frame);
      if (frame.msgType === 'HEART_BEAT') queueMicrotask(() => this.onmessage?.({ data: text }));
    }
  }
  const result = await pageRequest(
    async (url: string, options: any) => {
      calls.push({ url, options });
      if (options.method === 'PUT') {
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.deepEqual(Object.keys(options.headers), ['Content-Type']);
        assert(Buffer.from(await options.body.arrayBuffer()).equals(testPng()));
        if (mode === 'confirmed') {
          const confirmed = {
            msgType: 'U_IMAGE',
            content: caption || undefined,
            sessionId: '10001',
            sessionType: 'GROUP',
            sender: { chatUserId: '123' },
            fileProperties: { fileObjKey: key },
            localId: 'server-local',
            msgId: '98765',
          };
          for (const wrong of [
            { ...confirmed, sessionId: 'other' },
            { ...confirmed, sender: { chatUserId: 'other' } },
            { ...confirmed, content: 'wrong caption' },
            { ...confirmed, fileProperties: { fileObjKey: 'other' } },
            { ...confirmed, msgType: 'U_TEXT' },
          ])
            socket.onmessage({ data: JSON.stringify(wrong) });
          queueMicrotask(() => socket.onmessage({ data: JSON.stringify(confirmed) }));
        }
        return { ok: true, status: 200 };
      }
      if (url.endsWith('get-file-upload-url')) {
        assert.deepEqual(JSON.parse(options.body), {
          channelId: 10001,
          fileName: 'superbot-0123456789ab.png',
          text: caption,
          mentionAll: false,
          mentionUserNameMap: {},
          refId: '42',
        });
        return apiResponse({
          success: mode !== 'rejected',
          code: mode === 'rejected' ? '403' : '000000',
          data: {
            key,
            url:
              mode === 'unsafe_url'
                ? 'https://127.0.0.1/private'
                : 'https://bucket.s3.ap-southeast-1.amazonaws.com/upload?signature=private-fixture-signature',
          },
        });
      }
      const data = url.endsWith('get-my-profile')
        ? { chatUserId: '123' }
        : url.endsWith('get-channel-info')
          ? { id: '10001', name: 'fixture', systemMute: { muted: false }, ownerBan: { banned: false } }
          : url.endsWith('get-current-member-info')
            ? { role: 1, memberStatusInChannel: null, disabledReasonTypes: null, permissionMap: null }
            : url.endsWith('chat-restriction')
              ? { groupTextRestricted: false }
              : url.endsWith('/token')
                ? { uid: '123', token: 'private-fixture-token' }
                : { 'c2c-im': 'wss://stream.binance.com' };
      return apiResponse({ success: true, data });
    },
    'cr00=private-cookie',
    {
      operation: 'send_image',
      group_ids: ['10001'],
      params: {
        group_id: '10001',
        expected_user_id: '123',
        text: caption,
        reply_to: '42',
        local_id: randomUUID(),
        not_after: Date.now() + (mode === 'expired' ? -1 : 90000),
        image: {
          name: 'superbot-0123456789ab.png',
          content_type: 'image/png',
          width: 32,
          height: 24,
          data: testPng().toString('base64'),
        },
      },
    },
    {
      WebSocket: Socket,
      Blob,
      Uint8Array,
      setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay > 30000 ? 5 : delay),
      setInterval: () => 0,
      clearInterval() {},
    },
  );
  return { result, calls, frames };
}

test('Binance group images publish once through signed upload and require the exact self-image receipt, including caption', async () => {
  for (const caption of ['图片说明', '']) {
    const { result, calls, frames } = await imagePage('confirmed', caption);
    assert.equal(result.ok, true);
    assert.equal(result.data.message_id, '98765');
    assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 1);
    assert(frames.every((frame) => frame.msgType === 'HEART_BEAT')); // No duplicate image send frame.
    for (const secret of [
      'private-cookie',
      'private-fixture-token',
      'private-fixture-signature',
      testPng().toString('base64'),
    ])
      assert(!JSON.stringify(result).includes(secret));
  }
});

test('Binance rejects unsafe or denied uploads before sending bytes and treats an upload without a message receipt as uncertain', async () => {
  for (const mode of ['unsafe_url', 'rejected', 'expired', 'missing_ack'] as const) {
    const { result, calls, frames } = await imagePage(mode);
    assert.equal(result.ok, false);
    assert.equal(result.error.effect, mode === 'missing_ack' ? 'possible' : 'none');
    assert.equal(
      calls.filter((call) => call.options.method === 'PUT').length,
      mode === 'missing_ack' ? 1 : 0,
    );
    assert(frames.every((frame) => frame.msgType === 'HEART_BEAT'));
    assert(!JSON.stringify(result).includes('private-fixture-signature'));
  }
});

async function background(urls: string[] = [], stored?: unknown) {
  let listener: any,
    nextTimer = 0;
  const storage: any = { bridge: stored };
  const timers = new Map<number, { fn: () => void; delay: number }>();
  const sockets: any[] = [],
    pageRequests: any[] = [];
  let pageReply: any = { ok: true, data: { chatUserId: '123' } };
  const manifest = JSON.parse(await readFile(directory + 'manifest.json', 'utf8'));
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    onmessage?: (event: { data: string }) => Promise<void>;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    wire: any[] = [];
    url: string;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(data: string) {
      this.wire.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  }
  const context = vm.createContext({
    URL,
    TextEncoder,
    crypto: webcrypto,
    WebSocket: Socket,
    setTimeout(fn: () => void, delay: number) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    chrome: {
      runtime: {
        id: 'bridge-test',
        getManifest: () => manifest,
        getURL: (path: string) => 'chrome-extension://bridge-test/' + path,
        onMessage: {
          addListener(fn: any) {
            listener = fn;
          },
        },
      },
      storage: {
        local: {
          get: async () => ({ ...storage }),
          set: async (value: any) => {
            Object.assign(storage, value);
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          },
        },
      },
      tabs: {
        query: async () => urls.map((url, i) => ({ id: i + 1, url })),
        get: async (id: number) => ({ id, url: urls[id - 1] }),
        sendMessage: async (id: number, request: any) => {
          pageRequests.push({ id, request });
          return pageReply;
        },
      },
    },
  });
  vm.runInContext(await readFile(directory + 'background.js', 'utf8'), context);
  const send = (message: any) =>
    new Promise<any>((resolve) => listener(message, { id: 'bridge-test' }, resolve));
  await flush();
  return {
    send,
    sockets,
    timers,
    pageRequests,
    stored: () => storage.bridge,
    setPageReply: (value: any) => {
      pageReply = value;
    },
  };
}

test('extension recognizes Square chat, legacy chatroom and the direct chat widget without widening host access', async () => {
  for (const path of [
    '/zh-CN/square/chat',
    '/en/square/chat/',
    '/zh-CN/chatroom',
    '/zh-CN/chatWidgetEntrance',
  ]) {
    const bg = await background(['https://www.binance.com' + path]);
    const result = await bg.send({ type: 'configure', config });
    assert.equal(result.ok, true);
    assert.equal(result.saved, true);
    assert.equal(result.phase, 'connecting');
    assert.equal(bg.sockets.length, 1);
    const socket = bg.sockets[0];
    socket.readyState = 1;
    const nonce = 'one-time-nonce';
    await socket.onmessage({ data: JSON.stringify({ type: 'challenge', nonce }) });
    assert.equal(
      socket.wire[0].proof,
      createHmac('sha256', config.pairing_secret)
        .update(`qsb-binance-v1:${nonce}:${config.account_id}`)
        .digest('hex'),
    );
    await socket.onmessage({ data: JSON.stringify({ type: 'ready', group_ids: ['10001'] }) });
    assert.equal((await bg.send({ type: 'status' })).phase, 'connected');
    await socket.onmessage({
      data: JSON.stringify({ type: 'request', id: randomUUID(), operation: 'profile', params: {} }),
    });
    assert.equal(bg.pageRequests.length, 1);
    assert.equal(socket.wire.at(-1).ok, true);
    assert.equal(JSON.stringify(await bg.send({ type: 'status' })).includes(config.pairing_secret), false);
  }
  const manifest = JSON.parse(await readFile(directory + 'manifest.json', 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://www.binance.com/*']);
  assert.ok(manifest.content_scripts[0].matches.includes('https://www.binance.com/*/square/chat*'));
  assert.notEqual(manifest.content_scripts[0].all_frames, true);
});

test('scope changes update selected groups without re-pairing and each operation carries the current server scope', async () => {
  const bg = await background(['https://www.binance.com/zh-CN/square/chat']);
  await bg.send({ type: 'configure', config });
  const socket = bg.sockets[0];
  socket.readyState = 1;
  await socket.onmessage({ data: JSON.stringify({ type: 'challenge', nonce: 'scope-challenge' }) });
  await socket.onmessage({ data: JSON.stringify({ type: 'ready', group_ids: ['10001'] }) });
  await socket.onmessage({ data: JSON.stringify({ type: 'scope', group_ids: ['2000'] }) });
  await socket.onmessage({
    data: JSON.stringify({
      type: 'request',
      id: randomUUID(),
      operation: 'history',
      params: { group_id: '2000' },
      group_ids: ['2000'],
    }),
  });
  assert.deepEqual(Array.from(bg.pageRequests.at(-1).request.group_ids), ['2000']);
  assert.equal(bg.stored().pairing_secret, config.pairing_secret);
  assert.equal(bg.sockets.length, 1);
  await socket.onmessage({
    data: JSON.stringify({
      type: 'request',
      id: randomUUID(),
      operation: 'groups',
      params: { archived: false },
      group_ids: [],
    }),
  });
  assert.equal(bg.pageRequests.at(-1).request.operation, 'groups');
  assert.deepEqual(Array.from(bg.pageRequests.at(-1).request.group_ids), []);
});

test('saving without a chat tab reports saved configuration and waiting state; the stored configuration can reconnect', async () => {
  const urls: string[] = [];
  const bg = await background(urls);
  const saved = await bg.send({ type: 'configure', config });
  assert.equal(saved.ok, true);
  assert.equal(saved.saved, true);
  assert.equal(saved.phase, 'waiting_tab');
  assert.match(saved.state, /配置已保存/);
  assert.equal(bg.stored().account_id, config.account_id);
  urls.push('https://www.binance.com/zh-CN/square/chat');
  const retried = await bg.send({ type: 'retry' });
  assert.equal(retried.phase, 'connecting');
  assert.equal(bg.sockets.length, 1);
  const socket = bg.sockets[0];
  socket.onerror();
  socket.onclose({ code: 1006 });
  const unavailable = await bg.send({ type: 'status' });
  assert.equal(unavailable.saved, true);
  assert.equal(unavailable.phase, 'unreachable');
  assert.match(unavailable.state, /127\.0\.0\.1/);
});

test('invalid config leaves saved credentials intact; clearing and replacing a connection fences old callbacks', async () => {
  const bg = await background(['https://www.binance.com/zh-CN/square/chat']);
  await bg.send({ type: 'configure', config });
  const invalid = await bg.send({ type: 'configure', config: { server_url: config.server_url } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /account_id/);
  assert.equal(bg.stored().pairing_secret, config.pairing_secret);
  const old = bg.sockets[0];
  await bg.send({ type: 'disconnect' });
  await old.onmessage({ data: JSON.stringify({ type: 'ready', group_ids: ['999'] }) });
  old.onerror();
  const cleared = await bg.send({ type: 'status' });
  assert.equal(cleared.saved, false);
  assert.equal(cleared.phase, 'idle');
  assert.equal(cleared.groups.length, 0);
  assert.equal(bg.stored(), undefined);
});

test('an invalid pairing is shown explicitly and does not keep retrying the same revoked key', async () => {
  const bg = await background(['https://www.binance.com/zh-CN/square/chat']);
  await bg.send({ type: 'configure', config });
  bg.sockets[0].onclose({ code: 1008 });
  const state = await bg.send({ type: 'status' });
  assert.equal(state.phase, 'auth_failed');
  assert.match(state.state, /配对/);
  assert.equal([...bg.timers.values()].filter((timer) => timer.delay === 5000).length, 0);
});

async function popup(
  saved = false,
  options: { permission?: boolean; lostAuthorizationResponse?: boolean } = {},
) {
  const listeners = new Map<string, (event?: any) => any>();
  const elements = new Map<string, any>();
  let tick: (() => void) | undefined;
  const calls: any[] = [];
  let permissionRequests = 0,
    permissionRemovals = 0;
  let state: any = {
    state: '未找到币安聊天标签',
    phase: 'waiting_tab',
    saved,
    version: '0.1.1',
    groups: [],
    direct: { phase: 'idle', busy: false },
    ...(saved ? { server_url: config.server_url, account_id: config.account_id } : {}),
  };
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        value: '',
        hidden: false,
        disabled: false,
        dataset: {},
        className: '',
        addEventListener(type: string, fn: any) {
          listeners.set(`${id}:${type}`, fn);
        },
      });
    return elements.get(id);
  };
  vm.runInContext(
    await readFile(directory + 'popup.js', 'utf8'),
    vm.createContext({
      URL,
      document: { getElementById: element },
      chrome: {
        runtime: {
          sendMessage: async (message: any) => {
            calls.push(message);
            if (message.type === 'configure')
              state = { ...state, saved: true, server_url: config.server_url };
            if (message.type === 'authorize-direct') {
              state = { ...state, direct: { phase: 'authorizing', busy: true } };
              if (options.lostAuthorizationResponse) throw new Error('Response channel interrupted');
            }
            return message.type === 'status' ? state : { ok: true, ...state };
          },
        },
        permissions: {
          request: async () => {
            permissionRequests++;
            return options.permission ?? true;
          },
          remove: async () => {
            permissionRemovals++;
            return true;
          },
        },
      },
      setTimeout,
      clearTimeout,
      setInterval(fn: () => void) {
        tick = fn;
        return 1;
      },
      clearInterval() {},
      window: { addEventListener() {} },
    }),
  );
  await flush();
  return {
    element,
    calls,
    submit: () => listeners.get('form:submit')!({ preventDefault() {} }),
    authorize: () => listeners.get('authorize-direct:click')!(),
    permissions: () => ({ requested: permissionRequests, removed: permissionRemovals }),
    tick: async () => {
      tick?.();
      await flush();
    },
  };
}

test('popup keeps empty and malformed config errors visible after status polling', async () => {
  const ui = await popup();
  await ui.submit();
  assert.match(ui.element('notice').textContent, /完整配对 JSON/);
  const empty = ui.element('notice').textContent;
  await ui.tick();
  assert.equal(ui.element('notice').textContent, empty);
  ui.element('config').value = '{"server_url":"ws://127.0.0.1:3000",…}';
  await ui.submit();
  assert.match(ui.element('notice').textContent, /不是有效 JSON/);
  await ui.tick();
  assert.match(ui.element('notice').textContent, /不是有效 JSON/);
  assert.equal(ui.calls.filter((value) => value.type === 'configure').length, 0);
});

test('extension popup requires explicit consent and an approved permission before starting authorization', async () => {
  const ui = await popup(true, { permission: false });
  await ui.authorize();
  assert.equal(ui.permissions().requested, 0);
  ui.element('direct-consent').checked = true;
  await ui.authorize();
  assert.equal(ui.permissions().requested, 1);
  assert.equal(ui.calls.filter((c) => c.type === 'authorize-direct').length, 0);
  assert.match(ui.element('notice').textContent, /未授予/);
  const allowed = await popup(true);
  allowed.element('direct-consent').checked = true;
  await allowed.authorize();
  assert.equal(allowed.calls.filter((c) => c.type === 'authorize-direct').length, 1);
  assert.equal(allowed.permissions().removed, 0);
  assert.equal(allowed.element('authorize-direct').disabled, true);
});

test('a lost popup response leaves authorization unknown and never revokes permission from an active background run', async () => {
  const ui = await popup(true, { lostAuthorizationResponse: true });
  ui.element('direct-consent').checked = true;
  await ui.authorize();
  assert.match(ui.element('notice').textContent, /状态未确认/);
  assert.equal(ui.permissions().removed, 0);
  assert.equal(ui.element('authorize-direct').disabled, true);
  assert.equal(ui.calls.filter((c) => c.type === 'authorize-direct').length, 1);
});

test('popup separates successful saving from connection state and reuses saved credentials without exposing them', async () => {
  const ui = await popup();
  ui.element('config').value = JSON.stringify(config);
  await ui.submit();
  assert.equal(ui.element('config').value, '');
  assert.match(ui.element('notice').textContent, /配置已保存/);
  assert.match(ui.element('status').textContent, /未找到/);
  assert.match(ui.element('saved-config').textContent, /无需重复粘贴/);
  assert.equal(ui.element('retry').disabled, false);
  assert.equal(ui.element('local-hint').hidden, false);
  await ui.tick();
  assert.match(ui.element('notice').textContent, /配置已保存/);
  await ui.submit();
  assert.equal(ui.calls.at(-1).type, 'retry');
  assert.equal(ui.element('saved-address').textContent.includes(config.pairing_secret), false);
});

test('page bridge processes a profile request from the Square chat route', async () => {
  let listener: any,
    fetched = 0;
  vm.runInContext(
    await readFile(directory + 'content.js', 'utf8'),
    vm.createContext({
      location: { origin: 'https://www.binance.com', pathname: '/zh-CN/square/chat' },
      document: { cookie: '' },
      chrome: {
        runtime: {
          id: 'bridge-test',
          onMessage: {
            addListener(fn: any) {
              listener = fn;
            },
          },
        },
      },
      window: { addEventListener() {} },
      AbortSignal,
      TextEncoder,
      URL,
      fetch: async () => {
        fetched++;
        return { ok: true, text: async () => JSON.stringify({ success: true, data: { chatUserId: '123' } }) };
      },
    }),
  );
  const result: any = await new Promise((resolve) =>
    listener({ type: 'qsb-binance-request', operation: 'profile' }, { id: 'bridge-test' }, resolve),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.chatUserId, '123');
  assert.equal(fetched, 1);
});

async function pageRequest(
  fetcher: (...args: any[]) => any,
  cookie = '',
  request: any = { operation: 'profile' },
  runtime: Record<string, unknown> = {},
) {
  let listener: any;
  vm.runInContext(
    await readFile(directory + 'content.js', 'utf8'),
    vm.createContext({
      location: { origin: 'https://www.binance.com', pathname: '/zh-CN/square/chat' },
      document: { cookie },
      chrome: {
        runtime: {
          id: 'bridge-test',
          onMessage: {
            addListener(fn: any) {
              listener = fn;
            },
          },
        },
      },
      window: { addEventListener() {} },
      AbortSignal,
      TextEncoder,
      URL,
      fetch: fetcher,
      atob,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      ...runtime,
    }),
  );
  return new Promise<any>((resolve) =>
    listener({ type: 'qsb-binance-request', ...request }, { id: 'bridge-test' }, resolve),
  );
}
const apiResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

test('room discovery exports confirmed group memberships and a timestamp cursor without exporting private sessions or last messages', async () => {
  const fetched: any[] = [];
  const fetcher = async (path: string, options: any) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    fetched.push({ path, body });
    if (path.endsWith('get-my-profile')) return apiResponse({ success: true, data: { chatUserId: '123' } });
    if (path.endsWith('chat-list')) {
      assert.equal(body.sessionListType, 4);
      assert.equal(body.sessionType, 'GROUP');
      assert.equal(body.rows, 20);
      assert.equal(body.isArchived, true);
      assert.equal(body.timestamp, 200);
      return apiResponse({
        success: true,
        hasMore: true,
        data: [
          {
            sessionId: '10001',
            sessionType: 'GROUP',
            sessionName: '已加入的群',
            totalMemberCount: 8,
            lastMessageTime: 100,
            lastUnifiedMessage: { timestamp: 100, content: 'private-last-message' },
          },
          { sessionId: '2000', sessionType: 'GROUP', sessionName: '已退出的群', lastMessageTime: 90 },
          {
            sessionId: '3000',
            sessionType: 'GROUP',
            sessionName: '群主已解散',
            disbanded: true,
            lastMessageTime: 80,
          },
          { sessionId: '4000', sessionType: 'PRIVATE', sessionName: 'private-user', lastMessageTime: 70 },
        ],
      });
    }
    return apiResponse({
      success: true,
      data:
        body.channelId === '10001'
          ? { role: 1, memberStatusInChannel: null }
          : { role: 1, memberStatusInChannel: 1 },
    });
  };
  const result = await pageRequest(fetcher, 'cr00=private-cookie', {
    operation: 'groups',
    params: { archived: true, timestamp: 200, expected_user_id: '123' },
    group_ids: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    groups: [{ id: '10001', name: '已加入的群', member_count: 8 }],
    has_more: true,
    next_timestamp: 70,
  });
  assert.equal(fetched.filter((item) => item.path.endsWith('get-current-member-info')).length, 2);
  for (const secret of ['private-user', 'private-last-message', 'private-cookie'])
    assert(!JSON.stringify(result).includes(secret));
  const empty = await pageRequest(
    async (path: string) =>
      apiResponse({ success: true, data: path.endsWith('get-my-profile') ? { chatUserId: '123' } : null }),
    '',
    { operation: 'groups', params: { archived: false }, group_ids: [] },
  );
  assert.equal(empty.ok, true);
  assert.equal(empty.data.groups.length, 0);
  assert.equal(empty.data.has_more, false);
});

test('image URLs come only from the fixed media API for an authorized group and the exact requested message', async () => {
  let requests = 0;
  const fetcher = async (path: string, options: any) => {
    requests++;
    if (path.endsWith('get-my-profile')) return apiResponse({ success: true, data: { chatUserId: '123' } });
    assert.equal(path, '/bapi/c2c/v1/friendly/binance-chat/channel/get-file-url');
    assert.deepEqual(JSON.parse(options.body), {
      channelId: '10001',
      msgIds: ['90071992547409933'],
      fileType: 0,
    });
    return apiResponse({
      success: true,
      data: {
        msgUrls: [
          {
            msgId: '90071992547409933',
            url: 'https://cdn.example.com/photo.png?expires=1',
            unused: 'private-field',
          },
        ],
      },
    });
  };
  const params = { group_id: '10001', message_id: '90071992547409933', expected_user_id: '123' };
  const result = await pageRequest(fetcher, '', { operation: 'image_url', params, group_ids: ['10001'] });
  assert.equal(result.ok, true);
  assert.equal(result.data.url, 'https://cdn.example.com/photo.png?expires=1');
  assert(!JSON.stringify(result).includes('private-field'));
  const denied = await pageRequest(fetcher, '', { operation: 'image_url', params, group_ids: [] });
  assert.equal(denied.ok, false);
  assert.equal(requests, 2);
  for (const url of [
    'javascript:alert(1)',
    'http://cdn.example.com/a.png',
    'https://user:password@cdn.example.com/a.png',
  ]) {
    const invalid = await pageRequest(
      async (path: string) =>
        apiResponse({
          success: true,
          data: path.endsWith('get-my-profile')
            ? { chatUserId: '123' }
            : { msgUrls: [{ msgId: params.message_id, url }] },
        }),
      '',
      { operation: 'image_url', params, group_ids: ['10001'] },
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.stage, 'image');
  }
});

test('browser uses the official MD5(cr00) CSRF scheme for GET, including UTF-8 and MD5 block boundaries', async () => {
  for (const secret of [
    '',
    'a',
    'abc',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'x'.repeat(1000),
    '中文🔑',
  ]) {
    let headers: any;
    const result = await pageRequest(
      async (path, options) => {
        assert.equal(path, '/bapi/c2c/v3/private/binance-chat/user/get-my-profile');
        assert.equal(options.method, 'GET');
        assert.equal(options.credentials, 'include');
        headers = options.headers;
        return apiResponse({
          success: true,
          data: { chatUserId: '123', unusedPrivateField: 'must-not-leave-page' },
        });
      },
      'other=local;cr00=' + encodeURIComponent(secret) + '; csrftoken=stale-token',
    );
    assert.equal(result.ok, true);
    assert.equal(headers.csrftoken, createHash('md5').update(secret).digest('hex'));
    assert.equal(headers.c2ctype, 'c2c_web');
    assert.deepEqual(Object.keys(result.data), ['chatUserId']);
    assert(!JSON.stringify(result).includes('must-not-leave-page'));
    assert(!JSON.stringify(result).includes('stale-token'));
  }
});

test('browser reports only safe HTTP and platform codes, without returning response bodies or cookies', async () => {
  const secret = 'private-cookie-value';
  const http = await pageRequest(
    async () => ({ ok: false, status: 403, text: async () => '<html>' + secret + '</html>' }),
    'cr00=' + secret,
  );
  assert.equal(
    JSON.stringify(http),
    JSON.stringify({ ok: false, error: { code: 'HTTP', stage: 'profile', http_status: 403 } }),
  );
  const platform = await pageRequest(async () =>
    apiResponse({ success: false, code: '100001005', message: secret, data: { secret } }),
  );
  assert.equal(platform.error.code, 'API');
  assert.equal(platform.error.api_code, '100001005');
  assert(!JSON.stringify(platform).includes(secret));
  const maliciousCode = await pageRequest(async () =>
    apiResponse({ success: false, code: secret, message: secret }),
  );
  assert.equal(maliciousCode.error.api_code, undefined);
  assert(!JSON.stringify(maliciousCode).includes(secret));
});

test('browser distinguishes network, timeout and invalid JSON failures without forwarding exception text', async () => {
  for (const name of ['TypeError', 'TimeoutError', 'AbortError']) {
    const result = await pageRequest(async () => {
      const error = new Error('secret-exception-content');
      error.name = name;
      throw error;
    });
    assert.equal(result.error.code, name === 'TypeError' ? 'NETWORK' : 'TIMEOUT');
    assert(!JSON.stringify(result).includes('secret-exception-content'));
  }
  const result = await pageRequest(async () => ({
    ok: true,
    status: 200,
    text: async () => '<html>not-json</html>',
  }));
  assert.equal(result.error.code, 'NON_JSON');
});

test('a failed member request identifies the exact API stage after the profile succeeded', async () => {
  const result = await pageRequest(
    async (path) => {
      if (path.endsWith('/get-my-profile'))
        return apiResponse({ success: true, data: { chatUserId: '123' } });
      if (path.endsWith('/get-current-member-info'))
        return apiResponse({ success: false, code: '100001003' }, 403);
      return apiResponse({ success: true, data: { id: '10001' } });
    },
    '',
    { operation: 'group', params: { group_id: '10001', expected_user_id: '123' }, group_ids: ['10001'] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.stage, 'member');
  assert.equal(result.error.http_status, 403);
});

test('history uses the official 20-row page and preserves scope, large IDs and incremental cursor', async () => {
  let requested: any;
  const result = await pageRequest(
    async (path, options) => {
      if (path.endsWith('/get-my-profile'))
        return apiResponse({ success: true, data: { chatUserId: '123' } });
      requested = JSON.parse(options.body);
      return apiResponse({
        success: true,
        data: {
          messages: [
            {
              msgId: '90071992547409933',
              sessionId: '10001',
              sessionType: 'GROUP',
              msgType: 'U_TEXT',
              content: 'scope test',
              timestamp: Date.now(),
              sender: {
                chatUserId: '42',
                name: '真实昵称',
                avatarUrl: 'https://example.com/avatar.png',
                privateProfile: 'never-export',
              },
              privateValue: 'do-not-export',
            },
            { msgId: '2', sessionId: '999', sessionType: 'GROUP' },
          ],
        },
      });
    },
    '',
    { operation: 'history', params: { group_id: '10001', min_id: '90071992547409932' }, group_ids: ['10001'] },
  );
  assert.equal(result.ok, true);
  assert.equal(requested.rows, 20);
  assert.equal(requested.minMsgId, '90071992547409932');
  assert.equal(requested.direction, 'up');
  assert.equal(result.data.messages.length, 1);
  assert.equal(result.data.messages[0].msgId, '90071992547409933');
  assert.equal(result.data.messages[0].sender.nickname, '真实昵称');
  assert.equal(result.data.messages[0].sender.avatarUrl, 'https://example.com/avatar.png');
  assert(!JSON.stringify(result).includes('never-export'));
  assert(!JSON.stringify(result).includes('do-not-export'));
});

test('history distinguishes missing, null and malformed lists without declaring them empty or exporting response data', async () => {
  const shapes: Array<[unknown, string]> = [
    [null, 'DATA_NULL'],
    [[], 'DATA_ARRAY'],
    [false, 'DATA_TYPE'],
    [{ privateValue: 'secret-body' }, 'MESSAGES_MISSING'],
    [{ messages: null }, 'MESSAGES_NULL'],
    [{ messages: 'secret-body' }, 'MESSAGES_TYPE'],
    [{ messages: new Array(101).fill({}) }, 'MESSAGES_LIMIT'],
    [{ messages: [null] }, 'MESSAGE_ITEM'],
  ];
  for (const [data, detail] of shapes) {
    const result = await pageRequest(
      async (path) =>
        apiResponse({ success: true, data: path.endsWith('/get-my-profile') ? { chatUserId: '123' } : data }),
      '',
      { operation: 'history', params: { group_id: '10001' }, group_ids: ['10001'] },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.detail, detail);
    assert(!JSON.stringify(result).includes('secret-body'));
  }
});

test('extension shows and forwards sanitized diagnostics, while dropping arbitrary error strings', async () => {
  const bg = await background(['https://www.binance.com/zh-CN/square/chat']);
  await bg.send({ type: 'configure', config });
  const socket = bg.sockets[0];
  socket.readyState = 1;
  await socket.onmessage({ data: JSON.stringify({ type: 'ready', group_ids: ['10001'] }) });
  bg.setPageReply({
    ok: false,
    error: {
      code: 'HTTP',
      stage: 'profile',
      http_status: 403,
      api_code: '100001005',
      message: 'private-error-body',
      detail: 'MESSAGES_NULL',
    },
  });
  await socket.onmessage({
    data: JSON.stringify({ type: 'request', id: randomUUID(), operation: 'profile', params: {} }),
  });
  const state = await bg.send({ type: 'status' });
  assert.equal(state.phase, 'page_error');
  assert.match(state.state, /HTTP 403/);
  assert.match(state.state, /100001005/);
  assert.equal(socket.wire.at(-1).error.message, undefined);
  assert.equal(socket.wire.at(-1).error.detail, 'MESSAGES_NULL');
  assert.match(state.state, /messages 字段为空值/);
  assert(!JSON.stringify(state).includes('private-error-body'));
  bg.setPageReply({
    ok: false,
    error: {
      code: 'private-error-body',
      stage: 'private-error-body',
      api_code: 'private-error-body',
      http_status: 'private-error-body',
      detail: 'private-error-body',
    },
  });
  await socket.onmessage({
    data: JSON.stringify({ type: 'request', id: randomUUID(), operation: 'profile', params: {} }),
  });
  assert.equal(socket.wire.at(-1).error.code, 'FORMAT');
  assert(!JSON.stringify(socket.wire.at(-1)).includes('private-error-body'));
});

test('browser and server agree on nullable member status, current roles and explicit sending restrictions', async () => {
  const base = {
    group: {
      id: '10001',
      name: '权限测试群',
      permissionMap: { '1': false },
      systemMute: { muted: false },
      ownerBan: { banned: false },
    },
    member: {
      role: 3,
      memberStatusInChannel: null,
      disabledReasonTypes: [] as string[],
      permissionMap: { '1': false },
    },
    restriction: { groupTextRestricted: false },
  };
  const cases: Array<[any, string]> = [
    [base, 'granted'],
    ...[0, 1, 2, 3].map((role): [any, string] => [{ ...base, member: { ...base.member, role } }, 'granted']),
    [{ ...base, member: { ...base.member, memberStatusInChannel: 1 } }, 'denied'],
    [{ ...base, member: { ...base.member, memberStatusInChannel: 2 } }, 'denied'],
    [{ ...base, member: { ...base.member, disabledReasonTypes: ['SINGLE_MUTED'] } }, 'denied'],
    [{ ...base, member: { ...base.member, disabledReasonTypes: ['UNKNOWN_FUTURE_REASON'] } }, 'denied'],
    [{ ...base, member: { ...base.member, disabledReasonTypes: null } }, 'granted'],
    [
      {
        ...base,
        member: { role: 1, memberStatusInChannel: null, disabledReasonTypes: null, permissionMap: null },
      },
      'granted',
    ],
    [
      {
        ...base,
        member: { role: 0, memberStatusInChannel: null, disabledReasonTypes: null, permissionMap: null },
      },
      'unknown',
    ],
    [{ ...base, member: { ...base.member, role: null } }, 'unknown'],
    [{ ...base, restriction: { groupTextRestricted: true } }, 'denied'],
    [{ ...base, group: { ...base.group, systemMute: { muted: true } } }, 'denied'],
    [{ ...base, group: { ...base.group, systemMute: {} } }, 'unknown'],
    [{ ...base, group: { ...base.group, disbanded: true } }, 'denied'],
    [{ ...base, group: { ...base.group, windowMessageLimit: 0 } }, 'denied'],
    [{ ...base, group: { ...base.group, permissionMap: { '1': true } } }, 'granted'],
    [
      {
        ...base,
        group: { ...base.group, permissionMap: { '1': true } },
        member: { ...base.member, role: 2 },
      },
      'denied',
    ],
    [{ ...base, member: { ...base.member, permissionMap: { '1': true } } }, 'denied'],
    [{ ...base, member: { ...base.member, permissionMap: { '1': 'false' } } }, 'unknown'],
  ];
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ exp: expiry, private_claim: 'never-export' })).toString('base64url'),
    'signature',
  ].join('.');
  for (const [input, expected] of cases) {
    assert.equal(binanceGroup('10001', input).permissions[1]!.permission, expected);
    const frames: any[] = [];
    let opened = 0;
    class Socket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: any) => void;
      constructor() {
        opened++;
        queueMicrotask(() => this.onopen?.());
      }
      send(text: string) {
        const value = JSON.parse(text);
        frames.push(value);
        if (value.msgType === 'HEART_BEAT')
          queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) }));
      }
      close() {
        this.readyState = 3;
      }
    }
    const result = await pageRequest(
      async (path, options) => {
        const data = path.endsWith('get-my-profile')
          ? { chatUserId: '123' }
          : path.endsWith('get-channel-info')
            ? input.group
            : path.endsWith('get-current-member-info')
              ? input.member
              : path.endsWith('chat-restriction')
                ? input.restriction
                : path.endsWith('/token')
                  ? { uid: '123', token }
                  : { 'c2c-im': 'wss://stream.binance.com' };
        if (path.endsWith('chat-restriction'))
          assert.deepEqual(JSON.parse(options.body), { scenario: 1, source: 'p2p' });
        return apiResponse({ success: true, data });
      },
      '',
      { operation: 'send_check', params: { group_id: '10001', expected_user_id: '123' }, group_ids: ['10001'] },
      { WebSocket: Socket, setInterval: () => 0, clearInterval() {} },
    );
    assert.equal(result.ok, expected === 'granted');
    assert.equal(opened, expected === 'granted' ? 1 : 0);
    assert.ok(frames.every((frame) => frame.msgType === 'HEART_BEAT'));
    if (result.ok) {
      assert.equal(result.data.connection, 'open');
      assert.equal(result.data.token_format, 'jwt');
      assert.equal(result.data.token_expires_at, new Date(expiry * 1000).toISOString());
    } else assert.equal(result.error.code, 'PERMISSION');
    assert(!JSON.stringify(result).includes(token));
    assert(!JSON.stringify(result).includes('never-export'));
  }
});

test('successful nullable restriction responses follow the official inactive flag semantics; malformed responses stay unknown', async () => {
  const cases: Array<[unknown, string]> = [
    [undefined, 'granted'],
    [null, 'granted'],
    [{}, 'granted'],
    [{ groupTextRestricted: null, private_claim: 'never-export' }, 'granted'],
    [{ groupTextRestricted: false }, 'granted'],
    [{ groupTextRestricted: true }, 'denied'],
    [{ groupTextRestricted: 'false' }, 'unknown'],
    [{ groupTextRestricted: 0 }, 'unknown'],
    [[], 'unknown'],
    [true, 'unknown'],
    ['private-error', 'unknown'],
  ];
  for (const [restriction, expected] of cases) {
    const frames: any[] = [];
    class Socket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: any) => void;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      send(text: string) {
        const frame = JSON.parse(text);
        frames.push(frame);
        queueMicrotask(() => this.onmessage?.({ data: text }));
      }
    }
    const fetcher = async (path: string) =>
      apiResponse({
        success: true,
        data: path.endsWith('get-my-profile')
          ? { chatUserId: '123' }
          : path.endsWith('get-channel-info')
            ? { id: '10001', name: '管理员权限测试群' }
            : path.endsWith('get-current-member-info')
              ? { role: 1, memberStatusInChannel: null, disabledReasonTypes: null, permissionMap: null }
              : path.endsWith('chat-restriction')
                ? restriction
                : path.endsWith('/token')
                  ? { uid: '123', token: 'private-token' }
                  : { 'c2c-im': 'wss://stream.binance.com' },
      });
    const request = { params: { group_id: '10001', expected_user_id: '123' }, group_ids: ['10001'] };
    const group = await pageRequest(fetcher, '', { ...request, operation: 'group' });
    assert.equal(group.ok, true);
    assert.equal(binanceGroup('10001', group.data).permissions[1]!.permission, expected);
    assert.equal(group.data.restriction_error?.code, expected === 'unknown' ? 'FORMAT' : undefined);
    const probe = await pageRequest(
      fetcher,
      '',
      { ...request, operation: 'send_check' },
      { WebSocket: Socket, setInterval: () => 0, clearInterval() {} },
    );
    assert.equal(probe.ok, expected === 'granted');
    assert.equal(frames.length, expected === 'granted' ? 1 : 0);
    assert.ok(frames.every((frame) => frame.msgType === 'HEART_BEAT'));
    if (!probe.ok)
      assert.equal(probe.error.detail, expected === 'denied' ? 'MEMBER_DENIED' : 'RESTRICTION_UNKNOWN');
    const output = JSON.stringify({ group, probe });
    for (const secret of ['private_claim', 'never-export', 'private-error', 'private-token'])
      assert(!output.includes(secret));
  }
  // Missing normalized data from older extensions is still insufficient for the server.
  assert.equal(
    binanceGroup('10001', {
      group: { id: '10001', name: '测试群' },
      member: { role: 1, memberStatusInChannel: null },
      restriction: {},
    }).permissions[1]!.permission,
    'unknown',
  );
});

test('a failed restriction request preserves group discovery but blocks sending', async () => {
  const fetcher = async (path: string) =>
    path.endsWith('chat-restriction')
      ? apiResponse({ success: false, code: '100001005', message: 'private-error' }, 403)
      : apiResponse({
          success: true,
          data: path.endsWith('get-my-profile')
            ? { chatUserId: '123' }
            : path.endsWith('get-channel-info')
              ? { id: '10001', name: '测试群' }
              : { role: 3, memberStatusInChannel: null, disabledReasonTypes: [] },
        });
  const request = { params: { group_id: '10001' }, group_ids: ['10001'] };
  const group = await pageRequest(fetcher, '', { ...request, operation: 'group' });
  assert.equal(group.ok, true);
  assert.equal(group.data.restriction_error.stage, 'restriction');
  assert.equal(binanceGroup('10001', group.data).permissions[1]!.permission, 'unknown');
  const probe = await pageRequest(fetcher, '', { ...request, operation: 'send_check' });
  assert.equal(probe.ok, false);
  assert.equal(probe.error.detail, 'RESTRICTION_UNKNOWN');
  assert(!JSON.stringify(group).includes('private-error'));
});

test('send checks validate token identity, expiration, host and heartbeat without sending text or exporting credentials', async () => {
  const jwt = (payload: any) =>
    [
      Buffer.from('{"alg":"HS256"}').toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      'signature',
    ].join('.');
  const cases = [
    { token: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }), uid: '123', expected: 'TOKEN_EXPIRED' },
    { token: 'opaque-session', uid: '456', expected: 'TOKEN_IDENTITY' },
    { token: '', uid: '123', expected: 'TOKEN_FORMAT' },
    { token: 'opaque-session', uid: '123', host: 'wss://invalid.example.com', expected: 'DOMAIN_INVALID' },
    { token: 'opaque-session', uid: '123', silent: true, expected: 'SOCKET_TIMEOUT' },
    { token: 'opaque-session', uid: '123', expected: null, format: 'opaque' },
    { token: jwt({ iat: 1 }), uid: '123', expected: null, format: 'jwt' },
  ];
  for (const item of cases) {
    const frames: any[] = [];
    class Socket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onclose?: () => void;
      onmessage?: (event: any) => void;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      send(text: string) {
        const value = JSON.parse(text);
        frames.push(value);
        if (!item.silent) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) }));
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    const result = await pageRequest(
      async (path) =>
        apiResponse({
          success: true,
          data: path.endsWith('get-my-profile')
            ? { chatUserId: '123' }
            : path.endsWith('get-channel-info')
              ? { id: '10001' }
              : path.endsWith('get-current-member-info')
                ? { role: 3, memberStatusInChannel: null, disabledReasonTypes: [] }
                : path.endsWith('chat-restriction')
                  ? { groupTextRestricted: false }
                  : path.endsWith('/token')
                    ? { uid: item.uid, token: item.token }
                    : { 'c2c-im': item.host ?? 'wss://stream.binance.com' },
        }),
      '',
      { operation: 'send_check', params: { group_id: '10001' }, group_ids: ['10001'] },
      {
        WebSocket: Socket,
        setInterval: () => 0,
        clearInterval() {},
        setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay === 10000 ? 20 : delay),
      },
    );
    assert.equal(result.ok, item.expected === null);
    if (item.expected) assert.equal(result.error.detail, item.expected);
    else {
      assert.equal(result.data.token_format, item.format);
      assert.equal(result.data.token_expires_at, null);
    }
    assert.ok(frames.every((frame) => frame.msgType === 'HEART_BEAT'));
    assert.equal(result.data?.token, undefined);
    assert(!JSON.stringify(result).includes('opaque-session'));
  }
});
