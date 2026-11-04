import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices, type Services } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';

let s: Services;
let app: Awaited<ReturnType<typeof createHttpApp>>;
let base: string;
let headers: Record<string, string>;
let groups: any[];
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
    body: JSON.stringify({ username: 'templates-admin', password: 'templates-test-password' }),
  });
  const session: any = await setup.json();
  headers = {
    cookie: setup.headers.get('set-cookie')!.split(';')[0]!,
    'x-csrf-token': session.csrf,
    'content-type': 'application/json',
  };
  groups = await s.features.groups();
});
after(async () => {
  await app.close();
  await s.close();
});
const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(base + path, { headers, ...init });
  return { status: response.status, body: (await response.json()) as any };
};

test('broadcast templates and quick replies can be saved, listed by kind, edited and removed', async () => {
  const created = await call('/templates', {
    method: 'POST',
    body: JSON.stringify({ kind: 'broadcast', title: '周五活动', content: '今晚八点见' }),
  });
  assert.equal(created.status, 200);
  const reply = await call('/templates', {
    method: 'POST',
    body: JSON.stringify({ kind: 'reply', title: '欢迎', content: '欢迎新朋友，先看群公告～' }),
  });
  assert.equal(reply.status, 200);
  const broadcasts = await call('/templates?kind=broadcast');
  assert.deepEqual(
    broadcasts.body.map((t: any) => t.title),
    ['周五活动'],
  );
  const edited = await call(`/templates/${created.body.id}`, {
    method: 'PUT',
    body: JSON.stringify({ kind: 'broadcast', title: '周五活动', content: '改到九点' }),
  });
  assert.equal(edited.body.content, '改到九点');
  const wrongKind = await call(`/templates/${created.body.id}`, {
    method: 'PUT',
    body: JSON.stringify({ kind: 'reply', title: 'x', content: 'y' }),
  });
  assert.equal(wrongKind.status, 404, 'a template keeps its kind');
  const empty = await call('/templates', {
    method: 'POST',
    body: JSON.stringify({ kind: 'reply', title: '空', content: '  ' }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await call(`/templates/${reply.body.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/templates?kind=reply')).body.length, 0);
  const audit = await s.db.query(
    "SELECT action FROM audit WHERE action LIKE 'template.%' ORDER BY created_at",
  );
  assert.deepEqual(
    audit.map((row) => row.action),
    ['template.created', 'template.created', 'template.updated', 'template.deleted'],
  );
});

test('project keys cannot read or write templates', async () => {
  const project = await s.features.createProject(
    { name: 'tpl', conversation_ids: [groups[0].id], scopes: ['messages.send'] },
    'test',
  );
  const response = await fetch(base + '/templates', { headers: { authorization: `Bearer ${project.key}` } });
  assert.equal(response.status, 403);
});

test('a scheduled broadcast that has not started can be edited; old tasks stop and new ones replace them', async () => {
  const [first, second] = groups;
  const at = new Date(Date.now() + 3600_000).toISOString();
  const created = await call('/announcements', {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      title: '定时',
      content: '旧内容',
      conversation_ids: [first.id],
      scheduled_at: at,
    }),
  });
  assert.equal(created.status, 200);
  const id = created.body.id;
  const later = new Date(Date.now() + 7200_000).toISOString();
  const updated = await call(`/announcements/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: '定时（已改）',
      content: '新内容',
      conversation_ids: [first.id, second.id],
      scheduled_at: later,
    }),
  });
  assert.equal(updated.status, 200);
  const current = await s.db.query('SELECT * FROM jobs WHERE announcement_id=$1 ORDER BY conversation_id', [
    id,
  ]);
  assert.equal(current.length, 2);
  for (const job of current) {
    assert.equal(job.status, 'pending');
    assert.equal(job.params.segments[0].text, '新内容');
    assert.equal(new Date(job.due_at).toISOString(), later);
  }
  const replaced = await s.db.query(
    "SELECT * FROM jobs WHERE announcement_id IS NULL AND params->'segments'->0->>'text'='旧内容'",
  );
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]!.status, 'cancelled');
  const listed = (await call('/announcements')).body.find((a: any) => a.id === id);
  assert.equal(listed.title, '定时（已改）');
  assert.equal(listed.deliveries.length, 2, 'only the current deliveries belong to the broadcast');

  // Once any target has started, the broadcast can no longer be replaced.
  await s.db.query("UPDATE jobs SET status='in_flight' WHERE id=$1", [current[0]!.id]);
  const rejected = await call(`/announcements/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title: 'x', content: '再改', conversation_ids: [first.id], scheduled_at: later }),
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'ANNOUNCEMENT_STARTED');
  const unchanged = await s.db.query('SELECT status FROM jobs WHERE announcement_id=$1 ORDER BY status', [
    id,
  ]);
  assert.deepEqual(
    unchanged.map((job) => job.status),
    ['in_flight', 'pending'],
  );
});

test('editing validates the new schedule and targets like creating does', async () => {
  const at = new Date(Date.now() + 3600_000).toISOString();
  const { id } = await s.features.createAnnouncement(
    { title: '校验', content: '内容', conversation_ids: [groups[0].id], scheduled_at: at },
    'test',
  );
  const past = await call(`/announcements/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: '校验',
      content: '内容',
      conversation_ids: [groups[0].id],
      scheduled_at: new Date(Date.now() - 3600_000).toISOString(),
    }),
  });
  assert.equal(past.status, 400);
  const missing = await call(`/announcements/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title: '校验', content: '内容', conversation_ids: ['missing'], scheduled_at: at }),
  });
  assert.equal(missing.status, 404);
  const jobs = await s.db.query('SELECT status FROM jobs WHERE announcement_id=$1', [id]);
  assert.deepEqual(
    jobs.map((job) => job.status),
    ['pending'],
    'a rejected edit leaves the original tasks untouched',
  );
});
