import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  acceptHeartbeat, authorizeSync, connectorCommandSchema, connectorEventSchema,
  conversationKey, conversationPageSchema, discoveryQuerySchema, evaluateRestrictionRelease,
  handshakeSchema, hasEffectiveCapability, heartbeatSchema, MemoryExecutionStore, MemoryReplayStore,
  mergeReceipt, nextSyncTrace, permissionSnapshotSchema, ProtocolError, receiptSchema,
  requiredCapabilities, signRequest, startTrace, syncDeliveryKey, verifyRequest,
} from '../src/index.ts';
import type { ConnectorCommand, ExecutionReceipt, RestrictionRecord } from '../src/index.ts';
import { CONVERSATION_PATH, createDemoBridge, EVENT_PATH } from '../../../examples/custom-chat/handlers.ts';

const secret = randomBytes(32).toString('hex');
const source = { connector_id: 'custom-chat', account_id: 'a1', conversation_id: 'room-1' };
function command(): ConnectorCommand {
  return connectorCommandSchema.parse({
    schema_version: '1', command_id: 'operation-1', idempotency_key: 'delivery-1',
    attempt_id: 'try-1', attempt_number: 1, logical_conversation_id: 'logical-room-1',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    target: source, action: 'message.send', params: { segments: [{ type: 'text', text: 'hello' }] },
  });
}
function nextAttempt(value: ConnectorCommand): ConnectorCommand {
  return { ...value, attempt_id: `try-${value.attempt_number + 1}`, attempt_number: value.attempt_number + 1 };
}
function receipt(value: ConnectorCommand, status: ExecutionReceipt['status'], revision = 1, retryable = false): ExecutionReceipt {
  const base = {
    schema_version: '1', command_id: value.command_id, attempt_id: value.attempt_id,
    attempt_number: value.attempt_number, revision, observed_at: new Date().toISOString(), status,
  };
  return receiptSchema.parse(status === 'accepted' ? base : status === 'succeeded'
    ? { ...base, result: { message_id: 'platform-message-1' } }
    : { ...base, error: { code: 'TEST_RESULT', message: 'Test executor outcome', retryable } });
}
function code(expected: string) {
  return (error: unknown) => error instanceof ProtocolError && error.code === expected;
}

const message = {
  logical_conversation_id: 'logical-room-1', message_id: 'm1', content_version: 1,
  content_fingerprint: 'content-hash-1', deleted: false,
};
const review = {
  logical_conversation_id: message.logical_conversation_id, message_id: message.message_id,
  content_version: message.content_version, content_fingerprint: message.content_fingerprint,
  decision_id: 'review-1', policy_version: 'policy-1', verdict: 'allowed' as const,
  evaluated_at: new Date().toISOString(),
};
const gate = { message, review, currentPolicyVersion: 'policy-1', verification: 'passed' as const, blacklisted: false };

test('sync requires a completed review, verification and blacklist checks', () => {
  assert.equal(authorizeSync(gate).allowed, true);
  assert.equal(authorizeSync({ ...gate, review: null }).allowed, false);
  assert.equal(authorizeSync({ ...gate, review: { ...review, verdict: 'pending' } }).allowed, false);
  assert.equal(authorizeSync({ ...gate, review: { ...review, verdict: 'blocked' } }).allowed, false);
  assert.equal(authorizeSync({ ...gate, verification: 'pending' }).allowed, false);
  assert.equal(authorizeSync({ ...gate, blacklisted: true }).allowed, false);
});

test('edited, deleted or newly regulated messages cannot reuse an earlier review', () => {
  for (const changed of [
    { content_version: 2 }, { content_fingerprint: 'changed-content' },
    { logical_conversation_id: 'another-room' }, { message_id: 'another-message' }, { deleted: true },
  ]) assert.equal(authorizeSync({ ...gate, message: { ...message, ...changed } }).allowed, false);
  assert.equal(authorizeSync({ ...gate, currentPolicyVersion: 'policy-2' }).allowed, false);
});

test('the bridge waits for review and creates no outbound message when it is blocked', async () => {
  let release!: (result: 'blocked') => void;
  let started!: () => void;
  const waiting = new Promise<'blocked'>(resolve => { release = resolve; });
  const reviewing = new Promise<void>(resolve => { started = resolve; });
  const bridge = createDemoBridge({
    conversation: source, eventSecret: secret, commandSecret: secret,
    reviewMessage: async () => { started(); return waiting; },
  });
  const body = JSON.stringify({
    schema_version: '1', event_id: 'e1', occurred_at: new Date().toISOString(), source,
    type: 'message.created', data: { message_id: 'm1', sender_id: 'u1', direction: 'incoming', segments: [{ type: 'text', text: 'ad' }] },
  });
  const pending = bridge.handleEvent(new Request(`http://localhost${EVENT_PATH}`, {
    method: 'POST', body, headers: signRequest({ method: 'POST', path: EVENT_PATH, body, secret, keyId: 'demo-events', purpose: 'events' }),
  }));
  await reviewing;
  assert.equal(bridge.messages.length, 0);
  release('blocked');
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal((await result.json()).receipt, null);
  assert.equal(bridge.messages.length, 0);
});

test('two accounts observing one physical group share a logical route and delivery identity', () => {
  const secondObserver = { ...source, account_id: 'a2' };
  const bindings = new Map([[conversationKey(source), 'logical-room-1'], [conversationKey(secondObserver), 'logical-room-1']]);
  const firstTrace = startTrace(bindings.get(conversationKey(source))!, 'canonical-platform-event');
  const secondTrace = startTrace(bindings.get(conversationKey(secondObserver))!, 'canonical-platform-event');
  assert.equal(firstTrace.trace_id, secondTrace.trace_id);
  assert.equal(nextSyncTrace(firstTrace, bindings.get(conversationKey(secondObserver))!), null);
  assert.equal(syncDeliveryKey(firstTrace.trace_id, 'target-room'), syncDeliveryKey(secondTrace.trace_id, 'target-room'));
  assert.ok(nextSyncTrace(firstTrace, 'logical-room-2'));
});

test('a determinate retryable failure permits one new attempt with immutable business intent', async () => {
  const store = new MemoryExecutionStore();
  const original = command();
  let executions = 0;
  const run = async (value: ConnectorCommand) => {
    executions++;
    return receipt(value, value.attempt_number === 1 ? 'failed' : 'succeeded', 1, value.attempt_number === 1);
  };
  const first = await store.execute('workspace-1', original, run);
  assert.equal(first.status, 'failed');
  assert.deepEqual(await store.execute('workspace-1', original, run), first);
  const second = nextAttempt(original);
  const results = await Promise.all(Array.from({ length: 5 }, () => store.execute('workspace-1', second, run)));
  assert.equal(executions, 2);
  for (const result of results) assert.equal(result.status, 'succeeded');
  store.recordReceipt('workspace-1', original.idempotency_key, first);
  assert.equal(store.latestReceipt('workspace-1', original.idempotency_key)?.status, 'succeeded');
  await assert.rejects(store.execute('workspace-1', nextAttempt(second), run), code('RETRY_NOT_ALLOWED'));
});

test('a retry cannot change content or skip an attempt number', async () => {
  const store = new MemoryExecutionStore();
  const original = command();
  const run = async (value: ConnectorCommand) => receipt(value, 'failed', 1, true);
  await store.execute('w', original, run);
  const changed = connectorCommandSchema.parse({ ...nextAttempt(original), params: { segments: [{ type: 'text', text: 'different' }] } });
  await assert.rejects(store.execute('w', changed, run), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(store.execute('w', { ...original, attempt_id: 'try-3', attempt_number: 3 }, run), code('ATTEMPT_OUT_OF_ORDER'));
});

test('in-flight and accepted attempts block another execution', async () => {
  const store = new MemoryExecutionStore();
  const original = command();
  let finish!: (value: ExecutionReceipt) => void;
  const pending = new Promise<ExecutionReceipt>(resolve => { finish = resolve; });
  const executing = store.execute('w', original, async () => pending);
  await assert.rejects(store.execute('w', nextAttempt(original), async value => receipt(value, 'succeeded')), code('RETRY_NOT_ALLOWED'));
  finish(receipt(original, 'accepted'));
  await executing;
  await assert.rejects(store.execute('w', nextAttempt(original), async value => receipt(value, 'succeeded')), code('RETRY_NOT_ALLOWED'));
});

test('exceptions become unknown and require reconciliation before any retry', async () => {
  const store = new MemoryExecutionStore();
  const original = command();
  let sends = 0;
  const initial = await store.execute('w', original, async () => { sends++; throw new Error('receipt lost'); });
  assert.equal(initial.status, 'unknown');
  await store.execute('w', original, async value => { sends++; return receipt(value, 'succeeded'); });
  await assert.rejects(store.execute('w', nextAttempt(original), async value => receipt(value, 'succeeded')), code('RETRY_NOT_ALLOWED'));
  assert.equal(sends, 1);
  const resolved = receipt(original, 'failed', 2, true);
  assert.throws(() => store.recordReceipt('w', original.idempotency_key, resolved), code('INVALID_RECEIPT_TRANSITION'));
  store.recordReceipt('w', original.idempotency_key, resolved, { reconciled: true });
  assert.equal((await store.execute('w', nextAttempt(original), async value => receipt(value, 'succeeded'))).status, 'succeeded');
});

test('a delayed accepted response cannot overwrite an earlier final callback', async () => {
  const store = new MemoryExecutionStore();
  const original = command();
  let finish!: (value: ExecutionReceipt) => void;
  const pending = new Promise<ExecutionReceipt>(resolve => { finish = resolve; });
  const executing = store.execute('w', original, async () => pending);
  const final = receipt(original, 'succeeded', 2);
  store.recordReceipt('w', original.idempotency_key, final);
  finish(receipt(original, 'accepted', 1));
  assert.deepEqual(await executing, final);
  assert.deepEqual(await store.execute('w', original, async value => receipt(value, 'failed')), final);
});

test('receipt revisions reject conflicts, identity mismatches and terminal rollbacks', () => {
  const original = command();
  const final = receipt(original, 'succeeded', 2);
  assert.deepEqual(mergeReceipt(final, receipt(original, 'accepted', 1)), final);
  assert.throws(() => mergeReceipt(final, receipt(original, 'failed', 2)), code('RECEIPT_CONFLICT'));
  assert.throws(() => mergeReceipt(final, receipt(original, 'accepted', 3)), code('INVALID_RECEIPT_TRANSITION'));
  assert.throws(() => mergeReceipt(final, receipt(nextAttempt(original), 'succeeded')), code('RECEIPT_SCOPE_MISMATCH'));
});

test('expiry blocks new execution while completed duplicates retain their original outcome', async t => {
  const original = command();
  const store = new MemoryExecutionStore();
  const first = await store.execute('w', original, async value => receipt(value, 'succeeded'));
  t.mock.method(Date, 'now', () => Date.parse(original.expires_at) + 1);
  assert.deepEqual(await store.execute('w', original, async () => { throw new Error('must not execute'); }), first);
  const other = { ...original, command_id: 'other', idempotency_key: 'other' };
  const expired = await store.execute('w', other, async () => { throw new Error('must not execute'); });
  assert.equal(expired.status === 'failed' && expired.error.code, 'COMMAND_EXPIRED');
});

const restriction: RestrictionRecord = {
  restriction_id: 'restriction-1', logical_conversation_id: 'logical-room-1', user_id: 'u1',
  membership_id: 'join-1', version: 1, owner: 'verification', owner_id: 'challenge-1', status: 'active',
};
const release = {
  record: restriction,
  request: { restriction_id: 'restriction-1', owner_type: 'verification' as const, owner_id: 'challenge-1', membership_id: 'join-1', expected_version: 1, platform_fingerprint: 'platform-state-1' },
  logicalConversationId: 'logical-room-1', userId: 'u1', currentMembershipId: 'join-1',
  currentPlatformFingerprint: 'platform-state-1', otherActiveRestrictions: 0, platformGuard: 'atomic' as const,
};

test('verification releases only the original restriction in the current membership episode', () => {
  assert.equal(evaluateRestrictionRelease(release).decision, 'release_platform');
  assert.equal(evaluateRestrictionRelease({ ...release, currentMembershipId: 'join-2' }).decision, 'deny');
  assert.equal(evaluateRestrictionRelease({ ...release, record: { ...restriction, version: 2 } }).decision, 'deny');
  assert.equal(evaluateRestrictionRelease({ ...release, record: { ...restriction, owner: 'administrator' } }).decision, 'deny');
  assert.equal(evaluateRestrictionRelease({ ...release, request: { ...release.request, owner_id: 'another-challenge' } }).decision, 'deny');
});

test('admin restrictions and unverifiable concurrent changes cannot be cleared by verification', () => {
  assert.equal(evaluateRestrictionRelease({ ...release, otherActiveRestrictions: 1 }).decision, 'release_record_only');
  assert.equal(evaluateRestrictionRelease({ ...release, currentPlatformFingerprint: 'admin-changed-state' }).decision, 'manual_review');
  assert.equal(evaluateRestrictionRelease({ ...release, currentPlatformFingerprint: null }).decision, 'manual_review');
  assert.equal(evaluateRestrictionRelease({ ...release, platformGuard: 'unavailable' }).decision, 'manual_review');
  assert.equal(evaluateRestrictionRelease({ ...release, record: { ...restriction, status: 'released' } }).decision, 'noop');
});

test('button challenges, callbacks and acknowledgements have explicit validated contracts', () => {
  const challenge = connectorCommandSchema.parse({ ...command(), params: {
    segments: [{ type: 'text', text: 'Verify' }], buttons: [[{ type: 'callback', label: 'Verify', value: 'challenge-1:random-token' }]],
  } });
  assert.deepEqual(requiredCapabilities(challenge), ['messages.send', 'interactions.buttons']);
  const interaction = connectorEventSchema.parse({
    schema_version: '1', event_id: 'callback-event', occurred_at: new Date().toISOString(), source,
    type: 'interaction.created', data: { interaction_id: 'callback-1', user_id: 'u1', value: 'challenge-1:random-token', expires_at: new Date(Date.now() + 10_000).toISOString(), acknowledged: false },
  });
  assert.equal(interaction.type, 'interaction.created');
  const ack = connectorCommandSchema.parse({ ...command(), action: 'interaction.ack', params: { interaction_id: 'callback-1' } });
  assert.deepEqual(requiredCapabilities(ack), ['interactions.ack']);
  assert.equal(connectorCommandSchema.safeParse({ ...command(), action: 'member.unmute', params: { user_id: 'u1', reason: 'passed' } }).success, false);
});

test('key IDs and route purposes are authenticated rather than used as authorization claims', async () => {
  const input = { method: 'POST', path: '/same-path', body: '{}', secret, keyId: 'key-1', purpose: 'events' as const };
  const headers = signRequest(input);
  await assert.rejects(verifyRequest({ ...input, purpose: 'commands', headers, scope: 'w', replayStore: new MemoryReplayStore() }), code('INVALID_SIGNATURE'));
  headers.set('x-superbot-key-id', 'key-2');
  await assert.rejects(verifyRequest({ ...input, keyId: 'key-2', headers, scope: 'w', replayStore: new MemoryReplayStore() }), code('INVALID_SIGNATURE'));
});

test('discovery exposes an idle group and separates platform support from account permissions', async () => {
  const bridge = createDemoBridge({ conversation: source, eventSecret: secret, commandSecret: secret });
  const response = await bridge.handleDiscovery(new Request(`http://localhost${CONVERSATION_PATH}`, {
    headers: signRequest({ method: 'GET', path: CONVERSATION_PATH, body: '', secret, keyId: 'demo-commands', purpose: 'control' }),
  }));
  assert.equal(response.status, 200);
  const page = conversationPageSchema.parse(await response.json());
  assert.equal(page.items.length, 1);
  assert.equal(bridge.events.length, 0);
  const room = page.items[0]!;
  assert.equal(hasEffectiveCapability(room, 'messages.send'), true);
  assert.equal(hasEffectiveCapability({ ...room, permissions: [{ capability: 'messages.send', permission: 'denied' }] }, 'messages.send'), false);
  assert.equal(hasEffectiveCapability({ ...room, permissions: [] }, 'messages.send'), false);
  assert.equal(conversationPageSchema.safeParse({ ...page, items: [{ ...room, account_id: 'foreign-account' }] }).success, false);
});

test('control contracts bind session revisions and stable pagination snapshots', () => {
  const handshake = handshakeSchema.parse({ connector_id: source.connector_id, account_id: source.account_id,
    schema_version: '1', protocol_revision: '0.2', connector_type: 'custom-teamchat', instance_id: 'process-1', display_name: 'Chat', capabilities: [],
  });
  assert.equal(handshake.connector_type, 'custom-teamchat');
  assert.equal(discoveryQuerySchema.safeParse({ cursor: 'page-2' }).success, false);
  assert.equal(discoveryQuerySchema.safeParse({ cursor: 'page-2', snapshot_id: 'snapshot-1', limit: 100 }).success, true);
  const beat = heartbeatSchema.parse({
    connector_id: source.connector_id, account_id: source.account_id, schema_version: '1',
    session_id: 'session-new', sequence: 2, state: 'online', observed_at: new Date().toISOString(), last_event_at: null,
  });
  assert.equal(acceptHeartbeat({ ...source, session_id: 'session-new', sequence: 1 }, beat), true);
  assert.equal(acceptHeartbeat({ ...source, session_id: 'session-old', sequence: 1 }, beat), false);
  assert.equal(acceptHeartbeat({ ...source, session_id: 'session-new', sequence: 2 }, beat), false);
  assert.equal(acceptHeartbeat({ ...source, account_id: 'another-account', session_id: 'session-new', sequence: 1 }, beat), false);
  assert.equal(permissionSnapshotSchema.safeParse({
    ...source, schema_version: '1', session_id: 'session-new', revision: 1,
    observed_at: new Date().toISOString(), permissions: [{ capability: 'messages.send', permission: 'denied' }],
  }).success, true);
});
