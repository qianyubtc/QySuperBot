import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/database.ts';
import { createServices } from '../src/services.ts';
import type { Services } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { defaultPolicy } from '../src/inputs.ts';
import { groupSnapshot } from '../src/adapters.ts';
import type { ConnectorCommand, ExecutionReceipt } from '../../../packages/contracts/src/index.ts';

let s: Services;
let demo: any;
let group: any;
let target: any;
before(async () => {
  s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: true },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  demo = await s.accounts.get('local-demo');
  [group, target] = await s.features.groups();
});
after(async () => {
  await s.close();
});

test('failed credential initialization releases the persistent database lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qsb-startup-review-'));
  try {
    await assert.rejects(
      createServices(
        { ...loadConfig(), databaseUrl: undefined, dataDir: dir, encryptionKey: 'invalid', seedDemo: false },
        { worker: false },
      ),
      /ENCRYPTION_KEY/,
    );
    const reopened = await openDatabase({ dataDir: dir });
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
function message(text: string, user = 'review-user', id: string = randomUUID(), time = Date.now()) {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date(time).toISOString(),
    source: { connector_id: demo.id, account_id: demo.id, conversation_id: group.external_id },
    type: 'message.created',
    data: { message_id: id, sender_id: user, direction: 'incoming', segments: [{ type: 'text', text }] },
  };
}
async function drain() {
  for (let i = 0; i < 100; i++) if (!(await s.jobs.processOnce())) return;
  throw new Error('Queue did not drain');
}
async function remote() {
  const created = await s.accounts.create(
    { kind: 'custom', name: '审查测试连接', endpoint: 'https://example.com' },
    'review',
  );
  await s.db.query(
    "UPDATE accounts SET status='online',session_id=$2,session_expires_at=now()+interval '1 hour' WHERE id=$1",
    [created.id, randomUUID()],
  );
  const account = await s.accounts.get(created.id);
  const id = await s.accounts.upsertGroup(
    account,
    groupSnapshot(randomUUID(), '审查测试群', 'group', null, 'demo', true),
  );
  return { account, id };
}
function succeeded(command: ConnectorCommand, revision = 1): ExecutionReceipt {
  return {
    schema_version: '1',
    command_id: command.command_id,
    attempt_id: command.attempt_id,
    attempt_number: command.attempt_number,
    revision,
    observed_at: new Date().toISOString(),
    status: 'succeeded',
    result: { message_id: randomUUID() },
  };
}
async function enqueue(conversationId: string, text = 'review') {
  return s.jobs.enqueue({
    key: randomUUID(),
    conversationId,
    action: 'message.send',
    params: { segments: [{ type: 'text', text }] },
  });
}

test('a late first receipt remains valid after a transport timeout', async () => {
  const r = await remote();
  const job = await enqueue(r.id);
  let command!: ConnectorCommand;
  const original = s.adapters.execute;
  try {
    s.adapters.execute = async (_account, c) => {
      command = c;
      throw new Error('response lost');
    };
    await s.jobs.processOnce();
  } finally {
    s.adapters.execute = original;
  }
  const uncertain = (await s.features.deliveries(job.id)) as any;
  assert.equal(uncertain.status, 'unknown');
  assert.equal(uncertain.attempts[0].receipt, null);
  await assert.rejects(s.jobs.retry(job.id, 'review'), /安全重试/);
  const receipt = succeeded(command);
  await s.jobs.saveReceipt(r.account.id, receipt, true);
  await s.jobs.saveReceipt(r.account.id, receipt, true);
  assert.equal(((await s.features.deliveries(job.id)) as any).status, 'succeeded');
  assert.equal((await s.db.query('SELECT * FROM messages WHERE conversation_id=$1', [r.id])).length, 1);
});

test('accepted expiry does not steal the final connector revision', async () => {
  const r = await remote();
  const job = await enqueue(r.id);
  let command!: ConnectorCommand;
  const original = s.adapters.execute;
  try {
    s.adapters.execute = async (_account, c) => {
      command = c;
      return {
        schema_version: '1',
        command_id: c.command_id,
        attempt_id: c.attempt_id,
        attempt_number: c.attempt_number,
        revision: 1,
        observed_at: new Date().toISOString(),
        status: 'accepted',
      };
    };
    await s.jobs.processOnce();
  } finally {
    s.adapters.execute = original;
  }
  await s.db.query("UPDATE jobs SET expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
  await s.jobs.recover();
  const uncertain = (await s.features.deliveries(job.id)) as any;
  assert.equal(uncertain.status, 'unknown');
  assert.equal(uncertain.receipt.revision, 1);
  await s.jobs.saveReceipt(r.account.id, succeeded(command, 2), true);
  assert.equal(((await s.features.deliveries(job.id)) as any).status, 'succeeded');
});

test('recovery during an outstanding call does not reject its eventual response', async () => {
  const r = await remote();
  const job = await enqueue(r.id);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = s.adapters.execute;
  s.adapters.execute = async (_account, command) => {
    entered();
    await pending;
    return succeeded(command);
  };
  const running = s.jobs.processOnce();
  try {
    await ready;
    await s.db.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1", [job.id]);
    await s.jobs.recover();
    assert.equal(((await s.features.deliveries(job.id)) as any).status, 'unknown');
    release();
    await running;
    assert.equal(((await s.features.deliveries(job.id)) as any).status, 'succeeded');
  } finally {
    release();
    await running;
    s.adapters.execute = original;
  }
});

test('invalid task payloads fail without blocking following deliveries', async () => {
  const invalid = await enqueue(group.id, 'x'.repeat(33_000));
  const valid = await enqueue(group.id);
  await drain();
  assert.equal(((await s.features.deliveries(invalid.id)) as any).receipt.error.code, 'INVALID_COMMAND');
  assert.equal(((await s.features.deliveries(valid.id)) as any).status, 'succeeded');
});

test('older edits preserve the newest content; ambiguous equal timestamps cancel old reviews', async () => {
  await s.features.policy(group.id, { ...defaultPolicy, mode: 'enforce', keywords: ['SPAM'] }, 'review');
  await s.features.saveRoute({ source_id: group.id, target_id: target.id }, 'review');
  const time = Date.now() - 10_000;
  const latest = message('最新的正常讨论', 'editor', randomUUID(), time + 2000);
  await s.messages.ingest(demo, latest);
  for (const delta of [0, 1000])
    await s.messages.ingest(demo, {
      ...latest,
      event_id: randomUUID(),
      type: 'message.edited',
      occurred_at: new Date(time + delta).toISOString(),
      data: { ...latest.data, segments: [{ type: 'text', text: 'SPAM' }] },
    });
  let row = (await s.db.query('SELECT * FROM messages WHERE external_id=$1', [latest.data.message_id]))[0]!;
  assert.equal(row.content, latest.data.segments[0]!.text);
  assert.equal(row.verdict, 'allowed');
  await s.messages.ingest(demo, {
    ...latest,
    event_id: randomUUID(),
    type: 'message.edited',
    data: { ...latest.data, segments: [{ type: 'text', text: 'SPAM' }] },
  });
  row = (await s.db.query('SELECT * FROM messages WHERE id=$1', [row.id]))[0]!;
  assert.equal(row.content, latest.data.segments[0]!.text);
  assert.equal(row.verdict, 'pending');
  await drain();
  const sync = (
    await s.db.query("SELECT * FROM jobs WHERE review_ref->>'message_record_id'=$1", [row.id])
  )[0]!;
  assert.equal(sync.receipt.error.code, 'STALE_REVIEW');
  await s.features.policy(group.id, defaultPolicy, 'review');
});

test('a delete arriving before its create remains a tombstone', async () => {
  const original = message('不应被转发的已删除内容');
  await s.messages.ingest(demo, {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: original.source,
    type: 'message.deleted',
    data: { message_id: original.data.message_id },
  });
  await s.messages.ingest(demo, original);
  await s.messages.ingest(demo, { ...original, event_id: randomUUID(), type: 'message.edited' });
  assert.equal(
    (await s.db.query('SELECT * FROM messages WHERE external_id=$1', [original.data.message_id])).length,
    0,
  );
});

test('leaving without an observed join invalidates verification and its queued challenge', async () => {
  await s.features.policy(group.id, { ...defaultPolicy, verification_enabled: true }, 'review');
  const e = message('首次观察到的老成员', 'left-without-join');
  await s.messages.ingest(demo, e);
  const v = (
    await s.db.query('SELECT * FROM verifications WHERE conversation_id=$1 AND user_id=$2', [
      group.id,
      e.data.sender_id,
    ])
  )[0]!;
  await s.db.query("UPDATE verifications SET status='expired' WHERE id=$1", [v.id]);
  await s.messages.ingest(demo, {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: e.occurred_at,
    source: e.source,
    type: 'member.left',
    data: { user_id: e.data.sender_id, membership_id: 'unknown' },
  });
  assert.equal((await s.db.query('SELECT status FROM verifications WHERE id=$1', [v.id]))[0]!.status, 'left');
  assert.equal(
    (
      await s.db.query('SELECT status FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
        group.id,
        e.data.sender_id,
      ])
    )[0]!.status,
    'left',
  );
  await assert.rejects(s.features.approveVerification(v.id, 'review'), /批次/);
  await drain();
  const challenge = (
    await s.db.query('SELECT * FROM jobs WHERE idempotency_key=$1', [`verification:${v.id}`])
  )[0]!;
  assert.equal(challenge.receipt.error.code, 'STALE_VERIFICATION');
  const failedUser = message('已失败的上一批次', 'failed-old-episode');
  await s.messages.ingest(demo, failedUser);
  const failed = (
    await s.db.query('SELECT id FROM verifications WHERE conversation_id=$1 AND user_id=$2', [
      group.id,
      failedUser.data.sender_id,
    ])
  )[0]!;
  await s.db.query("UPDATE verifications SET status='failed' WHERE id=$1", [failed.id]);
  await s.features.policy(group.id, defaultPolicy, 'review');
  await s.messages.ingest(demo, {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date(Date.now() + 1000).toISOString(),
    source: failedUser.source,
    type: 'member.joined',
    data: { user_id: failedUser.data.sender_id, membership_id: randomUUID() },
  });
  await assert.rejects(s.features.approveVerification(failed.id, 'review'), /批次/);
  assert.equal(
    (await s.db.query('SELECT status FROM verifications WHERE id=$1', [failed.id]))[0]!.status,
    'superseded',
  );
  await drain();
});

test('a delayed discovery or heartbeat cannot undo an administrator pause', async () => {
  const r = await remote();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = s.adapters.discover;
  s.adapters.discover = async () => {
    entered();
    await pending;
    return { externalId: r.account.id, displayName: 'Review', groups: [] };
  };
  const refresh = s.accounts.refresh(r.account.id, '定时刷新');
  try {
    await ready;
    await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [r.account.id]);
    release();
    await assert.rejects(refresh, /状态或连接会话/);
    await assert.rejects(
      s.accounts.heartbeat(r.account, {
        schema_version: '1',
        connector_id: r.account.id,
        account_id: r.account.id,
        session_id: r.account.session_id,
        sequence: 1,
        state: 'online',
        observed_at: new Date().toISOString(),
        last_event_at: null,
      }),
      /失效/,
    );
    assert.equal((await s.accounts.get(r.account.id)).status, 'paused');
  } finally {
    release();
    await refresh.catch(() => {});
    s.adapters.discover = original;
  }
});

test('stale sessions and cached discovery cannot restore revoked permissions', async () => {
  const r = await remote();
  const old = r.account;
  const newSession = randomUUID();
  await s.db.query('UPDATE accounts SET session_id=$2 WHERE id=$1', [old.id, newSession]);
  const binding = (await s.db.query('SELECT * FROM bindings WHERE account_id=$1', [old.id]))[0]!;
  const permissions = binding.snapshot.permissions.map((p: any) => ({ ...p, permission: 'denied' }));
  const payload = {
    schema_version: '1',
    connector_id: old.id,
    account_id: old.id,
    conversation_id: binding.external_id,
    session_id: old.session_id,
    revision: 1,
    observed_at: new Date(Date.now() + 1000).toISOString(),
    permissions,
  };
  await assert.rejects(s.accounts.permissions(old, payload), /会话/);
  await s.accounts.permissions(old, { ...payload, session_id: newSession });
  await s.accounts.upsertGroup(old, {
    ...groupSnapshot(binding.external_id, '缓存旧快照', 'group', null, 'demo', true),
    observed_at: binding.snapshot.observed_at,
  });
  const job = await enqueue(r.id);
  await drain();
  assert.equal(((await s.features.deliveries(job.id)) as any).receipt.error.code, 'CAPABILITY_UNAVAILABLE');
});
