import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { BinanceDirect, binanceTokenMetadata, createDirectClient } from '../src/binance-direct.ts';
import type { ChatClient } from '../../../packages/binance-chat/client.js';
import { testPng } from './image-fixture.ts';

const credentials = {
  mode: 'direct' as const,
  web_token: 'web.private-test-credential',
  csrf_token: 'b'.repeat(32),
};
const group = {
  group: { id: '10001', name: 'fixture', systemMute: false, ownerBan: false },
  member: { role: 1, disabledReasonTypes: [], memberStatusInChannel: 0 },
  restriction: { groupTextRestricted: false },
};
let s: Awaited<ReturnType<typeof createServices>>;
before(async () => {
  s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
});
after(async () => s.close());
async function account() {
  const created = await s.accounts.create(
    { kind: 'binance', name: 'direct fixture', group_ids: ['10001'] },
    'test',
  );
  await s.db.query("UPDATE accounts SET external_id='123',session_id=$2,status='online' WHERE id=$1", [
    created.id,
    randomUUID(),
  ]);
  return s.accounts.get(created.id);
}
function fixture(failure?: 'identity' | 'secret' | 'socket') {
  const instances: Array<
    ChatClient & { closed: boolean; calls: string[]; guard: (group: string) => Promise<void> }
  > = [];
  const direct = new BinanceDirect(s.db, s.box, (_credentials, guard) => {
    const client = {
      closed: false,
      calls: [] as string[],
      guard,
      async request(message: { operation: string }) {
        this.calls.push(message.operation);
        if (failure === 'secret') throw new Error('Vendor URL ?token=' + credentials.web_token);
        if (message.operation === 'profile') return { chatUserId: failure === 'identity' ? '999' : '123' };
        if (message.operation === 'group') return group;
        if (message.operation === 'history') return { messages: [] };
        if (message.operation === 'send_image') return { message_id: '998' };
        return {};
      },
      async checkConnection() {
        if (failure === 'socket') throw new Error(credentials.web_token);
        return { connection: 'open' as const, token_format: 'opaque' as const, token_expires_at: null };
      },
      close() {
        this.closed = true;
      },
    };
    instances.push(client);
    return client;
  });
  return { direct, instances };
}

test('direct validation never switches on HTTP failure, identity mismatch, or missing heartbeat, and never reports credential values', async () => {
  for (const failure of ['identity', 'secret', 'socket'] as const) {
    const a = await account(),
      { direct, instances } = fixture(failure);
    await assert.rejects(
      direct.prepare(a, credentials, () => {}),
      (error: Error) => {
        assert(!error.message.includes(credentials.web_token));
        return true;
      },
    );
    assert.equal(instances[0]!.closed, true);
    const current = await s.accounts.get(a.id);
    assert.equal(current.secret_box, null);
    assert.equal(current.session_id, a.session_id);
    assert.deepEqual(current.settings.group_ids, ['10001']);
    direct.close();
  }
});

test('direct credentials are encrypted; activation, session restoration, deselection fencing and removal preserve group selections', async () => {
  const a = await account(),
    { direct, instances } = fixture();
  s.binance.direct = direct;
  const result = await s.binance.authentication(a, credentials, 'test');
  assert.equal(result.mode, 'direct');
  let current = await s.accounts.get(a.id);
  assert.equal(current.settings.transport, 'direct');
  assert.notEqual(current.session_id, a.session_id);
  assert.deepEqual(JSON.parse(s.box.open(current.secret_box)), credentials);
  const publicState = JSON.stringify({
    accounts: await s.accounts.list(),
    audit: await s.db.query('SELECT * FROM audit'),
  });
  assert(!publicState.includes(credentials.web_token));
  assert(!publicState.includes(credentials.csrf_token));
  assert.equal(((await direct.request(current, 'profile', {})) as any).chatUserId, '123');
  await s.db.query("UPDATE accounts SET status='online' WHERE id=$1", [a.id]);
  await instances[0]!.guard('10001');
  await assert.rejects(instances[0]!.guard('999'));
  await s.db.query("UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[]'::jsonb) WHERE id=$1", [
    a.id,
  ]);
  await assert.rejects(instances[0]!.guard('10001'));
  await s.db.query(
    "UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[\"10001\"]'::jsonb) WHERE id=$1",
    [a.id],
  );
  direct.disconnect(a.id);
  current = await s.accounts.get(a.id);
  await direct.request(current, 'profile', {});
  assert.equal(instances.length, 2);
  assert.equal(instances[0]!.closed, true);
  await s.binance.authentication(current, { mode: 'bridge' }, 'test');
  current = await s.accounts.get(a.id);
  assert.equal(current.secret_box, null);
  assert.equal(current.settings.direct_auth, undefined);
  assert.equal(current.settings.transport, 'bridge');
  assert.equal(current.status, 'awaiting_auth');
  assert.deepEqual(current.settings.group_ids, ['10001']);
  assert.equal(instances[1]!.closed, true);
});

test('expired JWT metadata cannot establish identity and expired tokens are refused before networking', async () => {
  const jwt = (exp: number) =>
    Buffer.from('{"alg":"HS256"}').toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify({ exp, sub: '123' })).toString('base64url') +
    '.invalid-signature';
  assert.equal(binanceTokenMetadata(jwt(1)).format, 'jwt');
  assert.equal(binanceTokenMetadata('web.123.opaque-token').format, 'opaque');
  assert.equal(binanceTokenMetadata('eyJhbGciOiJub25lIn0.invalid.signature').format, 'opaque');
  const a = await account(),
    { direct, instances } = fixture();
  await assert.rejects(
    direct.prepare(a, { ...credentials, web_token: jwt(1) }, () => {}),
    /过期/,
  );
  assert.equal(instances.length, 0);
  await assert.rejects(direct.prepare(a, { ...credentials, web_token: 'p20t=abc; other=secret' }, () => {}));
});

test('a selection or session change during verification rejects activation and closes the candidate socket', async () => {
  const a = await account(),
    { direct, instances } = fixture();
  const prepared = await direct.prepare(a, credentials, () => {});
  await s.db.query(
    "UPDATE accounts SET settings=jsonb_set(settings,'{group_revision}','\"1\"'::jsonb) WHERE id=$1",
    [a.id],
  );
  await assert.rejects(direct.save(a, prepared, 'test'), /变化/);
  assert.equal(instances[0]!.closed, true);
  assert.equal((await s.accounts.get(a.id)).secret_box, null);
});

test('server transport authenticates only fixed website requests, pins IM DNS, and confirms text/image receipts over a real local socket', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const frames: any[] = [],
    calls: any[] = [];
  let peer: WebSocket | undefined,
    allow = true;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.msgType === 'HEART_BEAT') socket.send(JSON.stringify(frame));
      else {
        const ack = { ...frame, sender: { chatUserId: '123' }, msgId: '456' };
        socket.send(JSON.stringify({ ...ack, sessionId: '999', content: frame.content }));
        socket.send(JSON.stringify(ack));
      }
    });
  });
  const client = createDirectClient(
    credentials,
    async () => {
      if (!allow) throw new Error('deselected');
    },
    {
      resolve: (async () => [{ address: '8.8.8.8', family: 4 }]) as any,
      connect(url, options) {
        assert.equal(url.hostname, 'im.binance.com');
        assert.equal(url.searchParams.get('token'), 'chat-fixture');
        assert.equal(options.followRedirects, false);
        assert.equal(options.maxPayload, 2 * 1024 * 1024);
        options.lookup!('im.binance.com', { all: true }, ((error: any, ips: any) => {
          assert.equal(error, null);
          assert.equal(ips[0].address, '8.8.8.8');
        }) as any);
        return new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`);
      },
      request: async (url, options) => {
        calls.push({ url, options });
        let data: any;
        if (options?.method === 'PUT') {
          assert.equal(new URL(url).hostname, 'bucket.s3.amazonaws.com');
          assert.deepEqual(Object.keys(options.headers!), ['content-type']);
          assert(Buffer.from(options.body as Uint8Array).equals(testPng()));
          peer!.send(
            JSON.stringify({
              msgType: 'U_IMAGE',
              content: 'caption',
              sessionType: 'GROUP',
              sessionId: '10001',
              sender: { chatUserId: '123' },
              msgId: '457',
              fileProperties: { fileObjKey: 'image-key' },
            }),
          );
          return { status: 200, body: Buffer.from('') };
        }
        assert.equal(new URL(url).origin, 'https://www.binance.com');
        assert.equal(options!.headers!.cookie, 'p20t=' + credentials.web_token);
        assert.equal(options!.headers!.csrftoken, credentials.csrf_token);
        assert(!url.includes(credentials.web_token));
        if (url.endsWith('get-my-profile')) data = { chatUserId: '123' };
        else if (url.endsWith('get-channel-info')) data = group.group;
        else if (url.endsWith('get-current-member-info')) data = group.member;
        else if (url.endsWith('chat-restriction')) data = group.restriction;
        else if (url.endsWith('/token')) data = { uid: '123', token: 'chat-fixture' };
        else if (url.endsWith('dynamic-domain')) data = { 'c2c-im': 'wss://im.binance.com' };
        else if (url.endsWith('get-file-upload-url'))
          data = { key: 'image-key', url: 'https://bucket.s3.amazonaws.com/upload?signature=fixture' };
        else throw new Error('Unexpected path');
        return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data })) };
      },
    },
  );
  try {
    assert.equal((await client.checkConnection('123')).connection, 'open');
    assert(frames.every((frame) => frame.msgType === 'HEART_BEAT'));
    const message = {
      operation: 'send',
      group_ids: ['10001'],
      params: {
        group_id: '10001',
        expected_user_id: '123',
        text: 'fixture',
        local_id: randomUUID(),
        not_after: Date.now() + 15000,
        reply_to: '42',
      },
    };
    assert.deepEqual(await client.request(message), { message_id: '456' });
    assert.deepEqual(frames.find((frame) => frame.msgType === 'U_TEXT').refMsgIds, ['42']);
    allow = false;
    await assert.rejects(
      client.request({ ...message, params: { ...message.params, local_id: randomUUID() } }),
    );
    assert.equal(frames.filter((frame) => frame.msgType === 'U_TEXT').length, 1);
    allow = true;
    assert.deepEqual(
      await client.request({
        ...message,
        operation: 'send_image',
        params: {
          ...message.params,
          text: 'caption',
          local_id: randomUUID(),
          image: {
            name: 'superbot-0123456789ab.png',
            content_type: 'image/png',
            width: 32,
            height: 24,
            data: testPng().toString('base64'),
          },
        },
      }),
      { message_id: '457' },
    );
    assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 1);
    assert.equal(frames.filter((frame) => frame.msgType === 'U_IMAGE').length, 0);
  } finally {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the browser bundle is generated from the same protocol used by the server', async () => {
  // @ts-expect-error The build script is a JavaScript-only development entry point.
  const { browserClient } = await import('../../../scripts/build-binance-client.mjs');
  assert.equal(await readFile('extensions/binance-browser/content.js', 'utf8'), await browserClient());
});

test('private IM DNS answers are refused before establishing any socket', async () => {
  let connected = false;
  const client = createDirectClient(credentials, undefined, {
    resolve: (async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]) as any,
    connect() {
      connected = true;
      throw new Error('must not connect');
    },
    request: async (url) => ({
      status: 200,
      body: Buffer.from(
        JSON.stringify({
          success: true,
          data: url.endsWith('get-my-profile')
            ? { chatUserId: '123' }
            : url.endsWith('/token')
              ? { uid: '123', token: 'fixture' }
              : { 'c2c-im': 'wss://im.binance.com' },
        }),
      ),
    }),
  });
  try {
    await assert.rejects(client.checkConnection('123'));
    assert.equal(connected, false);
  } finally {
    client.close();
  }
});

test('direct image broadcasts pass readiness and execute without a browser peer', async () => {
  const a = await account(),
    { direct, instances } = fixture();
  s.binance.direct = direct;
  await s.binance.authentication(a, credentials, 'test');
  await s.accounts.refresh(a.id, 'test');
  const binding = (await s.db.query('SELECT conversation_id FROM bindings WHERE account_id=$1', [a.id]))[0]!;
  assert.equal(s.binance.peers.has(a.id), false);
  const image = await s.uploads.create(testPng());
  await s.features.createAnnouncement(
    {
      title: 'direct fixture',
      content: 'caption',
      image_asset_id: image.id,
      conversation_ids: [binding.conversation_id],
    },
    'test',
  );
  while (await s.jobs.processOnce()) {
    /* Local adapter fixtures only. */
  }
  assert.equal(instances[0]!.calls.filter((call) => call === 'send_image').length, 1);
  const snapshot = await s.chat.snapshot(binding.conversation_id);
  assert.equal(snapshot.deliveries[0]!.status, 'succeeded');
  assert.equal(snapshot.messages[0]!.segments[0]!.text, 'caption');
  await s.binance.authentication(await s.accounts.get(a.id), { mode: 'bridge' }, 'test');
});

test('direct image failures before upload remain safely retryable; a possible upload stays unknown without resending', async () => {
  for (const effect of [undefined, 'none', 'possible'] as const) {
    const a = await account();
    let imageCalls = 0;
    const direct = new BinanceDirect(s.db, s.box, () => ({
      async request(message) {
        if (message.operation === 'send_image') {
          imageCalls++;
          throw Object.assign(new Error('private-provider-exception'), {
            bridgeError: {
              code: 'NETWORK',
              stage: effect === undefined ? 'profile' : 'upload',
              ...(effect ? { effect } : {}),
            },
          });
        }
        return message.operation === 'profile'
          ? { chatUserId: '123' }
          : message.operation === 'group'
            ? group
            : { messages: [] };
      },
      async checkConnection() {
        return { connection: 'open', token_format: 'opaque', token_expires_at: null };
      },
      close() {},
    }));
    s.binance.direct = direct;
    try {
      await s.binance.authentication(a, credentials, 'test');
      await s.accounts.refresh(a.id, 'test');
      const binding = (
        await s.db.query('SELECT conversation_id FROM bindings WHERE account_id=$1', [a.id])
      )[0]!;
      // The shared in-memory fixture reuses the same platform group across test accounts.
      await s.db.query('UPDATE conversations SET executor_account_id=$2 WHERE id=$1', [
        binding.conversation_id,
        a.id,
      ]);
      const image = await s.uploads.create(testPng());
      const announcement = await s.features.createAnnouncement(
        {
          title: 'failure fixture',
          content: 'caption',
          image_asset_id: image.id,
          conversation_ids: [binding.conversation_id],
        },
        'test',
      );
      while (await s.jobs.processOnce()) {}
      const job = (await s.db.query('SELECT * FROM jobs WHERE announcement_id=$1', [announcement.id]))[0]!;
      assert.equal(job.status, effect === 'possible' ? 'unknown' : 'failed');
      if (effect !== 'possible') assert.equal(job.receipt.error.retryable, true);
      assert.equal(job.current_attempt, 1);
      assert.equal(imageCalls, 1);
      assert(!JSON.stringify(job.receipt).includes('private-provider-exception'));
    } finally {
      direct.close();
    }
  }
});

test('the direct configuration endpoint requires administrator authentication and CSRF before reading a credential', async () => {
  const { createHttpApp } = await import('../src/http.ts');
  const app = await createHttpApp(s);
  try {
    await app.listen(0, '127.0.0.1');
    const a = await account();
    const path = (await app.getUrl()) + `/api/v1/accounts/${a.id}/binance-auth`;
    assert.equal(
      (
        await fetch(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(credentials),
        })
      ).status,
      401,
    );
    const setup = await fetch((await app.getUrl()) + '/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'direct-test', password: 'direct-test-password' }),
    });
    assert.equal(setup.status, 200);
    const session = (await setup.json()) as any;
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal(
      (
        await fetch(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(credentials),
        })
      ).status,
      403,
    );
    const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': session.csrf };
    const invalid = await fetch(path, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...credentials, cookie: 'unexpected-full-cookie' }),
    });
    assert.equal(invalid.status, 400);
    assert(!(await invalid.text()).includes(credentials.web_token));
    assert.equal((await s.accounts.get(a.id)).secret_box, null);
  } finally {
    await app.close();
  }
});

test('server CSRF derivation matches the official browser scheme and forwards only the selected login cookies', async () => {
  const raw = encodeURIComponent('csrf cookie-测试');
  const client = createDirectClient(
    { mode: 'direct', web_token: credentials.web_token, csrf_cookie: raw },
    undefined,
    {
      request: async (_url, options) => {
        assert.equal(options!.headers!.cookie, `p20t=${credentials.web_token}; cr00=${raw}`);
        assert.equal(options!.headers!.csrftoken, createHash('md5').update('csrf cookie-测试').digest('hex'));
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ success: true, data: { chatUserId: '123' } })),
        };
      },
    },
  );
  try {
    assert.deepEqual(await client.request({ operation: 'profile' }), { chatUserId: '123' });
  } finally {
    client.close();
  }
});
