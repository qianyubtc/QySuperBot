import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.ts';
import { createServices } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { SecretBox, sha } from '../src/security.ts';
import { BinanceDirect } from '../src/binance-direct.ts';
import { enrollmentProof } from '../src/binance-enrollment.ts';

const origin = 'chrome-extension://' + 'a'.repeat(32);
const cookieValues: Record<string, string> = {
  p20t: 'web.fixture-login',
  cr00: 'fixture-csrf-cookie',
  BNC_FV_KEY: 'fixture-device',
};
const group = {
  group: { id: '10001', name: 'fixture', systemMute: false, ownerBan: false },
  member: { role: 1, memberStatusInChannel: 0, disabledReasonTypes: [] },
  restriction: { groupTextRestricted: false },
};
let s: Awaited<ReturnType<typeof createServices>>,
  app: Awaited<ReturnType<typeof createHttpApp>>,
  url: string;
let uid = '123',
  prepareCount = 0,
  pauseProbe: (() => Promise<void>) | undefined;
const clients: Array<{ closed: boolean }> = [];
before(async () => {
  s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  s.binance.direct = new BinanceDirect(s.db, s.box, () => {
    const state = { closed: false };
    clients.push(state);
    prepareCount++;
    return {
      async request(message) {
        return message.operation === 'profile'
          ? { chatUserId: uid }
          : message.operation === 'group'
            ? group
            : { messages: [] };
      },
      async checkConnection() {
        await pauseProbe?.();
        return { connection: 'open', token_format: 'opaque', token_expires_at: null };
      },
      close() {
        state.closed = true;
      },
    };
  });
  app = await createHttpApp(s);
  await app.listen(0, '127.0.0.1');
  url = (await app.getUrl()).replace(/^http/, 'ws') + '/api/v1/connectors/binance/socket';
});
after(async () => {
  await app.close();
  await s.close();
});
async function fixture() {
  uid = '123';
  pauseProbe = undefined;
  const a = await s.accounts.create(
    { kind: 'binance', name: 'enrollment fixture', group_ids: ['10001'] },
    'test',
  );
  await s.db.query("UPDATE accounts SET external_id='123',session_id=$2,status='online' WHERE id=$1", [
    a.id,
    randomUUID(),
  ]);
  return { ...a.binance_bridge!, server_url: url };
}
const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, pass: (value: T) => boolean) {
  for (let i = 0; i < 250; i++) {
    const value = await read();
    if (pass(value)) return value;
    await delay();
  }
  throw new Error('Test condition did not complete');
}
async function background(
  config: any,
  options: {
    direct?: boolean;
    permission?: boolean;
    Socket?: any;
    stores?: any[];
    cleanupGate?: () => Promise<void>;
  } = {},
) {
  const storage: any = {
    bridge: config,
    ...(options.direct
      ? { bridge_direct: { server_url: config.server_url, account_id: config.account_id } }
      : {}),
  };
  const reads: any[] = [],
    sockets: any[] = [],
    timers = new Set<ReturnType<typeof setTimeout>>();
  let listener: any,
    allowed = options.permission ?? false,
    removals = 0;
  class Socket extends WebSocket {
    constructor(address: string) {
      super(address, { origin });
      sockets.push(this);
      this.on('error', () => {});
    }
  }
  const context = vm.createContext({
    URL,
    TextEncoder,
    crypto: webcrypto,
    WebSocket: options.Socket ?? Socket,
    setTimeout(fn: () => void, ms: number) {
      const timer = setTimeout(fn, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      clearTimeout(timer);
      timers.delete(timer);
    },
    chrome: {
      runtime: {
        id: 'fixture',
        getURL: (path: string) => origin + '/' + path,
        getManifest: () => ({ version: '0.1.10' }),
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
      permissions: {
        contains: async () => allowed,
        remove: async () => {
          await options.cleanupGate?.();
          allowed = false;
          removals++;
          return true;
        },
      },
      cookies: {
        getAllCookieStores: async () =>
          options.stores ?? [
            { id: 'wrong-store', tabIds: [99] },
            { id: 'selected-store', tabIds: [17] },
          ],
        get: async (request: any) => {
          reads.push(request);
          return { value: cookieValues[request.name] };
        },
      },
      tabs: {
        query: async () => [{ id: 17, url: 'https://www.binance.com/zh-CN/square/chat' }],
        get: async () => ({ id: 17, url: 'https://www.binance.com/zh-CN/square/chat' }),
        sendMessage: async (_id: number, request: any) => ({
          ok: true,
          data: request.operation === 'profile' ? { chatUserId: '123' } : group,
        }),
      },
    },
  });
  vm.runInContext(await readFile('extensions/binance-browser/background.js', 'utf8'), context);
  const send = (message: any, sender = { id: 'fixture', url: origin + '/popup.html' } as any) =>
    new Promise<any>((resolve) => {
      if (listener(message, sender, resolve) !== true) resolve(undefined);
    });
  await send({ type: 'status' });
  if (options.permission === undefined) allowed = true; // Simulate the popup's explicit permission grant.
  return {
    send,
    reads,
    storage,
    sockets,
    grant() {
      allowed = true;
    },
    removals: () => removals,
    authorize: (overrides = {}) =>
      send({
        type: 'authorize-direct',
        consent: true,
        server_url: config.server_url,
        account_id: config.account_id,
        ...overrides,
      }),
    async done() {
      return until(
        () => send({ type: 'status' }),
        (v) => ['active', 'error', 'unknown'].includes(v.direct.phase),
      );
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.terminate();
    },
  };
}

test('one explicit extension authorization mutually authenticates the paired backend, encrypts only selected login fields, and supports later renewal without a browser peer', async () => {
  const config = await fixture(),
    bg = await background(config);
  try {
    await until(
      () => s.accounts.get(config.account_id),
      (a) => a.status === 'online' && s.binance.peers.has(a.id),
    );
    assert.equal(bg.reads.length, 0);
    assert.equal((await bg.authorize()).ok, true);
    const state = await until(
      () => bg.send({ type: 'status' }),
      (v) => v.direct.phase === 'active' && v.phase === 'direct',
    );
    const a = await s.accounts.get(config.account_id);
    assert.equal(a.settings.transport, 'direct');
    assert.equal(a.status, 'online');
    assert.deepEqual(a.settings.group_ids, ['10001']);
    assert.deepEqual(JSON.parse(s.box.open(a.secret_box)), {
      mode: 'direct',
      web_token: cookieValues.p20t,
      csrf_cookie: cookieValues.cr00,
      device_id: cookieValues.BNC_FV_KEY,
    });
    assert.deepEqual(bg.reads.map((r) => r.name).sort(), ['BNC_FV_KEY', 'cr00', 'p20t']);
    assert(
      bg.reads.every(
        (r) => r.storeId === 'selected-store' && r.url.startsWith('https://www.binance.com/bapi/c2c/'),
      ),
    );
    for (const cookie of Object.values(cookieValues))
      assert(
        !JSON.stringify({
          state,
          storage: bg.storage,
          accounts: await s.accounts.list(),
          audit: await s.db.query('SELECT detail FROM audit'),
        }).includes(cookie),
      );
    await until(
      async () => bg.removals(),
      (count) => count === 1,
    );
    assert.equal(bg.storage.bridge.account_id, config.account_id);
    const firstSession = a.session_id;
    bg.grant();
    assert.equal((await bg.authorize()).ok, true);
    await until(
      () => bg.send({ type: 'status' }),
      (v) => v.direct.phase === 'active' && bg.reads.length === 6,
    );
    const renewed = await s.accounts.get(a.id);
    assert.notEqual(renewed.session_id, firstSession);
    assert.equal(renewed.settings.transport, 'direct');
    await until(
      async () => s.binance.peers.has(a.id),
      (value) => !value,
    );
    assert.equal(bg.sockets.length, 3); // One original peer and two explicit provisioning connections.
  } finally {
    bg.close();
  }
});

test('missing consent, denied permission, a different destination and non-popup senders cannot read cookies', async () => {
  const config = await fixture(),
    bg = await background(config, { direct: true, permission: false });
  try {
    assert.equal((await bg.authorize({ consent: false })).ok, false);
    assert.equal((await bg.authorize()).ok, false);
    bg.grant();
    assert.equal(
      (await bg.authorize({ server_url: 'wss://other.invalid/api/v1/connectors/binance/socket' })).ok,
      false,
    );
    assert.equal(
      await bg.send(
        { type: 'authorize-direct' },
        { id: 'fixture', tab: { id: 17 }, url: 'https://www.binance.com/zh-CN/square/chat' },
      ),
      undefined,
    );
    assert.equal(
      (
        await bg.send(
          { type: 'authorize-direct', consent: true, ...config },
          { id: 'fixture', url: origin + '/other.html' },
        )
      ).ok,
      false,
    );
    assert.equal(bg.reads.length, 0);
    assert.equal(bg.sockets.length, 0);
  } finally {
    bg.close();
  }
});

function fakeBackend(config: any, mode: 'forged' | 'disconnect' | 'malformed' | 'legacy') {
  const sockets: any[] = [],
    nonce = 'n'.repeat(43);
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    onmessage?: (event: any) => void;
    onclose?: (event: any) => void;
    onerror?: () => void;
    frames: any[] = [];
    constructor() {
      sockets.push(this);
      queueMicrotask(() =>
        this.onmessage?.({
          data:
            mode === 'malformed'
              ? cookieValues.p20t
              : JSON.stringify({
                  type: 'challenge',
                  nonce,
                  ...(mode === 'legacy' ? {} : { features: ['direct_authorization_v1'] }),
                }),
        }),
      );
    }
    send(raw: string) {
      const frame = JSON.parse(raw);
      this.frames.push(frame);
      if (frame.type === 'direct_hello')
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify({
              type: 'direct_ready',
              id: frame.id,
              proof:
                mode === 'forged'
                  ? '0'.repeat(64)
                  : enrollmentProof(config.pairing_secret, 'server', nonce, config.account_id, frame.id),
            }),
          }),
        );
      if (frame.type === 'direct_credentials') queueMicrotask(() => this.close());
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code: 1006 });
    }
  }
  return { Socket, sockets };
}

test('a forged, legacy, or malformed backend cannot cause credential capture or leak a response into status text', async () => {
  for (const mode of ['forged', 'legacy', 'malformed'] as const) {
    const config = await fixture(),
      fake = fakeBackend(config, mode),
      bg = await background(config, { direct: true, Socket: fake.Socket });
    try {
      await bg.authorize();
      const state = await until(
        () => bg.send({ type: 'status' }),
        (v) => v.direct.phase === 'error',
      );
      assert.equal(bg.reads.length, 0);
      assert(!JSON.stringify(state).includes(cookieValues.p20t!));
      assert.equal(fake.sockets[0].frames.filter((f: any) => f.type === 'direct_credentials').length, 0);
      await until(
        async () => bg.removals(),
        (count) => count === 1,
      );
    } finally {
      bg.close();
    }
  }
});

test('disconnect after submission leaves an unknown result, never resends, and removes optional cookie permission', async () => {
  const config = await fixture(),
    fake = fakeBackend(config, 'disconnect'),
    bg = await background(config, { direct: true, Socket: fake.Socket });
  try {
    await bg.authorize();
    const state = await until(
      () => bg.send({ type: 'status' }),
      (v) => v.direct.phase === 'unknown',
    );
    assert.match(state.direct.message, /未确认/);
    assert.equal(fake.sockets.length, 1);
    assert.equal(fake.sockets[0].frames.filter((f: any) => f.type === 'direct_credentials').length, 1);
    assert(!JSON.stringify(bg.storage).includes(cookieValues.p20t!));
    await until(
      async () => bg.removals(),
      (count) => count === 1,
    );
  } finally {
    bg.close();
  }
});

test('backend rejects a tampered credential digest without validating or switching the account', async () => {
  const config = await fixture(),
    before = prepareCount,
    id = randomUUID();
  const ws = new WebSocket(url, { origin });
  ws.on('error', () => {});
  try {
    const result = await new Promise<any>((resolve, reject) => {
      ws.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.type === 'challenge')
          ws.send(
            JSON.stringify({
              type: 'direct_hello',
              id,
              account_id: config.account_id,
              proof: enrollmentProof(config.pairing_secret, 'client', value.nonce, config.account_id, id),
            }),
          );
        else if (value.type === 'direct_ready')
          ws.send(
            JSON.stringify({
              type: 'direct_credentials',
              id,
              consent: true,
              credentials: { mode: 'direct', web_token: cookieValues.p20t, csrf_cookie: cookieValues.cr00 },
              proof: '0'.repeat(64),
            }),
          );
        else if (value.type === 'direct_result') resolve(value);
      });
      ws.on('error', reject);
    });
    assert.equal(result.ok, false);
    assert(!JSON.stringify(result).includes(cookieValues.p20t!));
    assert.equal(prepareCount, before);
    assert.equal((await s.accounts.get(config.account_id)).secret_box, null);
  } finally {
    ws.terminate();
  }
});

test('a pairing rotation during validation cancels activation and closes the candidate', async () => {
  const config = await fixture();
  let release!: () => void,
    entered = false;
  pauseProbe = async () => {
    entered = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const bg = await background(config, { direct: true });
  try {
    await bg.authorize();
    await until(async () => entered, Boolean);
    await s.accounts.pairBinance(config.account_id, 'test');
    release();
    const state = await until(
      () => bg.send({ type: 'status' }),
      (v) => v.direct.phase === 'error',
    );
    assert.match(state.direct.message, /变化/);
    assert.equal((await s.accounts.get(config.account_id)).secret_box, null);
    assert.equal(clients.at(-1)!.closed, true);
  } finally {
    release?.();
    pauseProbe = undefined;
    bg.close();
  }
});

test('without a matching cookie store no other browser profile is used', async () => {
  const config = await fixture(),
    fake = fakeBackend(config, 'disconnect');
  const bg = await background(config, {
    direct: true,
    Socket: fake.Socket,
    stores: [{ id: 'wrong-store', tabIds: [99] }],
  });
  try {
    await bg.authorize();
    const state = await until(
      () => bg.send({ type: 'status' }),
      (v) => v.direct.phase === 'error',
    );
    assert.match(state.direct.message, /会话/);
    assert.equal(bg.reads.length, 0);
  } finally {
    bg.close();
  }
});

test('a restarted extension worker revokes leftover cookie permission before allowing a new explicit authorization', async () => {
  const config = await fixture(),
    bg = await background(config, { direct: true, permission: true });
  try {
    assert.equal(bg.removals(), 1);
    assert.equal(bg.reads.length, 0);
    assert.equal((await bg.authorize()).ok, false);
    assert.equal(bg.sockets.length, 0);
    bg.grant();
    assert.equal((await bg.authorize()).ok, true);
    await until(
      () => bg.send({ type: 'status' }),
      (state) => state.direct.phase === 'active' && !state.direct.busy,
    );
    assert.equal(bg.removals(), 2);
    assert.equal(bg.reads.length, 3);
  } finally {
    bg.close();
  }
});

test('a new authorization cannot race the previous run while its temporary permission is being removed', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const config = await fixture(),
    bg = await background(config, { direct: true, cleanupGate: () => blocked });
  try {
    assert.equal((await bg.authorize()).ok, true);
    const active = await until(
      () => bg.send({ type: 'status' }),
      (state) => state.direct.phase === 'active',
    );
    assert.equal(active.direct.busy, true);
    assert.equal((await bg.authorize()).ok, false);
    assert.equal(bg.reads.length, 3);
    finish();
    await until(
      () => bg.send({ type: 'status' }),
      (state) => !state.direct.busy,
    );
    assert.equal(bg.removals(), 1);
  } finally {
    finish();
    bg.close();
  }
});
