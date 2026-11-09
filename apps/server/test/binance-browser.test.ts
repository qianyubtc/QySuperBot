import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { ChromePipe } from '../src/chrome-pipe.ts';
import { BinanceBrowser, browserInput } from '../src/binance-browser.ts';
import { createServices } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';

test('Chrome pipe handles split and coalesced frames and redacts command errors', async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    pipe = new ChromePipe(input, output);
  const writes: any[] = [],
    events: any[] = [];
  input.on('data', (value) => writes.push(JSON.parse(value.toString().slice(0, -1))));
  pipe.on('event', (value) => events.push(value));
  const first = pipe.command('Page.enable', {}, 'page'),
    second = pipe.command('Network.getCookies');
  assert.deepEqual(writes[0], { id: 1, method: 'Page.enable', params: {}, sessionId: 'page' });
  output.write('{"id":1,"result":');
  output.write('{"ok":true}}\0{"method":"Page.test","params":{}}\0');
  assert.deepEqual(await first, { ok: true });
  assert.equal(events[0].method, 'Page.test');
  output.write('{"id":2,"error":{"message":"secret-cookie-should-never-leak"}}\0');
  await assert.rejects(second, (error: Error) => !error.message.includes('secret-cookie'));
  const pending = pipe.command('Page.enable');
  pipe.close();
  await assert.rejects(pending, /登录窗口已断开/);
  await assert.rejects(pipe.command('Page.enable'));
  assert.equal(pipe.pending.size, 0);
});
test('Chrome pipe rejects malformed and oversized messages without reporting their content', async () => {
  for (const value of ['secret-invalid-json\0', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    const input = new PassThrough(),
      output = new PassThrough(),
      pipe = new ChromePipe(input, output);
    const pending = pipe.command('Page.enable');
    output.write(value);
    await assert.rejects(pending, (error: Error) => !error.message.includes('secret-invalid'));
    assert.equal(pipe.closed, true);
  }
});
test('browser input only accepts bounded display input, never arbitrary protocol commands', () => {
  for (const input of [
    { type: 'Runtime.evaluate', expression: 'process.env' },
    { type: 'text', text: 'x'.repeat(4097) },
    { type: 'pointer', action: 'mousePressed', x: -1, y: 0 },
    { type: 'key', action: 'keyDown', key: 'x', code: 'KeyX', keyCode: 88, modifiers: 16 },
    { type: 'text', text: 'safe', method: 'Network.getCookies' },
  ])
    assert.equal(browserInput.safeParse(input).success, false);
  assert.equal(browserInput.safeParse({ type: 'text', text: '用户主动输入' }).success, true);
});

let s: Awaited<ReturnType<typeof createServices>>,
  app: Awaited<ReturnType<typeof createHttpApp>>,
  base: string,
  cookie: string,
  csrf: string;
const publicOrigin = 'https://superbot.example';
before(async () => {
  s = await createServices(
    {
      ...loadConfig(),
      publicOrigin,
      dataDir: 'memory://',
      databaseUrl: undefined,
      binanceBrowserEnabled: false,
      seedDemo: false,
    },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  app = await createHttpApp(s);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  const setup = await fetch(base + '/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'browser-test', password: 'browser-test-password' }),
  });
  cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await setup.json()) as any).csrf;
});
after(async () => {
  await app.close();
  await s.close();
});
async function fixture() {
  s.binanceBrowser.stop();
  const a = await s.accounts.create(
    { kind: 'binance', name: 'browser fixture', group_ids: ['10001'] },
    'test',
  );
  const calls: Array<{ method: string; params: any }> = [];
  const runtime = {
    id: randomUUID(),
    accountId: a.id,
    abort: new AbortController(),
    expires: Date.now() + 60_000,
    ready: true,
    switching: false,
    viewers: new Set<WebSocket>(),
    target: 'page',
    cdp: {
      async command(method: string, params: any) {
        calls.push({ method, params });
        return {};
      },
      close() {},
    },
  };
  s.binanceBrowser.session = runtime as any;
  return { a, runtime, calls };
}
async function rejected(path: string, headers: Record<string, string> = {}) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + path, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Unexpected pending upgrade'));
    }, 2000);
    ws.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('open', () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error('Unauthorized upgrade accepted'));
    });
  });
}
test('browser REST requires admin and CSRF, and remains disabled until explicitly configured', async () => {
  const a = await s.accounts.create({ kind: 'binance', name: 'guard fixture', group_ids: ['10001'] }, 'test');
  const path = base + `/api/v1/accounts/${a.id}/binance-browser`;
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, { method: 'POST', headers: { cookie } })).status, 403);
  const response = await fetch(path, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(response.status, 409);
  assert.equal(s.binanceBrowser.session, undefined);
  const status = await (await fetch(path, { headers: { cookie } })).json();
  assert.equal(status.available, false);
});
test('browser websocket rejects unauthorized, cross-origin, unknown paths and wrong accounts; supports bounded input', async () => {
  const { a, runtime, calls } = await fixture();
  const path = `/api/v1/accounts/${a.id}/binance-browser/socket?window_id=${runtime.id}`;
  await rejected(path, { origin: publicOrigin });
  await rejected(path, { origin: 'https://attacker.example', cookie });
  await rejected('/api/v1/not-a-browser', { origin: publicOrigin, cookie });
  await rejected(`/api/v1/accounts/${randomUUID()}/binance-browser/socket?window_id=${runtime.id}`, {
    origin: publicOrigin,
    cookie,
  });
  await rejected(`/api/v1/accounts/${a.id}/binance-browser/socket?window_id=${randomUUID()}`, {
    origin: publicOrigin,
    cookie,
  });
  // A console served from a different address than PUBLIC_ORIGIN (dev proxy, alternate domain)
  // still connects, because a browser cannot forge Host and Origin/Host therefore stay same-origin.
  const sameHost = new WebSocket(base.replace('http', 'ws') + path, { headers: { origin: base, cookie } });
  await new Promise<void>((resolve, reject) => {
    sameHost.once('open', resolve);
    sameHost.once('error', reject);
  });
  sameHost.close();
  for (let i = 0; i < 100 && runtime.viewers.size; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runtime.viewers.size, 0);
  const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: { origin: publicOrigin, cookie } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const pong = new Promise<any>((resolve) =>
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))),
  );
  ws.send(JSON.stringify({ type: 'text', text: 'user-provided-test' }));
  ws.send(JSON.stringify({ type: 'ping' }));
  assert.deepEqual(await pong, { type: 'pong' });
  assert.deepEqual(calls[0], { method: 'Input.insertText', params: { text: 'user-provided-test' } });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const serverClosed = new Promise<void>((resolve) =>
    [...runtime.viewers][0]!.once('close', () => resolve()),
  );
  ws.send(JSON.stringify({ type: 'Runtime.evaluate', expression: 'unsafe' }));
  assert.equal(await closed, 1008);
  await serverClosed;
  assert.equal(runtime.viewers.size, 0);
  s.binanceBrowser.stop();
});
test('a viewer that acknowledges frames gets one at a time and always the newest; Chrome is paced', async () => {
  const { a, runtime, calls } = await fixture();
  const path = `/api/v1/accounts/${a.id}/binance-browser/socket?window_id=${runtime.id}`;
  const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: { origin: publicOrigin, cookie } });
  const frames: string[] = [];
  ws.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    if (value.type === 'frame') frames.push(value.data);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(check());
  };
  const chromeAcks = () =>
    calls.filter((call) => call.method === 'Page.screencastFrameAck').map((call) => call.params.sessionId);
  const ackTimes: number[] = [];
  const command = runtime.cdp.command;
  runtime.cdp.command = async (method: string, params: any) => {
    if (method === 'Page.screencastFrameAck') ackTimes.push(Date.now());
    return command(method, params);
  };
  const browser = s.binanceBrowser;
  await until(() => runtime.viewers.size === 1);

  browser.frame(runtime as any, 1, 'frame-1');
  await until(() => frames.length === 1 && chromeAcks().length === 1);
  ws.send(JSON.stringify({ type: 'frame_ack' }));
  await new Promise((r) => setTimeout(r, 50));

  // Like Chrome, send the next frame only after the previous one was acknowledged.
  for (const n of [2, 3, 4]) {
    browser.frame(runtime as any, n, `frame-${n}`);
    await until(() => chromeAcks().length === n);
  }
  await new Promise((r) => setTimeout(r, 100));
  // The viewer has not drawn frame 2 yet, so frames 3 and 4 were held back.
  assert.deepEqual(frames, ['frame-1', 'frame-2']);
  // Chrome keeps painting meanwhile, but no faster than one frame per 80 ms.
  assert.deepEqual(chromeAcks(), [1, 2, 3, 4]);
  for (let i = 1; i < ackTimes.length; i++) assert.ok(ackTimes[i]! - ackTimes[i - 1]! >= 70);

  // Once it has drawn frame 2 it gets the newest frame straight away, skipping frame 3.
  ws.send(JSON.stringify({ type: 'frame_ack' }));
  await until(() => frames.length === 3);
  assert.deepEqual(frames, ['frame-1', 'frame-2', 'frame-4']);
  ws.close();
  s.binanceBrowser.stop();
});
test('browser adopts only minimal URL-scoped credentials and preserves the window on validation failure', async () => {
  const { a, runtime } = await fixture();
  const cookies = [
    { name: 'p20t', value: 'fixture-web-login', path: '/' },
    { name: 'cr00', value: 'fixture-csrf', path: '/' },
    { name: 'BNC_FV_KEY', value: 'fixture-device', path: '/' },
    { name: 'unrelated', value: 'must-not-export', path: '/' },
  ];
  runtime.cdp.command = async (method, params) => {
    // The window first proves it is showing Binance and not a CDN refusal page.
    if (method === 'Runtime.evaluate') return { result: { value: { title: '币安广场', text: '' } } };
    assert.equal(method, 'Network.getCookies');
    assert.deepEqual(params.urls, [
      'https://www.binance.com/bapi/c2c/v3/private/binance-chat/user/get-my-profile',
    ]);
    return { cookies };
  };
  let adopted: any;
  const browser = new BinanceBrowser(s.config, s.db, s.auth, async (_a, value, _actor, signal) => {
    adopted = value;
    assert.equal(signal.aborted, false);
    throw new Error('fixture validation failure');
  });
  s.binanceBrowser.session = undefined;
  browser.session = runtime as any;
  await assert.rejects(browser.connect(a.id, 'test'), /fixture validation failure/);
  assert.deepEqual(adopted, {
    mode: 'direct',
    web_token: 'fixture-web-login',
    csrf_cookie: 'fixture-csrf',
    device_id: 'fixture-device',
  });
  assert.equal(browser.session, runtime);
  assert.equal(runtime.switching, false);
  const visible = JSON.stringify({
    status: browser.status(a.id),
    audit: await s.db.query('SELECT * FROM audit'),
  });
  assert(!visible.includes('fixture-web-login'));
  assert(!visible.includes('must-not-export'));
  browser.stop();
  assert.equal(runtime.abort.signal.aborted, true);
});
test('a connected window becomes the kept chat browser: it outlives the window, streams only while watched and never navigates under a viewer', async () => {
  const { a, runtime } = await fixture();
  const calls: Array<{ method: string; params: any }> = [];
  let url = 'https://www.binance.com/zh-CN/square/chat';
  const events: any[] = [];
  (runtime as any).casting = true;
  runtime.cdp.command = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'Network.getCookies')
      return {
        cookies: [
          { name: 'p20t', value: 'fixture-web-login', path: '/' },
          { name: 'cr00', value: 'fixture-csrf', path: '/' },
        ],
      };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url } } };
    if (method === 'Page.navigate') url = params.url;
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Runtime.evaluate') {
      const started = /__qsbBinance\.start\((\d+)/.exec(params.expression);
      if (started) {
        events.push({ type: 'done', job: Number(started[1]), ok: true, data: { chatUserId: '42' } });
        return { result: { value: true } };
      }
      if (params.expression.includes('__qsbBinance.next(')) return { result: { value: events.splice(0) } };
      return { result: { value: 'installed' } };
    }
    return {};
  };
  let options: any;
  const browser: BinanceBrowser = new BinanceBrowser(
    s.config,
    s.db,
    s.auth,
    async (_account, _value, _actor, _signal, o): Promise<unknown> => {
      options = o;
      // Validation already runs inside the page.
      return browser.hostedClient(a.id).request({ operation: 'profile' });
    },
  );
  s.binanceBrowser.session = undefined;
  browser.session = runtime as any;
  assert.deepEqual(await browser.connect(a.id, 'test'), { chatUserId: '42' });
  assert.deepEqual(options, { hosted: true });
  const evaluated = calls.filter(
    (c) => c.method === 'Runtime.evaluate' && /__qsbBinance/.test(String(c.params.expression)),
  );
  assert(evaluated.every((c) => c.params.contextId === 7 && c.params.returnByValue));
  assert(calls.some((c) => c.method === 'Page.createIsolatedWorld' && c.params.worldName === 'qsb-binance'));

  // Kept: no time limit, closing the window leaves it running, and an unwatched browser stops painting.
  assert.equal(browser.status(a.id).kept, true);
  assert.equal(browser.status(a.id).expires_at, null);
  assert.equal(browser.stop(a.id, runtime.id), false);
  assert.equal(browser.session, runtime);
  assert.equal(runtime.abort.signal.aborted, false);
  assert.equal(calls.at(-1)?.method, 'Page.stopScreencast');
  runtime.viewers.add({ readyState: 1 } as any);
  (browser as any).cast(runtime);
  assert.equal(calls.at(-1)?.method, 'Page.startScreencast');

  // While someone is in the window (say, passing a verification), the browser is never navigated.
  url = 'https://accounts.binance.com/zh-CN/login';
  (runtime as any).channel.close();
  await assert.rejects(
    browser.hostedClient(a.id).request({ operation: 'profile' }),
    (error: any) => error.code === 'BINANCE_BROWSER_IN_USE',
  );
  assert(!calls.some((c) => c.method === 'Page.navigate'));
  // Unwatched, it returns to the chat page by itself and carries on.
  runtime.viewers.clear();
  assert.deepEqual(await browser.hostedClient(a.id).request({ operation: 'profile' }), { chatUserId: '42' });
  assert.equal(
    calls.filter((c) => c.method === 'Page.navigate')[0]?.params.url,
    'https://www.binance.com/zh-CN/square/chat',
  );

  // Pausing the account (a forced stop) does close it.
  assert.equal(browser.stop(a.id, undefined, true), true);
  assert.equal(runtime.abort.signal.aborted, true);
});
test('missing login and paused accounts cannot be adopted; stopping aborts the current login session', async () => {
  const { a, runtime } = await fixture();
  runtime.cdp.command = async () => ({ cookies: [] });
  await assert.rejects(s.binanceBrowser.connect(a.id, 'test'), /请先在窗口完成/);
  await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [a.id]);
  await assert.rejects(s.binanceBrowser.connect(a.id, 'test'), /请先恢复/);
  const other = { ...runtime, id: randomUUID(), abort: new AbortController() };
  s.binanceBrowser.stop();
  s.binanceBrowser.session = other as any;
  assert.equal(runtime.abort.signal.aborted, true);
  assert.equal(other.abort.signal.aborted, false);
  s.binanceBrowser.stop();
});
test('closing while cookies are being read prevents adoption', async () => {
  const { a, runtime } = await fixture();
  let reading!: () => void, finish!: (value: any) => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  runtime.cdp.command = async (method: string) => {
    // The refusal probe answers at once; only the cookie read is held open by this test.
    if (method === 'Runtime.evaluate') return { result: { value: { title: '币安广场', text: '' } } };
    reading();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = s.binanceBrowser.connect(a.id, 'test');
  await started;
  s.binanceBrowser.stop();
  finish({
    cookies: [
      { name: 'p20t', path: '/', value: 'fixture-private' },
      { name: 'cr00', path: '/', value: 'fixture-csrf' },
    ],
  });
  await assert.rejects(pending, /登录窗口已关闭/);
  assert.equal((await s.accounts.get(a.id)).secret_box, null);
});
test('display location strips sensitive query and fragment, and navigation uses fixed official destinations', async () => {
  const { a, runtime, calls } = await fixture();
  s.binanceBrowser.page(
    runtime as any,
    'https://accounts.binance.com/zh-CN/login?code=private-auth-code#private-fragment',
  );
  assert.equal((runtime as any).page, 'https://accounts.binance.com/zh-CN/login');
  await s.binanceBrowser.navigate(a.id, 'login');
  await s.binanceBrowser.navigate(a.id, 'chat');
  await s.binanceBrowser.navigate(a.id, 'square');
  assert.deepEqual(
    calls.map((c) => c.params.url),
    [
      'https://accounts.binance.com/zh-CN/login',
      'https://www.binance.com/zh-CN/square/chat',
      'https://www.binance.com/zh-CN/square',
    ],
  );
  const square = await fetch(base + `/api/v1/accounts/${a.id}/binance-browser/navigate`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ destination: 'square', window_id: runtime.id }),
  });
  assert.equal(square.status, 200);
  assert.equal(calls.at(-1)!.params.url, 'https://www.binance.com/zh-CN/square');
  const r = await fetch(base + `/api/v1/accounts/${a.id}/binance-browser/navigate`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ destination: 'http://localhost:1234' }),
  });
  assert.equal(r.status, 400);
  s.binanceBrowser.stop();
});

test('stale login window actions cannot navigate, connect or close a replacement window', async () => {
  const { a, runtime, calls } = await fixture(),
    stale = randomUUID();
  const path = base + `/api/v1/accounts/${a.id}/binance-browser`;
  const headers = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  for (const action of ['connect', 'navigate']) {
    const response = await fetch(path + '/' + action, {
      method: 'POST',
      headers,
      body: JSON.stringify({ window_id: stale }),
    });
    assert.equal(response.status, 409);
  }
  assert.equal((await fetch(path + '/connect', { method: 'POST', headers, body: '{}' })).status, 400);
  const response = await fetch(path, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ window_id: stale }),
  });
  assert.deepEqual(await response.json(), { stopped: false });
  assert.equal(s.binanceBrowser.session, runtime);
  assert.equal(runtime.abort.signal.aborted, false);
  assert.equal(calls.length, 0);
  const navigated = await fetch(path + '/navigate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ window_id: runtime.id, destination: 'login' }),
  });
  assert.equal(navigated.status, 200);
  assert.equal(calls[0]!.params.url, 'https://accounts.binance.com/zh-CN/login');
  const stopped = await fetch(path, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ window_id: runtime.id }),
  });
  assert.deepEqual(await stopped.json(), { stopped: true });
  assert.equal(runtime.abort.signal.aborted, true);
});

test('an opening login window returns busy until ready, then exposes the same window identity', async () => {
  const { a, runtime } = await fixture();
  const before = s.config.binanceBrowserEnabled;
  s.config.binanceBrowserEnabled = true;
  try {
    runtime.ready = false;
    await assert.rejects(s.binanceBrowser.start(a.id, 'test'), /正在启动/);
    runtime.ready = true;
    const result = await s.binanceBrowser.start(a.id, 'test');
    assert.equal(result.window_id, runtime.id);
    assert.equal(result.running, true);
  } finally {
    s.config.binanceBrowserEnabled = before;
    s.binanceBrowser.stop();
  }
});

test('application shutdown closes an active login websocket and aborts its session', async () => {
  const { a, runtime } = await fixture();
  const ws = new WebSocket(
    base.replace('http', 'ws') + `/api/v1/accounts/${a.id}/binance-browser/socket?window_id=${runtime.id}`,
    { headers: { origin: publicOrigin, cookie } },
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Application did not close login stream')), 2000);
      }),
    ]);
    await closed;
    assert.equal(runtime.abort.signal.aborted, true);
    assert.equal(s.binanceBrowser.session, undefined);
  } finally {
    clearTimeout(timeout);
    ws.terminate();
  }
});

test('the configured site decides which pages the window opens and which count as the session', async () => {
  const backup = new BinanceBrowser(
    { ...loadConfig(), binanceWebSite: 'backup' },
    s.db,
    s.auth,
    async () => ({}),
  );
  assert.deepEqual(backup.destinations, {
    login: 'https://www.qorscuxtbd.com/zh-CN/login',
    chat: 'https://www.qorscuxtbd.com/zh-CN/square',
    square: 'https://www.qorscuxtbd.com/zh-CN/square',
  });
  assert.equal(backup.onChatOrigin('https://www.qorscuxtbd.com/zh-CN/square'), true);
  assert.equal(backup.onChatOrigin('https://www.binance.com/zh-CN/square/chat'), false);
  const official = new BinanceBrowser(
    { ...loadConfig(), binanceWebSite: 'official' },
    s.db,
    s.auth,
    async () => ({}),
  );
  assert.equal(official.destinations.chat, 'https://www.binance.com/zh-CN/square/chat');
  assert.equal(official.onChatOrigin('https://www.binance.com/zh-CN/square/chat'), true);
  // The sign-in host belongs to the site but never serves the chat session.
  assert.equal(official.onChatOrigin('https://accounts.binance.com/zh-CN/login'), false);
});
