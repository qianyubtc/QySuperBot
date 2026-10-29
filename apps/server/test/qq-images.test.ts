import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { ApiError, SecretBox } from '../src/security.ts';
import { groupSnapshot, qqEvents } from '../src/adapters.ts';
import { testPng } from './image-fixture.ts';

async function fixture() {
  const s = await createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const created = await s.accounts.create(
    { kind: 'qq', name: 'image fixture', endpoint: 'https://qq.example', token: 'fixture-only' },
    'test',
  );
  await s.db.query("UPDATE accounts SET external_id='12345',status='online' WHERE id=$1", [created.id]);
  const account = await s.accounts.get(created.id);
  const group = await s.accounts.upsertGroup(
    account,
    groupSnapshot('67890', 'QQ images', 'group', 3, 'qq', true),
  );
  const payload: any = {
    time: Math.floor(Date.now() / 1000),
    self_id: 12345,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: 67890,
    user_id: 99999,
    message_id: 10001,
    sender: { user_id: 99999, nickname: 'fixture' },
    message: [{ type: 'image', data: { file: 'a'.repeat(32), url: 'https://cdn.example/stored' } }],
  };
  const event = qqEvents(account, payload)[0]!;
  await s.messages.ingest(account, event.event, event.name, false, event.presentation);
  const row = (await s.db.query('SELECT * FROM messages WHERE conversation_id=$1', [group]))[0]!;
  const calls: string[] = [];
  let reply = structuredClone(payload);
  reply.message[0].data.url = 'https://cdn.example/expired-legacy';
  s.adapters.qq = async (_account, action) => {
    calls.push(action);
    return {
      status: 200,
      data: {
        status: 'ok',
        retcode: 0,
        data: action === 'get_msg' ? reply : { url: 'https://cdn.example/renewed' },
      },
    };
  };
  s.chat.loadImage = async (url) => {
    calls.push(url);
    if (url !== 'https://cdn.example/renewed') throw new ApiError(502, 'IMAGE_UNAVAILABLE', 'expired');
    return { body: testPng(), contentType: 'image/png' };
  };
  return {
    s,
    account,
    group,
    row,
    calls,
    payload,
    setReply: (value: any) => {
      reply = value;
    },
  };
}
test('expired stored and legacy QQ links renew through the exact message and native image lookup, then reuse cached bytes', async () => {
  const f = await fixture();
  try {
    const [one, two] = await Promise.all([
      f.s.chat.image(f.group, f.row.id),
      f.s.chat.image(f.group, f.row.id),
    ]);
    assert(one.body.equals(testPng()));
    assert.equal(one, two);
    assert.deepEqual(f.calls, [
      'https://cdn.example/stored',
      'get_msg',
      'https://cdn.example/expired-legacy',
      'get_image',
      'https://cdn.example/renewed',
    ]);
    await f.s.chat.image(f.group, f.row.id);
    assert.equal(f.calls.length, 5);
    await f.s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [f.account.id]);
    await assert.rejects(f.s.chat.image(f.group, f.row.id), { code: 'GROUP_SYNC_DISABLED' });
  } finally {
    await f.s.close();
  }
});
test('mismatched QQ readbacks and unsafe native file references cannot supply replacement media', async () => {
  const f = await fixture();
  try {
    for (const field of ['group_id', 'message_id', 'user_id']) {
      f.calls.length = 0;
      const wrong = structuredClone(f.payload);
      wrong[field] = 88888;
      f.setReply(wrong);
      await assert.rejects(f.s.chat.image(f.group, f.row.id), { code: 'QQ_IMAGE_UNAVAILABLE' });
      assert.deepEqual(f.calls, ['https://cdn.example/stored', 'get_msg']);
    }
    for (const file of ['/etc/passwd', 'file:///secret', 'https://127.0.0.1/image', '../other.png']) {
      f.calls.length = 0;
      const wrong = structuredClone(f.payload);
      wrong.message[0].data.file = file;
      f.setReply(wrong);
      await assert.rejects(f.s.chat.image(f.group, f.row.id), { code: 'QQ_IMAGE_UNAVAILABLE' });
      assert(!f.calls.includes('get_image'));
    }
  } finally {
    await f.s.close();
  }
});
test('media edits and cancellations invalidate QQ image results, including pending requests', async () => {
  const f = await fixture();
  try {
    await f.s.chat.image(f.group, f.row.id);
    f.calls.length = 0;
    await f.s.db.query("UPDATE messages SET media='[]'::jsonb WHERE id=$1", [f.row.id]);
    f.s.chat.loadImage = async () => {
      await f.s.db.query('UPDATE messages SET deleted=true WHERE id=$1', [f.row.id]);
      return { body: testPng(), contentType: 'image/png' };
    };
    await assert.rejects(f.s.chat.image(f.group, f.row.id), { code: 'IMAGE_NOT_FOUND' });
    assert.equal(f.s.chat.qqImagePending.size, 0);
  } finally {
    await f.s.close();
  }
});
test('QQ images prefer a working stored URL even if the native message API is unavailable', async () => {
  const f = await fixture();
  try {
    f.s.chat.loadImage = async (url) => {
      f.calls.push(url);
      return { body: testPng(), contentType: 'image/png' };
    };
    assert((await f.s.chat.image(f.group, f.row.id)).body.equals(testPng()));
    assert.deepEqual(f.calls, ['https://cdn.example/stored']);
  } finally {
    await f.s.close();
  }
});
test('a bridge restart can rebuild old short IDs from bounded history in the original group', async () => {
  const f = await fixture();
  try {
    let pages = 0;
    f.s.adapters.qq = async (_account, action, params: any) => {
      f.calls.push(action);
      if (action === 'get_msg') return { status: 200, data: { status: 'failed', retcode: 200 } };
      if (action === 'get_group_msg_history') {
        assert.equal(params.group_id, '67890');
        assert.equal(params.count, 100);
        assert.equal(params.parse_mult_msg, false);
        assert.equal(params.quick_reply, true);
        pages++;
        if (pages === 1)
          return {
            status: 200,
            data: { retcode: 0, data: { messages: [{ ...f.payload, message_id: 20002, time: 100 }] } },
          };
        assert.equal(params.message_seq, '20002');
        const target = structuredClone(f.payload);
        target.message[0].data.url = 'https://cdn.example/renewed';
        return { status: 200, data: { retcode: 0, data: { messages: [target] } } };
      }
      throw Error('unexpected mutation');
    };
    assert((await f.s.chat.image(f.group, f.row.id)).body.equals(testPng()));
    assert.equal(pages, 2);
    assert(!f.calls.includes('get_image'));
    f.s.chat.qqImageCache.clear();
    pages = 0;
    f.s.adapters.qq = async (_a, action) =>
      action === 'get_msg'
        ? { status: 200, data: { retcode: 200 } }
        : { status: 200, data: { retcode: 0, data: { messages: [{ ...f.payload, group_id: 77777 }] } } };
    await assert.rejects(f.s.chat.image(f.group, f.row.id), { code: 'QQ_IMAGE_UNAVAILABLE' });
  } finally {
    await f.s.close();
  }
});
