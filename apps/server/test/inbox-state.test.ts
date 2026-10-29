import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSnapshot,
  prependHistory,
  rememberSnapshot,
  visibleInboxGroups,
  partitionInboxDeliveries,
  type InboxSnapshot,
} from '../../admin/src/inbox-state.ts';

const messages = (from: number, through: number) =>
  Array.from({ length: through - from + 1 }, (_, index) => {
    const id = String(from + index).padStart(4, '0');
    return { id, created_at: '2026-10-27T12:00:00.000Z', content: id };
  });
const snapshot = (from: number, through: number, hasMore: boolean): InboxSnapshot => ({
  conversation: { id: 'room' },
  conversations: [],
  messages: messages(from, through),
  deliveries: [],
  pagination: { before: String(from).padStart(4, '0'), has_more: hasMore },
});

test('completed failures remain inspectable without being appended as the latest live chat', () => {
  for (const platform of ['qq', 'telegram', 'binance']) {
    const jobs = ['failed', 'cancelled', 'pending', 'in_flight', 'accepted', 'unknown', 'succeeded'].map(
      (status) => ({
        id: platform + ':' + status,
        platform,
        status,
        last_error: status === 'failed' ? '账号未在线' : null,
      }),
    );
    const before = JSON.stringify(jobs);
    const { active, history } = partitionInboxDeliveries(jobs);
    assert.deepEqual(
      history.map((job) => job.status),
      ['failed', 'cancelled'],
    );
    assert.deepEqual(
      active.map((job) => job.status),
      ['pending', 'in_flight', 'accepted', 'unknown'],
    );
    assert.equal(history[0]?.last_error, '账号未在线');
    assert.equal(
      JSON.stringify(jobs),
      before,
      'presentation must never clear or change real execution receipts',
    );
    jobs[0]!.status = 'succeeded';
    assert.deepEqual(
      partitionInboxDeliveries(jobs).history.map((job) => job.status),
      ['cancelled'],
    );
  }
});

test('initial inbox groups hide deselected Telegram, QQ and Binance rooms while retaining other sources', () => {
  const groups = ['qq', 'telegram', 'binance'].flatMap((platform) => [
    { id: `${platform}-on`, platform, sync_enabled: true },
    { id: `${platform}-off`, platform, sync_enabled: false },
  ]);
  groups.push({ id: 'custom', platform: 'custom', sync_enabled: true });
  assert.deepEqual(
    visibleInboxGroups(groups).map((group) => group.id),
    ['qq-on', 'telegram-on', 'binance-on', 'custom'],
  );
  assert.deepEqual(visibleInboxGroups(groups.filter((group) => !group.sync_enabled)), []);
});

test('switching cached rooms and late preloads never restore deselected groups or disturb saved history', () => {
  const cache = new Map<string, InboxSnapshot>();
  const groups = ['qq', 'telegram', 'binance'].map((id) => ({ id, platform: id }));
  const observed = (second: number) => `2026-10-28T00:00:${String(second).padStart(2, '0')}.000000Z`;
  const room = (id: string, second: number, visible = groups): InboxSnapshot => ({
    ...snapshot(1, 25, true),
    observed_at: observed(second),
    conversation: { id, can_send: true },
    conversations: visible,
  });
  let directory = rememberSnapshot(cache, room('qq', 1));
  directory = rememberSnapshot(cache, room('telegram', 2), directory);
  directory = rememberSnapshot(cache, room('binance', 3), directory);
  const history = cache.get('telegram')!.messages;
  const pagination = cache.get('telegram')!.pagination;
  directory = rememberSnapshot(cache, room('qq', 5, groups.slice(0, 2)), directory);
  assert.deepEqual(
    cache.get('telegram')!.conversations.map((g) => g.id),
    ['qq', 'telegram'],
  );
  assert.equal(cache.get('telegram')!.messages, history);
  assert.equal(cache.get('telegram')!.pagination, pagination);
  assert.equal(cache.get('binance')!.conversation.sync_enabled, false);
  assert.equal(cache.get('binance')!.conversation.can_send, false);
  // An HTTP preload started before the new selection can finish after the live snapshot.
  directory = rememberSnapshot(cache, room('telegram', 4), directory);
  assert.deepEqual(
    directory.groups.map((g) => g.id),
    ['qq', 'telegram'],
  );
  assert(!cache.get('telegram')!.conversations.some((g) => g.id === 'binance'));
  directory = rememberSnapshot(cache, room('qq', 6, []), directory);
  assert([...cache.values()].every((s) => !s.conversations.length && s.conversation.sync_enabled === false));
  directory = rememberSnapshot(cache, room('binance', 7, groups.slice(2)), directory);
  assert.equal(cache.get('binance')!.conversation.sync_enabled, true);
  assert.equal(cache.get('binance')!.conversation.can_send, true);
  assert.deepEqual(
    directory.groups.map((g) => g.id),
    ['binance'],
  );
});

test('a delayed preload cannot restore old message content after a newer live snapshot', () => {
  const old = { ...snapshot(1, 25, false), observed_at: '2026-10-28T00:00:01.000001Z' };
  const latest = { ...snapshot(1, 25, false), observed_at: '2026-10-28T00:00:01.000002Z' };
  latest.messages[0] = { ...latest.messages[0], content: '消息已删除', deleted: true };
  assert.equal(mergeSnapshot(latest, old), latest);
  assert.equal(mergeSnapshot(latest, old).messages[0]!.deleted, true);
});

test('a room receiving more than 100 messages while closed keeps the missing interval reachable through history', () => {
  const cached = snapshot(1, 20, false);
  const current = mergeSnapshot(cached, snapshot(201, 300, true));
  assert.equal(current.messages.length, 100);
  assert.deepEqual(current.pagination, { before: '0201', has_more: true });
  const page = { messages: messages(151, 200), pagination: { before: '0151', has_more: true } };
  const history = prependHistory(current, page, '0201');
  assert.equal(history.messages.length, 150);
  assert.equal(history.messages[0]!.id, '0151');
  assert.equal(history.messages.at(-1)!.id, '0300');
});

test('overlapping live snapshots preserve paged history and apply new edits without duplication', () => {
  const cached = snapshot(51, 200, true);
  const incoming = snapshot(102, 201, true);
  incoming.messages[0]!.content = 'edited';
  const current = mergeSnapshot(cached, incoming);
  assert.equal(current.messages.length, 151);
  assert.deepEqual(current.pagination, cached.pagination);
  assert.equal(current.messages.find((message) => message.id === '0102')!.content, 'edited');
  assert.equal(new Set(current.messages.map((message) => message.id)).size, 151);
  assert.equal(mergeSnapshot(snapshot(1, 100, false), snapshot(2, 101, true)).pagination.has_more, false);
});

test('an old history response cannot reconnect a discarded cache across a missing message interval', () => {
  const current = mergeSnapshot(snapshot(51, 150, true), snapshot(251, 350, true));
  const late = { messages: messages(1, 50), pagination: { before: '0001', has_more: false } };
  assert.equal(prependHistory(current, late, '0051'), current);
  assert.deepEqual(current.pagination, { before: '0251', has_more: true });
  const other = snapshot(1, 30, false);
  other.conversation.id = 'other';
  assert.equal(mergeSnapshot(current, other), other);
});
