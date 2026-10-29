import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServices, type Services } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { groupSnapshot } from '../src/adapters.ts';

let s: Services;
before(async () => {
  s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
});
after(async () => {
  await s.close();
});

test('Telegram preflight refuses an existing webhook without changing it or consuming updates', async () => {
  const calls: string[] = [];
  s.adapters.telegram = async (_account, action) => {
    calls.push(action);
    return {
      status: 200,
      data: {
        ok: true,
        result:
          action === 'getMe'
            ? { id: 123, first_name: 'Fixture Bot' }
            : { url: 'https://old-service.example/secret-hook' },
      },
    };
  };
  const created = await s.accounts.create(
    { kind: 'telegram', name: 'Webhook fixture', token: 'fixture-token' },
    'test',
  );
  await assert.rejects(
    s.accounts.refresh(created.id, 'test'),
    (error: any) => error.code === 'TELEGRAM_WEBHOOK_ACTIVE' && !error.message.includes('secret-hook'),
  );
  assert.deepEqual(calls, ['getMe', 'getWebhookInfo']);
  const account = await s.accounts.get(created.id);
  assert.equal(account.external_id, null);
  assert.equal(account.status, 'error');
});

test('Telegram admits only one active connection for a bot and permits transfer after pausing it', async () => {
  s.adapters.telegram = async (_account, action) => ({
    status: 200,
    data: { ok: true, result: action === 'getMe' ? { id: 456, first_name: 'Fixture Bot' } : { url: '' } },
  });
  const first = await s.accounts.create(
    { kind: 'telegram', name: 'First bot', token: 'first-fixture-token' },
    'test',
  );
  const second = await s.accounts.create(
    { kind: 'telegram', name: 'Duplicate bot', token: 'same-bot-fixture-token' },
    'test',
  );
  const results = await Promise.allSettled([
    s.accounts.refresh(first.id, 'test'),
    s.accounts.refresh(second.id, 'test'),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'TELEGRAM_DUPLICATE_BOT');
  const active = (await s.accounts.list()).filter(
    (account) => account.kind === 'telegram' && account.status === 'online',
  );
  assert.equal(active.length, 1);
  const previous = active[0]!;
  const nextId = previous.id === first.id ? second.id : first.id;
  await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [previous.id]);
  await s.accounts.refresh(nextId, 'test');
  assert.equal((await s.accounts.get(nextId)).status, 'online');
  assert.equal((await s.accounts.get(previous.id)).status, 'paused');
});

test('Telegram group permissions reflect removal, mute, unknown membership and channel posting rights', async () => {
  const cases = [
    {
      member: { status: 'administrator', can_delete_messages: true, can_restrict_members: false },
      send: 'granted',
      remove: 'granted',
    },
    { member: { status: 'left' }, send: 'denied', remove: 'denied' },
    { member: { status: 'kicked' }, send: 'denied', remove: 'denied' },
    {
      member: { status: 'restricted', is_member: true, can_send_messages: false },
      send: 'denied',
      remove: 'denied',
    },
    {
      member: { status: 'restricted', is_member: false, can_send_messages: true },
      send: 'denied',
      remove: 'denied',
    },
    { member: { status: 'member' }, muted: true, send: 'denied', remove: 'denied' },
    {
      member: { status: 'administrator', can_post_messages: false },
      channel: true,
      send: 'denied',
      remove: 'denied',
    },
    { member: null, send: 'unknown', remove: 'unknown' },
  ];
  for (const value of cases) {
    s.adapters.telegram = async (_account, action) => ({
      status: 200,
      data: {
        ok: action !== 'getChatMember' || value.member != null,
        result:
          action === 'getChat'
            ? {
                type: value.channel ? 'channel' : 'supergroup',
                title: '权限测试群',
                permissions: { can_send_messages: !value.muted },
              }
            : action === 'getChatMember'
              ? value.member
              : 3,
      },
    });
    const group = await s.adapters.telegramGroup({ kind: 'telegram', external_id: '456' }, '-100123');
    assert.equal(
      group.permissions.find((item) => item.capability === 'messages.send')!.permission,
      value.send,
    );
    assert.equal(
      group.permissions.find((item) => item.capability === 'messages.delete')!.permission,
      value.remove,
    );
  }
  s.adapters.telegram = async () => ({ status: 200, data: { ok: true, result: { type: 'private' } } });
  await assert.rejects(s.adapters.telegramGroup({ kind: 'telegram', external_id: '456' }, '456'), /仅支持/);
});

test('Telegram polling reports competing receivers accurately and leaves paused connections paused', async () => {
  const calls: string[] = [];
  s.adapters.telegram = async (_account, action) => {
    calls.push(action);
    return { status: 409, data: { ok: false, error_code: 409 } };
  };
  await (s.worker as any).poll();
  assert.deepEqual(calls, ['getUpdates']);
  const accounts = await s.accounts.list();
  const conflicting = accounts.find((account) => account.external_id === '456' && account.status === 'error');
  assert.match(conflicting!.last_error, /其他程序同时轮询/);
  assert.equal(
    accounts.filter((account) => account.external_id === '456' && account.status === 'paused').length,
    1,
  );
});

test('Telegram sending without a platform message ID stays uncertain and is not sent again', async () => {
  const created = await s.accounts.create(
    { kind: 'telegram', name: 'Missing receipt bot', token: 'receipt-fixture-token' },
    'test',
  );
  await s.db.query("UPDATE accounts SET status='online',external_id='789' WHERE id=$1", [created.id]);
  const account = await s.accounts.get(created.id);
  const id = await s.accounts.upsertGroup(
    account,
    groupSnapshot('-100789', 'Receipt fixture group', 'group', 3, 'telegram', true),
  );
  let sends = 0;
  s.adapters.telegram = async (_account, action) => {
    assert.equal(action, 'sendMessage');
    sends++;
    return { status: 200, data: { ok: true, result: {} } };
  };
  const job = await s.jobs.enqueue({
    key: 'telegram-missing-message-id',
    conversationId: id,
    action: 'message.send',
    params: { segments: [{ type: 'text', text: 'receipt fixture' }] },
  });
  await s.jobs.processOnce();
  assert.equal(((await s.features.deliveries(job.id)) as any).status, 'unknown');
  assert.equal((await s.db.query('SELECT id FROM messages WHERE conversation_id=$1', [id])).length, 0);
  await assert.rejects(s.jobs.retry(job.id, 'test'), /安全重试/);
  assert.equal(await s.jobs.processOnce(), false);
  assert.equal(sends, 1);
});
