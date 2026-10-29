import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServices } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';

test('OneBot HTTP discovery, NapCat signed events and backend replies complete a round trip', async () => {
  const apiToken = 'fixture-onebot-api-token';
  const calls: { action: string; params: any }[] = [];
  let loggedInUserId = 12345;
  let sendMessageId: number | undefined = -456;
  const fixture = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${apiToken}`) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const action = req.url!.slice(1);
    const params = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ action, params });
    const data: Record<string, unknown> = {
      get_login_info: { user_id: loggedInUserId, nickname: 'QQ fixture' },
      get_group_list: [{ group_id: 67890, group_name: 'QQ 测试群', member_count: 3 }],
      get_group_member_info: { group_id: 67890, user_id: 12345, role: 'admin' },
      get_group_member_list: [{ group_id: 67890, user_id: 12345, role: 'admin' }],
      send_group_msg: { message_id: sendMessageId },
    };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: data[action] }));
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address() as { port: number };
  const s = await createServices(
    {
      ...loadConfig(),
      dataDir: 'memory://',
      databaseUrl: undefined,
      seedDemo: false,
      allowPrivateConnectors: false,
      qqLocalPort: address.port,
    },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const app = await createHttpApp(s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'qq-test', password: 'qq-test-password' }),
    });
    assert.equal(setup.status, 200);
    const session = (await setup.json()) as any;
    const headers = {
      cookie: setup.headers.get('set-cookie')!.split(';')[0]!,
      'content-type': 'application/json',
      'x-csrf-token': session.csrf,
    };
    const created = await s.accounts.create(
      { kind: 'qq', name: 'QQ fixture', endpoint: `http://127.0.0.1:${address.port}`, token: apiToken },
      'test',
    );
    const refreshed = await fetch(`${base}/accounts/${created.id}/refresh`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(await refreshed.json(), { groups: 1 });
    const account = await s.accounts.get(created.id);
    for (const endpoint of [
      'http://localhost:' + address.port,
      'http://127.0.0.1:1',
      `http://127.0.0.1:${address.port}/other`,
    ])
      await assert.rejects(
        s.adapters.qq({ ...account, endpoint }, 'get_login_info'),
        (error: any) => error.code === 'ENDPOINT_NOT_ALLOWED',
      );
    await assert.rejects(
      s.adapters.qq({ ...account, kind: 'custom' }, 'get_login_info'),
      (error: any) => error.code === 'ENDPOINT_NOT_ALLOWED',
    );
    const groups = (await (await fetch(base + '/conversations', { headers })).json()) as any[];
    assert.equal(groups.length, 1);
    const group = groups[0];
    assert.equal(group.name, 'QQ 测试群');
    const path = `${base}/connectors/qq/${created.id}/events`;
    const sign = (body: string, secret = created.credentials.qq_webhook_token!) =>
      'sha1=' + createHmac('sha1', secret).update(body).digest('hex');
    const post = (body: string, auth: Record<string, string> = { 'x-signature': sign(body) }) =>
      fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body });
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: 12345,
      post_type: 'message',
      message_type: 'group',
      group_id: 67890,
      user_id: 99999,
      message_id: 111,
      sender: { nickname: '测试成员' },
      message: [{ type: 'text', data: { text: 'QQ 同步测试' } }],
    };
    const body = JSON.stringify(event, null, 2);
    assert.equal((await post(body, {})).status, 401);
    assert.equal((await post('{broken', { 'x-signature': sign(body) })).status, 401);
    assert.equal((await post(body + ' ', { 'x-signature': sign(body) })).status, 401);
    assert.equal((await post(body, { 'x-signature': sign(body, apiToken) })).status, 401);
    assert.equal(
      (
        await post(body, {
          'x-signature': 'sha1=bad',
          authorization: `Bearer ${created.credentials.qq_webhook_token}`,
        })
      ).status,
      401,
    );
    assert.equal((await post('{broken')).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post(JSON.stringify({ ...event, self_id: 54321 }))).status, 403);
    assert.equal((await post(body)).status, 200);
    assert.equal((await post(body)).status, 200);
    const legacy = JSON.stringify({ ...event, message_id: 112, message: 'Bearer 兼容测试' });
    assert.equal(
      (
        await post(legacy, {
          authorization: `Bearer ${created.credentials.qq_webhook_token}`,
        })
      ).status,
      200,
    );
    const before = (await (await fetch(`${base}/conversations/${group.id}/chat`, { headers })).json()) as any;
    assert.equal(before.conversation.can_send, true);
    assert.equal(before.messages.length, 2);
    const incoming = before.messages.find((item: any) => item.external_id === '111');
    assert.equal(incoming.content, 'QQ 同步测试');
    assert.equal(incoming.sender_name, '测试成员');
    const sent = await fetch(base + '/messages', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'qq-roundtrip-fixture' },
      body: JSON.stringify({
        conversation_ids: [group.id],
        text: 'QQ 后台回复测试',
        reply_to_message_id: incoming.id,
      }),
    });
    assert.equal(sent.status, 200);
    const queued = (await sent.json()) as any;
    await s.jobs.processOnce();
    const delivery = (await (
      await fetch(`${base}/deliveries/${queued.delivery_ids[0]}`, { headers })
    ).json()) as any;
    assert.equal(delivery.status, 'succeeded');
    assert.equal(delivery.receipt.result.message_id, '-456');
    const sendCalls = calls.filter((item) => item.action === 'send_group_msg');
    assert.equal(sendCalls.length, 1);
    assert.equal(String(sendCalls[0]!.params.group_id), '67890');
    assert.deepEqual(sendCalls[0]!.params.message, [
      { type: 'reply', data: { id: '111' } },
      { type: 'text', data: { text: 'QQ 后台回复测试' } },
    ]);
    const after = (await (await fetch(`${base}/conversations/${group.id}/chat`, { headers })).json()) as any;
    assert.ok(
      after.messages.some((item: any) => item.direction === 'outgoing' && item.external_id === '-456'),
    );
    // A nominally successful response without a platform message ID is uncertain,
    // and must never create a fabricated outgoing message or permit a blind retry.
    sendMessageId = undefined;
    const uncertain = await s.jobs.enqueue({
      key: 'qq-missing-message-id',
      conversationId: group.id,
      action: 'message.send',
      params: { segments: [{ type: 'text', text: 'missing receipt fixture' }] },
    });
    await s.jobs.processOnce();
    assert.equal(((await s.features.deliveries(uncertain.id)) as any).status, 'unknown');
    await assert.rejects(s.jobs.retry(uncertain.id, 'test'), /安全重试/);
    assert.equal(await s.jobs.processOnce(), false);
    assert.equal(calls.filter((item) => item.action === 'send_group_msg').length, 2);
    assert.equal(
      (await s.db.query('SELECT id FROM messages WHERE conversation_id=$1', [group.id])).length,
      3,
    );

    // Reusing the OneBot address after logging a different QQ account in must
    // neither execute pending work as that account nor replace the stored identity.
    loggedInUserId = 54321;
    const wrongIdentity = await s.jobs.enqueue({
      key: 'qq-different-login',
      conversationId: group.id,
      action: 'message.send',
      params: { segments: [{ type: 'text', text: 'identity guard fixture' }] },
    });
    await s.jobs.processOnce();
    const refused = (await s.features.deliveries(wrongIdentity.id)) as any;
    assert.equal(refused.status, 'failed');
    assert.equal(refused.receipt.error.code, 'QQ_IDENTITY_CHANGED');
    assert.equal(calls.filter((item) => item.action === 'send_group_msg').length, 2);
    await assert.rejects(
      s.accounts.refresh(created.id, 'test'),
      (error: any) => error.code === 'QQ_IDENTITY_CHANGED',
    );
    assert.equal((await s.accounts.get(created.id)).external_id, '12345');
    await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [created.id]);
    assert.equal((await post(JSON.stringify({ ...event, message_id: 113 }))).status, 401);
    assert.equal(
      (await s.db.query('SELECT id FROM messages WHERE conversation_id=$1', [group.id])).length,
      3,
    );
  } finally {
    await app.close();
    await s.close();
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
