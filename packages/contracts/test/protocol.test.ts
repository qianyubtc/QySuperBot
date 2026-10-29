import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  connectorCommandSchema, connectorEventSchema, MemoryIdempotencyStore,
  MemoryReplayStore, nextSyncTrace, ProtocolError, receiptSchema,
  signRequest, startTrace, traceSchema, verifyRequest,
} from '../src/index.ts';
import { COMMAND_PATH, createDemoBridge, EVENT_PATH } from '../../../examples/custom-chat/handlers.ts';

const secret = randomBytes(32).toString('hex');
const source = { connector_id: 'custom-teamchat', account_id: 'account-1', conversation_id: 'room-1' };
function event() {
  return connectorEventSchema.parse({
    schema_version: '1', event_id: 'event-1', occurred_at: new Date().toISOString(),
    source, type: 'message.created',
    data: { message_id: '90071992547409931234', sender_id: 'user-1', direction: 'incoming', segments: [{ type: 'text', text: 'Hello' }] },
  });
}
function command() {
  return connectorCommandSchema.parse({
    schema_version: '1', command_id: 'command-1', idempotency_key: 'key-1',
    attempt_id: 'attempt-1', attempt_number: 1, logical_conversation_id: 'demo-logical-room',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    target: source, action: 'message.send', params: { segments: [{ type: 'text', text: 'Hello' }] },
  });
}
function signedRequest(path: string, payload: unknown, signingSecret = secret) {
  const body = JSON.stringify(payload);
  return new Request(`http://localhost${path}`, {
    method: 'POST', body, headers: signRequest({
      method: 'POST', path, body, secret: signingSecret,
      keyId: path === EVENT_PATH ? 'demo-events' : 'demo-commands',
      purpose: path === EVENT_PATH ? 'events' : 'commands',
    }),
  });
}
function isError(code: string) {
  return (error: unknown) => error instanceof ProtocolError && error.code === code;
}

test('preserves large platform IDs and rejects malformed discriminated payloads', () => {
  const value = event();
  assert.equal(value.type === 'message.created' && value.data.message_id, '90071992547409931234');
  assert.equal(connectorEventSchema.safeParse({ ...value, source: { ...source, conversation_id: 123 } }).success, false);
  assert.equal(connectorEventSchema.safeParse({ ...value, data: { message_id: 'm' } }).success, false);
  assert.equal(connectorEventSchema.safeParse({ ...value, schema_version: '2' }).success, false);
  assert.equal(connectorCommandSchema.safeParse({ ...command(), action: 'member.remove' }).success, false);
  assert.equal(receiptSchema.safeParse({ schema_version: '1', command_id: 'c', observed_at: new Date().toISOString(), status: 'failed' }).success, false);
  assert.equal(receiptSchema.safeParse({
    schema_version: '1', command_id: 'c', observed_at: new Date().toISOString(), status: 'unknown',
    attempt_id: 'a1', attempt_number: 1, revision: 1,
    error: { code: 'TIMEOUT', message: 'Outcome could not be confirmed', retryable: true },
  }).success, false);
});

test('signature binds the original body, method, path and query string', async () => {
  const input = { method: 'POST', path: EVENT_PATH + '?key=one', body: '{}', secret, now: 1000, keyId: 'test-key', purpose: 'events' as const };
  const headers = signRequest(input);
  for (const alteration of [ { body: '{} ' }, { method: 'DELETE' }, { path: EVENT_PATH + '?key=two' } ]) {
    await assert.rejects(verifyRequest({ ...input, ...alteration, headers, scope: 'a', replayStore: new MemoryReplayStore() }), isError('INVALID_SIGNATURE'));
  }
  await verifyRequest({ ...input, headers, scope: 'a', replayStore: new MemoryReplayStore() });
});

test('rejects expired and future requests and signed nonce replays', async () => {
  const input = { method: 'POST', path: EVENT_PATH, body: '{}', secret, now: 1000, keyId: 'test-key', purpose: 'events' as const };
  const headers = signRequest(input);
  const replayStore = new MemoryReplayStore();
  await assert.rejects(verifyRequest({ ...input, now: 1301, headers, scope: 'a', replayStore }), isError('STALE_REQUEST'));
  await assert.rejects(verifyRequest({ ...input, now: 699, headers, scope: 'a', replayStore }), isError('STALE_REQUEST'));
  await verifyRequest({ ...input, headers, scope: 'a', replayStore });
  await assert.rejects(verifyRequest({ ...input, headers, scope: 'a', replayStore }), isError('REPLAYED_REQUEST'));
});

test('invalid signatures do not consume a valid request nonce', async () => {
  const input = { method: 'POST', path: EVENT_PATH, body: '{}', secret, now: 1000, keyId: 'test-key', purpose: 'events' as const };
  const headers = signRequest(input);
  const replayStore = new MemoryReplayStore();
  await assert.rejects(verifyRequest({ ...input, body: 'changed', headers, scope: 'a', replayStore }), isError('INVALID_SIGNATURE'));
  await verifyRequest({ ...input, headers, scope: 'a', replayStore });
});

test('coalesces concurrent deliveries, rejects changed payloads and separates accounts', async () => {
  const store = new MemoryIdempotencyStore<number>();
  let effects = 0;
  const operation = async () => { effects++; return 42; };
  const results = await Promise.all(Array.from({ length: 10 }, () => store.run('account-1', 'key', { a: 1, b: 2 }, operation)));
  assert.equal(effects, 1);
  assert.equal(results.filter(result => result.duplicate).length, 9);
  assert.equal((await store.run('account-1', 'key', { b: 2, a: 1 }, operation)).duplicate, true);
  await assert.rejects(store.run('account-1', 'key', { a: 2 }, operation), isError('IDEMPOTENCY_CONFLICT'));
  await store.run('account-2', 'key', { a: 2 }, operation);
  assert.equal(effects, 2);
});

test('blocks synchronization loops while allowing distinct rooms on one connector', () => {
  const a = startTrace('logical-room-1', 'canonical-event-1');
  const second = 'logical-room-2';
  const b = nextSyncTrace(a, second)!;
  assert.ok(b);
  assert.equal(nextSyncTrace(b, 'logical-room-1'), null);
  assert.equal(nextSyncTrace(b, second), null);
  assert.equal(nextSyncTrace(b, 'logical-room-3', 1), null);
  assert.equal(traceSchema.safeParse(a).success, true);
});

test('an exception after a side effect cannot trigger an automatic second execution', async () => {
  const store = new MemoryIdempotencyStore<never>();
  let effects = 0;
  const operation = async () => { effects++; throw new Error('Receipt was lost after sending'); };
  await assert.rejects(store.run('account-1', 'key', {}, operation), /Receipt was lost/);
  await assert.rejects(store.run('account-1', 'key', {}, operation), /Receipt was lost/);
  assert.equal(effects, 1);
});

test('signed round trip has one side effect across concurrent event and command retries', async () => {
  const bridge = createDemoBridge({ conversation: source, eventSecret: secret, commandSecret: secret + 'other' });
  const inbound = event();
  const results = await Promise.all(Array.from({ length: 5 }, () => bridge.handleEvent(signedRequest(EVENT_PATH, inbound))));
  for (const response of results) assert.equal(response.status, 200);
  assert.equal(bridge.messages.length, 1);
  assert.equal(bridge.events.length, 1);
  const payload = command();
  const first = await bridge.handleCommand(signedRequest(COMMAND_PATH, payload, secret + 'other'));
  const second = await bridge.handleCommand(signedRequest(COMMAND_PATH, payload, secret + 'other'));
  assert.deepEqual(await first.json(), await second.json());
  assert.equal(bridge.messages.length, 2);
});

test('credential scope rejects account and conversation impersonation', async () => {
  const bridge = createDemoBridge({ conversation: source, eventSecret: secret, commandSecret: secret });
  for (const changed of [{ account_id: 'other-account' }, { conversation_id: 'other-room' }, { connector_id: 'other-app' }]) {
    const response = await bridge.handleEvent(signedRequest(EVENT_PATH, { ...event(), source: { ...source, ...changed } }));
    assert.equal(response.status, 403);
  }
  const response = await bridge.handleCommand(signedRequest(COMMAND_PATH, { ...command(), target: { ...source, conversation_id: 'other-room' } }));
  assert.equal(response.status, 403);
  assert.equal(bridge.messages.length, 0);
});

test('expired and unsupported commands return explicit failures with no side effects', async () => {
  const bridge = createDemoBridge({ conversation: source, eventSecret: secret, commandSecret: secret });
  const expired = { ...command(), created_at: new Date(Date.now() - 120_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString() };
  const response = await bridge.handleCommand(signedRequest(COMMAND_PATH, expired));
  assert.equal((await response.json()).error.code, 'COMMAND_EXPIRED');
  const unsupported = { ...command(), command_id: 'command-2', idempotency_key: 'key-2', action: 'member.remove', params: { user_id: 'user-2', reason: 'Spam' } };
  const other = await bridge.handleCommand(signedRequest(COMMAND_PATH, unsupported));
  assert.equal((await other.json()).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(bridge.messages.length, 0);
});

test('changing an executed command payload or reassigning its ID is rejected', async () => {
  const bridge = createDemoBridge({ conversation: source, eventSecret: secret, commandSecret: secret });
  const payload = command();
  assert.equal((await bridge.handleCommand(signedRequest(COMMAND_PATH, payload))).status, 200);
  const changed = { ...payload, params: { segments: [{ type: 'text', text: 'Changed' }] } };
  assert.equal((await bridge.handleCommand(signedRequest(COMMAND_PATH, changed))).status, 409);
  assert.equal((await bridge.handleCommand(signedRequest(COMMAND_PATH, { ...payload, idempotency_key: 'different-key' }))).status, 409);
  assert.equal(bridge.messages.length, 1);
});

test('malformed JSON and oversized bodies are rejected without execution', async () => {
  const bridge = createDemoBridge({ conversation: source, eventSecret: secret, commandSecret: secret });
  for (const [body, status] of [['{invalid', 400], ['a'.repeat(256 * 1024 + 1), 413]] as const) {
    const request = new Request(`http://localhost${EVENT_PATH}`, {
      method: 'POST', body, headers: signRequest({ method: 'POST', path: EVENT_PATH, body, secret, keyId: 'demo-events', purpose: 'events' }),
    });
    assert.equal((await bridge.handleEvent(request)).status, status);
  }
  assert.equal(bridge.messages.length, 0);
});

test('outgoing echoes and forwarded events do not produce another automated reply', async () => {
  const bridge = createDemoBridge({ conversation: source, eventSecret: secret, commandSecret: secret });
  const incoming = event();
  assert.equal(incoming.type, 'message.created');
  const outgoing = { ...incoming, data: { ...incoming.data, direction: 'outgoing' } };
  const first = await bridge.handleEvent(signedRequest(EVENT_PATH, outgoing));
  const forwarded = { ...incoming, event_id: 'event-2', trace: startTrace('demo-logical-room', incoming.event_id) };
  const second = await bridge.handleEvent(signedRequest(EVENT_PATH, forwarded));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(bridge.messages.length, 0);
});
