import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { defaultPolicy } from '../src/inputs.ts';
import { policyAvailability } from '../src/governance.ts';
import { groupSnapshot } from '../src/adapters.ts';
import { createHttpApp } from '../src/http.ts';

const services = (seedDemo = true) =>
  createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );

test('QQ discovers scoped management roles from a fresh member list when forced single-member lookup fails', async () => {
  const s = await services(false);
  let role = 'admin',
    lookupStatus = 'ok',
    scope = 'correct',
    identity = '12345',
    mutations = 0;
  const calls: { action: string; params: any }[] = [];
  s.adapters.qq = async (_account, action, params: any = {}) => {
    calls.push({ action, params });
    if (action === 'get_login_info')
      return { status: 200, data: { retcode: 0, data: { user_id: identity } } };
    if (action === 'get_group_list')
      return { status: 200, data: { retcode: 0, data: [{ group_id: 67890, group_name: 'Role fixture' }] } };
    if (action === 'get_group_member_list')
      return {
        status: 200,
        data: {
          status: lookupStatus,
          retcode: 0,
          data: [
            {
              group_id: scope === 'wrong_group' ? '99999' : '67890',
              user_id: scope === 'wrong_user' ? '99999' : '12345',
              role,
            },
          ],
        },
      };
    if (action === 'get_group_member_info')
      return { status: 200, data: { retcode: 200, status: 'failed', data: null } };
    if (action === 'set_group_kick') {
      mutations++;
      return { status: 200, data: { retcode: 0 } };
    }
    throw Error('Unexpected QQ action');
  };
  try {
    const created = await s.accounts.create(
      { kind: 'qq', name: 'Role fixture', endpoint: 'https://example.com', token: 'fixture' },
      'test',
    );
    await s.accounts.refresh(created.id, 'test');
    const binding = () =>
      s.db
        .query('SELECT snapshot,conversation_id FROM bindings WHERE account_id=$1', [created.id])
        .then((rows) => rows[0]!);
    const management = async () =>
      (await binding()).snapshot.permissions.filter((p: any) =>
        ['messages.delete', 'members.remove'].includes(p.capability),
      );
    assert(
      (await management()).every((p: any) => p.permission === 'granted' && p.reason.includes('实时成员列表')),
    );
    assert.equal(calls.filter((c) => c.action === 'get_group_member_info').length, 0);
    assert(
      calls.filter((c) => c.action === 'get_group_member_list').every((c) => c.params.no_cache === true),
    );
    const group = await s.features.group((await binding()).conversation_id);
    assert.equal(group.policy_options.remove.available, true);
    assert.equal(group.policy_options.ban.available, false);
    const account = await s.accounts.get(created.id);
    const command = {
      schema_version: '1' as const,
      command_id: randomUUID(),
      idempotency_key: randomUUID(),
      attempt_id: randomUUID(),
      attempt_number: 1,
      logical_conversation_id: group.id,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      target: { connector_id: account.id, account_id: account.id, conversation_id: '67890' },
      action: 'member.remove' as const,
      params: { user_id: '99999', reason: 'fixture' },
    };
    role = 'member';
    const denied = await s.adapters.execute(account, command);
    assert.equal(denied.status, 'failed');
    assert.equal(denied.status === 'failed' && denied.error.code, 'QQ_PERMISSION_DENIED');
    assert.equal(mutations, 0);
    await s.accounts.refresh(created.id, 'test');
    assert((await management()).every((p: any) => p.permission === 'denied'));
    role = 'admin';
    scope = 'wrong_group';
    await s.accounts.refresh(created.id, 'test');
    assert((await management()).every((p: any) => p.permission === 'unknown'));
    const unknown = await s.adapters.execute(account, command);
    assert.equal(unknown.status === 'failed' && unknown.error.code, 'QQ_PERMISSION_UNKNOWN');
    assert.equal(mutations, 0);
    scope = 'wrong_user';
    assert.equal((await s.adapters.qqRole(account, '67890', '12345')).admin, null);
    scope = 'correct';
    role = 'not-a-role';
    assert.equal((await s.adapters.qqRole(account, '67890', '12345')).admin, null);
    role = 'owner';
    assert.equal((await s.adapters.qqRole(account, '67890', '12345')).admin, true);
    for (const status of ['failed', 'async', 'unexpected']) {
      lookupStatus = status;
      assert.equal((await s.adapters.qqRole(account, '67890', '12345')).admin, null);
    }
    lookupStatus = 'ok';
    identity = '99999';
    const switched = await s.adapters.execute(account, command);
    assert.equal(switched.status === 'failed' && switched.error.code, 'QQ_IDENTITY_CHANGED');
    assert.equal(mutations, 0);
  } finally {
    await s.close();
  }
});

test('policy availability separates platform support, permissions, stale snapshots and selected group scope', () => {
  const group = { external_id: '10001' };
  const account = { kind: 'qq', status: 'online', settings: { group_ids: ['10001'] } };
  const snapshot = {
    ...groupSnapshot('10001', 'fixture', 'group', 3, 'qq', true),
    observed_at: new Date().toISOString(),
  };
  assert.equal(policyAvailability(group, account, snapshot).remove!.available, true);
  assert.equal(policyAvailability(group, account, snapshot).ban!.available, false);
  assert.equal(
    policyAvailability(group, { ...account, settings: { group_ids: [] } }, snapshot).delete!.available,
    false,
  );
  assert.equal(
    policyAvailability(group, { ...account, status: 'paused' }, snapshot).delete!.available,
    false,
  );
  assert.match(
    policyAvailability(group, account, {
      ...snapshot,
      observed_at: new Date(Date.now() - 301000).toISOString(),
    }).delete!.reason!,
    /过期/,
  );
  for (const state of [false, null]) {
    const value = {
      ...groupSnapshot('10001', 'fixture', 'group', 3, 'qq', state),
      observed_at: new Date().toISOString(),
    };
    assert.equal(policyAvailability(group, account, value).delete!.available, false);
    assert.match(policyAvailability(group, account, value).ban!.reason!, /尚未接入/);
  }
});

test('unsupported enforcement is rejected by the API while observe-only rules remain configurable', async () => {
  const s = await services();
  const app = await createHttpApp(s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const setup = await fetch(base + '/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'policy-test', password: 'policy-test-password' }),
    });
    const session = (await setup.json()) as any;
    const headers = {
      cookie: setup.headers.get('set-cookie')!.split(';')[0]!,
      'x-csrf-token': session.csrf,
      'content-type': 'application/json',
    };
    const group = (await s.features.groups())[0]!;
    const before = (await s.features.group(group.id)).policy_version;
    const rejected = await fetch(`${base}/api/v1/conversations/${group.id}/policy`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...defaultPolicy, mode: 'enforce', action: 'remove' }),
    });
    assert.equal(rejected.status, 409);
    assert.equal(((await rejected.json()) as any).error.code, 'POLICY_ACTION_UNAVAILABLE');
    assert.equal((await s.features.group(group.id)).policy_version, before);
    await s.features.policy(group.id, { ...defaultPolicy, action: 'remove', keywords: ['观察'] }, 'test');
    assert.equal((await s.features.group(group.id)).policy.mode, 'observe');
    const binding = (
      await s.db.query('SELECT snapshot FROM bindings WHERE conversation_id=$1', [group.id])
    )[0]!;
    binding.snapshot.permissions = binding.snapshot.permissions.map((p: any) =>
      p.capability === 'messages.delete' ? { ...p, permission: 'unknown' } : p,
    );
    await s.db.query('UPDATE bindings SET snapshot=$2::jsonb WHERE conversation_id=$1', [
      group.id,
      JSON.stringify(binding.snapshot),
    ]);
    await assert.rejects(
      s.features.policy(group.id, { ...defaultPolicy, mode: 'enforce' }, 'test'),
      (e: any) => e.code === 'POLICY_ACTION_UNAVAILABLE',
    );
    await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [group.executor_account_id]);
    const refreshPath = `${base}/api/v1/accounts/${group.executor_account_id}/permissions-refresh`;
    assert.equal((await fetch(refreshPath, { method: 'POST' })).status, 401);
    assert.equal(
      (await fetch(refreshPath, { method: 'POST', headers: { cookie: headers.cookie } })).status,
      403,
    );
    assert.equal((await fetch(refreshPath, { method: 'POST', headers })).status, 409);
    assert.equal((await s.accounts.get(group.executor_account_id)).status, 'paused');
  } finally {
    await app.close();
    await s.close();
  }
});

test('message decisions remain distinct from partial, failed, uncertain and older moderation receipts in chat, history and group details', async () => {
  const s = await services();
  try {
    const group = (await s.features.groups())[0]!;
    const account = await s.accounts.get(group.executor_account_id);
    const binding = (
      await s.db.query('SELECT snapshot FROM bindings WHERE conversation_id=$1', [group.id])
    )[0]!;
    binding.snapshot.capabilities.push({ capability: 'members.ban', state: 'supported' });
    binding.snapshot.permissions.push({ capability: 'members.ban', permission: 'granted' });
    await s.db.query('UPDATE bindings SET snapshot=$2::jsonb WHERE conversation_id=$1', [
      group.id,
      JSON.stringify(binding.snapshot),
    ]);
    await s.features.policy(
      group.id,
      { ...defaultPolicy, mode: 'enforce', action: 'ban', keywords: ['广告'] },
      'test',
    );
    const source = { connector_id: account.id, account_id: account.id, conversation_id: group.external_id };
    await s.messages.ingest(account, {
      schema_version: '1',
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      source,
      type: 'member.joined',
      data: { user_id: 'member', membership_id: 'current-join' },
    });
    const messageId = randomUUID();
    await s.messages.ingest(account, {
      schema_version: '1',
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      source,
      type: 'message.created',
      data: {
        message_id: messageId,
        sender_id: 'member',
        direction: 'incoming',
        segments: [{ type: 'text', text: '广告' }],
      },
    });
    const find = async () =>
      (await s.chat.snapshot(group.id)).messages.find((m: any) => m.external_id === messageId);
    const pending = await find();
    assert.equal(pending.verdict, 'blocked');
    assert.equal(pending.deleted, false);
    assert.equal(pending.moderation_jobs.length, 2);
    assert(pending.moderation_jobs.every((j: any) => j.status === 'pending'));
    await s.jobs.processOnce();
    const deletion = (await find()).moderation_jobs.find((j: any) => j.action === 'message.delete');
    assert.equal(deletion.status, 'succeeded');
    const member = (await find()).moderation_jobs.find((j: any) => j.action === 'member.ban');
    await s.db.query("UPDATE jobs SET status='unknown',last_error='平台回执尚未确认' WHERE id=$1", [
      member.id,
    ]);
    const partial = await find();
    assert.equal(partial.deleted, true);
    assert.deepEqual(
      new Set(partial.moderation_jobs.map((j: any) => j.status)),
      new Set(['succeeded', 'unknown']),
    );
    await s.db.query("UPDATE jobs SET status='failed',last_error='账号没有封禁权限' WHERE id=$1", [
      member.id,
    ]);
    const failed = (await s.features.group(group.id)).messages.find((m: any) => m.external_id === messageId);
    assert(
      failed.moderation_jobs.some((j: any) => j.status === 'failed' && j.last_error === '账号没有封禁权限'),
    );
    await s.db.query('UPDATE messages SET content_version=content_version+1 WHERE id=$1', [pending.id]);
    assert((await find()).moderation_jobs.every((j: any) => j.current_version === false));
    const anchor = await s.db.query(
      "INSERT INTO messages(id,conversation_id,account_id,external_id,sender_id,sender_name,content,segments,direction,verdict,fingerprint,source_at,created_at) VALUES($1,$2,$3,$4,'member','Member','normal','[]','incoming','allowed','fixture',now(),now()+interval '1 second') RETURNING id",
      [randomUUID(), group.id, account.id, randomUUID()],
    );
    const history = await s.chat.history(group.id, { before: anchor[0]!.id });
    assert.equal(history.messages.find((m: any) => m.id === pending.id).moderation_jobs.length, 2);
  } finally {
    await s.close();
  }
});
