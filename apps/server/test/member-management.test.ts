import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { createHttpApp } from '../src/http.ts';

async function fixture() {
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const state = {
    chatType: 'supergroup',
    mutationResponse: null as any,
    wrongIdentity: false,
    hook: null as null | ((action: string, params: any) => Promise<void>),
  };
  const members = new Map<string, any>([
    [
      '12345',
      {
        status: 'administrator',
        can_restrict_members: true,
        can_delete_messages: true,
        user: { id: 12345, is_bot: true },
      },
    ],
    ['200', { status: 'administrator', can_restrict_members: true, user: { id: 200 } }],
    ['777', { status: 'member', user: { id: 777 } }],
    ['778', { status: 'member', user: { id: 778 } }],
  ]);
  const calls: { action: string; params: any }[] = [];
  let next = 1000;
  s.adapters.telegram = async (_account, action, params: any = {}) => {
    calls.push({ action, params });
    await state.hook?.(action, params);
    let result: any;
    if (action === 'getMe')
      result = { id: state.wrongIdentity ? 54321 : 12345, username: 'Fixture_bot', first_name: 'Fixture' };
    else if (action === 'getWebhookInfo') result = { url: '' };
    else if (action === 'getChat')
      result = { id: params.chat_id, title: 'Fixture group', type: state.chatType };
    else if (action === 'getChatMember')
      result = members.get(String(params.user_id)) ?? {
        status: 'left',
        user: { id: Number(params.user_id) },
      };
    else if (action === 'getChatMemberCount') result = 10;
    else if (action === 'sendMessage') result = { message_id: next++ };
    else if (['restrictChatMember', 'banChatMember'].includes(action)) {
      if (state.mutationResponse) return state.mutationResponse;
      result = true;
    } else throw Error('Unexpected fixture action ' + action);
    return { status: 200, data: { ok: true, result } };
  };
  const created = await s.accounts.create(
    { kind: 'telegram', name: 'Fixture bot', token: 'local-fixture' },
    'test',
  );
  await s.accounts.refresh(created.id, 'test');
  const group = await s.accounts.addTelegramGroup(created.id, { external_id: '-10012345' }, 'test');
  const account = await s.accounts.get(created.id);
  const web = { source: 'web' as const, id: 'admin-test', name: 'Fixture admin' };
  const act = (action: string, user = '777', key = randomUUID(), extra: any = {}) =>
    s.members.act(
      group.id,
      {
        user_id: user,
        action,
        reason: 'Fixture reason',
        ...(action === 'mute' ? { duration_seconds: 600 } : {}),
        ...extra,
      },
      key,
      web,
    );
  const jobs = () =>
    s.db.query('SELECT * FROM jobs WHERE conversation_id=$1 ORDER BY created_at,id', [group.id]);
  const command = (text: string, id = 1, actor = 200, extra: any = {}) => ({
    update_id: id,
    message: {
      message_id: 500 + id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: -10012345, type: 'supergroup' },
      from: { id: actor },
      text,
      reply_to_message: { message_id: 123, chat: { id: -10012345 }, from: { id: 777 } },
      ...extra,
    },
  });
  return { s, state, members, calls, group, account, act, jobs, command, close: () => s.close() };
}

test('Telegram manual mute uses bounded independent permissions and confirmed receipts', async () => {
  const f = await fixture();
  try {
    const view = await f.s.members.overview(f.group.id);
    assert.equal(view.availability.mute!.available, true);
    assert.equal(view.commands_enabled, false);
    const action = await f.act('mute');
    assert.equal(action.status, 'pending');
    assert(action.job_id);
    await f.s.jobs.processOnce();
    const job = (await f.jobs())[0]!;
    assert.equal(job.status, 'succeeded');
    const call = f.calls.find((c) => c.action === 'restrictChatMember')!;
    assert(call);
    assert.equal(call.params.use_independent_chat_permissions, true);
    assert.equal(call.params.permissions.can_send_messages, false);
    assert(call.params.until_date > Math.floor(Date.now() / 1000) + 550);
    assert.equal(call.params.until_date, job.review_ref.until_date);
    const overview = await f.s.members.overview(f.group.id);
    assert.equal(overview.actions[0]!.job_status, 'succeeded');
    await assert.rejects(f.act('mute', '778', randomUUID(), { duration_seconds: 20 }));
    await assert.rejects(f.act('mute', '778', randomUUID(), { duration_seconds: 367 * 86400 }));
  } finally {
    await f.close();
  }
});

test('Warnings are group-scoped, idempotent, counted accurately and cleared without erasing history', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const [a, b] = await Promise.all([f.act('warn', '777', key), f.act('warn', '777', key)]);
    assert.equal(a.id, b.id);
    assert.equal(a.warning_count, 1);
    assert.equal((await f.jobs()).length, 0);
    const c = await f.act('warn');
    assert.equal(c.warning_count, 2);
    await assert.rejects(f.act('warn', '778', key), (e: any) => e.code === 'IDEMPOTENCY_CONFLICT');
    const other = await f.s.accounts.addTelegramGroup(f.account.id, { external_id: '-10099999' }, 'test');
    assert.equal((await f.s.members.overview(other.id, '777')).selected_warning_count, 0);
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 2);
    await f.act('clearwarnings');
    const view = await f.s.members.overview(f.group.id, '777');
    assert.equal(view.selected_warning_count, 0);
    assert.equal(view.actions.filter((a) => a.action === 'warn').length, 2);
    assert(view.actions.filter((a) => a.action === 'warn').every((a) => !a.warning_active));
  } finally {
    await f.close();
  }
});

test('Management protects admins, owner, bots, existing restrictions and uncertain identities', async () => {
  const f = await fixture();
  try {
    for (const target of [
      { status: 'creator', user: { id: 777 } },
      { status: 'administrator', user: { id: 777 } },
      { status: 'member', user: { id: 777, is_bot: true } },
    ]) {
      f.members.set('777', target);
      await assert.rejects(f.act('ban'), (e: any) => e.code === 'TG_TARGET_PROTECTED');
    }
    f.members.set('777', { status: 'restricted', is_member: true, user: { id: 777 } });
    await assert.rejects(f.act('mute'), (e: any) => e.code === 'TG_EXISTING_RESTRICTION');
    f.members.set('777', { status: 'member', user: { id: 999 } });
    await assert.rejects(f.act('warn'), (e: any) => e.code === 'TG_MEMBER_LOOKUP');
    f.members.set('777', { status: 'member', user: { id: 777 } });
    f.state.wrongIdentity = true;
    await assert.rejects(f.act('ban'), (e: any) => e.code === 'TG_IDENTITY_CHANGED');
    assert.equal((await f.jobs()).length, 0);
    assert(!f.calls.some((c) => c.action === 'banChatMember' || c.action === 'restrictChatMember'));
  } finally {
    await f.close();
  }
});

test('Basic groups, stale snapshots, offline accounts and disabled sync never submit unsupported mute', async () => {
  const f = await fixture();
  try {
    f.state.chatType = 'group';
    await f.s.accounts.refresh(f.account.id, 'test');
    assert.equal((await f.s.members.overview(f.group.id)).availability.mute!.available, false);
    await assert.rejects(f.act('mute'), (e: any) => e.code === 'CAPABILITY_UNAVAILABLE');
    f.state.chatType = 'supergroup';
    await f.s.accounts.refresh(f.account.id, 'test');
    await f.s.db.query("UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[]') WHERE id=$1", [
      f.account.id,
    ]);
    await assert.rejects(f.act('ban'), (e: any) => e.code === 'ACCOUNT_OFFLINE');
    assert.equal((await f.jobs()).length, 0);
  } finally {
    await f.close();
  }
});

test('Group commands are opt-in, reply-scoped, ignore other bots and exclude ordinary/anonymous senders', async () => {
  const f = await fixture();
  try {
    await f.s.members.handleUpdate(f.account, f.command('/warn fixture'));
    assert.equal((await f.jobs()).length, 0);
    await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
    await f.s.members.handleUpdate(f.account, f.command('/ban@Another_bot reason', 2));
    await f.s.members.handleUpdate(f.account, f.command('/ban reason', 3, 777));
    await f.s.members.handleUpdate(
      f.account,
      f.command('/ban reason', 4, 200, { sender_chat: { id: -10012345 } }),
    );
    assert.equal((await f.jobs()).length, 0);
    await f.s.members.handleUpdate(
      f.account,
      f.command('/ban malformed timestamp', 7, 200, { date: undefined }),
    );
    assert.equal((await f.jobs()).length, 0);
    const warn = f.command('/warn@fixture_bot repeated advertising', 5);
    await f.s.members.handleUpdate(f.account, warn);
    await f.s.members.handleUpdate(f.account, warn);
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 1);
    assert.equal((await f.jobs()).length, 1);
    assert((await f.jobs())[0]!.params.segments[0].text.includes('原因：repeated advertising'));
    await f.s.members.handleUpdate(
      f.account,
      f.command('/ban bad reply', 6, 200, {
        reply_to_message: { chat: { id: -10099999 }, from: { id: 777 } },
      }),
    );
    assert(!(await f.jobs()).some((j) => j.action === 'member.ban'));
    assert((await f.s.members.overview(f.group.id)).actions.some((a) => a.action === 'command_rejected'));
  } finally {
    await f.close();
  }
});

test('Admin commands enforce actor privileges again before mutation and stop when disabled', async () => {
  const f = await fixture();
  try {
    await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
    await f.s.members.handleUpdate(f.account, f.command('/mute 10m advertising'));
    const job = (await f.jobs()).find((j) => j.action === 'member.mute')!;
    assert(job);
    f.members.set('200', { status: 'member', user: { id: 200 } });
    await f.s.jobs.processOnce();
    const after = (await f.jobs()).find((j) => j.id === job.id)!;
    assert.equal(after.status, 'failed');
    assert.equal(after.receipt.error.code, 'TG_ACTOR_PERMISSION');
    assert(!f.calls.some((c) => c.action === 'restrictChatMember'));
    f.members.set('200', { status: 'administrator', can_restrict_members: true, user: { id: 200 } });
    await f.s.members.handleUpdate(f.account, f.command('/ban spam', 2));
    await f.s.members.settings(f.group.id, { commands_enabled: false }, 'test');
    for (let i = 0; i < 4; i++) await f.s.jobs.processOnce();
    assert(!f.calls.some((c) => c.action === 'banChatMember' || c.action === 'restrictChatMember'));
    assert((await f.jobs()).some((j) => j.status === 'cancelled'));
  } finally {
    await f.close();
  }
});

test('Expired, paused and changed membership requests stop without platform mutation', async () => {
  for (const change of ['expired', 'paused', 'membership']) {
    const f = await fixture();
    try {
      if (change === 'membership')
        await f.s.db.query(
          "INSERT INTO memberships(conversation_id,user_id,membership_id,status,source_at) VALUES($1,'777','episode1','active',now())",
          [f.group.id],
        );
      const action = await f.act('ban');
      if (change === 'expired')
        await f.s.db.query(
          "UPDATE jobs SET review_ref=jsonb_set(review_ref,'{expires_at}',to_jsonb('2020-01-01T00:00:00Z'::text)) WHERE id=$1",
          [action.job_id],
        );
      if (change === 'paused')
        await f.s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [f.account.id]);
      if (change === 'membership')
        await f.s.db.query("UPDATE memberships SET membership_id='episode2' WHERE conversation_id=$1", [
          f.group.id,
        ]);
      await f.s.jobs.processOnce();
      assert.equal((await f.jobs())[0]!.status, 'failed');
      assert(!f.calls.some((c) => c.action === 'banChatMember'));
    } finally {
      await f.close();
    }
  }
});

test('Unknown Telegram mutation receipts remain uncertain and block a second conflicting request', async () => {
  for (const response of [
    { status: 500, data: { ok: true, result: true } },
    { status: 200, data: { ok: true, result: false } },
    { status: 200, data: { ok: false, error_code: 500 } },
  ]) {
    const f = await fixture();
    try {
      f.state.mutationResponse = response;
      await f.act('ban');
      await f.s.jobs.processOnce();
      assert.equal((await f.jobs())[0]!.status, 'unknown');
      await assert.rejects(f.act('mute'), (e: any) => e.code === 'MEMBER_ACTION_PENDING');
      assert.equal(await f.s.jobs.processOnce(), false);
      assert.equal(f.calls.filter((c) => c.action === 'banChatMember').length, 1);
    } finally {
      await f.close();
    }
  }
});

test('HTTP member management requires admin authentication, CSRF and idempotency', async () => {
  const f = await fixture();
  const app = await createHttpApp(f.s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const path = `/conversations/${f.group.id}/member-actions`;
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 401);
    const project = await f.s.features.createProject(
      {
        name: 'Fixture project',
        conversation_ids: [f.group.id],
        scopes: ['conversations.read', 'messages.send'],
      },
      'test',
    );
    for (const [url, method, body] of [
      [`/conversations/${f.group.id}/member-management`, 'GET', undefined],
      [`/conversations/${f.group.id}/member-management`, 'PUT', '{"commands_enabled":true}'],
      [path, 'POST', '{"user_id":"777","action":"ban","reason":"Fixture"}'],
    ])
      assert.equal(
        (
          await fetch(base + url, {
            method,
            headers: {
              authorization: `Bearer ${project.key}`,
              'content-type': 'application/json',
              'idempotency-key': randomUUID(),
            },
            body,
          })
        ).status,
        403,
      );
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member-test', password: 'member-test-password' }),
    });
    const auth = (await setup.json()) as any;
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const body = JSON.stringify({ user_id: '777', action: 'warn', reason: 'Fixture' });
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
    const headers = {
      cookie,
      'x-csrf-token': auth.csrf,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    };
    assert.equal(
      (
        await fetch(base + `/conversations/${f.group.id}/member-management`, {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: '{"commands_enabled":true}',
        })
      ).status,
      403,
    );
    const first = await fetch(base + path, { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    const a = (await first.json()) as any;
    const second = await fetch(base + path, { method: 'POST', headers, body });
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as any).id, a.id);
    const view = await fetch(base + `/conversations/${f.group.id}/member-management?user_id=777`, {
      headers,
    });
    assert.equal(view.status, 200);
    assert.equal(((await view.json()) as any).selected_warning_count, 1);
    assert.equal(
      (await fetch(base + path, { method: 'POST', headers: { ...headers, 'idempotency-key': '' }, body }))
        .status,
      400,
    );
  } finally {
    await app.close();
    await f.close();
  }
});

test('A pause during Telegram permission reads is checked again immediately before mutation', async () => {
  const f = await fixture();
  try {
    await f.act('mute');
    f.state.hook = async (action) => {
      if (action === 'getChat')
        await f.s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [f.account.id]);
    };
    await f.s.jobs.processOnce();
    const job = (await f.jobs())[0]!;
    assert.equal(job.status, 'failed');
    assert.equal(job.receipt.error.code, 'ACCOUNT_OFFLINE');
    assert(!f.calls.some((c) => c.action === 'restrictChatMember'));
  } finally {
    await f.close();
  }
});

test('Worker polling ingests a scoped admin command once and advances the Telegram cursor', async () => {
  const f = await fixture();
  try {
    await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
    const call = f.s.adapters.telegram.bind(f.s.adapters);
    let delivered = false;
    f.s.adapters.telegram = async (account, action, params) =>
      action === 'getUpdates'
        ? {
            status: 200,
            data: {
              ok: true,
              result: delivered ? [] : ((delivered = true), [f.command('/mute 5m flood', 90)]),
            },
          }
        : call(account, action, params);
    await (f.s.worker as any).poll();
    await (f.s.worker as any).poll();
    assert.equal((await f.jobs()).filter((j) => j.action === 'member.mute').length, 1);
    assert.equal((await f.s.accounts.get(f.account.id)).cursor, '91');
    assert.equal((await f.s.features.group(f.group.id)).messages.length, 1);
  } finally {
    await f.close();
  }
});

test('A determinate Telegram rejection displays failure instead of success or uncertainty', async () => {
  const f = await fixture();
  try {
    f.state.mutationResponse = { status: 403, data: { ok: false, error_code: 403 } };
    await f.act('ban');
    await f.s.jobs.processOnce();
    const job = (await f.jobs())[0]!;
    assert.equal(job.status, 'failed');
    assert.equal(job.receipt.error.code, 'TELEGRAM_REJECTED');
    assert.equal(f.calls.filter((c) => c.action === 'banChatMember').length, 1);
  } finally {
    await f.close();
  }
});

test('Rejected, disabled and unprivileged commands never become executable after redelivery', async () => {
  const f = await fixture();
  try {
    const disabled = f.command('/warn disabled', 101);
    await f.s.members.handleUpdate(f.account, disabled);
    await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
    await f.s.members.handleUpdate(f.account, disabled);
    const unprivileged = f.command('/warn ordinary sender', 102, 778);
    await f.s.members.handleUpdate(f.account, unprivileged);
    f.members.set('778', { status: 'administrator', user: { id: 778 } });
    await f.s.members.handleUpdate(f.account, unprivileged);
    f.members.set('777', { status: 'administrator', user: { id: 777 } });
    const rejected = f.command('/ban protected target', 103);
    await f.s.members.handleUpdate(f.account, rejected);
    f.members.set('777', { status: 'member', user: { id: 777 } });
    await f.s.members.handleUpdate(f.account, rejected);
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 0);
    assert.equal((await f.jobs()).filter((j) => j.action === 'member.ban').length, 0);
    assert.equal((await f.s.members.overview(f.group.id)).actions.length, 1);
    const fresh = f.command('/warn new command', 104);
    await Promise.all([
      f.s.members.handleUpdate(f.account, fresh),
      f.s.members.handleUpdate(f.account, fresh),
    ]);
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 1);
  } finally {
    await f.close();
  }
});

test('Disabling then re-enabling commands cancels queued jobs and stops mutations already in preflight', async () => {
  const f = await fixture();
  try {
    await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
    await f.s.members.handleUpdate(f.account, f.command('/ban queued', 110));
    await f.s.members.settings(f.group.id, { commands_enabled: false }, 'test');
    await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
    assert((await f.jobs()).every((j) => j.status === 'cancelled'));
    await f.s.members.handleUpdate(f.account, f.command('/mute 10m in preflight', 111));
    f.state.hook = async (action) => {
      if (action === 'getChat') {
        await f.s.members.settings(f.group.id, { commands_enabled: false }, 'test');
        await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
      }
    };
    await f.s.jobs.processOnce();
    const mute = (await f.jobs()).find((j) => j.action === 'member.mute')!;
    assert.equal(mute.status, 'failed');
    assert.equal(mute.receipt.error.code, 'TG_COMMANDS_CHANGED');
    assert(!f.calls.some((c) => ['restrictChatMember', 'banChatMember'].includes(c.action)));
  } finally {
    await f.close();
  }
});

test('A sync scope revision change during preflight cannot revive an old member action', async () => {
  const f = await fixture();
  try {
    await f.act('mute');
    f.state.hook = async (action) => {
      if (action === 'getChat')
        await f.s.db.query(
          "UPDATE accounts SET settings=jsonb_set(settings,'{group_revision}',to_jsonb('new-selection'::text)) WHERE id=$1",
          [f.account.id],
        );
    };
    await f.s.jobs.processOnce();
    const mute = (await f.jobs())[0]!;
    assert.equal(mute.status, 'failed');
    assert.equal(mute.receipt.error.code, 'GROUP_SCOPE_CHANGED');
    assert(!f.calls.some((c) => c.action === 'restrictChatMember'));
  } finally {
    await f.close();
  }
});

test('Commands received before a settings change cannot enter a newly enabled command session', async () => {
  const f = await fixture();
  try {
    await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
    let changed = false;
    f.state.hook = async (action) => {
      if (action === 'getMe' && !changed) {
        changed = true;
        await f.s.members.settings(f.group.id, { commands_enabled: false }, 'test');
        await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
      }
    };
    await f.s.members.handleUpdate(f.account, f.command('/warn interrupted command', 115));
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 0);
    const records = (await f.s.members.overview(f.group.id)).actions;
    assert.equal(records.length, 1);
    assert.equal(records[0]!.action, 'command_rejected');
    assert(!(await f.jobs()).some((j) => j.action === 'member.mute' || j.action === 'member.ban'));
    f.state.hook = null;
    await f.s.members.handleUpdate(f.account, f.command('/warn fresh session', 116));
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 1);
  } finally {
    await f.close();
  }
});

test('Bot and command actor must have the exact permissions for each management action', async () => {
  const f = await fixture();
  try {
    f.members.set('12345', { status: 'member', user: { id: 12345, is_bot: true } });
    for (const action of ['warn', 'warnings', 'clearwarnings', 'mute', 'ban'])
      await assert.rejects(f.act(action), (e: any) => e.code === 'TG_BOT_PERMISSION');
    f.members.set('12345', {
      status: 'administrator',
      can_restrict_members: false,
      user: { id: 12345, is_bot: true },
    });
    for (const action of ['mute', 'ban'])
      await assert.rejects(f.act(action), (e: any) => e.code === 'TG_BOT_PERMISSION');
    await f.act('warn');
    f.members.set('12345', {
      status: 'administrator',
      can_restrict_members: true,
      user: { id: 12345, is_bot: true },
    });
    f.members.set('200', { status: 'administrator', can_restrict_members: false, user: { id: 200 } });
    await f.s.members.settings(f.group.id, { commands_enabled: true }, 'test');
    await f.s.members.handleUpdate(f.account, f.command('/mute 10m missing rights', 120));
    await f.s.members.handleUpdate(f.account, f.command('/ban missing rights', 121));
    await f.s.members.handleUpdate(f.account, f.command('/warn permitted', 122));
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 2);
    assert(!(await f.jobs()).some((j) => ['member.mute', 'member.ban'].includes(j.action)));
    f.members.set('200', { status: 'creator', user: { id: 200 } });
    await f.s.members.handleUpdate(f.account, f.command('/ban owner permitted', 123));
    assert((await f.jobs()).some((j) => j.action === 'member.ban'));
  } finally {
    await f.close();
  }
});

test('Queued punishments stop if the bot loses rights or a target becomes protected', async () => {
  for (const change of ['bot', 'target', 'identity']) {
    const f = await fixture();
    try {
      await f.act('ban');
      if (change === 'bot')
        f.members.set('12345', {
          status: 'administrator',
          can_restrict_members: false,
          user: { id: 12345, is_bot: true },
        });
      if (change === 'target') f.members.set('777', { status: 'administrator', user: { id: 777 } });
      if (change === 'identity') f.state.wrongIdentity = true;
      await f.s.jobs.processOnce();
      const job = (await f.jobs())[0]!;
      assert.equal(job.status, 'failed');
      assert.equal(
        job.receipt.error.code,
        { bot: 'TG_BOT_PERMISSION', target: 'TG_TARGET_PROTECTED', identity: 'TG_IDENTITY_CHANGED' }[change],
      );
      assert(!f.calls.some((c) => c.action === 'banChatMember'));
    } finally {
      await f.close();
    }
  }
});
