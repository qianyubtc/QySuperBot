import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';

async function fixture() {
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  let identity = '12345',
    switchDuringRole = false,
    mutations = 0;
  let outcome = { status: 200, data: { retcode: 0, status: 'ok' } };
  s.adapters.qq = async (_account, action) => {
    if (action === 'get_login_info')
      return { status: 200, data: { retcode: 0, data: { user_id: identity } } };
    if (action === 'get_group_list')
      return {
        status: 200,
        data: { retcode: 0, data: [{ group_id: '67890', group_name: 'review fixture' }] },
      };
    if (action === 'get_group_member_list') {
      if (switchDuringRole) identity = '54321';
      return {
        status: 200,
        data: { retcode: 0, data: [{ group_id: '67890', user_id: '12345', role: 'admin' }] },
      };
    }
    if (['delete_msg', 'set_group_kick'].includes(action)) {
      mutations++;
      return outcome;
    }
    throw Error('Unexpected test request');
  };
  const created = await s.accounts.create(
    { kind: 'qq', name: 'review', endpoint: 'https://example.com', token: 'local-review-token' },
    'test',
  );
  await s.accounts.refresh(created.id, 'test');
  const account = await s.accounts.get(created.id);
  const group = (await s.features.groups())[0]!;
  return {
    s,
    account,
    group,
    get mutations() {
      return mutations;
    },
    changeDuringRole() {
      identity = '12345';
      switchDuringRole = true;
    },
    outcome(value: typeof outcome) {
      outcome = value;
    },
  };
}

test('QQ account switches during role queries cannot publish permissions or issue member mutations', async () => {
  const f = await fixture();
  try {
    const before = (await f.s.features.group(f.group.id)).bindings[0].snapshot;
    f.changeDuringRole();
    await assert.rejects(
      f.s.accounts.refresh(f.account.id, 'test'),
      (error: any) => error.code === 'QQ_IDENTITY_CHANGED',
    );
    assert.deepEqual((await f.s.features.group(f.group.id)).bindings[0].snapshot, before);
    f.changeDuringRole();
    const result = await f.s.adapters.execute(f.account, {
      schema_version: '1',
      command_id: randomUUID(),
      idempotency_key: randomUUID(),
      attempt_id: randomUUID(),
      attempt_number: 1,
      logical_conversation_id: f.group.id,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      target: { connector_id: f.account.id, account_id: f.account.id, conversation_id: f.group.external_id },
      action: 'member.remove',
      params: { user_id: '99999', reason: 'fixture' },
    });
    assert.equal(result.status === 'failed' && result.error.code, 'QQ_IDENTITY_CHANGED');
    assert.equal(f.mutations, 0);
  } finally {
    await f.s.close();
  }
});

test('contradictory or asynchronous QQ management responses stay unknown, while definite rejection is a failure', async () => {
  const f = await fixture();
  try {
    const outcomes = [
      { status: 500, data: { retcode: 0, status: 'ok' } },
      { status: 200, data: { retcode: 0, status: 'failed' } },
      { status: 200, data: { retcode: 1, status: 'async' } },
      { status: 200, data: { retcode: 1403, status: 'ok' } },
    ];
    for (const [index, outcome] of outcomes.entries()) {
      f.outcome(outcome);
      const job = await f.s.jobs.enqueue({
        key: randomUUID(),
        conversationId: f.group.id,
        action: 'message.delete',
        params: { message_id: '123', reason: 'fixture' },
      });
      await f.s.jobs.processOnce();
      const delivery = (await f.s.features.deliveries(job.id)) as any;
      assert.equal(delivery.status, 'unknown');
      assert.equal(delivery.attempts.length, 1);
      await assert.rejects(
        f.s.jobs.retry(job.id, 'test'),
        (error: any) => error.code === 'RETRY_NOT_ALLOWED',
      );
      assert.equal(await f.s.jobs.processOnce(), false);
      assert.equal(f.mutations, index + 1);
    }
    f.outcome({ status: 200, data: { retcode: 1403, status: 'failed' } });
    const rejected = await f.s.jobs.enqueue({
      key: randomUUID(),
      conversationId: f.group.id,
      action: 'message.delete',
      params: { message_id: '124', reason: 'fixture' },
    });
    await f.s.jobs.processOnce();
    assert.equal(((await f.s.features.deliveries(rejected.id)) as any).status, 'failed');
    assert.equal(f.mutations, 5);
  } finally {
    await f.s.close();
  }
});
