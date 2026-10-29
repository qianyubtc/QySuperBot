import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readInboxDrafts,
  saveInboxDrafts,
  readInboxSendAttempts,
  saveInboxSendAttempts,
  inboxSendIntent,
  readInboxReplies,
  saveInboxReplies,
} from '../../admin/src/inbox-drafts.ts';

const memory = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};
test('chat drafts survive reloads for separate rooms without crossing administrator boundaries', () => {
  const storage = memory();
  assert.equal(saveInboxDrafts('admin-a', { telegram: 'TG 草稿', qq: 'QQ 草稿' }, storage), true);
  assert.equal(saveInboxDrafts('admin-b', { telegram: '另一位管理员的草稿' }, storage), true);
  assert.deepEqual(readInboxDrafts('admin-a', storage), { telegram: 'TG 草稿', qq: 'QQ 草稿' });
  assert.deepEqual(readInboxDrafts('admin-b', storage), { telegram: '另一位管理员的草稿' });
  saveInboxDrafts('admin-a', { telegram: '', qq: 'QQ 草稿' }, storage);
  assert.deepEqual(readInboxDrafts('admin-a', storage), { qq: 'QQ 草稿' });
  saveInboxDrafts('admin-a', {}, storage);
  assert.equal(storage.values.has('admin-a'), false);
  assert.equal(readInboxDrafts('admin-b', storage).telegram, '另一位管理员的草稿');
});
test('unsent quotes survive reload independently of send keys and clearing remains explicit', () => {
  const storage = memory();
  const quote = { id: 'message-quote', sender_name: '小羽', content: '原消息' };
  assert.equal(readInboxReplies('quotes:admin', storage), undefined);
  assert.equal(saveInboxReplies('quotes:admin', { qq: quote }, storage), true);
  assert.deepEqual(readInboxReplies('quotes:admin', storage), { qq: quote });
  assert.equal(readInboxReplies('quotes:other', storage), undefined);
  assert.deepEqual(readInboxSendAttempts('sends:admin', storage), {});
  saveInboxReplies(
    'quotes:admin',
    { qq: { ...quote, content: 'x'.repeat(400), extra: 'not-persisted' } } as any,
    storage,
  );
  assert.equal(readInboxReplies('quotes:admin', storage)?.qq?.content.length, 280);
  assert(!storage.getItem('quotes:admin')!.includes('not-persisted'));
  saveInboxReplies('quotes:admin', { qq: undefined }, storage);
  assert.deepEqual(readInboxReplies('quotes:admin', storage), {});
  assert.equal(storage.getItem('quotes:admin'), '{}');
  storage.setItem('quotes:admin', JSON.stringify({ invalid: { id: '' }, valid: quote }));
  assert.deepEqual(readInboxReplies('quotes:admin', storage), { valid: quote });
  storage.setItem('quotes:admin', '{');
  assert.deepEqual(readInboxReplies('quotes:admin', storage), {});
});
test('unavailable or malformed browser storage never prevents opening and editing the inbox', () => {
  const storage = memory();
  for (const raw of ['{', 'null', '[]', '42', 'x'.repeat(512_001)]) {
    storage.values.set('admin', raw);
    assert.deepEqual(readInboxDrafts('admin', storage), {});
  }
  storage.values.set('admin', JSON.stringify({ normal: '保留', wrong: 123, excessive: 'x'.repeat(8001) }));
  assert.deepEqual(readInboxDrafts('admin', storage), { normal: '保留' });
  const blocked = {
    getItem: () => {
      throw Error('disabled');
    },
    setItem: () => {
      throw Error('quota');
    },
    removeItem: () => {
      throw Error('disabled');
    },
  };
  assert.deepEqual(readInboxDrafts('admin', blocked), {});
  assert.equal(saveInboxDrafts('admin', { qq: '仍然可以在内存中编辑' }, blocked), false);
});
test('draft persistence has a bounded room count and keeps the most recently edited entries', () => {
  const storage = memory();
  const drafts = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`room-${i}`, `草稿 ${i}`]));
  saveInboxDrafts('admin', drafts, storage);
  const restored = readInboxDrafts('admin', storage);
  assert.equal(Object.keys(restored).length, 30);
  assert.equal(restored['room-0'], undefined);
  assert.equal(restored['room-39'], '草稿 39');
});
test('pending chat submissions retain the same key and quoted message across reloads', () => {
  const storage = memory();
  const pending = {
    key: 'submission-12345678',
    text: '回复测试',
    reply: { id: 'message-123', sender_name: '小羽', content: '原始消息' },
  };
  assert.equal(saveInboxSendAttempts('sends:admin-a', { room: pending }, storage), true);
  const restored = readInboxSendAttempts('sends:admin-a', storage).room;
  assert.deepEqual(restored, pending);
  assert.equal(inboxSendIntent(restored), inboxSendIntent(pending));
  assert.notEqual(inboxSendIntent({ ...restored, reply: undefined }), inboxSendIntent(pending));
  assert.notEqual(inboxSendIntent({ ...restored, text: '新消息' }), inboxSendIntent(pending));
  assert.deepEqual(readInboxSendAttempts('sends:admin-b', storage), {});
  saveInboxSendAttempts('sends:admin-a', {}, storage);
  assert.deepEqual(readInboxSendAttempts('sends:admin-a', storage), {});
});
test('pending chat submissions reject malformed records and bound browser storage', () => {
  const storage = memory();
  for (const raw of ['null', '{', '[]', 'x'.repeat(512_001)]) {
    storage.values.set('sends', raw);
    assert.deepEqual(readInboxSendAttempts('sends', storage), {});
  }
  storage.values.set(
    'sends',
    JSON.stringify({
      short: { key: 'short', text: '内容' },
      blank: { key: 'valid-key-1234', text: '  ' },
      invalidQuote: { key: 'valid-key-1234', text: '内容', reply: {} },
      valid: { key: 'valid-key-1234', text: '内容' },
    }),
  );
  assert.deepEqual(Object.keys(readInboxSendAttempts('sends', storage)), ['valid']);
  const attempts = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`room-${i}`, { key: `submission-${i}`, text: `内容 ${i}` }]),
  );
  saveInboxSendAttempts('sends', attempts, storage);
  assert.equal(Object.keys(readInboxSendAttempts('sends', storage)).length, 30);
  assert.equal(readInboxSendAttempts('sends', storage)['room-0'], undefined);
  assert.equal(readInboxSendAttempts('sends', storage)['room-39']?.key, 'submission-39');
  const blocked = {
    getItem: () => {
      throw Error('disabled');
    },
    setItem: () => {
      throw Error('quota');
    },
    removeItem: () => {
      throw Error('disabled');
    },
  };
  assert.deepEqual(readInboxSendAttempts('sends', blocked), {});
  assert.equal(saveInboxSendAttempts('sends', attempts, blocked), false);
});
