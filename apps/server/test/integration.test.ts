import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices } from '../src/services.ts';
import type { Services } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { openDatabase } from '../src/database.ts';
import { defaultPolicy } from '../src/inputs.ts';
import { groupSnapshot } from '../src/adapters.ts';
import { signRequest } from '../../../packages/contracts/src/index.ts';

let s: Services;
let source: string;
let target: string;
let account: any;
const admin = { kind: 'admin' as const, id: 'admin', name: '测试管理员', csrf: '' };
before(async () => {
  s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: true },
    { box: new SecretBox(randomBytes(32)), worker: false },
  );
  const groups = await s.features.groups();
  source = groups[0]!.id;
  target = groups[1]!.id;
  account = await s.accounts.get('local-demo');
});
after(async () => {
  await s.close();
});
function event(groupId: string, text: string, user = 'tester', externalId: string = randomUUID()) {
  return {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: groupId },
    type: 'message.created',
    data: {
      message_id: externalId,
      sender_id: user,
      direction: 'incoming',
      segments: [{ type: 'text', text }],
    },
  };
}
async function external(id: string) {
  return (await s.features.group(id)).external_id;
}
async function drain() {
  for (let i = 0; i < 100; i++) if (!(await s.jobs.processOnce())) return;
  throw new Error('Queue did not drain');
}

test('setup is once-only; sessions require CSRF and project keys cannot administer', async () => {
  const session = await s.auth.setup({ username: 'testadmin', password: 'safe-test-password' });
  await assert.rejects(s.auth.setup({ username: 'other', password: 'another-password' }), /已经创建/);
  const headers = { cookie: `qsb_session=${session.token}` };
  assert.equal((await s.auth.authenticate(headers)).kind, 'admin');
  await assert.rejects(s.auth.authenticate(headers, true), /校验/);
  assert.equal(
    (await s.auth.authenticate({ ...headers, 'x-csrf-token': session.user.csrf }, true)).kind,
    'admin',
  );
  const project = await s.features.createProject(
    { name: '只读项目', conversation_ids: [source], scopes: ['conversations.read'] },
    'test',
  );
  const principal = await s.auth.authenticate({ authorization: `Bearer ${project.key}` });
  assert.equal((await s.features.groups(principal)).length, 1);
  assert.throws(() => s.auth.requireAdmin(principal), /管理员/);
  await assert.rejects(
    s.features.send(principal, { conversation_ids: [source], text: 'hello' }, 'test-key-0001'),
    /权限/,
  );
  await s.auth.logout(headers.cookie);
  await assert.rejects(s.auth.authenticate(headers), /登录/);
});

test('group-local message IDs do not collide; inbox rejects changed replay bodies', async () => {
  const e = event(await external(source), 'first', 'same-user', '42');
  await s.messages.ingest(account, e);
  assert.equal((await s.messages.ingest(account, e)).duplicate, true);
  await assert.rejects(
    s.messages.ingest(account, { ...e, data: { ...e.data, segments: [{ type: 'text', text: 'changed' }] } }),
    /载荷/,
  );
  await s.messages.ingest(account, event(await external(target), 'second', 'same-user', '42'));
  const rows = await s.db.query("SELECT * FROM messages WHERE account_id='local-demo' AND external_id='42'");
  assert.equal(rows.length, 2);
});

test('enforced ads never enter sync; reviewed messages are stopped after rule changes', async () => {
  await s.features.policy(source, { ...defaultPolicy, mode: 'enforce', keywords: ['返佣广告'] }, 'test');
  await s.features.saveRoute({ source_id: source, target_id: target }, 'test');
  const bad = event(await external(source), '返佣广告 https://bad.example');
  await s.messages.ingest(account, bad);
  const row = (await s.db.query('SELECT * FROM messages WHERE external_id=$1', [bad.data.message_id]))[0]!;
  assert.equal(row.verdict, 'blocked');
  assert.equal(
    (
      await s.db.query(
        "SELECT * FROM jobs WHERE review_ref->>'message_record_id'=$1 AND review_ref->>'purpose'='sync'",
        [row.id],
      )
    ).length,
    0,
  );
  await drain();
  assert.equal((await s.db.query('SELECT deleted FROM messages WHERE id=$1', [row.id]))[0]!.deleted, true);
  const good = event(await external(source), '正常讨论');
  await s.messages.ingest(account, good);
  const job = (
    await s.db.query(
      "SELECT j.* FROM jobs j JOIN messages m ON m.id=j.review_ref->>'message_record_id' WHERE m.external_id=$1",
      [good.data.message_id],
    )
  )[0]!;
  await s.features.policy(source, { ...defaultPolicy, keywords: ['新规则'] }, 'test');
  await drain();
  assert.equal(
    (await s.db.query('SELECT * FROM jobs WHERE id=$1', [job.id]))[0]!.receipt.error.code,
    'STALE_REVIEW',
  );
  await s.features.policy(source, defaultPolicy, 'test');
});

test('sync delivers once and connector echoes cannot create a forwarding chain', async () => {
  await s.features.saveRoute({ source_id: target, target_id: source }, 'test');
  const e = event(await external(source), '同步这条消息');
  await s.messages.ingest(account, e);
  await s.messages.ingest(account, e);
  const record = (await s.db.query('SELECT * FROM messages WHERE external_id=$1', [e.data.message_id]))[0]!;
  const jobs = await s.db.query("SELECT * FROM jobs WHERE review_ref->>'message_record_id'=$1", [record.id]);
  assert.equal(jobs.length, 1);
  await drain();
  const echo = event(await external(target), '同步这条消息');
  await s.messages.ingest(account, { ...echo, trace: jobs[0]!.trace });
  const echoed = (
    await s.db.query('SELECT id FROM messages WHERE external_id=$1', [echo.data.message_id])
  )[0]!;
  assert.equal(
    (await s.db.query("SELECT * FROM jobs WHERE review_ref->>'message_record_id'=$1", [echoed.id])).length,
    0,
  );
});

test('member enforcement deletes the ad and checks the original membership before banning', async () => {
  const binding = (
    await s.db.query('SELECT * FROM bindings WHERE account_id=$1 AND conversation_id=$2', [
      account.id,
      source,
    ])
  )[0]!;
  const snapshot = {
    ...binding.snapshot,
    capabilities: [...binding.snapshot.capabilities, { capability: 'members.ban', state: 'supported' }],
    permissions: [...binding.snapshot.permissions, { capability: 'members.ban', permission: 'granted' }],
  };
  await s.db.query('UPDATE bindings SET snapshot=$2::jsonb WHERE account_id=$1 AND conversation_id=$3', [
    account.id,
    JSON.stringify(snapshot),
    source,
  ]);
  await s.features.policy(
    source,
    { ...defaultPolicy, mode: 'enforce', keywords: ['ban-test'], action: 'ban' },
    'test',
  );
  const join = {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: await external(source) },
    type: 'member.joined',
    data: { user_id: 'ban-user', membership_id: randomUUID() },
  };
  await s.messages.ingest(account, join);
  const ad = event(await external(source), 'ban-test', 'ban-user');
  await s.messages.ingest(account, ad);
  await drain();
  const message = (await s.db.query('SELECT * FROM messages WHERE external_id=$1', [ad.data.message_id]))[0]!;
  assert.equal(message.deleted, true);
  const first = await s.db.query("SELECT * FROM jobs WHERE review_ref->>'message_record_id'=$1", [
    message.id,
  ]);
  assert.deepEqual(
    first.map((j) => j.status),
    ['succeeded', 'succeeded'],
  );
  const another = event(await external(source), 'ban-test again', 'ban-user');
  await s.messages.ingest(account, another);
  await s.messages.ingest(account, {
    ...join,
    event_id: randomUUID(),
    occurred_at: new Date(Date.now() + 1000).toISOString(),
    data: { user_id: 'ban-user', membership_id: randomUUID() },
  });
  await drain();
  const stopped = (
    await s.db.query(
      "SELECT j.* FROM jobs j JOIN messages m ON m.id=j.review_ref->>'message_record_id' WHERE m.external_id=$1 AND j.action='member.ban'",
      [another.data.message_id],
    )
  )[0]!;
  assert.equal(stopped.receipt.error.code, 'MEMBERSHIP_UNCONFIRMED');
  await s.features.policy(source, defaultPolicy, 'test');
  await s.db.query('UPDATE bindings SET snapshot=$2::jsonb WHERE account_id=$1 AND conversation_id=$3', [
    account.id,
    JSON.stringify(binding.snapshot),
    source,
  ]);
});

test('verification binds user and latest membership episode; no automatic unmute', async () => {
  await s.features.policy(source, { ...defaultPolicy, verification_enabled: true }, 'test');
  const join = {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: await external(source) },
    type: 'member.joined',
    data: { user_id: 'newbie', membership_id: randomUUID() },
  };
  await s.messages.ingest(account, join);
  const verification = (
    await s.db.query("SELECT * FROM verifications WHERE user_id='newbie' ORDER BY created_at DESC")
  )[0]!;
  const welcome = (
    await s.db.query('SELECT * FROM jobs WHERE idempotency_key=$1', [`verification:${verification.id}`])
  )[0]!;
  const code = welcome.params.segments[0].text.match(/\/verify (\d{6})/)[1];
  await s.messages.ingest(account, event(await external(source), `/verify ${code}`, 'someone-else'));
  assert.equal(
    (await s.db.query('SELECT status FROM verifications WHERE id=$1', [verification.id]))[0]!.status,
    'pending',
  );
  await s.messages.ingest(account, event(await external(source), `/verify ${code}`, 'newbie'));
  assert.equal(
    (await s.db.query('SELECT status FROM verifications WHERE id=$1', [verification.id]))[0]!.status,
    'passed',
  );
  assert.equal((await s.db.query("SELECT * FROM jobs WHERE action='member.unmute'")).length, 0);
  await s.messages.ingest(account, {
    ...join,
    event_id: randomUUID(),
    occurred_at: new Date(Date.now() + 1000).toISOString(),
    data: { user_id: 'newbie', membership_id: randomUUID() },
  });
  await assert.rejects(s.features.approveVerification(verification.id, 'test'), /批次/);
  await s.features.policy(source, defaultPolicy, 'test');
  await drain();
});

test('API idempotency includes all target groups; revocation cancels pending sends', async () => {
  const created = await s.features.createProject(
    { name: '发送项目', conversation_ids: [source, target], scopes: ['messages.send', 'deliveries.read'] },
    'test',
  );
  const principal = await s.auth.authenticate({ authorization: `Bearer ${created.key}` });
  const first = await s.features.send(
    principal,
    { conversation_ids: [source], text: 'API 通知' },
    'request-00001',
  );
  assert.deepEqual(
    await s.features.send(principal, { conversation_ids: [source], text: 'API 通知' }, 'request-00001'),
    first,
  );
  await assert.rejects(
    s.features.send(principal, { conversation_ids: [source, target], text: 'API 通知' }, 'request-00001'),
    /目标群/,
  );
  await s.features.revokeProject(created.id, 'test');
  assert.equal(
    (await s.db.query('SELECT status FROM jobs WHERE id=$1', [first.delivery_ids[0]]))[0]!.status,
    'cancelled',
  );
  await assert.rejects(s.auth.authenticate({ authorization: `Bearer ${created.key}` }), /撤销/);
});

test('transport ambiguity becomes unknown, survives recovery and cannot be retried', async () => {
  const c = await s.accounts.create(
    { kind: 'custom', name: '受测连接', endpoint: 'https://example.com' },
    'test',
  );
  await s.db.query(
    "UPDATE accounts SET status='online',session_expires_at=now()+interval '1 hour' WHERE id=$1",
    [c.id],
  );
  const a = await s.accounts.get(c.id);
  const group = await s.accounts.upsertGroup(
    a,
    groupSnapshot('one', '远程测试群', 'group', null, 'demo', true),
  );
  const j = await s.jobs.enqueue({
    key: randomUUID(),
    conversationId: group,
    action: 'message.send',
    params: { segments: [{ type: 'text', text: 'one' }] },
  });
  const execute = s.adapters.execute;
  s.adapters.execute = async () => {
    throw new Error('lost response');
  };
  await drain();
  s.adapters.execute = execute;
  assert.equal((await s.db.query('SELECT status FROM jobs WHERE id=$1', [j.id]))[0]!.status, 'unknown');
  await s.jobs.recover();
  await assert.rejects(s.jobs.retry(j.id, 'test'), /安全重试/);
  await assert.rejects(
    s.jobs.reconcile(j.id, { outcome: 'succeeded', evidence: '已核对平台消息记录和发送时间' }, 'test'),
    /消息 ID/,
  );
  await s.jobs.reconcile(
    j.id,
    { outcome: 'succeeded', evidence: '已核对平台消息记录和发送时间', message_id: 'confirmed' },
    'test',
  );
  assert.equal((await s.db.query('SELECT status FROM jobs WHERE id=$1', [j.id]))[0]!.status, 'succeeded');
  assert.equal(
    (await s.db.query("SELECT * FROM audit WHERE action='delivery.reconciled' AND target=$1", [j.id])).length,
    1,
  );
  await assert.rejects(
    s.jobs.reconcile(j.id, { outcome: 'no_effect', evidence: '不能回滚已经确认完成的动作结果' }, 'test'),
    /待核对/,
  );
});

test('lottery freezes eligible entrants and cannot redraw', async () => {
  const lottery = await s.features.createLottery(
    {
      conversation_id: source,
      title: '测试抽奖',
      winners_count: 2,
      closes_at: new Date(Date.now() + 60_000).toISOString(),
    },
    'test',
  );
  for (const user of ['a', 'b', 'c'])
    await s.messages.ingest(account, event(await external(source), `/join ${lottery.id}`, user));
  await s.features.blacklist({ conversation_id: source, user_id: 'c', reason: '不符合活动条件' }, 'test');
  await s.db.query("UPDATE lotteries SET closes_at=now()-interval '1 second' WHERE id=$1", [lottery.id]);
  const first = await s.features.drawLottery(lottery.id, 'test');
  assert.deepEqual([...first.winners].sort(), ['a', 'b']);
  assert.deepEqual((await s.features.drawLottery(lottery.id, 'test')).winners, first.winners);
  assert.equal(
    (await s.db.query('SELECT * FROM jobs WHERE idempotency_key=$1', [`lottery:${lottery.id}:result`]))
      .length,
    1,
  );
});

test('HMAC authenticates exact bytes, rejects nonce replay and wrong account sources', async () => {
  const c = await s.accounts.create(
    { kind: 'custom', name: '签名测试', endpoint: 'https://example.com' },
    'test',
  );
  const body = Buffer.from('{"hello":"world"}');
  const path = '/api/v1/connector-events';
  const headers = signRequest({
    method: 'POST',
    path,
    body,
    secret: c.credentials.event_secret,
    keyId: c.credentials.event_key_id,
    purpose: 'events',
  });
  const result = await s.accounts.authenticateHmac(headers, 'POST', path, body, 'events');
  assert.equal(result.account.id, c.id);
  await assert.rejects(s.accounts.authenticateHmac(headers, 'POST', path, body, 'events'), /replay|nonce/i);
  await assert.rejects(s.messages.ingest(result.account, event(await external(source), 'forged')), /范围/);
});

test('local PostgreSQL data survives database close and reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qsb-test-'));
  try {
    const db = await openDatabase({ dataDir: dir });
    await assert.rejects(openDatabase({ dataDir: dir }), /locked/);
    await db.query("INSERT INTO metadata(key,value) VALUES('persistence','{\"saved\":true}')");
    await db.close();
    const reopened = await openDatabase({ dataDir: dir });
    assert.equal(
      (await reopened.query("SELECT value FROM metadata WHERE key='persistence'"))[0]!.value.saved,
      true,
    );
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
