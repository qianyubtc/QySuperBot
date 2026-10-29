import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createBinanceChatClient } from '../../../packages/binance-chat/client.js';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { ApiError, SecretBox } from '../src/security.ts';
import { BinanceDirect } from '../src/binance-direct.ts';
import { binanceGroup } from '../src/binance.ts';
import { createHttpApp } from '../src/http.ts';

function protocol() {
  const state = {
    self: '123',
    actorRole: 1,
    targetRole: 0,
    targetActive: true,
    muted: false,
    wrongUser: false,
    wrongGroup: false,
    billingFee: 0,
    groupOverrides: {} as Record<string, unknown>,
    mode: 'normal',
    mutationCount: 0,
    hook: null as null | ((path: string, body: any) => Promise<void>),
  };
  const calls: Array<{ path: string; body: any }> = [];
  const fetcher = async (input: any, init: any = {}) => {
    const path = String(input),
      body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, body });
    await state.hook?.(path, body);
    let data: any;
    const response = (value: any) => new Response(JSON.stringify(value), { status: 200 });
    if (path.endsWith('get-my-profile')) data = { chatUserId: state.self };
    else if (path.endsWith('get-channel-info'))
      data = {
        id: state.wrongGroup ? '999' : '10001',
        name: 'fixture',
        systemMute: false,
        ownerBan: false,
        isVipCommunityGroup: false,
        billingCycleType: 0,
        billingFee: state.billingFee,
        ...state.groupOverrides,
      };
    else if (path.endsWith('get-current-member-info'))
      data = { uid: '123', role: state.actorRole, memberStatusInChannel: null, disabledReasonTypes: null };
    else if (path.endsWith('chat-restriction')) data = { groupTextRestricted: false };
    else if (path.endsWith('get-member-info')) {
      if (state.mode === 'auth_preflight' || (state.mode === 'auth_readback' && state.mutationCount))
        return response({ success: false, code: '100001005' });
      if (state.mode === 'readback_rejected' && state.mutationCount)
        return response({ success: false, code: '100000001' });
      const own = String(body.uid) === '123';
      data = {
        uid: state.wrongUser ? '999' : String(body.uid),
        name: own ? 'Fixture bot' : 'Fixture member',
        role: own ? state.actorRole : state.targetRole,
        memberStatusInChannel: own || state.targetActive ? 0 : 1,
        disabledReasonTypes: !own && state.muted ? ['SINGLE_MUTED'] : null,
      };
    } else if (path.endsWith('set-single-user-permission') || path.endsWith('remove-member')) {
      state.mutationCount++;
      if (state.mode === 'auth_mutation') return response({ success: false, code: '100001005' });
      if (state.mode === 'reject') return response({ success: false, code: '100000001' });
      if (state.mode !== 'no_change') {
        if (path.endsWith('remove-member')) state.targetActive = false;
        else state.muted = body.permissionMap['1'];
      }
      if (state.mode === 'network_after') throw new Error('Network disconnected after publication');
      data = null;
    } else throw Error('Unexpected route ' + path);
    return response({ success: true, code: '000000', data });
  };
  const make = (guard?: () => Promise<void>, managementEnabled = true) =>
    createBinanceChatClient({ fetch: fetcher as typeof fetch, managementEnabled, beforeSend: guard });
  const request = (client: ReturnType<typeof make>, operation: string, extra: any = {}) =>
    client.request({
      operation,
      group_ids: ['10001'],
      params: {
        group_id: '10001',
        expected_user_id: '123',
        user_id: '777',
        not_after: Date.now() + 60000,
        ...extra,
      },
      before_effect: async () => {},
    });
  return { state, calls, make, request };
}
async function fixture() {
  const p = protocol();
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const direct = new BinanceDirect(s.db, s.box, (_credentials, guard) => p.make(() => guard('10001')));
  s.binance.direct = direct;
  const a = await s.accounts.create(
    { kind: 'binance', name: 'Fixture management', group_ids: ['10001'] },
    'test',
  );
  await s.db.query(
    "UPDATE accounts SET external_id='123',session_id=$2,status='online',secret_box=$3,settings=settings||$4::jsonb WHERE id=$1",
    [
      a.id,
      randomUUID(),
      s.box.seal(
        JSON.stringify({ mode: 'direct', web_token: 'private-fixture', csrf_token: 'b'.repeat(32) }),
      ),
      JSON.stringify({ transport: 'direct' }),
    ],
  );
  await s.accounts.refresh(a.id, 'test');
  const group = (await s.db.query('SELECT * FROM conversations WHERE executor_account_id=$1', [a.id]))[0]!;
  const act = (action: string, user = '777', key = randomUUID()) =>
    s.binanceMembers.act(group.id, { user_id: user, action, reason: 'Fixture reason' }, key, {
      id: 'admin',
      name: 'Fixture admin',
    });
  const jobs = () =>
    s.db.query('SELECT * FROM jobs WHERE conversation_id=$1 ORDER BY created_at,id', [group.id]);
  return { ...p, s, group, account: await s.accounts.get(a.id), act, jobs, close: () => s.close() };
}

test('Binance mute, explicit unmute and removal use exact official parameters and read-back before success', async () => {
  const f = await fixture();
  try {
    const start = await f.s.binanceMembers.overview(f.group.id, '777');
    assert(start.availability.mute!.available);
    assert(!start.availability.unmute!.available);
    const rules = await f.s.features.group(f.group.id);
    assert.equal(rules.policy_options.verification.available, false);
    assert.equal(rules.policy_options.verification_mute.available, false);
    assert.equal(rules.policy_options.remove.available, false);
    const muted = await f.act('mute');
    await f.s.jobs.processOnce();
    let job = (await f.jobs()).find((j) => j.id === muted.job_id)!;
    assert.equal(job.status, 'succeeded');
    assert.equal(job.receipt.result.member.state, 'muted');
    assert.deepEqual(f.calls.find((c) => c.path.endsWith('set-single-user-permission'))!.body, {
      channelId: '10001',
      memberId: 777,
      permissionMap: { '1': true },
    });
    await f.act('unmute');
    await f.s.jobs.processOnce();
    assert.equal(f.state.muted, false);
    assert.equal((await f.s.binanceMembers.overview(f.group.id, '777')).availability.mute!.available, true);
    await f.act('remove');
    await f.s.jobs.processOnce();
    assert.equal(f.state.targetActive, false);
    assert.deepEqual(f.calls.find((c) => c.path.endsWith('remove-member'))!.body, {
      channelId: '10001',
      uid: '777',
    });
    const view = await f.s.binanceMembers.overview(f.group.id, '777');
    assert(view.actions.every((a) => a.job_status === 'succeeded'));
    assert(view.actions.every((a) => a.receipt.result.member.user_id === '777'));
    assert(!view.availability.remove!.available);
  } finally {
    await f.close();
  }
});
test('Binance platform capability does not grant bridge, ordinary actors, unknown identities, or stale permissions', async () => {
  const f = await fixture();
  try {
    let view = await f.s.binanceMembers.overview(f.group.id, '777');
    assert(view.availability.remove!.available);
    f.state.actorRole = 0;
    view = await f.s.binanceMembers.overview(f.group.id, '777');
    assert(!view.availability.remove!.available);
    await assert.rejects(f.act('remove'));
    f.state.actorRole = 1;
    f.state.wrongUser = true;
    await assert.rejects(f.act('mute'));
    f.state.wrongUser = false;
    await f.s.db.query(
      "UPDATE bindings SET snapshot=jsonb_set(snapshot,'{observed_at}',to_jsonb($2::text)) WHERE conversation_id=$1",
      [f.group.id, new Date(0).toISOString()],
    );
    view = await f.s.binanceMembers.overview(f.group.id, '777');
    assert.match(view.availability.mute!.reason!, /过期/);
    assert.equal(f.state.mutationCount, 0);
    const snapshot = binanceGroup('10001', { group: { id: '10001', name: 'fixture' }, member: { role: 1 } });
    assert(snapshot.capabilities.find((c) => c.capability === 'members.mute')?.state === 'unsupported');
  } finally {
    await f.close();
  }
});
test('Binance protects self, owners, admins and subadmins; request keys and uncertain pending actions cannot duplicate effects', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.act('mute', '123'));
    for (const role of [1, 2, 3]) {
      f.state.targetRole = role;
      await assert.rejects(f.act('remove'));
    }
    f.state.targetRole = 0;
    const key = randomUUID();
    const [a, b] = await Promise.all([f.act('mute', '777', key), f.act('mute', '777', key)]);
    assert.equal(a.id, b.id);
    await assert.rejects(f.act('remove', '777', key), (e: any) => e.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(f.act('remove'), (e: any) => e.code === 'MEMBER_ACTION_PENDING');
    await f.s.jobs.processOnce();
    assert.equal(f.state.mutationCount, 1);
    assert.equal((await f.act('mute', '777', key)).id, a.id);
    assert.equal(f.state.mutationCount, 1);
  } finally {
    await f.close();
  }
});
test('Binance roles and scope changes between submission and execution stop old jobs', async () => {
  const f = await fixture();
  try {
    const action = await f.act('remove');
    f.state.targetRole = 1;
    await f.s.jobs.processOnce();
    assert.equal((await f.jobs()).find((j) => j.id === action.job_id)!.status, 'failed');
    assert.equal(f.state.mutationCount, 0);
    f.state.targetRole = 0;
    await f.act('mute');
    await f.s.db.query('UPDATE accounts SET session_id=$2 WHERE id=$1', [f.account.id, randomUUID()]);
    await f.s.jobs.processOnce();
    assert((await f.jobs()).every((j) => j.status === 'failed'));
    assert.equal(f.state.mutationCount, 0);
  } finally {
    await f.close();
  }
});
test('Binance execution rechecks paid status, actor authority, target role and expected mute state', async () => {
  const f = await fixture();
  try {
    const changes = [
      { actorRole: 0 },
      { actorRole: 2 },
      { targetRole: 2 },
      { targetActive: false },
      { billingFee: 1 },
      { groupOverrides: { billingCycleType: 3 } },
      { groupOverrides: { isVipCommunityGroup: true } },
      { groupOverrides: { billingFee: false } },
      { muted: true },
      { self: '999' },
    ];
    for (const change of changes) {
      Object.assign(f.state, {
        self: '123',
        actorRole: 1,
        targetRole: 0,
        targetActive: true,
        billingFee: 0,
        groupOverrides: {},
        muted: false,
      });
      const action = await f.act('muted' in change ? 'mute' : 'remove');
      Object.assign(f.state, change);
      await f.s.jobs.processOnce();
      assert.equal((await f.jobs()).find((job) => job.id === action.job_id)!.status, 'failed');
      assert.equal(f.state.mutationCount, 0);
      if ('billingFee' in change || (change.groupOverrides && 'billingCycleType' in change.groupOverrides))
        assert.match((await f.jobs()).find((job) => job.id === action.job_id)!.last_error, /付费群/);
      if ('self' in change) assert.equal((await f.s.accounts.get(f.account.id)).status, 'expired');
    }
    Object.assign(f.state, { self: '123', muted: false });
    await f.s.db.query("UPDATE accounts SET status='online' WHERE id=$1", [f.account.id]);
    await f.s.jobs.enqueue({
      key: randomUUID(),
      conversationId: f.group.id,
      action: 'member.remove',
      params: { user_id: '777', reason: 'No manual review reference' },
    });
    await f.s.jobs.processOnce();
    assert((await f.jobs()).every((job) => job.status === 'failed'));
    assert.equal(f.state.mutationCount, 0);
  } finally {
    await f.close();
  }
});
test('Binance publication failures distinguish explicit rejection from unconfirmed state, and never retry', async () => {
  const f = await fixture();
  try {
    f.state.mode = 'reject';
    const rejected = await f.act('mute');
    await f.s.jobs.processOnce();
    const failedJob = (await f.jobs()).find((j) => j.id === rejected.job_id)!;
    assert.equal(failedJob.status, 'failed');
    assert.match(failedJob.last_error, /拒绝.*成员管理请求/);
    const health = (
      await f.s.db.query('SELECT value FROM metadata WHERE key=$1', [`binance-health:${f.account.id}`])
    )[0]?.value;
    assert(!Object.keys(health?.issues ?? {}).some((key) => key.startsWith('member_set_mute:')));
    f.state.mutationCount = 0;
    f.state.mode = 'readback_rejected';
    const unknown = await f.act('mute');
    await f.s.jobs.processOnce();
    const job = (await f.jobs()).find((j) => j.id === unknown.job_id)!;
    assert.equal(job.status, 'unknown');
    assert.equal(job.receipt.error.retryable, false);
    const attempts = f.state.mutationCount;
    await f.s.jobs.processOnce();
    assert.equal(f.state.mutationCount, attempts);
    f.state.mode = 'normal';
    await assert.rejects(f.act('remove'), (e: any) => e.code === 'MEMBER_ACTION_PENDING');
  } finally {
    await f.close();
  }
});
test('Binance final scope fence, wrong IDs, expired requests, and browser transport cannot mutate', async () => {
  const f = protocol();
  for (const mode of ['expired', 'identity', 'target', 'group', 'billing', 'actor', 'disabled', 'guard']) {
    f.state.self = '123';
    f.state.wrongUser = false;
    f.state.wrongGroup = false;
    f.state.actorRole = 1;
    f.state.billingFee = 0;
    if (mode === 'identity') f.state.self = '999';
    if (mode === 'target') f.state.wrongUser = true;
    if (mode === 'group') f.state.wrongGroup = true;
    if (mode === 'billing') f.state.billingFee = 1;
    if (mode === 'actor') f.state.actorRole = 0;
    const client = f.make(
      mode === 'guard'
        ? async () => {
            throw new Error('Cancelled by server fence');
          }
        : undefined,
      mode !== 'disabled',
    );
    try {
      await assert.rejects(
        f.request(client, mode === 'billing' ? 'member_remove' : 'member_set_mute', {
          muted: true,
          expected_muted: false,
          ...(mode === 'expired' ? { not_after: Date.now() - 1 } : {}),
        }),
      );
    } finally {
      client.close();
    }
    assert.equal(f.state.mutationCount, 0);
  }
});
test('Binance network loss, read-back mismatch and rejected read-back after mutation remain unknown', async () => {
  for (const mode of ['network_after', 'no_change', 'readback_rejected']) {
    const f = protocol(),
      client = f.make();
    f.state.mode = mode;
    try {
      await assert.rejects(
        f.request(client, 'member_set_mute', { muted: true, expected_muted: false }),
        (error: any) => error.bridgeError?.effect === 'possible',
      );
      assert.equal(f.state.mutationCount, 1);
    } finally {
      client.close();
    }
  }
});
test('Binance paid groups allow mute and unmute but never use a member removal or payment endpoint', async () => {
  const f = await fixture();
  try {
    f.state.billingFee = 1;
    await f.s.accounts.refresh(f.account.id, 'test');
    const view = await f.s.binanceMembers.overview(f.group.id, '777');
    assert.equal(view.paid_group, true);
    assert(view.availability.mute!.available);
    assert(!view.availability.remove!.available);
    assert.match(view.availability.remove!.reason!, /付费/);
    await f.act('mute');
    await f.s.jobs.processOnce();
    await f.act('unmute');
    await f.s.jobs.processOnce();
    await assert.rejects(f.act('remove'));
    assert.equal(f.state.mutationCount, 2);
    assert(!f.calls.some((c) => c.path.endsWith('remove-member')));
  } finally {
    await f.close();
  }
});
test('Binance malformed or absent billing metadata never grants removal or reaches member mutations', async () => {
  const invalid = [undefined, null, false, true, '', ' ', '-1', [], {}, NaN, Infinity, -1];
  const overrides = [
    ...['billingCycleType', 'billingFee'].flatMap((key) => invalid.map((value) => ({ [key]: value }))),
    { billingCycleType: 0.5 },
    { isVipCommunityGroup: undefined },
    { isVipCommunityGroup: null },
    { isVipCommunityGroup: 1 },
    { disbanded: 'false' },
  ];
  for (const group of overrides) {
    const p = protocol(),
      client = p.make();
    p.state.groupOverrides = group;
    try {
      await assert.rejects(p.request(client, 'member_remove'));
      await assert.rejects(p.request(client, 'member_set_mute', { muted: true, expected_muted: false }));
      assert.equal(p.state.mutationCount, 0);
      const raw = await p.request(client, 'group');
      try {
        const snapshot = binanceGroup('10001', raw, true, '123');
        assert.notEqual(
          snapshot.permissions.find((v) => v.capability === 'members.remove')?.permission,
          'granted',
        );
      } catch (error: any) {
        // Malformed boolean group flags are rejected by the group response schema itself.
        if (error instanceof assert.AssertionError) throw error;
        assert.equal(error.code, 'BINANCE_RESPONSE_FORMAT');
      }
    } finally {
      client.close();
    }
  }
  for (const group of [
    { billingCycleType: '0', billingFee: '0.00' },
    { billingCycleType: '3', billingFee: '0' },
  ]) {
    const p = protocol(),
      client = p.make();
    p.state.groupOverrides = group;
    try {
      const raw = await p.request(client, 'group');
      const snapshot = binanceGroup('10001', raw, true, '123');
      assert.equal(snapshot.permissions.find((v) => v.capability === 'members.mute')?.permission, 'granted');
      if (group.billingCycleType === '3') {
        await assert.rejects(p.request(client, 'member_remove'));
        assert.equal(
          snapshot.permissions.find((v) => v.capability === 'members.remove')?.permission,
          'denied',
        );
      } else {
        await p.request(client, 'member_remove');
        assert.equal(p.state.mutationCount, 1);
      }
    } finally {
      client.close();
    }
  }
});
test('Binance member endpoint authentication failures guide re-login without disguising a possible effect', async () => {
  for (const mode of ['auth_preflight', 'auth_mutation', 'auth_readback']) {
    const f = await fixture();
    try {
      const action = await f.act('mute');
      f.state.mode = mode;
      await f.s.jobs.processOnce();
      const job = (await f.jobs()).find((v) => v.id === action.job_id)!;
      assert.equal(job.status, mode === 'auth_readback' ? 'unknown' : 'failed');
      assert.equal(job.receipt.error.retryable, false);
      const account = await f.s.accounts.get(f.account.id);
      assert.equal(account.status, 'expired');
      assert.match(account.last_error, /重新登录/);
      assert.equal(f.state.mutationCount, mode === 'auth_preflight' ? 0 : 1);
    } finally {
      await f.close();
    }
  }
});
test('Binance direct error wrapping preserves possible effects even for typed conflict errors', async () => {
  const f = await fixture();
  try {
    const action = await f.act('mute');
    f.s.binance.direct.close();
    f.s.binance.direct = new BinanceDirect(f.s.db, f.s.box, (_credentials, guard) => {
      const client = f.make(() => guard('10001'));
      return {
        ...client,
        request: async (message) => {
          const result = await client.request(message);
          if (message.operation === 'member_set_mute')
            throw Object.assign(new ApiError(409, 'CONFLICT_AFTER_WRITE', 'Read-back conflict'), {
              bridgeError: { effect: 'possible' },
            });
          return result;
        },
      };
    });
    await f.s.jobs.processOnce();
    const job = (await f.jobs()).find((v) => v.id === action.job_id)!;
    assert.equal(f.state.mutationCount, 1);
    assert.equal(job.status, 'unknown');
    assert.equal(job.receipt.error.retryable, false);
    await assert.rejects(f.act('remove'), (e: any) => e.code === 'MEMBER_ACTION_PENDING');
  } finally {
    await f.close();
  }
});
test('Binance scope cancellation during native preflight cannot reach the mutation endpoint', async () => {
  const f = await fixture();
  try {
    await f.act('remove');
    f.state.hook = async (path, body) => {
      if (path.endsWith('get-member-info') && body.uid === 777)
        await f.s.db.query(
          "UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[]'::jsonb) WHERE id=$1",
          [f.account.id],
        );
    };
    await f.s.jobs.processOnce();
    assert.equal((await f.jobs())[0]!.status, 'failed');
    assert.equal(f.state.mutationCount, 0);
  } finally {
    await f.close();
  }
});
test('Binance member jobs cannot redirect to a different selected group through a changed binding', async () => {
  const f = await fixture();
  try {
    await f.s.db.query(
      'UPDATE accounts SET settings=jsonb_set(settings,\'{group_ids}\',\'["10001","999"]\'::jsonb) WHERE id=$1',
      [f.account.id],
    );
    const action = await f.act('remove');
    await f.s.db.query('UPDATE bindings SET external_id=$2 WHERE conversation_id=$1', [f.group.id, '999']);
    f.state.groupOverrides = { id: '999' };
    await f.s.jobs.processOnce();
    const job = (await f.jobs()).find((v) => v.id === action.job_id)!;
    assert.equal(job.status, 'failed');
    assert.equal(job.receipt.error.code, 'BINANCE_MEMBER_CONTEXT_CHANGED');
    assert.equal(f.state.mutationCount, 0);
  } finally {
    await f.close();
  }
});
test('Binance HTTP management rejects anonymous, project tokens, missing CSRF and missing idempotency', async () => {
  const f = await fixture(),
    app = await createHttpApp(f.s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1',
      path = `/conversations/${f.group.id}/binance-member-actions`;
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 401);
    const project = await f.s.features.createProject(
      {
        name: 'Fixture project',
        conversation_ids: [f.group.id],
        scopes: ['conversations.read', 'messages.send'],
      },
      'test',
    );
    assert.equal(
      (
        await fetch(base + `/conversations/${f.group.id}/binance-members`, {
          headers: { authorization: `Bearer ${project.key}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + path, {
          method: 'POST',
          headers: { authorization: `Bearer ${project.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ user_id: '777', action: 'remove', reason: 'Unauthorized project' }),
        })
      ).status,
      403,
    );
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'binance-test', password: 'binance-test-password' }),
    });
    const auth = (await setup.json()) as any;
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const body = JSON.stringify({ user_id: '777', action: 'mute', reason: 'Fixture' }),
      headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': auth.csrf };
    assert.equal(
      (
        await fetch(base + path, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body,
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + path, { method: 'POST', headers, body })).status, 400);
    const good = await fetch(base + path, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      body,
    });
    assert.equal(good.status, 200);
    assert.equal(f.state.mutationCount, 0);
  } finally {
    await app.close();
    await f.close();
  }
});
