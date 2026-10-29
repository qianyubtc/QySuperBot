import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { groupSnapshot, qqEvents, telegramEvents } from '../src/adapters.ts';
import type { Row } from '../src/database.ts';

const services = () =>
  createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
const group = (id: string, kind: string) => groupSnapshot(id, `Group ${id}`, 'group', 3, kind, true);
function event(account: any, groupId: string, id = randomUUID()) {
  return {
    schema_version: '1',
    event_id: id,
    occurred_at: new Date().toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: groupId },
    type: 'message.created',
    data: {
      message_id: id,
      sender_id: '99999',
      direction: 'incoming',
      segments: [{ type: 'text', text: 'scope fixture' }],
    },
  };
}

test('QQ and Telegram selection fences stale events, cancels pending work and constrains batch sending atomically', async () => {
  const s = await services();
  try {
    for (const kind of ['qq', 'telegram'] as const) {
      const created = await s.accounts.create(
        {
          kind,
          name: kind,
          ...(kind === 'qq' ? { endpoint: 'https://example.com' } : { token: 'fixture-token' }),
        },
        'test',
      );
      s.adapters.discover = async () => ({
        externalId: '12345',
        displayName: kind,
        groups: [group('10001', kind), group('10002', kind)],
      });
      await s.accounts.refresh(created.id, 'test');
      const stale = await s.accounts.get(created.id);
      const bindings = await s.db.query('SELECT * FROM bindings WHERE account_id=$1 ORDER BY external_id', [
        created.id,
      ]);
      const [first, second] = bindings;
      const pending = await s.jobs.enqueue({
        key: randomUUID(),
        conversationId: second!.conversation_id,
        action: 'message.send',
        params: { segments: [{ type: 'text', text: 'cancel me' }] },
      });
      const unknown = await s.jobs.enqueue({
        key: randomUUID(),
        conversationId: second!.conversation_id,
        action: 'message.send',
        params: { segments: [{ type: 'text', text: 'never resend' }] },
      });
      await s.db.query("UPDATE jobs SET status='unknown' WHERE id=$1", [unknown.id]);
      const retryable = await s.jobs.enqueue({
        key: randomUUID(),
        conversationId: second!.conversation_id,
        action: 'message.send',
        params: { segments: [{ type: 'text', text: 'retry only after selecting again' }] },
      });
      await s.db.query("UPDATE jobs SET status='failed',receipt=$2::jsonb WHERE id=$1", [
        retryable.id,
        JSON.stringify({ error: { retryable: true } }),
      ]);
      const before = await s.accounts.groups(created.id);
      assert.equal(before.group_ids.length, 2);
      const selected = await s.accounts.selectGroups(
        created.id,
        { group_ids: ['10001'], revision: before.revision },
        'test',
      );
      assert.deepEqual(selected.group_ids, ['10001']);
      assert.equal(((await s.features.deliveries(pending.id)) as any).status, 'cancelled');
      assert.equal(((await s.features.deliveries(unknown.id)) as any).status, 'unknown');
      await assert.rejects(s.jobs.retry(retryable.id, 'test'), (e: any) => e.code === 'GROUP_SYNC_DISABLED');
      assert.equal(((await s.features.deliveries(retryable.id)) as any).status, 'failed');
      assert.equal((await s.messages.ingest(stale, event(stale, '10001'))).ignored, true);
      const account = await s.accounts.get(created.id);
      assert.equal((await s.messages.ingest(account, event(account, '10002'))).ignored, true);
      await s.messages.ingest(account, event(account, '10001'));
      assert.equal((await s.db.query('SELECT id FROM messages WHERE account_id=$1', [created.id])).length, 1);
      assert.equal((await s.chat.snapshot(second!.conversation_id)).conversation.can_send, false);
      const inbox = await s.chat.snapshot(second!.conversation_id);
      assert.match(inbox.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      assert((await s.chat.snapshot(first!.conversation_id)).observed_at >= inbox.observed_at);
      assert.equal(inbox.conversation.sync_enabled, false);
      assert(!inbox.conversations.some((room: any) => room.id === second!.conversation_id));
      assert(inbox.conversations.some((room: any) => room.id === first!.conversation_id));
      await assert.rejects(
        s.accounts.selectGroups(
          created.id,
          { group_ids: ['10001', '10002'], revision: before.revision },
          'test',
        ),
        (e: any) => e.code === 'SELECTION_CHANGED',
      );
      await assert.rejects(
        s.accounts.selectGroups(
          created.id,
          { group_ids: ['not-joined'], revision: selected.revision },
          'test',
        ),
        (e: any) => e.code === 'GROUP_SCOPE',
      );
      await assert.rejects(
        s.features.createAnnouncement(
          { title: 'batch', content: 'hello', conversation_ids: bindings.map((b) => b.conversation_id) },
          'test',
        ),
        (e: any) => e.code === 'GROUP_SYNC_DISABLED',
      );
      assert.equal((await s.db.query('SELECT id FROM announcements')).length, 0);
      const restored = await s.accounts.selectGroups(
        created.id,
        { group_ids: ['10001', '10002'], revision: selected.revision },
        'test',
      );
      const queued = await s.features.createAnnouncement(
        {
          title: 'batch',
          content: 'hello',
          conversation_ids: [first!.conversation_id, second!.conversation_id],
          scheduled_at: new Date(Date.now() + 60000).toISOString(),
        },
        'test',
      );
      assert.equal((await s.db.query('SELECT id FROM jobs WHERE announcement_id=$1', [queued.id])).length, 2);
      await s.features.cancelAnnouncement(queued.id, 'test');
      await s.db.query('DELETE FROM announcements WHERE id=$1', [queued.id]).catch(() => {});
      // Discovery already in flight cannot overwrite a concurrent selection.
      s.adapters.discover = async () => {
        await s.accounts.selectGroups(created.id, { group_ids: [], revision: restored.revision }, 'test');
        return {
          externalId: '12345',
          displayName: kind,
          groups: [group('10001', kind), group('10002', kind)],
        };
      };
      await assert.rejects(s.accounts.refresh(created.id, 'test'), (e: any) => e.code === 'STALE_CONNECTION');
      assert.deepEqual((await s.accounts.groups(created.id)).group_ids, []);
      await s.db.query('DELETE FROM jobs WHERE announcement_id=$1', [queued.id]);
      await s.db.query('DELETE FROM announcements WHERE id=$1', [queued.id]);
    }
  } finally {
    await s.close();
  }
});

test('Telegram and QQ preserve image captions and multiple images behind authenticated media routes', async () => {
  const s = await services();
  const app = await createHttpApp(s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'media-admin', password: 'media-fixture-password' }),
    });
    const headers = { cookie: setup.headers.get('set-cookie')!.split(';')[0]! };
    const loaded: string[] = [];
    s.chat.loadImage = async (url) => {
      loaded.push(url);
      if (/https:\/\/example\.com\/(one|two)\.png$/.test(url)) throw new Error('expired QQ image link');
      return { body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), contentType: 'image/png' };
    };
    for (const kind of ['telegram', 'qq'] as const) {
      const created = await s.accounts.create(
        {
          kind,
          name: kind,
          ...(kind === 'telegram' ? { token: 'private-fixture-token' } : { endpoint: 'https://example.com' }),
        },
        'test',
      );
      await s.db.query("UPDATE accounts SET status='online',external_id='12345' WHERE id=$1", [created.id]);
      const account = await s.accounts.get(created.id);
      const id = await s.accounts.upsertGroup(account, group('10001', kind));
      const message =
        kind === 'telegram'
          ? telegramEvents(account, {
              update_id: 1,
              message: {
                message_id: 42,
                date: Math.floor(Date.now() / 1000),
                from: { id: 99999, first_name: '昵称' },
                chat: { id: 10001, type: 'supergroup' },
                caption: '图片说明',
                photo: [
                  { file_id: 'small', file_size: 10 },
                  { file_id: 'photo-file-id', file_size: 200 },
                ],
              },
            })[0]!
          : qqEvents(account, {
              time: Math.floor(Date.now() / 1000),
              post_type: 'message',
              message_type: 'group',
              group_id: 10001,
              message_id: 42,
              user_id: 99999,
              sender: { card: '群名片' },
              message: [
                { type: 'text', data: { text: '图片说明' } },
                { type: 'image', data: { file: 'one.jpg', url: 'https://example.com/one.png' } },
                { type: 'image', data: { file: 'two.jpg', url: 'https://example.com/two.png' } },
              ],
            })[0]!;
      await s.messages.ingest(account, message.event, message.name, false, message.presentation);
      const record = (await s.chat.snapshot(id)).messages[0]!;
      assert.equal(record.sender_name, kind === 'telegram' ? '昵称' : '群名片');
      assert.equal(record.segments[0].text, '图片说明');
      assert.equal(
        record.segments.filter((p: any) => p.type === 'image').length,
        kind === 'telegram' ? 1 : 2,
      );
      assert(!JSON.stringify(record).includes('photo-file-id'));
      let profileCalls = 0;
      s.adapters.telegram = async (_account, action, params: any) => {
        if (action === 'getFile')
          return {
            status: 200,
            data: { ok: true, result: { file_path: `photos/${params.file_id}.jpg`, file_size: 200 } },
          };
        assert.equal(action, 'getUserProfilePhotos');
        profileCalls++;
        return { status: 200, data: { ok: true, result: { photos: [[{ file_id: 'avatar-file-id' }]] } } };
      };
      s.adapters.qq = async () => ({
        status: 200,
        data: {
          retcode: 0,
          data: {
            message_id: 42,
            group_id: 10001,
            user_id: 99999,
            message: [
              { type: 'image', data: { file: 'new1.jpg', url: 'https://example.com/refreshed-one.png' } },
              { type: 'image', data: { file: 'new2.jpg', url: 'https://example.com/refreshed-two.png' } },
            ],
          },
        },
      });
      const path = `${base}/conversations/${id}/messages/${record.id}`;
      assert.equal((await fetch(path + '/image')).status, 401);
      const response = await fetch(path + '/image', { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.match(response.headers.get('cache-control')!, /no-store/);
      assert.equal((await fetch(path + '/image?index=-1', { headers })).status, 400);
      if (kind === 'qq') {
        assert.equal((await fetch(path + '/image?index=1', { headers })).status, 200);
        assert.equal(loaded.at(-1), 'https://example.com/refreshed-two.png');
      } else {
        assert(loaded.some((url) => url.endsWith('/photos/photo-file-id.jpg')));
        assert(!JSON.stringify(await s.chat.snapshot(id)).includes('private-fixture-token'));
      }
      const avatars = await Promise.all([s.chat.avatar(id, record.id), s.chat.avatar(id, record.id)]);
      assert.equal(avatars.length, 2);
      if (kind === 'telegram') assert.equal(profileCalls, 1);
      await s.db.query('UPDATE messages SET deleted=true WHERE id=$1', [record.id]);
      assert.equal((await fetch(path + '/image', { headers })).status, 404);
      assert.equal((await fetch(path + '/avatar', { headers })).status, 404);
    }
  } finally {
    await app.close();
    await s.close();
  }
});

test('history uses a stable composite cursor across identical timestamps and does not cross conversation scope', async () => {
  const s = await services();
  try {
    const created = await s.accounts.create(
      { kind: 'qq', name: 'history', endpoint: 'https://example.com' },
      'test',
    );
    const account = await s.accounts.get(created.id);
    const id = await s.accounts.upsertGroup(account, group('10001', 'qq'));
    const other = await s.accounts.upsertGroup(account, group('10002', 'qq'));
    await s.db.query(
      `INSERT INTO messages(id,conversation_id,account_id,external_id,sender_id,sender_name,content,segments,direction,verdict,fingerprint,source_at,created_at)
      SELECT 'history-'||lpad(n::text,3,'0'),$1,$2,n::text,'99999','昵称',n::text,'[{"type":"text","text":"fixture"}]'::jsonb,'incoming','allowed','fixture',now(),now() FROM generate_series(1,235) n`,
      [id, account.id],
    );
    const snapshot = await s.chat.snapshot(id);
    assert.equal(snapshot.messages.length, 100);
    assert.equal(snapshot.pagination.has_more, true);
    let cursor = snapshot.pagination.before;
    const ids = snapshot.messages.map((m: any) => m.id);
    while (cursor) {
      const page = await s.chat.history(id, { before: cursor, limit: 50 });
      ids.unshift(...page.messages.map((m: any) => m.id));
      cursor = page.pagination.has_more ? page.pagination.before : null;
    }
    assert.equal(ids.length, 235);
    assert.equal(new Set(ids).size, 235);
    assert.equal(ids[0], 'history-001');
    assert.equal(ids.at(-1), 'history-235');
    await assert.rejects(s.chat.history(other, { before: ids[0] }), (e: any) => e.code === 'HISTORY_CURSOR');
    await assert.rejects(s.chat.history(id, { before: ids[0], limit: 1000 }));
    await s.db.query('UPDATE messages SET deleted=true WHERE id=$1', [ids[0]]);
    const older = await s.chat.history(id, { before: 'history-002' });
    assert.equal(older.messages[0].deleted, true);
  } finally {
    await s.close();
  }
});

test('batch submission is idempotent under concurrent retries and validates target text limits before creating work', async () => {
  const s = await services();
  try {
    const created = await s.accounts.create(
      { kind: 'telegram', name: 'batch fixture', token: 'fixture-token' },
      'test',
    );
    const account = await s.accounts.get(created.id);
    const one = await s.accounts.upsertGroup(account, group('10001', 'telegram'));
    const two = await s.accounts.upsertGroup(account, group('10002', 'telegram'));
    const body = { title: '发布', content: 'hello', conversation_ids: [one, two] };
    const [a, b] = await Promise.all([
      s.features.createAnnouncement(body, 'test', 'same-batch-key'),
      s.features.createAnnouncement({ ...body, conversation_ids: [two, one] }, 'test', 'same-batch-key'),
    ]);
    assert.equal(a.id, b.id);
    assert.equal((await s.db.query('SELECT id FROM announcements')).length, 1);
    assert.equal((await s.db.query('SELECT id FROM jobs')).length, 2);
    await assert.rejects(
      s.features.createAnnouncement({ ...body, content: 'changed' }, 'test', 'same-batch-key'),
      (e: any) => e.code === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      s.features.createAnnouncement({ ...body, content: 'a'.repeat(4097) }, 'test', 'overlong-batch-key'),
      (e: any) => e.code === 'CONTENT_TOO_LONG',
    );
    assert.equal((await s.db.query('SELECT id FROM jobs')).length, 2);
    await s.features.cancelAnnouncement(a.id, 'test');
    assert.equal((await s.features.createAnnouncement(body, 'test', 'same-batch-key')).id, a.id);
    assert.equal((await s.db.query("SELECT id FROM jobs WHERE status='pending'")).length, 0);
  } finally {
    await s.close();
  }
});

test('Binance profile enrichment repairs existing names without replaying moderation or changing message content', async () => {
  const s = await services();
  try {
    const created = await s.accounts.create(
      { kind: 'binance', name: 'profile fixture', group_ids: ['10001'] },
      'test',
    );
    await s.db.query("UPDATE accounts SET status='online',session_id='profile-session' WHERE id=$1", [
      created.id,
    ]);
    const account = await s.accounts.get(created.id);
    const id = await s.accounts.upsertGroup(account, group('10001', 'qq'));
    const incoming = event(account, '10001');
    await s.messages.ingest(account, incoming);
    const before = (await s.db.query('SELECT * FROM messages WHERE conversation_id=$1', [id]))[0]!;
    await s.messages.enrich(account, '10001', incoming.data.message_id, '币安昵称', {
      avatar_url: 'https://example.com/avatar.png',
    });
    const after = (await s.db.query('SELECT * FROM messages WHERE conversation_id=$1', [id]))[0]!;
    assert.equal(after.sender_name, '币安昵称');
    assert.equal(after.sender_avatar, 'https://example.com/avatar.png');
    assert.equal(after.fingerprint, before.fingerprint);
    assert.equal(after.content, before.content);
    assert.equal(after.verdict, before.verdict);
    assert.equal(after.content_version, before.content_version);
    assert.equal((await s.db.query('SELECT id FROM inbox')).length, 1);
    assert.equal((await s.db.query('SELECT id FROM jobs')).length, 0);
    await s.db.query("UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[]') WHERE id=$1", [
      account.id,
    ]);
    const hidden = await s.chat.snapshot(id);
    assert.equal(hidden.conversation.sync_enabled, false);
    assert(!hidden.conversations.some((room: any) => room.id === id));
    assert.equal(hidden.messages.length, 1); // History is retained outside the active inbox list.
    await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [created.id]);
    await s.messages.enrich(account, '10001', incoming.data.message_id, '迟到的昵称');
    assert.equal(
      (await s.db.query('SELECT sender_name FROM messages WHERE id=$1', [before.id]))[0]!.sender_name,
      '币安昵称',
    );
  } finally {
    await s.close();
  }
});

test('cancelling sync during standalone enqueue leaves no pending task that can revive when the group is reselected', async () => {
  const s = await services();
  let releaseRead = () => {};
  try {
    const created = await s.accounts.create(
      { kind: 'qq', name: 'selection race', endpoint: 'https://example.com' },
      'test',
    );
    await s.db.query("UPDATE accounts SET status='online' WHERE id=$1", [created.id]);
    const account = await s.accounts.get(created.id);
    const id = await s.accounts.upsertGroup(account, group('10001', 'qq'));
    const selection = await s.accounts.groups(account.id);
    let reportRead = () => {};
    const read = new Promise<void>((resolve) => (reportRead = resolve));
    const released = new Promise<void>((resolve) => (releaseRead = resolve));
    const originalQuery = s.db.query.bind(s.db);
    const originalTransaction = s.db.transaction.bind(s.db);
    const intercept =
      (query: typeof s.db.query): typeof s.db.query =>
      async <T extends Row>(text: string, values?: unknown[]) => {
        const rows = await query<T>(text, values);
        if (text.startsWith('SELECT kind,settings FROM accounts')) {
          reportRead();
          await released;
        }
        return rows;
      };
    s.db.query = intercept(originalQuery);
    s.db.transaction = (handler) =>
      originalTransaction((tx) => handler({ query: intercept(tx.query.bind(tx)) }));
    const queued = s.jobs.enqueue({
      key: randomUUID(),
      conversationId: id,
      action: 'message.send',
      params: { segments: [{ type: 'text', text: 'must remain cancelled' }] },
    });
    await read;
    const deselected = s.accounts.selectGroups(
      account.id,
      { group_ids: [], revision: selection.revision },
      'test',
    );
    // PGlite serializes transactions. An unfenced standalone insert lets selection
    // finish first; a fenced insert makes selection wait and cancel it after commit.
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([deselected, new Promise<void>((resolve) => (timer = setTimeout(resolve, 100)))]);
    clearTimeout(timer!);
    releaseRead();
    const [job, next] = await Promise.all([queued, deselected]);
    assert.equal(((await s.features.deliveries(job.id)) as any).status, 'cancelled');
    await s.accounts.selectGroups(account.id, { group_ids: ['10001'], revision: next.revision }, 'test');
    let sends = 0;
    s.adapters.execute = async () => {
      sends++;
      throw new Error('unexpected send');
    };
    assert.equal(await s.jobs.processOnce(), false);
    assert.equal(sends, 0);
  } finally {
    releaseRead();
    await s.close();
  }
});
