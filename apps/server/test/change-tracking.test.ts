import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServices, type Services } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';

let s: Services;
let app: Awaited<ReturnType<typeof createHttpApp>>;
let base: string;
let cookie: string;
let group: any, account: any;
before(async () => {
  s = await createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: true },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  app = await createHttpApp(s);
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api/v1';
  const setup = await fetch(base + '/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tracking-admin', password: 'tracking-test-password' }),
  });
  cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  group = (await s.features.groups()).find((g) => g.external_id === 'demo-community')!;
  account = await s.accounts.get('local-demo');
});
after(async () => {
  await app.close();
  await s.close();
});

async function say(sender: string, name?: string, text = '你好') {
  const event = {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: group.external_id },
    type: 'message.created',
    data: {
      message_id: randomUUID(),
      sender_id: sender,
      direction: 'incoming',
      segments: [{ type: 'text', text }],
    },
  };
  await s.messages.ingest(account, event, name);
  return (await s.db.query('SELECT * FROM messages WHERE external_id=$1', [event.data.message_id]))[0]!;
}

test('the change version moves only after committed writes that changed rows', async () => {
  const version = () => s.db.version(['audit']);
  const start = version();
  await s.db.query("UPDATE audit SET actor=actor WHERE id='missing'");
  await s.db.query('SELECT * FROM audit LIMIT 1');
  assert.equal(version(), start, 'reads and no-op writes are not changes');
  await s.db.query("INSERT INTO audit(id,actor,action,target) VALUES($1,'test','tracking.check','x')", [
    randomUUID(),
  ]);
  assert.equal(version(), start + 1);
  await assert.rejects(
    s.db.transaction(async (tx) => {
      await tx.query("INSERT INTO audit(id,actor,action,target) VALUES($1,'test','tracking.check','x')", [
        randomUUID(),
      ]);
      throw new Error('rolled back');
    }),
  );
  assert.equal(version(), start + 1, 'a rolled-back transaction is not a change');
  const messages = s.db.version(['messages']);
  await s.db.transaction(async (tx) => {
    await tx.query("INSERT INTO audit(id,actor,action,target) VALUES($1,'test','tracking.check','x')", [
      randomUUID(),
    ]);
    assert.equal(version(), start + 1, 'uncommitted writes are not visible yet');
  });
  assert.equal(version(), start + 2);
  assert.equal(s.db.version(['messages']), messages, 'other tables keep their version');
});

test('a repeated sender name leaves history untouched; a new name updates it once', async () => {
  const sender = `profile-${randomUUID()}`;
  const first = await say(sender, '旧昵称');
  await say(sender, '旧昵称');
  const stamp = async (id: string) =>
    (await s.db.query('SELECT xmin::text AS xmin FROM messages WHERE id=$1', [id]))[0]!.xmin;
  const before = await stamp(first.id);
  await say(sender, '旧昵称');
  assert.equal(await stamp(first.id), before, 'an unchanged profile must not rewrite older messages');

  await say(sender, '新昵称');
  const names = await s.db.query('SELECT DISTINCT sender_name FROM messages WHERE sender_id=$1', [sender]);
  assert.deepEqual(
    names.map((row) => row.sender_name),
    ['新昵称'],
  );
  const unnamed = await say(sender);
  assert.equal(unnamed.sender_name, '新昵称', 'a message without a name shows the latest known name');
});

test('a live stream does not re-read the snapshot until something it shows has changed', async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/conversations/${group.id}/stream`, {
    headers: { cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (predicate: (data: any) => boolean) => {
    const deadline = setTimeout(() => controller.abort(new Error('SSE event timed out')), 8000);
    try {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const value = chunk.match(/^event: chat\.snapshot\ndata: (.+)$/m)?.[1];
          if (value && predicate(JSON.parse(value))) return;
          continue;
        }
        const item = await reader.read();
        assert.equal(item.done, false);
        buffer += decoder.decode(item.value, { stream: true });
      }
    } finally {
      clearTimeout(deadline);
    }
  };
  const original = s.chat.snapshot;
  let reads = 0;
  s.chat.snapshot = (id: string) => {
    reads++;
    return original.call(s.chat, id);
  };
  try {
    await next(() => true);
    reads = 0;
    await sleep(2500);
    assert.equal(reads, 0, 'an idle stream must not query the snapshot every second');
    const message = await say(`stream-${randomUUID()}`, '实时成员', '新的一条消息');
    await next((data) => data.messages.some((m: any) => m.id === message.id));
    assert.ok(reads >= 1);
  } finally {
    s.chat.snapshot = original;
    controller.abort();
  }
});
