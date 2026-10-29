import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServices } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import {
  signRequest,
  verifyRequest,
  MemoryReplayStore,
  connectorCommandSchema,
  MemoryExecutionStore,
} from '../../../packages/contracts/src/index.ts';

test('HTTP boundary enforces authentication, CSRF, scoped keys and raw signed bodies', async () => {
  const services = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: true },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const app = await createHttpApp(services);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const request = (path: string, options: RequestInit = {}) => fetch(base + '/api/v1' + path, options);
    assert.equal((await request('/overview')).status, 401);
    const setup = await request('/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'http-test', password: 'http-test-password' }),
    });
    assert.equal(setup.status, 200);
    const session = (await setup.json()) as any;
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(setup.headers.get('set-cookie')!, /HttpOnly/);
    const headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf };
    assert.equal(
      (
        await request('/projects', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    const groups = (await (await request('/conversations', { headers })).json()) as any[];
    const project = (await (
      await request('/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'test',
          conversation_ids: [groups[0].id],
          scopes: ['conversations.read'],
        }),
      })
    ).json()) as any;
    assert.equal(
      (await request('/accounts', { headers: { authorization: `Bearer ${project.key}` } })).status,
      403,
    );
    assert.equal(
      (
        (await (
          await request('/conversations', { headers: { authorization: `Bearer ${project.key}` } })
        ).json()) as any[]
      ).length,
      1,
    );
    const c = await services.accounts.create(
      { kind: 'custom', name: 'HTTP', endpoint: 'https://example.com' },
      'test',
    );
    const diagnostic = `/accounts/${c.id}/binance-diagnostics?group_id=10001`;
    assert.equal((await request(diagnostic)).status, 401);
    assert.equal(
      (await request(diagnostic, { headers: { authorization: `Bearer ${project.key}` } })).status,
      403,
    );
    assert.equal((await request(diagnostic, { headers })).status, 400);
    const roomPath = `/accounts/${c.id}/binance-groups`;
    assert.equal((await request(roomPath)).status, 401);
    assert.equal(
      (await request(roomPath, { headers: { authorization: `Bearer ${project.key}` } })).status,
      403,
    );
    assert.equal((await request(roomPath, { headers })).status, 400);
    for (const [path, method] of [
      [roomPath, 'PUT'],
      [roomPath + '/refresh', 'POST'],
    ])
      assert.equal(
        (
          await request(path!, {
            method,
            headers: { cookie, 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        403,
      );
    const imagePath = `/conversations/${groups[0].id}/messages/not-a-message/image`;
    assert.equal((await request(imagePath)).status, 401);
    assert.equal(
      (await request(imagePath, { headers: { authorization: `Bearer ${project.key}` } })).status,
      403,
    );
    assert.equal(
      (
        await request(`/accounts/${c.id}/binance-send-check`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: '{"group_id":"10001"}',
        })
      ).status,
      403,
    );
    const body = JSON.stringify(
      {
        schema_version: '1',
        protocol_revision: '0.2',
        connector_id: c.id,
        account_id: c.id,
        connector_type: 'test',
        instance_id: 'test-instance',
        display_name: 'Test',
        capabilities: [],
      },
      null,
      2,
    );
    const path = '/api/v1/connectors/handshake';
    const signed = signRequest({
      method: 'POST',
      path,
      purpose: 'control',
      body,
      keyId: c.credentials.event_key_id,
      secret: c.credentials.event_secret,
    });
    const first = await fetch(base + path, { method: 'POST', headers: signed, body });
    assert.equal(first.status, 200);
    assert.ok(((await first.json()) as any).session_id);
    assert.equal((await fetch(base + path, { method: 'POST', headers: signed, body })).status, 401);
    const fresh = signRequest({
      method: 'POST',
      path,
      purpose: 'control',
      body,
      keyId: c.credentials.event_key_id,
      secret: c.credentials.event_secret,
    });
    assert.equal(
      (await fetch(base + path, { method: 'POST', headers: fresh, body: body + ' ' })).status,
      401,
    );
    const malformed = await request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await request('/accounts', { headers })).headers.get('cache-control'), 'no-store');
  } finally {
    await app.close();
    await services.close();
  }
});

test('custom chat completes real HTTP handshake, discovery, event ingestion and signed outbound execution', async () => {
  const s = await createServices(
    {
      ...loadConfig(),
      dataDir: 'memory://',
      databaseUrl: undefined,
      seedDemo: false,
      allowPrivateConnectors: true,
    },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const replayStore = new MemoryReplayStore(),
    execution = new MemoryExecutionStore();
  let credentials: any;
  let sessionId = '';
  let effects = 0;
  const fixture = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const purpose = req.method === 'GET' ? 'control' : 'commands';
      await verifyRequest({
        method: req.method!,
        path: req.url!,
        body,
        purpose,
        secret: credentials.command_secret,
        keyId: credentials.command_key_id,
        headers: new Headers(req.headers as Record<string, string>),
        scope: credentials.account_id,
        replayStore,
      });
      const capabilities = ['messages.read', 'messages.send', 'messages.delete'].map((capability) => ({
        capability,
        state: 'supported',
      }));
      let value: unknown;
      if (req.method === 'GET')
        value = {
          schema_version: '1',
          connector_id: credentials.connector_id,
          account_id: credentials.account_id,
          session_id: sessionId,
          snapshot_id: 'fixture-snapshot',
          revision: 1,
          observed_at: new Date().toISOString(),
          coverage: 'complete',
          next_cursor: null,
          items: [
            {
              connector_id: credentials.connector_id,
              account_id: credentials.account_id,
              conversation_id: 'custom-room',
              kind: 'group',
              name: '真实 HTTP 测试群',
              member_count: 3,
              observed_at: new Date().toISOString(),
              capabilities,
              permissions: capabilities.map((c) => ({ capability: c.capability, permission: 'granted' })),
            },
          ],
        };
      else {
        const command = connectorCommandSchema.parse(JSON.parse(body.toString()));
        value = await execution.execute(credentials.account_id, command, async () => {
          effects++;
          return {
            schema_version: '1',
            command_id: command.command_id,
            attempt_id: command.attempt_id,
            attempt_number: command.attempt_number,
            revision: 1,
            status: 'succeeded',
            observed_at: new Date().toISOString(),
            result: { message_id: 'fixture-sent-1' },
          };
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    } catch {
      res.writeHead(400);
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const app = await createHttpApp(s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const created = await s.accounts.create(
      { kind: 'custom', name: 'Fixture', endpoint: `http://127.0.0.1:${(fixture.address() as any).port}` },
      'test',
    );
    credentials = created.credentials;
    const post = async (path: string, payload: unknown, purpose: 'events' | 'control') => {
      const body = JSON.stringify(payload);
      return fetch(base + path, {
        method: 'POST',
        body,
        headers: signRequest({
          method: 'POST',
          path,
          body,
          purpose,
          keyId: credentials.event_key_id,
          secret: credentials.event_secret,
        }),
      });
    };
    const reply = await post(
      '/api/v1/connectors/handshake',
      {
        schema_version: '1',
        protocol_revision: '0.2',
        connector_id: created.id,
        account_id: created.id,
        connector_type: 'fixture',
        instance_id: 'one',
        display_name: 'Fixture',
        capabilities: [],
      },
      'control',
    );
    assert.equal(reply.status, 200);
    sessionId = ((await reply.json()) as any).session_id;
    assert.equal((await s.accounts.refresh(created.id, 'test')).groups, 1);
    const event = {
      schema_version: '1',
      event_id: 'fixture-event-1',
      occurred_at: new Date().toISOString(),
      source: { connector_id: created.id, account_id: created.id, conversation_id: 'custom-room' },
      type: 'message.created',
      data: {
        message_id: 'fixture-in-1',
        sender_id: 'member-1',
        direction: 'incoming',
        segments: [{ type: 'text', text: '来自另一个聊天项目的消息' }],
      },
    };
    assert.equal((await post('/api/v1/connector-events', event, 'events')).status, 200);
    assert.equal(
      ((await (await post('/api/v1/connector-events', event, 'events')).json()) as any).duplicate,
      true,
    );
    const group = (await s.features.groups())[0]!;
    const queued = await s.features.send(
      { kind: 'admin', id: 'admin', name: 'test', csrf: '' },
      { conversation_ids: [group.id], text: '发回你的聊天项目' },
      'fixture-request-1',
    );
    await s.jobs.processOnce();
    assert.equal(effects, 1);
    assert.equal(await s.jobs.processOnce(), false);
    const delivery = (await s.features.deliveries(queued.delivery_ids[0])) as any;
    assert.equal(delivery.status, 'succeeded');
    assert.equal((await s.features.group(group.id)).messages.length, 2);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => fixture.close((e) => (e ? reject(e) : resolve())));
    await s.close();
  }
});
