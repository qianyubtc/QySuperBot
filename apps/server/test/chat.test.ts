import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { Request, Response } from 'express';
import { createServices, type Services } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { qqEvents, telegramEvents } from '../src/adapters.ts';
import type { ConnectorCommand } from '../../../packages/contracts/src/index.ts';
import { qqVerificationPurposes } from '../src/qq-verification.ts';

let s: Services;
let app: Awaited<ReturnType<typeof createHttpApp>>;
let base: string;
let headers: Record<string, string>;
let group: any, other: any, account: any;
const streams = new Set<AbortController>();
before(async () => {
  s = await createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: true },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  app = await createHttpApp(s);
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api/v1';
  const setup = await request('/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'chat-admin', password: 'chat-test-password' }),
  });
  const session: any = await setup.json();
  headers = {
    cookie: setup.headers.get('set-cookie')!.split(';')[0]!,
    'x-csrf-token': session.csrf,
    'content-type': 'application/json',
  };
  const groups = await s.features.groups();
  group = groups.find((g) => g.external_id === 'demo-community')!;
  other = groups.find((g) => g.id !== group.id)!;
  account = await s.accounts.get('local-demo');
});
after(async () => {
  for (const controller of streams) controller.abort();
  await app.close();
  await s.close();
});
function request(path: string, init: RequestInit = {}) {
  return fetch(base + path, { headers, ...init });
}
async function incoming(text: string, room = group, data: Record<string, unknown> = {}) {
  const event = {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: room.external_id },
    type: 'message.created',
    data: {
      message_id: randomUUID(),
      sender_id: 'chat-user',
      direction: 'incoming',
      segments: [{ type: 'text', text }],
      ...data,
    },
  };
  await s.messages.ingest(account, event, '聊天测试成员');
  return (await s.db.query('SELECT * FROM messages WHERE external_id=$1', [event.data.message_id]))[0]!;
}
async function openStream(id = group.id) {
  const controller = new AbortController();
  streams.add(controller);
  const response = await request(`/conversations/${id}/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next(predicate: (event: string, data: any) => boolean) {
    const deadline = setTimeout(() => controller.abort(new Error('SSE event timed out')), 8000);
    try {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = chunk.match(/^event: (.+)$/m)?.[1];
          const value = chunk.match(/^data: (.+)$/m)?.[1];
          if (event && value) {
            const data = JSON.parse(value);
            if (predicate(event, data)) return { event, data };
          }
          continue;
        }
        const item = await reader.read();
        assert.equal(item.done, false, 'stream ended before the expected event');
        buffer += decoder.decode(item.value, { stream: true });
      }
    } finally {
      clearTimeout(deadline);
    }
  }
  return {
    next,
    close: () => {
      controller.abort();
      streams.delete(controller);
    },
  };
}

test('chat snapshots and live streams require an administrator, including scoped project keys', async () => {
  for (const suffix of ['chat', 'stream']) {
    assert.equal((await request(`/conversations/${group.id}/${suffix}`, { headers: {} })).status, 401);
  }
  const project = await s.features.createProject(
    { name: 'Chat scope', conversation_ids: [group.id], scopes: ['conversations.read', 'messages.send'] },
    'test',
  );
  for (const suffix of ['chat', 'stream']) {
    assert.equal(
      (
        await request(`/conversations/${group.id}/${suffix}`, {
          headers: { authorization: `Bearer ${project.key}` },
        })
      ).status,
      403,
    );
  }
  assert.equal((await request('/conversations/missing/chat')).status, 404);
  const snapshot = (await (await request(`/conversations/${group.id}/chat`)).json()) as any;
  assert.equal(snapshot.conversation.can_send, true);
  assert.equal(snapshot.conversations.length, 2);
  assert.equal(
    snapshot.conversations.find((room: any) => room.id === group.id).external_id,
    group.external_id,
  );
});

test('publish records keep the platform and stable conversation identity for each target', async () => {
  const created = await s.features.createAnnouncement(
    { title: 'Directory identity', content: 'Preview metadata', conversation_ids: [group.id, other.id] },
    'test',
    randomUUID(),
  );
  try {
    const published = (await s.features.announcements()).find((row) => row.id === created.id)!;
    assert.deepEqual(
      published.deliveries.map((row: any) => row.conversation_id).sort(),
      [group.id, other.id].sort(),
    );
    for (const target of published.deliveries) {
      assert.equal(target.platform, 'custom');
      const detail: any = await s.features.deliveries(target.id);
      const room = [group, other].find((room) => room.id === target.conversation_id)!;
      assert.equal(detail.platform, room.platform);
      assert.equal(detail.conversation_external_id, room.external_id);
    }
  } finally {
    await s.db.query('DELETE FROM jobs WHERE announcement_id=$1', [created.id]);
    await s.db.query('DELETE FROM announcements WHERE id=$1', [created.id]);
  }
});

test('live retry controls exclude expired, uncertain and QQ verification jobs that the retry API rejects', async () => {
  const scenarios = [
    { status: 'failed', retryable: true, expired: false, purpose: undefined, expected: true },
    { status: 'failed', retryable: false, expired: false, purpose: undefined, expected: false },
    { status: 'failed', retryable: true, expired: true, purpose: undefined, expected: false },
    { status: 'unknown', retryable: true, expired: false, purpose: undefined, expected: false },
    ...[...qqVerificationPurposes].map((purpose) => ({
      status: 'failed',
      retryable: true,
      expired: false,
      purpose,
      expected: false,
    })),
  ];
  const ids: string[] = [];
  try {
    for (const scenario of scenarios) {
      const job = await s.jobs.enqueue({
        key: randomUUID(),
        conversationId: group.id,
        action: 'message.send',
        params: { segments: [{ type: 'text', text: 'Retry eligibility' }] },
        ...(scenario.purpose ? { reviewRef: { purpose: scenario.purpose } } : {}),
      });
      ids.push(job.id);
      await s.db.query('UPDATE jobs SET status=$2,receipt=$3::jsonb,expires_at=$4 WHERE id=$1', [
        job.id,
        scenario.status,
        JSON.stringify({ error: { retryable: scenario.retryable } }),
        new Date(Date.now() + (scenario.expired ? -60_000 : 60_000)).toISOString(),
      ]);
      const view = await s.chat.snapshot(group.id);
      assert.equal(
        view.deliveries.find((row: any) => row.id === job.id).retryable,
        scenario.expected,
        JSON.stringify(scenario),
      );
      if (!scenario.expected)
        await assert.rejects(s.jobs.retry(job.id, 'test'), {
          code: scenario.purpose ? 'QQ_VERIFICATION_RETRY_REQUIRED' : 'RETRY_NOT_ALLOWED',
        });
    }
  } finally {
    await s.db.query('DELETE FROM jobs WHERE id=ANY($1::text[])', [ids]);
  }
});

test('moderation receipts update the live stream without a new message and remain separate from the verdict', async () => {
  const keyword = 'moderation-live-' + randomUUID();
  await s.features.policy(group.id, { ...group.policy, mode: 'enforce', keywords: [keyword] }, 'test');
  const original = await incoming(keyword);
  const stream = await openStream();
  try {
    const pending = await stream.next(
      (event, data) =>
        event === 'chat.snapshot' &&
        data.messages.some(
          (m: any) => m.id === original.id && m.moderation_jobs.some((j: any) => j.status === 'pending'),
        ),
    );
    assert.equal(pending.data.messages.find((m: any) => m.id === original.id).verdict, 'blocked');
    await s.jobs.processOnce();
    const succeeded = await stream.next(
      (event, data) =>
        event === 'chat.snapshot' &&
        data.messages.some(
          (m: any) => m.id === original.id && m.moderation_jobs.some((j: any) => j.status === 'succeeded'),
        ),
    );
    const message = succeeded.data.messages.find((m: any) => m.id === original.id);
    assert.equal(message.verdict, 'blocked');
    assert.equal(message.deleted, true);
  } finally {
    stream.close();
    await s.features.policy(group.id, group.policy, 'test');
  }
});

test('a live stream observes inbound messages, queued replies, confirmed sends, edits and deletion', async () => {
  const stream = await openStream();
  try {
    await stream.next((event) => event === 'chat.snapshot');
    const original = await incoming('网页实时收到的原消息', group, { thread_id: '77' });
    const received = await stream.next(
      (event, data) => event === 'chat.snapshot' && data.messages.some((m: any) => m.id === original.id),
    );
    assert.equal(received.data.messages.at(-1).thread_id, '77');
    const body = { conversation_ids: [group.id], text: '网页引用回复', reply_to_message_id: original.id };
    const init = {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'live-reply-0001' },
      body: JSON.stringify(body),
    };
    const queued = await request('/messages', init);
    assert.equal(queued.status, 200);
    const value: any = await queued.json();
    assert.deepEqual(await (await request('/messages', init)).json(), value);
    await stream.next(
      (event, data) =>
        event === 'chat.snapshot' &&
        data.deliveries.some((d: any) => d.id === value.delivery_ids[0] && d.status === 'pending'),
    );
    while (await s.jobs.processOnce()) {
      /* dispatch the durable queue */
    }
    const confirmed = await stream.next(
      (event, data) => event === 'chat.snapshot' && data.messages.some((m: any) => m.content === body.text),
    );
    const reply = confirmed.data.messages.find((m: any) => m.content === body.text);
    assert.equal(reply.reply_to, original.external_id);
    assert.equal(reply.reply_record_id, original.id);
    assert.equal(reply.reply_content, original.content);
    assert.equal(reply.thread_id, '77');
    assert.equal(
      confirmed.data.deliveries.find((d: any) => d.id === value.delivery_ids[0]).status,
      'succeeded',
    );
    await s.messages.ingest(account, {
      schema_version: '1',
      event_id: randomUUID(),
      occurred_at: new Date(Date.now() + 1000).toISOString(),
      source: { connector_id: account.id, account_id: account.id, conversation_id: group.external_id },
      type: 'message.edited',
      data: {
        message_id: original.external_id,
        sender_id: 'chat-user',
        direction: 'incoming',
        segments: [{ type: 'text', text: '编辑后的消息' }],
      },
    });
    const edited = await stream.next(
      (event, data) =>
        event === 'chat.snapshot' &&
        data.messages.some((m: any) => m.id === original.id && m.content === '编辑后的消息'),
    );
    assert.equal(edited.data.messages.find((m: any) => m.id === reply.id).reply_content, '编辑后的消息');
    await s.messages.ingest(account, {
      schema_version: '1',
      event_id: randomUUID(),
      occurred_at: new Date(Date.now() + 2000).toISOString(),
      source: { connector_id: account.id, account_id: account.id, conversation_id: group.external_id },
      type: 'message.deleted',
      data: { message_id: original.external_id },
    });
    const deleted = await stream.next(
      (event, data) =>
        event === 'chat.snapshot' && data.messages.some((m: any) => m.id === original.id && m.deleted),
    );
    assert.equal(deleted.data.messages.find((m: any) => m.id === reply.id).reply_content, '原消息已删除');
    // Retrying a known request after deletion returns its original result, never a second send.
    assert.deepEqual(await (await request('/messages', init)).json(), value);
  } finally {
    stream.close();
  }
});

test('reply validation rejects other groups, changed idempotent intent and deletion before dispatch', async () => {
  const original = await incoming('等待回复');
  const second = await incoming('另一条原消息');
  const foreign = await incoming('其他群的消息', other);
  const send = (ids: string[], quote: string, key: string = randomUUID()) =>
    request('/messages', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': key },
      body: JSON.stringify({ conversation_ids: ids, text: '回复正文', reply_to_message_id: quote }),
    });
  assert.equal((await send([group.id], foreign.id)).status, 409);
  assert.equal((await send([group.id, other.id], original.id)).status, 400);
  const result = await send([group.id], original.id, 'guarded-reply-0001');
  assert.equal(result.status, 200);
  const { delivery_ids }: any = await result.json();
  assert.equal((await send([group.id], second.id, 'guarded-reply-0001')).status, 409);
  await s.db.query('UPDATE messages SET deleted=true WHERE id=$1', [original.id]);
  while (await s.jobs.processOnce()) {}
  const job = (await s.db.query('SELECT * FROM jobs WHERE id=$1', [delivery_ids[0]]))[0]!;
  assert.equal(job.status, 'failed');
  assert.equal(job.receipt.error.code, 'REPLY_UNAVAILABLE');
  assert.equal((await send([group.id], original.id)).status, 409);
});

test('reconnecting snapshots cover missed messages and sidebar activity in other groups', async () => {
  const missed = await incoming('重连后可以看到');
  const elsewhere = await incoming('另一个群也有消息', other);
  const failed = await s.jobs.enqueue({
    key: randomUUID(),
    conversationId: group.id,
    action: 'message.send',
    params: { segments: [{ type: 'text', text: '离线时没有发出的旧消息' }] },
  });
  await s.db.query("UPDATE jobs SET status='failed',last_error='账号未在线，请恢复连接后再重试' WHERE id=$1", [
    failed.id,
  ]);
  const stream = await openStream();
  try {
    const { data } = await stream.next((event) => event === 'chat.snapshot');
    assert.ok(data.messages.some((m: any) => m.id === missed.id));
    assert.equal(data.conversations.find((g: any) => g.id === other.id).last_message_id, elsewhere.id);
    await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [account.id]);
    const offline = await stream.next(
      (event, data) => event === 'chat.snapshot' && !data.conversation.can_send,
    );
    assert.match(offline.data.conversation.send_error, /未在线/);
    await s.db.query("UPDATE accounts SET status='online',last_error=NULL WHERE id=$1", [account.id]);
    const recovered = await stream.next(
      (event, data) => event === 'chat.snapshot' && data.conversation.can_send,
    );
    assert.equal(recovered.data.conversation.send_error, null);
    const history = recovered.data.deliveries.find((job: any) => job.id === failed.id);
    assert.equal(history.status, 'failed', 'recovery must not fabricate a successful send');
    assert.match(history.last_error, /账号未在线/);
  } finally {
    await s.db.query("UPDATE accounts SET status='online' WHERE id=$1", [account.id]);
    await s.db.query('DELETE FROM jobs WHERE id=$1', [failed.id]);
    stream.close();
  }
});

test('Telegram and QQ preserve quote identifiers and Telegram forum topics on both directions', async () => {
  const tg = telegramEvents(
    { id: 'tg', external_id: '1' },
    {
      update_id: 1,
      message: {
        message_id: 91,
        message_thread_id: 77,
        chat: { id: -100, type: 'supergroup' },
        from: { id: 2 },
        text: '引用',
        reply_to_message: { message_id: 90 },
      },
    },
  )[0]!.event;
  assert.equal((tg.data as any).thread_id, '77');
  assert.equal((tg.data as any).reply_to, '90');
  const qq = qqEvents(
    { id: 'qq', external_id: '1' },
    {
      group_id: 123,
      post_type: 'message',
      message_type: 'group',
      message_id: 91,
      user_id: 2,
      message: [
        { type: 'reply', data: { id: '-90' } },
        { type: 'text', data: { text: '引用正文' } },
      ],
    },
  )[0]!.event;
  assert.equal((qq.data as any).reply_to, '-90');
  assert.deepEqual((qq.data as any).segments, [{ type: 'text', text: '引用正文' }]);
  const command = {
    schema_version: '1',
    command_id: randomUUID(),
    attempt_id: randomUUID(),
    attempt_number: 1,
    idempotency_key: randomUUID(),
    logical_conversation_id: group.id,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 10000).toISOString(),
    target: { conversation_id: '123' },
    action: 'message.send',
    params: { segments: [{ type: 'text', text: '答复' }], reply_to: '90', thread_id: '77' },
  } as ConnectorCommand;
  const calls: any[] = [];
  const telegram = s.adapters.telegram,
    onebot = s.adapters.qq;
  try {
    s.adapters.telegram = async (_account, action, params) => {
      calls.push({ action, params });
      return { status: 200, data: { ok: true, result: { message_id: 92 } } } as any;
    };
    s.adapters.qq = async (_account, action, params) => {
      if (action === 'get_login_info') return { status: 200, data: { retcode: 0, data: { user_id: 1 } } };
      calls.push({ action, params });
      return { status: 200, data: { retcode: 0, data: { message_id: 92 } } } as any;
    };
    assert.equal((await s.adapters.execute({ kind: 'telegram' }, command)).status, 'succeeded');
    assert.deepEqual(calls[0].params.reply_parameters, {
      message_id: 90,
      allow_sending_without_reply: false,
    });
    assert.equal(calls[0].params.message_thread_id, 77);
    assert.equal((await s.adapters.execute({ kind: 'qq', external_id: '1' }, command)).status, 'succeeded');
    assert.deepEqual(calls[1].params.message[0], { type: 'reply', data: { id: '90' } });
    const invalid = {
      ...command,
      params: { ...command.params, reply_to: 'not-numeric' },
    } as ConnectorCommand;
    assert.equal((await s.adapters.execute({ kind: 'telegram' }, invalid)).status, 'failed');
    assert.equal(calls.length, 2, 'invalid quote never reaches the platform');
  } finally {
    s.adapters.telegram = telegram;
    s.adapters.qq = onebot;
  }
});

test('disconnecting while the initial snapshot is loading does not leave a polling stream', async () => {
  s.chat.closeStreams();
  const server = app.getHttpServer();
  const controller = new AbortController();
  let received!: (response: ServerResponse) => void;
  const responseReady = new Promise<ServerResponse>((resolve) => {
    received = resolve;
  });
  const observe = (_request: IncomingMessage, response: ServerResponse) => received(response);
  server.once('request', observe);
  let started!: () => void, release!: () => void, finished!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const snapshot = s.chat.snapshot,
    open = s.chat.open;
  s.chat.snapshot = async (id) => {
    started();
    await gate;
    return snapshot.call(s.chat, id);
  };
  s.chat.open = async (...args) => {
    try {
      await open.apply(s.chat, args);
    } finally {
      finished();
    }
  };
  const pending = request(`/conversations/${group.id}/stream`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
  }).catch(() => undefined);
  try {
    const response = await responseReady;
    await loading;
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    controller.abort();
    await closed;
    release();
    await completed;
    assert.equal(s.chat.streams.size, 0, 'an aborted request must not create a poller after loading');
  } finally {
    release();
    controller.abort();
    await pending;
    s.chat.snapshot = snapshot;
    s.chat.open = open;
    server.off('request', observe);
    s.chat.closeStreams();
  }
});

test('unchanged snapshots do not emit SSE frames just because their query timestamp changed', async (t) => {
  s.chat.closeStreams();
  const initial = await s.chat.snapshot(group.id);
  const snapshot = s.chat.snapshot,
    authenticate = s.auth.authenticate;
  let calls = 0,
    changed = false;
  s.chat.snapshot = async () => ({
    ...initial,
    observed_at: `2026-10-28T00:00:0${++calls}.000000Z`,
    conversation: { ...initial.conversation, ...(changed ? { can_send: false, send_error: 'offline' } : {}) },
  });
  s.auth.authenticate = async () => ({ kind: 'admin', id: 'fixture', name: 'fixture', csrf: 'fixture' });
  const chunks: string[] = [];
  const response = Object.assign(new PassThrough(), {
    status() {
      return this;
    },
    set() {
      return this;
    },
    flushHeaders() {},
  });
  response.on('data', (chunk) => chunks.push(String(chunk)));
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    await s.chat.open(group.id, { headers } as Request, response as unknown as Response);
    t.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(calls, 2);
    assert.equal(chunks.join('').match(/event: chat.snapshot/g)?.length, 1);
    changed = true;
    t.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(chunks.join('').match(/event: chat.snapshot/g)?.length, 2);
    assert(chunks.join('').includes('2026-10-28T00:00:03.000000Z'));
  } finally {
    s.chat.closeStreams();
    response.destroy();
    s.chat.snapshot = snapshot;
    s.auth.authenticate = authenticate;
    t.mock.timers.reset();
  }
});

test('closing a backpressured stream releases its socket without waiting for the reader', async () => {
  // A client that stops reading holds the response below its drain threshold.
  const response = Object.assign(new PassThrough({ highWaterMark: 1 }), {
    status() {
      return this;
    },
    set() {
      return this;
    },
    flushHeaders() {},
  });
  try {
    await s.chat.open(group.id, { headers } as Request, response as unknown as Response);
    assert.equal(response.writableNeedDrain, true);
    s.chat.closeStreams();
    assert.equal(response.destroyed, true, 'shutdown must not wait for buffered bytes to drain');
  } finally {
    response.destroy();
    s.chat.closeStreams();
  }
});

test('logging out terminates an already-open stream and server shutdown closes active streams', async () => {
  const stream = await openStream();
  try {
    await stream.next((event) => event === 'chat.snapshot');
    await s.auth.logout(headers.cookie!);
    await stream.next((event) => event === 'auth.expired');
  } finally {
    stream.close();
  }
  const login = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'chat-admin', password: 'chat-test-password' }),
  });
  headers.cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const active = await openStream();
  try {
    await active.next((event) => event === 'chat.snapshot');
    const watchdog = setTimeout(() => {
      s.chat.closeStreams();
      assert.fail('app shutdown did not close SSE streams');
    }, 3000);
    try {
      await app.close();
    } finally {
      clearTimeout(watchdog);
    }
    assert.equal(s.chat.streams.size, 0);
  } finally {
    active.close();
  }
});
