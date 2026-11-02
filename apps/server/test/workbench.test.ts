import assert from 'node:assert/strict';
import test from 'node:test';
import { filterChatScope, selectedAvailableIds, sortDirectory } from '../../admin/src/workbench.ts';

test('directory sorting is deterministic and leaves source order unchanged', () => {
  const groups = [
    { id: 'b', name: 'B', messages_24h: 2, member_count: null },
    { id: 'c', name: 'C', messages_24h: 10, member_count: 4 },
    { id: 'a', name: 'A', messages_24h: 2, member_count: 8 },
  ];
  assert.deepEqual(
    sortDirectory(groups, 'activity').map((g) => g.id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    sortDirectory(groups, 'members').map((g) => g.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    sortDirectory(groups, 'name').map((g) => g.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    groups.map((g) => g.id),
    ['b', 'c', 'a'],
  );
});

test('chat scopes distinguish unread discussions from nonempty drafts', () => {
  const groups = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const unread = new Set(['b', 'removed']);
  const drafts = { a: '  ', c: '继续讨论', removed: '旧群' };
  assert.deepEqual(filterChatScope(groups, 'unread', unread, drafts), [{ id: 'b' }]);
  assert.deepEqual(filterChatScope(groups, 'drafts', unread, drafts), [{ id: 'c' }]);
  assert.deepEqual(filterChatScope(groups, 'all', unread, drafts), groups);
});

test('broadcast selection excludes removed or disabled groups and deduplicates targets', () => {
  assert.deepEqual(
    selectedAvailableIds(['a', 'b', 'a', 'removed'], [{ id: 'a' }, { id: 'b', sync_enabled: false }]),
    ['a'],
  );
});
