import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { defaultPolicy } from '../src/inputs.ts';
import { qqEvents, groupSnapshot } from '../src/adapters.ts';
import { verificationRows } from '../src/qq-verification.ts';
import { QQVerification } from '../src/qq-verification.ts';
import { createHttpApp } from '../src/http.ts';

async function fixture(
  action: 'manual' | 'remove' | 'mute_retry' = 'manual',
  failedAction: 'manual' | 'mute' = 'manual',
) {
  const s = await createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  let now = Math.floor(Date.now() / 1000);
  const state = {
    uin: '12345',
    role: 'admin',
    targetRole: 'member',
    joinTime: now - 1,
    mutedUntil: 0 as number | undefined,
    missingTarget: false,
    response: null as any,
    hook: null as null | ((action: string, params: any) => Promise<void>),
    sequence: 1000,
  };
  const calls: { action: string; params: any }[] = [];
  s.adapters.qq = async (_account, action, params: any = {}) => {
    calls.push({ action, params });
    await state.hook?.(action, params);
    let data: any = null;
    if (action === 'get_login_info') data = { user_id: state.uin, nickname: 'Fixture QQ' };
    else if (action === 'get_group_list')
      data = [{ group_id: 67890, group_name: 'QQ verification fixture', member_count: 2 }];
    else if (action === 'get_group_member_list')
      data = [
        { user_id: state.uin, group_id: '67890', role: state.role },
        ...(!state.missingTarget
          ? [
              {
                user_id: '99999',
                group_id: '67890',
                role: state.targetRole,
                join_time: state.joinTime,
                shut_up_timestamp: state.mutedUntil,
              },
            ]
          : []),
      ];
    else if (action === 'get_group_member_info') {
      if (state.missingTarget) return { status: 200, data: { status: 'failed', retcode: 1400 } };
      data = {
        user_id: String(params.user_id),
        group_id: '67890',
        role: state.targetRole,
        join_time: state.joinTime,
        shut_up_timestamp: state.mutedUntil,
      };
    } else if (
      ['send_group_msg', 'set_group_kick', 'set_group_ban', 'set_group_add_request', 'delete_msg'].includes(
        action,
      )
    ) {
      if (state.response) return state.response;
      if (action === 'send_group_msg') data = { message_id: ++state.sequence };
      if (action === 'set_group_ban')
        state.mutedUntil = Math.floor(Date.now() / 1000) + Number(params.duration);
    } else throw Error('Unexpected fixture action ' + action);
    return { status: 200, data: { status: 'ok', retcode: 0, data } };
  };
  const created = await s.accounts.create(
    { kind: 'qq', name: 'Fixture QQ', endpoint: 'https://example.com' },
    'test',
  );
  await s.accounts.refresh(created.id, 'test');
  const account = await s.accounts.get(created.id);
  const group = (await s.features.groups())[0]!;
  await s.features.policy(
    group.id,
    {
      ...defaultPolicy,
      verification_enabled: true,
      verification_timeout: 30,
      verification_timeout_action: action,
      verification_failed_action: failedAction,
    },
    'test',
  );
  now = Math.floor(Date.now() / 1000);
  state.joinTime = now - 1;
  const notice = (time = now, user = '99999', kind = 'group_increase') => ({
    time,
    self_id: 12345,
    post_type: 'notice',
    notice_type: kind,
    sub_type: kind === 'group_increase' ? 'approve' : 'leave',
    group_id: 67890,
    user_id: user,
    operator_id: 12345,
  });
  const ingest = async (payload: any) => {
    for (const item of qqEvents(account, payload))
      await s.messages.ingest(account, item.event, item.name, false, item.presentation);
  };
  const join = async (time = now) => ingest(notice(time));
  const answer = async (text: string, user = '99999', reply?: string, mention?: string) =>
    ingest({
      time: Math.floor(Date.now() / 1000),
      self_id: 12345,
      post_type: 'message',
      message_type: 'group',
      group_id: 67890,
      user_id: user,
      message_id: ++state.sequence,
      message: [
        ...(reply ? [{ type: 'reply', data: { id: reply } }] : []),
        ...(mention ? [{ type: 'at', data: { qq: mention } }] : []),
        { type: 'text', data: { text } },
      ],
      sender: { nickname: 'Fixture member' },
    });
  const current = async () =>
    (
      await s.db.query(
        'SELECT * FROM verifications WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC',
        [group.id],
      )
    )[0]!;
  const view = async () => (await verificationRows(s.db, group.id))[0]!;
  const drain = async () => {
    for (let i = 0; i < 20; i++) if (!(await s.jobs.processOnce())) return;
    throw Error('Fixture queue did not drain');
  };
  const expire = async () => {
    const v = await current();
    await s.db.query("UPDATE verifications SET expires_at=now()-interval '1 second' WHERE id=$1", [v.id]);
    await s.qqVerification.sweep();
  };
  const solution = async () => {
    const sent = calls.filter((c) => c.action === 'send_group_msg').at(-1)!;
    const text = sent.params.message
      .filter((m: any) => m.type === 'text')
      .map((m: any) => m.data.text)
      .join('');
    const math = text.match(/(\d+) \+ (\d+) =/)!;
    const ticket = (await current()).qq_context.ticket;
    return { answer: String(Number(math[1]) + Number(math[2])), ticket, text };
  };
  return {
    s,
    state,
    calls,
    account,
    group,
    now,
    notice,
    ingest,
    join,
    answer,
    current,
    view,
    drain,
    expire,
    solution,
    close: () => s.close(),
  };
}

test('QQ automatic admission links a single challenge to the real joined membership and confirmed delivery starts the deadline', async () => {
  const f = await fixture();
  try {
    await f.s.qqRequests.settings(f.group.id, { auto_approve: true }, 'test');
    const request = {
      time: f.now,
      self_id: 12345,
      post_type: 'request',
      request_type: 'group',
      sub_type: 'add',
      group_id: 67890,
      user_id: 99999,
      comment: 'Fixture',
      flag: 'verification-fixture',
    };
    await f.s.qqRequests.receive(f.account, request);
    await f.drain();
    await f.join();
    await f.join();
    const waiting = await f.current();
    assert.equal(waiting.challenge_sent_at, null);
    assert.equal((await f.view()).display_state, 'challenge_pending');
    await f.drain();
    const active = await f.current();
    assert(active.challenge_sent_at);
    assert.equal(
      Math.round(
        (new Date(active.expires_at).getTime() - new Date(active.challenge_sent_at).getTime()) / 1000,
      ),
      30,
    );
    assert.equal(active.qq_context.platform_join_time, f.state.joinTime);
    const overview = await f.s.qqRequests.overview(f.group.id);
    assert.equal(overview.requests[0]!.verification.id, active.id);
    assert.equal(overview.requests[0]!.verification.display_state, 'pending');
    assert.equal(f.calls.filter((c) => c.action === 'send_group_msg').length, 1);
    const { answer, ticket } = await f.solution();
    await f.answer(`/verify ${ticket} ${answer}`, '88888');
    assert.equal((await f.current()).status, 'pending');
    await f.answer(`/verify deadbeef ${answer}`);
    assert.equal((await f.current()).attempts, 0);
    await f.answer(`[at] /verify ${ticket} ${answer}`);
    assert.equal((await f.current()).status, 'passed');
    await f.drain();
    assert.equal(f.calls.filter((c) => c.action === 'set_group_kick').length, 0);
    assert.equal(f.calls.filter((c) => c.action === 'send_group_msg').length, 2);
    assert.equal(f.calls.find((c) => c.action === 'send_group_msg')!.params.message[0].type, 'at');
    const serialized = JSON.stringify(await f.view());
    assert(!serialized.includes('token_hash'));
    assert(!serialized.includes('qq_context'));
  } finally {
    await f.close();
  }
});

test('QQ default timeout records manual review and never removes members; a referenced numeric reply can pass before expiry', async () => {
  const f = await fixture();
  try {
    await f.join();
    await f.drain();
    const code = await f.solution();
    const v = await f.current();
    await f.answer(code.answer, '99999', 'unrelated');
    assert.equal((await f.current()).status, 'pending');
    const job = (await f.s.db.query('SELECT receipt FROM jobs WHERE id=$1', [v.challenge_job_id]))[0]!;
    await f.answer(code.answer, '99999', job.receipt.result.message_id);
    assert.equal((await f.current()).status, 'passed');
    await f.expire();
    assert.equal((await f.current()).status, 'passed');
    await f.ingest(f.notice(f.now + 1, '99999', 'group_decrease'));
    await f.join(f.now + 2);
    await f.drain();
    await f.expire();
    assert.equal((await f.current()).status, 'manual_review');
    assert.equal((await f.view()).display_state, 'manual_review');
    assert.equal((await f.s.features.overview()).pending_verifications, 1);
    assert.equal((await f.s.features.groups()).find((g) => g.id === f.group.id)!.pending_verifications, 1);
    await f.drain();
    assert.equal(f.calls.filter((c) => c.action === 'set_group_kick').length, 0);
    await f.s.features.approveVerification((await f.current()).id, 'test');
    assert.equal((await f.current()).status, 'passed');
    assert.equal((await f.s.features.overview()).pending_verifications, 0);
  } finally {
    await f.close();
  }
});

test('QQ members can answer by natively mentioning this bot; other mentions, plain text and old quoted prompts cannot answer for them', async () => {
  const f = await fixture();
  try {
    await f.join();
    await f.drain();
    const code = await f.solution();
    assert(!code.text.includes('/verify'));
    assert(code.text.includes('@本机器人'));
    for (const [text, user, reply, mention] of [
      [code.answer, '99999', undefined, undefined],
      ['[at] ' + code.answer, '99999', undefined, undefined],
      [code.answer, '99999', undefined, '77777'],
      [code.answer, '99999', undefined, 'all'],
      [code.answer, '88888', undefined, '12345'],
      [code.answer, '99999', 'old-prompt', '12345'],
    ]) {
      await f.answer(text!, user!, reply, mention);
      assert.equal((await f.current()).attempts, 0);
    }
    await f.answer('0', '99999', undefined, '12345');
    assert.equal((await f.current()).attempts, 1);
    await f.answer('  ' + code.answer + '  ', '99999', undefined, '12345');
    assert.equal((await f.current()).status, 'passed');
    await f.drain();
    await f.ingest(f.notice(f.now + 1, '99999', 'group_decrease'));
    await f.join(f.now + 2);
    await f.drain();
    const next = await f.solution();
    const v = await f.current();
    const prompt = (await f.s.db.query('SELECT receipt FROM jobs WHERE id=$1', [v.challenge_job_id]))[0]!;
    await f.answer(next.answer, '99999', prompt.receipt.result.message_id, '12345');
    assert.equal((await f.current()).status, 'passed');
  } finally {
    await f.close();
  }
});

test('QQ optional failure mute runs exactly once after three wrong answers for 600 seconds; simple timeout still only records manual review', async () => {
  const f = await fixture('manual', 'mute');
  try {
    await f.join();
    await f.drain();
    for (let i = 0; i < 2; i++) {
      await f.answer('0', '99999', undefined, '12345');
      assert.equal((await f.current()).failure_job_id, null);
    }
    await f.answer('0', '99999', undefined, '12345');
    const failed = await f.current();
    assert(failed.failure_job_id);
    assert.equal((await f.view()).display_state, 'failure_pending');
    await f.answer('0', '99999', undefined, '12345');
    await f.drain();
    const calls = f.calls.filter((c) => c.action === 'set_group_ban');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.params.duration, 600);
    assert.equal((await f.current()).status, 'manual_review');
    assert.equal((await f.view()).display_state, 'failure_succeeded');
    assert.equal((await f.current()).timeout_job_id, null);
    assert.equal((await f.view()).can_resend, false);
    await assert.rejects(
      f.s.qqVerification.resend(failed.id, 'muted-resend-key', 'test'),
      (e: any) => e.code === 'QQ_VERIFICATION_MEMBER_MUTED',
    );
    await f.s.features.approveVerification(failed.id, 'test');
    assert.equal((await f.current()).status, 'passed');
    assert((await f.current()).detail_reason.includes('不会自动解除'));
    assert.equal(f.calls.filter((c) => c.action === 'set_group_ban').length, 1);
    await f.ingest(f.notice(f.now + 1, '99999', 'group_decrease'));
    await f.join(f.now + 2);
    await f.drain();
    await f.expire();
    await f.drain();
    assert.equal((await f.current()).status, 'manual_review');
    assert.equal((await f.current()).failure_job_id, null);
    assert.equal(f.calls.filter((c) => c.action === 'set_group_ban').length, 1);
    assert.equal(f.calls.filter((c) => c.action === 'set_group_kick').length, 0);
  } finally {
    await f.close();
  }
});

test('QQ failure mute protects existing restrictions, changed role, identity, membership, rules and manual approval', async () => {
  for (const change of [
    'already_muted',
    'unknown_mute',
    'admin',
    'owner',
    'new_join_time',
    'unknown_join_time',
    'identity',
    'permissions',
    'offline',
    'scope',
    'rule',
    'approve',
  ]) {
    const f = await fixture('manual', 'mute');
    try {
      await f.join();
      await f.drain();
      for (let i = 0; i < 3; i++) await f.answer('0', '99999', undefined, '12345');
      if (change === 'already_muted') f.state.mutedUntil = f.now + 3600;
      if (change === 'unknown_mute') f.state.mutedUntil = undefined;
      if (change === 'admin' || change === 'owner') f.state.targetRole = change;
      if (change === 'new_join_time') f.state.joinTime += 100;
      if (change === 'unknown_join_time') f.state.joinTime = 0;
      if (change === 'identity') f.state.uin = '54321';
      if (change === 'permissions') {
        f.state.role = 'member';
        await f.s.accounts.refresh(f.account.id, 'test');
      }
      if (change === 'offline')
        await f.s.db.query("UPDATE accounts SET status='error' WHERE id=$1", [f.account.id]);
      if (change === 'scope')
        await f.s.accounts.selectGroups(f.account.id, { group_ids: [], revision: '0' }, 'test');
      if (change === 'rule') await f.s.features.policy(f.group.id, { ...defaultPolicy }, 'test');
      if (change === 'approve') await f.s.features.approveVerification((await f.current()).id, 'test');
      await f.drain();
      assert.equal(f.calls.filter((c) => c.action === 'set_group_ban').length, 0, change);
    } finally {
      await f.close();
    }
  }
});

test('QQ failure mute uncertainty cannot be replayed or hidden by approval or rule edits', async () => {
  const f = await fixture('manual', 'mute');
  try {
    await f.join();
    await f.drain();
    for (let i = 0; i < 3; i++) await f.answer('0', '99999', undefined, '12345');
    f.state.response = { status: 500, data: { status: 'ok', retcode: 0 } };
    await f.drain();
    const v = await f.current();
    assert.equal((await f.view()).display_state, 'failure_unknown');
    assert.equal((await f.view()).can_approve, false);
    await assert.rejects(
      f.s.features.approveVerification(v.id, 'test'),
      (e: any) => e.code === 'QQ_VERIFICATION_ACTION_PENDING',
    );
    await assert.rejects(f.s.qqVerification.resend(v.id, 'unknown-failure-resend', 'test'));
    await assert.rejects(f.s.jobs.retry(v.failure_job_id, 'test'));
    const group = await f.s.features.group(f.group.id);
    await f.s.features.policy(group.id, { ...group.policy, verification_timeout: 60 }, 'test');
    assert.equal((await f.view()).display_state, 'failure_unknown');
    await f.s.qqVerification.sweep();
    await f.drain();
    assert.equal(f.calls.filter((c) => c.action === 'set_group_ban').length, 1);
  } finally {
    await f.close();
  }
});

test('QQ timeout loop persists cooldown, reissues one new question per round, and stops on a correct quoted answer', async () => {
  const f = await fixture('mute_retry', 'mute');
  try {
    await f.join();
    await f.drain();
    const initial = await f.current();
    const oldCode = await f.solution();
    for (let round = 1; round <= 2; round++) {
      if (round === 2)
        await f.s.db.query(
          "UPDATE verifications SET qq_context=jsonb_set(qq_context,'{ticket}',to_jsonb($2::text)) WHERE id=$1",
          [initial.id, initial.qq_context.ticket],
        );
      await f.expire();
      assert.equal((await f.view()).display_state, 'timeout_mute_pending');
      await f.drain();
      let v = await f.current();
      assert.equal(v.status, 'cooldown');
      assert(v.retry_after);
      assert(new Date(v.retry_after).getTime() >= Date.now() + 590000);
      await f.answer(oldCode.answer, '99999', undefined, '12345');
      assert.equal((await f.current()).status, 'cooldown');
      await f.s.qqVerification.sweep();
      assert.equal(f.calls.filter((c) => c.action === 'send_group_msg').length, round);
      await f.s.db.query("UPDATE verifications SET retry_after=now()-interval '1 second' WHERE id=$1", [
        v.id,
      ]);
      f.state.mutedUntil = 0;
      const restarted = new QQVerification(f.s, f.s.jobs);
      await Promise.all([restarted.sweep(), f.s.qqVerification.sweep()]);
      await f.drain();
      v = await f.current();
      assert.equal(v.status, 'pending');
      assert.equal(v.qq_context.round, round + 1);
      assert.equal(v.attempts, 0);
      assert.equal(v.retry_after, null);
      assert.notEqual(v.qq_context.ticket, initial.qq_context.ticket);
      assert.equal(f.calls.filter((c) => c.action === 'send_group_msg').length, round + 1);
      assert.equal(f.calls.filter((c) => c.action === 'set_group_ban').length, round);
    }
    const v = await f.current(),
      code = await f.solution();
    const prompt = (await f.s.db.query('SELECT receipt FROM jobs WHERE id=$1', [v.challenge_job_id]))[0]!;
    await f.answer(code.answer, '99999', prompt.receipt.result.message_id);
    await f.drain();
    assert.equal((await f.current()).status, 'passed');
    await f.s.qqVerification.sweep();
    assert.equal(f.calls.filter((c) => c.action === 'set_group_ban').length, 2);
    assert(f.calls.filter((c) => c.action === 'set_group_ban').every((c) => c.params.duration === 600));
  } finally {
    await f.close();
  }
});

test('QQ third-wrong mute also rejoins the selected retry loop and resets attempts after native expiry', async () => {
  const f = await fixture('mute_retry', 'mute');
  try {
    await f.join();
    await f.drain();
    for (let i = 0; i < 3; i++) await f.answer('0', '99999', undefined, '12345');
    await f.drain();
    const v = await f.current();
    assert.equal(v.status, 'cooldown');
    assert(v.failure_job_id);
    assert.equal(v.timeout_job_id, null);
    await f.s.db.query("UPDATE verifications SET retry_after=now()-interval '1 second' WHERE id=$1", [v.id]);
    f.state.mutedUntil = 0;
    await f.s.qqVerification.sweep();
    await f.drain();
    assert.equal((await f.current()).qq_context.round, 2);
    assert.equal((await f.current()).attempts, 0);
    const code = await f.solution();
    await f.answer(code.answer, '99999', undefined, '12345');
    await f.drain();
    assert.equal((await f.current()).status, 'passed');
  } finally {
    await f.close();
  }
});

test('QQ automatic cycles stop on manual approval, departure, settings, stale membership, unknown roles and additional native mutes', async () => {
  for (const change of [
    'approve',
    'left',
    'disabled',
    'scope',
    'offline',
    'identity',
    'permissions',
    'admin',
    'owner',
    'other_mute',
    'unknown_mute',
    'new_join_time',
    'missing',
    'prompt_failure',
  ]) {
    const f = await fixture('mute_retry', 'mute');
    try {
      await f.join();
      await f.drain();
      await f.expire();
      await f.drain();
      const v = await f.current();
      assert.equal(v.status, 'cooldown');
      await f.s.db.query("UPDATE verifications SET retry_after=now()-interval '1 second' WHERE id=$1", [
        v.id,
      ]);
      f.state.mutedUntil = 0;
      if (change === 'approve') await f.s.features.approveVerification(v.id, 'test');
      if (change === 'left') await f.ingest(f.notice(f.now + 1, '99999', 'group_decrease'));
      if (change === 'disabled') await f.s.features.policy(f.group.id, { ...defaultPolicy }, 'test');
      if (change === 'scope')
        await f.s.accounts.selectGroups(f.account.id, { group_ids: [], revision: '0' }, 'test');
      if (change === 'offline')
        await f.s.db.query("UPDATE accounts SET status='error' WHERE id=$1", [f.account.id]);
      if (change === 'identity') f.state.uin = '54321';
      if (change === 'permissions') f.state.role = 'member';
      if (change === 'admin' || change === 'owner') f.state.targetRole = change;
      if (change === 'other_mute') f.state.mutedUntil = f.now + 3600;
      if (change === 'unknown_mute') f.state.mutedUntil = undefined;
      if (change === 'new_join_time') f.state.joinTime += 100;
      if (change === 'missing') f.state.missingTarget = true;
      await f.s.qqVerification.sweep();
      if (change === 'prompt_failure')
        f.state.response = { status: 200, data: { status: 'failed', retcode: 1403 } };
      await f.drain();
      await f.s.qqVerification.sweep();
      assert.equal(f.calls.filter((c) => c.action === 'set_group_ban').length, 1, change);
      assert.equal(
        f.calls.filter((c) => c.action === 'send_group_msg').length,
        change === 'prompt_failure' ? 2 : 1,
        change,
      );
      const ended = await f.current();
      assert.notEqual(ended.status, 'cooldown', change);
      assert.equal(ended.retry_after, null, change);
    } finally {
      await f.close();
    }
  }
});

test('QQ timeout loop never schedules a restart after uncertain or failed mute delivery', async () => {
  for (const unknown of [true, false]) {
    const f = await fixture('mute_retry', 'mute');
    try {
      await f.join();
      await f.drain();
      f.state.response = unknown
        ? { status: 500, data: { status: 'ok', retcode: 0 } }
        : { status: 200, data: { status: 'failed', retcode: 1403 } };
      await f.expire();
      await f.drain();
      await f.s.qqVerification.sweep();
      assert.equal((await f.current()).status, 'manual_review');
      assert.equal((await f.current()).retry_after, null);
      assert.equal((await f.view()).display_state, unknown ? 'timeout_mute_unknown' : 'timeout_mute_failed');
      await f.s.qqVerification.sweep();
      await f.drain();
      assert.equal(f.calls.filter((c) => c.action === 'set_group_ban').length, 1);
      assert.equal(f.calls.filter((c) => c.action === 'send_group_msg').length, 1);
    } finally {
      await f.close();
    }
  }
});

test('QQ retry after a long service outage refreshes stale permissions before sending the next question', async () => {
  const f = await fixture('mute_retry', 'mute');
  try {
    await f.join();
    await f.drain();
    await f.expire();
    await f.drain();
    const v = await f.current();
    assert.equal((await f.s.features.overview()).pending_verifications, 1);
    await f.s.db.query("UPDATE verifications SET retry_after=now()-interval '1 second' WHERE id=$1", [v.id]);
    f.state.mutedUntil = 0;
    await f.s.db.query(
      "UPDATE bindings SET snapshot=jsonb_set(snapshot,'{observed_at}',to_jsonb($2::text)) WHERE conversation_id=$1",
      [f.group.id, new Date(Date.now() - 1200000).toISOString()],
    );
    const restarted = new QQVerification(f.s, f.s.jobs, (id) => f.s.accounts.refresh(id, 'fixture recovery'));
    await restarted.sweep();
    await f.drain();
    assert.equal((await f.current()).status, 'pending');
    assert.equal((await f.current()).qq_context.round, 2);
  } finally {
    await f.close();
  }
});

test('QQ prompt failure or uncertain delivery never starts a timer or auto removes; resends require a new confirmed attempt', async () => {
  for (const uncertain of [false, true]) {
    const f = await fixture('remove');
    try {
      f.state.response = uncertain
        ? { status: 500, data: { retcode: 0, status: 'ok' } }
        : { status: 200, data: { retcode: 1403, status: 'failed' } };
      await f.join();
      await f.drain();
      const first = await f.current();
      assert.equal(first.challenge_sent_at, null);
      assert.equal((await f.view()).display_state, uncertain ? 'challenge_unknown' : 'challenge_failed');
      await f.s.qqVerification.sweep();
      assert.equal((await f.current()).status, 'manual_review');
      await f.expire();
      assert.equal(f.calls.filter((c) => c.action === 'set_group_kick').length, 0);
      await assert.rejects(f.s.jobs.retry(first.challenge_job_id, 'test'));
      if (uncertain) {
        assert.equal((await f.view()).can_resend, false);
        await assert.rejects(f.s.qqVerification.resend(first.id, 'test-resend-1', 'test'));
        await f.s.jobs.reconcile(
          first.challenge_job_id,
          { outcome: 'no_effect', evidence: 'Fixture operator confirms the prompt was never sent.' },
          'test',
        );
      }
      f.state.response = null;
      const result = await f.s.qqVerification.resend(first.id, 'test-resend-1', 'test');
      const duplicate = await f.s.qqVerification.resend(first.id, 'test-resend-1', 'test');
      assert.equal(duplicate.job_id, result.job_id);
      assert.equal(duplicate.duplicate, true);
      await f.drain();
      const v = await f.current();
      assert(v.challenge_sent_at);
      assert.notEqual(v.challenge_job_id, first.challenge_job_id);
      assert.equal((await f.view()).display_state, 'pending');
    } finally {
      await f.close();
    }
  }
});

test('QQ optional timeout removal has distinct pending, succeeded and unknown outcomes without replay', async () => {
  for (const outcome of ['succeeded', 'unknown', 'failed']) {
    const f = await fixture('remove');
    try {
      await f.join();
      await f.drain();
      await f.expire();
      const v = await f.current();
      assert.equal((await f.view()).display_state, 'timeout_pending');
      if (outcome === 'unknown') f.state.response = { status: 500, data: { retcode: 0, status: 'ok' } };
      if (outcome === 'failed') f.state.response = { status: 200, data: { retcode: 1403, status: 'failed' } };
      await f.drain();
      assert.equal(
        (await f.view()).display_state,
        outcome === 'succeeded' ? 'removed' : 'timeout_' + outcome,
      );
      assert.equal(f.calls.filter((c) => c.action === 'set_group_kick').length, 1);
      await f.s.qqVerification.sweep();
      await f.drain();
      assert.equal(f.calls.filter((c) => c.action === 'set_group_kick').length, 1);
      await assert.rejects(f.s.jobs.retry(v.timeout_job_id, 'test'));
      if (outcome === 'unknown') {
        const group = await f.s.features.group(f.group.id);
        await f.s.features.policy(f.group.id, { ...group.policy, verification_timeout: 60 }, 'test');
        assert.equal((await f.view()).display_state, 'timeout_unknown');
        await assert.rejects(
          f.s.features.approveVerification(v.id, 'test'),
          (e: any) => e.code === 'QQ_VERIFICATION_ACTION_PENDING',
        );
      }
    } finally {
      await f.close();
    }
  }
});

test('QQ verification removal protects changed permissions, identities, settings and platform join episodes', async () => {
  for (const change of [
    'admin',
    'owner',
    'missing',
    'new_join_time',
    'unknown_join_time',
    'identity',
    'scope',
    'rule',
    'left',
    'offline',
  ]) {
    const f = await fixture('remove');
    try {
      await f.join();
      await f.drain();
      await f.expire();
      if (change === 'admin') f.state.targetRole = 'admin';
      if (change === 'owner') f.state.targetRole = 'owner';
      if (change === 'missing') f.state.missingTarget = true;
      if (change === 'new_join_time') f.state.joinTime += 10;
      if (change === 'unknown_join_time') f.state.joinTime = 0;
      if (change === 'identity') f.state.uin = '54321';
      if (change === 'scope')
        await f.s.accounts.selectGroups(f.account.id, { group_ids: [], revision: '0' }, 'test');
      if (change === 'rule') await f.s.features.policy(f.group.id, { ...defaultPolicy }, 'test');
      if (change === 'left') await f.ingest(f.notice(f.now + 1, '99999', 'group_decrease'));
      if (change === 'offline')
        await f.s.db.query("UPDATE accounts SET status='error' WHERE id=$1", [f.account.id]);
      await f.drain();
      assert.equal(f.calls.filter((c) => c.action === 'set_group_kick').length, 0, change);
    } finally {
      await f.close();
    }
  }
});

test('Manual QQ approval cancels an unclaimed timeout action, while an in-flight removal cannot be overridden', async () => {
  for (const inFlight of [false, true]) {
    const f = await fixture('remove');
    try {
      await f.join();
      await f.drain();
      await f.expire();
      const v = await f.current();
      if (inFlight) {
        let checked = false;
        f.state.hook = async (action) => {
          if (action === 'get_group_member_list' && !checked) {
            checked = true;
            await assert.rejects(
              f.s.features.approveVerification(v.id, 'test'),
              (e: any) => e.code === 'QQ_VERIFICATION_ACTION_PENDING',
            );
          }
        };
      } else await f.s.features.approveVerification(v.id, 'test');
      await f.drain();
      assert.equal(f.calls.filter((c) => c.action === 'set_group_kick').length, inFlight ? 1 : 0);
      assert.equal((await f.current()).status, inFlight ? 'removed' : 'passed');
    } finally {
      await f.close();
    }
  }
});

test('QQ rejoin supersedes the old challenge and old answers, and existing members do not receive retroactive verification', async () => {
  const f = await fixture();
  try {
    await f.answer('existing-member-message', '88888');
    assert.equal((await f.s.db.query('SELECT id FROM verifications')).length, 0);
    await f.join();
    await f.drain();
    const old = await f.current();
    const answer = await f.solution();
    await f.ingest(f.notice(f.now + 1, '99999', 'group_decrease'));
    await f.join(f.now + 2);
    await f.drain();
    const current = await f.current();
    assert.notEqual(old.id, current.id);
    await f.answer(`/verify ${answer.ticket} ${answer.answer}`);
    assert.equal((await f.current()).attempts, 0);
    await assert.rejects(f.s.features.approveVerification(old.id, 'test'));
    await f.s.db.query("UPDATE verifications SET expires_at=now()-interval '1 second' WHERE id=$1", [old.id]);
    await f.s.qqVerification.sweep();
    assert.equal((await f.current()).status, 'pending');
  } finally {
    await f.close();
  }
});

test('QQ owner and admin members are exempt; answering three times incorrectly cannot bypass the selected timeout policy', async () => {
  const f = await fixture();
  try {
    f.state.targetRole = 'admin';
    await f.join();
    await f.drain();
    assert.equal((await f.current()).status, 'passed');
    assert.equal(f.calls.filter((c) => c.action === 'send_group_msg').length, 0);
    f.state.targetRole = 'member';
    await f.ingest(f.notice(f.now + 1, '99999', 'group_decrease'));
    await f.join(f.now + 2);
    await f.drain();
    const { ticket } = await f.solution();
    for (let i = 0; i < 3; i++) await f.answer(`/verify ${ticket} 0`);
    assert.equal((await f.current()).status, 'failed');
    await f.expire();
    assert.equal((await f.current()).status, 'manual_review');
  } finally {
    await f.close();
  }
});

test('QQ existing members can still sync messages and join lotteries while newly joined unverified members are gated', async () => {
  const f = await fixture();
  try {
    const target = await f.s.accounts.upsertGroup(
      f.account,
      groupSnapshot('67891', 'Target group', 'group', 2, 'qq', true),
    );
    await f.s.features.saveRoute({ source_id: f.group.id, target_id: target }, 'test');
    await f.answer('Existing member normal message', '88888');
    await f.drain();
    const sync = (await f.s.db.query("SELECT status FROM jobs WHERE review_ref->>'purpose'='sync'"))[0]!;
    assert.equal(sync.status, 'succeeded');
    const lottery = await f.s.features.createLottery(
      {
        conversation_id: f.group.id,
        title: 'Fixture',
        winners_count: 1,
        closes_at: new Date(Date.now() + 60000).toISOString(),
      },
      'test',
    );
    await f.answer(`/join ${lottery.id}`, '88888');
    await f.join();
    await f.answer(`/join ${lottery.id}`);
    const entries = await f.s.db.query('SELECT user_id FROM lottery_entries WHERE lottery_id=$1', [
      lottery.id,
    ]);
    assert.deepEqual(
      entries.map((r) => r.user_id),
      ['88888'],
    );
    await f.s.db.query("UPDATE lotteries SET closes_at=now()-interval '1 second' WHERE id=$1", [lottery.id]);
    const drawn = await f.s.features.drawLottery(lottery.id, 'test');
    assert.deepEqual(drawn.winners, ['88888']);
  } finally {
    await f.close();
  }
});

test('QQ challenge preflight rechecks account, scope, rules and manual approval after member lookup', async () => {
  for (const change of ['identity', 'scope', 'rule', 'approve']) {
    const f = await fixture();
    try {
      await f.join();
      const verification = await f.current();
      let changed = false;
      f.state.hook = async (action) => {
        if (action !== 'get_group_member_list' || changed) return;
        changed = true;
        if (change === 'identity') f.state.uin = '54321';
        if (change === 'scope')
          await f.s.accounts.selectGroups(f.account.id, { group_ids: [], revision: '0' }, 'test');
        if (change === 'rule') await f.s.features.policy(f.group.id, defaultPolicy, 'test');
        if (change === 'approve') await f.s.features.approveVerification(verification.id, 'test');
      };
      await f.drain();
      assert.equal(f.calls.filter((c) => c.action === 'send_group_msg').length, 0, change);
      if (change === 'approve') assert.equal((await f.current()).status, 'passed');
    } finally {
      await f.close();
    }
  }
});

test('QQ ad edits preserve a pending verification, while verification setting changes stop old tasks and allow explicit resend', async () => {
  const f = await fixture();
  try {
    await f.join();
    await f.drain();
    const initial = await f.current();
    const answer = await f.solution();
    let group = await f.s.features.group(f.group.id);
    await f.s.features.policy(f.group.id, { ...group.policy, keywords: ['fixture-ad'] }, 'test');
    assert.equal((await f.current()).status, 'pending');
    await f.answer(`/verify ${answer.ticket} ${answer.answer}`);
    assert.equal((await f.current()).status, 'passed');
    await f.drain();
    await f.ingest(f.notice(f.now + 1, '99999', 'group_decrease'));
    await f.join(f.now + 2);
    await f.drain();
    group = await f.s.features.group(f.group.id);
    await f.s.features.policy(f.group.id, { ...group.policy, verification_timeout: 60 }, 'test');
    const stopped = await f.current();
    assert.equal(stopped.status, 'cancelled');
    assert.equal((await f.view()).can_resend, true);
    await f.s.qqVerification.resend(stopped.id, 'new-timeout-resend', 'test');
    await f.drain();
    const renewed = await f.current();
    assert.equal(renewed.status, 'pending');
    assert.notEqual(renewed.qq_context.ticket, stopped.qq_context.ticket);
    assert.equal(
      Math.round(
        (new Date(renewed.expires_at).getTime() - new Date(renewed.challenge_sent_at).getTime()) / 1000,
      ),
      60,
    );
  } finally {
    await f.close();
  }
});

test('QQ verification pages and actions require administrator and CSRF, and request secrets never enter public state', async () => {
  const f = await fixture();
  const app = await createHttpApp(f.s);
  try {
    await f.join();
    await f.drain();
    const v = await f.current();
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const auth = await f.s.auth.setup({
      username: 'verify-review',
      password: 'verification-fixture-password',
    });
    const cookie = `qsb_session=${auth.token}`;
    for (const path of ['/verifications', `/conversations/${f.group.id}/verifications`]) {
      assert.equal((await fetch(base + path)).status, 401);
      const response = await fetch(base + path, { headers: { cookie } });
      assert.equal(response.status, 200);
      const data = JSON.stringify(await response.json());
      assert(!data.includes('token_hash'));
      assert(!data.includes('qq_context'));
    }
    for (const suffix of ['approve', 'resend'])
      assert.equal(
        (await fetch(base + `/verifications/${v.id}/${suffix}`, { method: 'POST', headers: { cookie } }))
          .status,
        403,
      );
    const project = await f.s.features.createProject(
      { name: 'Fixture', conversation_ids: [f.group.id], scopes: ['conversations.read'] },
      'test',
    );
    assert.equal(
      (await fetch(base + '/verifications', { headers: { authorization: `Bearer ${project.key}` } })).status,
      403,
    );
  } finally {
    await app.close();
    await f.close();
  }
});
