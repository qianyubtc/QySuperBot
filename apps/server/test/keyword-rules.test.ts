import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { groupSnapshot } from '../src/adapters.ts';
import { keywordRuleInput, matchedKeyword } from '../src/keyword-rules.ts';
import { createHttpApp } from '../src/http.ts';
import { defaultPolicy } from '../src/inputs.ts';
import { testPng } from './image-fixture.ts';
import { keywordRulePayload } from '../../admin/src/keyword-form.ts';

async function fixture(kind: 'telegram' | 'qq' | 'binance' = 'telegram') {
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const external = kind === 'telegram' ? '-10012345' : '67890';
  const created = await s.accounts.create(
    {
      kind,
      name: 'Keyword fixture',
      ...(kind === 'telegram'
        ? { token: 'fixture-token' }
        : kind === 'qq'
          ? { endpoint: 'https://example.com' }
          : { group_ids: [external] }),
    },
    'test',
  );
  await s.db.query(
    "UPDATE accounts SET status='online',external_id='12345',session_id='fixture-session',settings=$2::jsonb WHERE id=$1",
    [
      created.id,
      JSON.stringify({
        group_ids: [external],
        group_revision: 'fixture-scope',
        ...(kind === 'binance' ? { transport: 'direct' } : {}),
      }),
    ],
  );
  const account = await s.accounts.get(created.id);
  const snapshot = {
    ...groupSnapshot(external, 'Keyword fixture group', 'group', 10, kind, true),
    observed_at: new Date().toISOString(),
  };
  if (kind === 'telegram') {
    snapshot.capabilities.push({ capability: 'members.mute', state: 'supported' });
    snapshot.permissions.push({ capability: 'members.mute', permission: 'granted' });
  }
  const groupId = await s.accounts.upsertGroup(account, snapshot);
  const group = await s.features.group(groupId);
  const state = {
    role: 'member',
    botAdmin: true,
    identity: '12345',
    muted: 0,
    joinTime: Math.floor(Date.now() / 1000) - 3600,
    unknown: false,
    reject: false,
    hook: null as null | (() => Promise<void>),
  };
  const mutations: { action: string; params: any; image?: unknown }[] = [];
  let next = 100;
  s.adapters.telegram = async (_account, action, params: any = {}, image) => {
    if (action === 'getMe')
      return { status: 200, data: { ok: true, result: { id: Number(state.identity) } } };
    if (action === 'getChat')
      return { status: 200, data: { ok: true, result: { id: external, type: 'supergroup' } } };
    if (action === 'getChatMember') {
      const self = String(params.user_id) === '12345';
      const hook = state.hook;
      state.hook = null;
      if (!self) await hook?.();
      if (state.unknown) return { status: 503, data: {} };
      return {
        status: 200,
        data: {
          ok: true,
          result: {
            user: { id: Number(params.user_id), is_bot: self || state.role === 'bot' },
            status: self
              ? state.botAdmin
                ? 'administrator'
                : 'member'
              : state.muted
                ? 'restricted'
                : state.role === 'admin'
                  ? 'administrator'
                  : state.role === 'owner'
                    ? 'creator'
                    : 'member',
            can_restrict_members: self && state.botAdmin,
            is_member: true,
          },
        },
      };
    }
    mutations.push({ action, params, image });
    if (state.unknown) throw Error('Unconfirmed fixture result');
    if (state.reject) return { status: 200, data: { ok: false, error_code: 403 } };
    return {
      status: 200,
      data: {
        ok: true,
        result: ['sendMessage', 'sendPhoto'].includes(action) ? { message_id: next++ } : true,
      },
    };
  };
  s.adapters.qq = async (_account, action, params: any = {}) => {
    if (action === 'get_login_info')
      return { status: 200, data: { retcode: 0, data: { user_id: Number(state.identity) } } };
    if (action === 'get_group_member_list') {
      const hook = state.hook;
      state.hook = null;
      await hook?.();
      return {
        status: 200,
        data: {
          retcode: 0,
          data: state.unknown
            ? []
            : ['12345', '777', '778'].map((id) => ({
                group_id: external,
                user_id: id,
                role: id === '12345' ? (state.botAdmin ? 'admin' : 'member') : state.role,
                join_time: state.joinTime,
                shut_up_timestamp: state.muted,
              })),
        },
      };
    }
    if (action === 'get_group_member_info') return { status: 200, data: { retcode: 1404, status: 'failed' } };
    mutations.push({ action, params });
    if (state.unknown) throw Error('Unconfirmed fixture result');
    return {
      status: 200,
      data: state.reject
        ? { retcode: 1403, status: 'failed' }
        : { retcode: 0, data: action === 'send_group_msg' ? { message_id: next++ } : {} },
    };
  };
  s.binance.request = async (_account, action, params) => {
    if (action === 'member_check')
      return {
        group_id: external,
        actor: { user_id: state.identity, active: true, role: 1 },
        target: { user_id: '777', active: true, role: state.role === 'member' ? 0 : 1 },
      };
    mutations.push({ action, params });
    if (state.unknown) throw Error('Unconfirmed fixture result');
    return { message_id: String(next++) };
  };
  const ruleInput = (extra: any = {}) => ({
    name: 'Keyword fixture rule',
    keywords: ['帮助'],
    action: 'reply',
    response: '这是帮助内容',
    mode: 'enforce',
    ...extra,
  });
  const save = (extra: any = {}) => s.keywords.save(group.id, undefined, ruleInput(extra), 'test');
  const incoming = async (text = '请发帮助', extra: any = {}, eventExtra: any = {}, historical = false) => {
    const event = {
      schema_version: '1',
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      source: { connector_id: account.id, account_id: account.id, conversation_id: external },
      type: 'message.created',
      data: {
        message_id: String(next++),
        sender_id: '777',
        direction: 'incoming',
        segments: [{ type: 'text', text }],
        ...extra,
      },
      ...eventExtra,
    };
    await s.messages.ingest(account, event, 'Keyword member', historical);
    return event;
  };
  const hits = async () => (await s.keywords.overview(group.id)).hits;
  const job = async () =>
    (
      await s.db.query(
        "SELECT * FROM jobs WHERE review_ref->>'purpose'='keyword' ORDER BY created_at DESC,id DESC",
      )
    )[0]!;
  return {
    s,
    state,
    mutations,
    account,
    group,
    save,
    incoming,
    hits,
    job,
    ruleInput,
    close: () => s.close(),
  };
}

test('keyword matching normalizes text, distinguishes exact matches and validates usable rules', () => {
  assert.equal(
    matchedKeyword({ match: 'contains', keywords: ['HELLO'] }, 'ｈｅ\u200blｌｏ everyone'),
    'HELLO',
  );
  assert.equal(matchedKeyword({ match: 'exact', keywords: ['帮助'] }, ' 帮助 '), '帮助');
  assert.equal(matchedKeyword({ match: 'exact', keywords: ['帮助'] }, '请帮助'), null);
  assert.equal(matchedKeyword({ match: 'contains', keywords: ['a.b'] }, 'axb'), null);
  assert.equal(
    keywordRuleInput.safeParse({ name: 'empty', keywords: ['x'], action: 'reply' }).success,
    false,
  );
  assert.equal(
    keywordRuleInput.safeParse({ name: 'mute', keywords: ['x'], action: 'mute', duration_seconds: 1 })
      .success,
    false,
  );
});

test('observe mode, priority and preview are group scoped and do not execute anything', async () => {
  const f = await fixture();
  try {
    const first = await f.save({ mode: 'observe', priority: 1, name: '优先观察' });
    await f.save({ priority: 2 });
    assert.equal((await f.s.keywords.preview(f.group.id, { text: '帮助' })).rule_id, first.id);
    assert.equal((await f.hits()).length, 0);
    await f.incoming();
    assert.equal((await f.hits())[0]!.status, 'observed');
    assert.equal((await f.hits())[0]!.rule_id, first.id);
    assert.equal(await f.job(), undefined);
    assert.equal(await f.s.jobs.processOnce(), false);
    assert.equal(f.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test('editing and disabling API list rows sends only editable fields, preserving the revision guard', async () => {
  const f = await fixture();
  try {
    const saved = await f.save();
    const row = (await f.s.keywords.overview(f.group.id)).rules[0]!;
    assert(row.conversation_id && row.created_at);
    const body = keywordRulePayload({ ...row, name: 'Updated rule', enabled: false } as any);
    assert(!('conversation_id' in body));
    assert(!('created_at' in body));
    const updated = await f.s.keywords.save(f.group.id, saved.id, body, 'test');
    assert.equal(updated.enabled, false);
    assert.equal(updated.name, 'Updated rule');
    await assert.rejects(
      f.s.keywords.save(f.group.id, saved.id, body, 'test'),
      (e: any) => e.code === 'KEYWORD_EDIT_CONFLICT',
    );
  } finally {
    await f.close();
  }
});

test('reply is quoted once, retains TG topic, persists both member cooldown and group flood interval', async () => {
  const f = await fixture();
  try {
    await f.save();
    const event = await f.incoming('帮助', { thread_id: '123' });
    await f.s.messages.ingest(f.account, { ...event, event_id: randomUUID() });
    await f.incoming();
    await f.incoming('帮助', { sender_id: '778' });
    assert.equal((await f.hits()).filter((h) => h.status === 'pending').length, 1);
    assert.equal((await f.hits()).filter((h) => h.status === 'cooldown').length, 2);
    await f.s.jobs.processOnce();
    assert.equal((await f.job()).status, 'succeeded');
    assert.equal(f.mutations.length, 1);
    assert.equal(f.mutations[0]!.params.reply_parameters.message_id, Number(event.data.message_id));
    assert.equal(f.mutations[0]!.params.message_thread_id, 123);
    await f.s.db.query("UPDATE keyword_hits SET created_at=now()-interval '4 seconds'");
    await f.incoming();
    assert.equal((await f.hits())[0]!.status, 'cooldown');
    await f.incoming('帮助', { sender_id: '778' });
    assert.equal((await f.hits())[0]!.status, 'pending');
  } finally {
    await f.close();
  }
});

test('outgoing, historical imports, edits, old messages and traced forwards never replay keyword rules', async () => {
  const f = await fixture();
  try {
    await f.save();
    await f.incoming('帮助', { direction: 'outgoing' });
    await f.incoming('帮助', {}, {}, true);
    await f.incoming('帮助', {}, { type: 'message.edited' });
    await f.incoming('帮助', {}, { occurred_at: new Date(Date.now() - 180000).toISOString() });
    await f.incoming(
      '帮助',
      {},
      {
        trace: {
          trace_id: 'trace-fixture',
          origin: { logical_conversation_id: f.group.id, event_id: 'origin' },
          visited: [f.group.id],
        },
      },
    );
    assert.equal((await f.hits()).length, 0);
    assert.equal(f.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test('media placeholders do not trigger rules; actual captions do, with group-wide cooldown across rules', async () => {
  const f = await fixture();
  try {
    await f.save({ keywords: ['image'], priority: 1 });
    await f.save({ keywords: ['帮助'], priority: 2 });
    await f.incoming('', { segments: [{ type: 'image', asset_id: 'fixture-picture' }] });
    assert.equal((await f.hits()).length, 0);
    await f.incoming('image', {
      segments: [
        { type: 'text', text: 'image' },
        { type: 'image', asset_id: 'fixture-picture' },
      ],
    });
    await f.incoming('帮助');
    const hits = await f.hits();
    assert.equal(hits[0]!.status, 'cooldown');
    assert.equal(hits[1]!.status, 'pending');
  } finally {
    await f.close();
  }
});

for (const [kind, action, expected] of [
  ['telegram', 'ban', 'banChatMember'],
  ['qq', 'remove', 'set_group_kick'],
  ['qq', 'delete', 'delete_msg'],
] as const)
  test(`${kind} standalone keyword ${action} executes with a scoped target and confirmed result`, async () => {
    const f = await fixture(kind);
    try {
      await f.save({ action, response: '' });
      const event = await f.incoming();
      await f.s.jobs.processOnce();
      assert.equal((await f.job()).status, 'succeeded', (await f.job()).last_error);
      assert.equal(f.mutations[0]!.action, expected);
      if (action === 'delete') assert.equal(f.mutations[0]!.params.message_id, event.data.message_id);
      else assert.equal(f.mutations[0]!.params.user_id, '777');
    } finally {
      await f.close();
    }
  });

test('policy changes, new blacklisting, task expiry, removed permissions and changed membership prevent stale keyword work', async () => {
  for (const scenario of ['policy', 'blacklist', 'expiry', 'permissions', 'membership', 'deleted'] as const) {
    const f = await fixture();
    try {
      await f.save({ action: 'mute', response: '' });
      await f.incoming();
      if (scenario === 'policy') await f.s.features.policy(f.group.id, defaultPolicy, 'test');
      if (scenario === 'blacklist')
        await f.s.db.query('INSERT INTO blacklists(id,conversation_id,user_id,reason) VALUES($1,$2,$3,$4)', [
          randomUUID(),
          f.group.id,
          '777',
          'fixture',
        ]);
      if (scenario === 'expiry') await f.s.db.query("UPDATE jobs SET expires_at=now()-interval '1 second'");
      if (scenario === 'permissions') {
        const binding = (
          await f.s.db.query('SELECT snapshot FROM bindings WHERE conversation_id=$1', [f.group.id])
        )[0]!;
        binding.snapshot.permissions = binding.snapshot.permissions.map((p: any) =>
          p.capability === 'members.mute' ? { ...p, permission: 'denied' } : p,
        );
        await f.s.db.query('UPDATE bindings SET snapshot=$2::jsonb WHERE conversation_id=$1', [
          f.group.id,
          JSON.stringify(binding.snapshot),
        ]);
      }
      if (scenario === 'membership')
        await f.s.db.query(
          "INSERT INTO memberships(conversation_id,user_id,membership_id,status,source_at) VALUES($1,'777','new-membership','active',now())",
          [f.group.id],
        );
      if (scenario === 'deleted')
        await f.s.db.query('UPDATE messages SET deleted=true WHERE conversation_id=$1', [f.group.id]);
      await f.s.jobs.processOnce();
      assert.equal((await f.job()).status, 'failed', scenario);
      assert.equal(f.mutations.length, 0, scenario);
    } finally {
      await f.close();
    }
  }
});

for (const kind of ['telegram', 'qq', 'binance'] as const)
  test(`${kind} keyword image reply sends one image with caption and stores confirmed history`, async () => {
    const f = await fixture(kind);
    try {
      const image = await f.s.uploads.create(testPng());
      await f.save({ image_asset_id: image.id });
      await f.incoming();
      await f.s.jobs.processOnce();
      assert.equal((await f.job()).status, 'succeeded', (await f.job()).last_error);
      assert.equal(f.mutations.length, 1);
      assert.equal(
        f.mutations[0]!.action,
        kind === 'telegram' ? 'sendPhoto' : kind === 'qq' ? 'send_group_msg' : 'send_image',
      );
      const history = await f.s.db.query("SELECT * FROM messages WHERE direction='outgoing'");
      assert.equal(history.length, 1);
      assert.equal(history[0]!.media[0].asset_id, image.id);
    } finally {
      await f.close();
    }
  });

for (const kind of ['telegram', 'qq'] as const)
  test(`${kind} keyword mute validates actor/target and uses platform-limited duration`, async () => {
    const f = await fixture(kind);
    try {
      await f.save({ action: 'mute', response: '', duration_seconds: 900 });
      await f.incoming();
      await f.s.jobs.processOnce();
      assert.equal((await f.job()).status, 'succeeded', (await f.job()).last_error);
      const mutation = f.mutations[0]!;
      assert.equal(mutation.action, kind === 'telegram' ? 'restrictChatMember' : 'set_group_ban');
      if (kind === 'qq') assert.equal(mutation.params.duration, 900);
      else {
        assert.equal(mutation.params.until_date, (await f.job()).review_ref.until_date);
        assert.equal(mutation.params.permissions.can_send_messages, false);
      }
      const detail = await f.s.features.group(f.group.id);
      assert.equal(detail.messages[0]!.verdict, 'blocked');
      assert.equal(detail.messages[0]!.moderation_jobs[0].status, 'succeeded');
    } finally {
      await f.close();
    }
  });

test('warnings are counted only after a confirmed send, protected targets never accrue warnings', async () => {
  const f = await fixture();
  try {
    await f.save({ action: 'warn', response: '请遵守群规' });
    await f.incoming();
    assert.equal((await f.s.db.query('SELECT * FROM member_actions')).length, 0);
    await f.s.jobs.processOnce();
    const job = await f.job();
    assert.equal(job.status, 'succeeded');
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 1);
    await f.s.jobs.saveReceipt(f.account.id, job.receipt);
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 1);
    await f.s.db.query("UPDATE keyword_hits SET created_at=now()-interval '1 day'");
    f.state.role = 'admin';
    await f.incoming();
    await f.s.jobs.processOnce();
    assert.equal((await f.job()).receipt.error.code, 'KEYWORD_PROTECTED');
    assert.equal((await f.s.members.overview(f.group.id, '777')).selected_warning_count, 1);
    assert.equal(f.mutations.length, 1);
  } finally {
    await f.close();
  }
});

test('turning off reply admin exemption permits help replies to admins while other bots remain protected', async () => {
  const f = await fixture();
  try {
    await f.save({ exempt_admins: false });
    f.state.role = 'admin';
    await f.incoming();
    await f.s.jobs.processOnce();
    assert.equal((await f.job()).status, 'succeeded');
    await f.s.db.query("UPDATE keyword_hits SET created_at=now()-interval '1 day'");
    f.state.role = 'bot';
    await f.incoming();
    await f.s.jobs.processOnce();
    assert.equal((await f.job()).receipt.error.code, 'KEYWORD_PROTECTED');
    assert.equal(f.mutations.length, 1);
  } finally {
    await f.close();
  }
});

test('edits, deletion, changed rules, stale editor revisions and rule removal stop stale queued work', async () => {
  const f = await fixture();
  try {
    const rule = await f.save();
    const event = await f.incoming();
    await f.s.messages.ingest(f.account, {
      ...event,
      event_id: randomUUID(),
      type: 'message.edited',
      occurred_at: new Date(Date.now() + 50).toISOString(),
      data: { ...event.data, segments: [{ type: 'text', text: '已修改' }] },
    });
    await f.s.jobs.processOnce();
    assert.equal((await f.job()).receipt.error.code, 'KEYWORD_MESSAGE_CHANGED');
    await f.s.db.query("UPDATE keyword_hits SET created_at=now()-interval '1 day'");
    await f.incoming();
    const updated = await f.s.keywords.save(
      f.group.id,
      rule.id,
      { ...f.ruleInput(), expected_revision: rule.revision },
      'test',
    );
    assert.equal((await f.job()).status, 'cancelled');
    await assert.rejects(
      f.s.keywords.save(f.group.id, rule.id, { ...f.ruleInput(), expected_revision: rule.revision }, 'test'),
      (e: any) => e.code === 'KEYWORD_EDIT_CONFLICT',
    );
    await f.s.db.query("UPDATE keyword_hits SET created_at=now()-interval '1 day'");
    await f.incoming();
    await f.s.keywords.remove(f.group.id, updated.id, 'test');
    assert.equal((await f.job()).status, 'cancelled');
    assert.equal((await f.hits()).length, 3);
    assert.equal(f.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test('QQ protects administrators, existing mutes, replaced login, rejoined users and unavailable identities', async () => {
  for (const scenario of ['admin', 'muted', 'identity', 'rejoined', 'unknown', 'actor'] as const) {
    const f = await fixture('qq');
    try {
      await f.save({ action: 'mute', response: '' });
      await f.incoming();
      if (scenario === 'admin') f.state.role = 'admin';
      if (scenario === 'muted') f.state.muted = Math.floor(Date.now() / 1000) + 300;
      if (scenario === 'identity') f.state.identity = '54321';
      if (scenario === 'rejoined') f.state.joinTime = Math.floor(Date.now() / 1000) + 1;
      if (scenario === 'unknown') f.state.unknown = true;
      if (scenario === 'actor') f.state.botAdmin = false;
      await f.s.jobs.processOnce();
      assert.equal((await f.job()).status, 'failed', scenario);
      assert.equal(f.mutations.length, 0, scenario);
    } finally {
      await f.close();
    }
  }
});

test('changing rule or cancelling group sync during realtime permission lookup aborts before mutation', async () => {
  for (const kind of ['telegram', 'qq'] as const) {
    const f = await fixture(kind);
    try {
      await f.save({ action: 'mute', response: '' });
      await f.incoming();
      f.state.hook = async () => {
        await f.s.db.query(
          "UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[]'::jsonb) WHERE id=$1",
          [f.account.id],
        );
      };
      await f.s.jobs.processOnce();
      assert.equal((await f.job()).status, 'failed');
      assert.equal(f.mutations.length, 0);
    } finally {
      await f.close();
    }
  }
});

test('unknown sends remain unresolved without retrying or counting a warning', async () => {
  const f = await fixture('binance');
  try {
    await f.save({ action: 'warn' });
    await f.incoming();
    f.state.unknown = true;
    await f.s.jobs.processOnce();
    assert.equal((await f.job()).status, 'unknown');
    assert.equal((await f.s.db.query('SELECT * FROM member_actions')).length, 0);
    assert.equal(await f.s.jobs.processOnce(), false);
    assert.equal(f.mutations.length, 1);
    assert.equal((await f.hits())[0]!.job_status, 'unknown');
  } finally {
    await f.close();
  }
});

test('a QQ account switch during member lookup cannot authorize a keyword action with the replacement account', async () => {
  const f = await fixture('qq');
  try {
    await f.save({ action: 'mute', response: '' });
    await f.incoming();
    f.state.hook = async () => {
      f.state.identity = '54321';
    };
    await f.s.jobs.processOnce();
    assert.equal((await f.job()).status, 'failed');
    assert.equal((await f.job()).receipt.error.code, 'KEYWORD_IDENTITY_CHANGED');
    assert.equal(f.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test('legacy ad blocks take precedence and new punitive hits never relay offending content', async () => {
  const f = await fixture();
  try {
    await f.save({ action: 'delete', response: '' });
    const other = await f.s.accounts.upsertGroup(f.account, {
      ...groupSnapshot('-10099999', 'Target fixture', 'group', 5, 'telegram', true),
      observed_at: new Date().toISOString(),
    });
    await f.s.db.query('INSERT INTO routes(id,source_id,target_id) VALUES($1,$2,$3)', [
      randomUUID(),
      f.group.id,
      other,
    ]);
    await f.incoming();
    assert.equal((await f.s.db.query("SELECT id FROM jobs WHERE review_ref->>'purpose'='sync'")).length, 0);
    await f.s.jobs.processOnce();
    assert.equal((await f.job()).status, 'succeeded');
    await f.s.features.policy(f.group.id, { ...defaultPolicy, mode: 'enforce', keywords: ['帮助'] }, 'test');
    await f.incoming();
    assert.equal((await f.hits()).length, 1);
    assert.equal(
      (await f.s.db.query("SELECT id FROM jobs WHERE review_ref->>'purpose'='moderation'")).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('keyword endpoints require admin authentication and CSRF; unsupported enforcement is rejected server-side', async () => {
  const f = await fixture('binance');
  const app = await createHttpApp(f.s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const path = `/conversations/${f.group.id}/keyword-rules`;
    assert.equal((await fetch(base + path)).status, 401);
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'keyword-admin', password: 'keyword-fixture-password' }),
    });
    const session: any = await setup.json();
    const headers = {
      cookie: setup.headers.get('set-cookie')!.split(';')[0]!,
      'x-csrf-token': session.csrf,
      'content-type': 'application/json',
    };
    assert.equal(
      (
        await fetch(base + path, {
          method: 'POST',
          headers: { cookie: headers.cookie, 'content-type': 'application/json' },
          body: JSON.stringify(f.ruleInput()),
        })
      ).status,
      403,
    );
    const denied = await fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(f.ruleInput({ action: 'mute', response: '' })),
    });
    assert.equal(denied.status, 409);
    assert.equal(((await denied.json()) as any).error.code, 'KEYWORD_ACTION_UNAVAILABLE');
    const observed = await fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(f.ruleInput({ action: 'mute', response: '', mode: 'observe' })),
    });
    assert.equal(observed.status, 200);
    const list: any = await (await fetch(base + path, { headers })).json();
    assert.equal(list.rules.length, 1);
    assert.equal(list.availability.mute.available, false);
    await assert.rejects(f.save({ keywords: ['\u200b'] }), (e: any) => e.code === 'EMPTY_KEYWORD');
  } finally {
    await app.close();
    await f.close();
  }
});
