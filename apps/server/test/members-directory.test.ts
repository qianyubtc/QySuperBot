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
    body: JSON.stringify({ username: 'members-admin', password: 'members-test-password' }),
  });
  const session: any = await setup.json();
  headers = { cookie: setup.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': session.csrf };
  group = (await s.features.groups()).find((g) => g.external_id === 'demo-community')!;
  account = await s.accounts.get('local-demo');
});
after(async () => {
  await app.close();
  await s.close();
});
async function event(type: string, data: Record<string, unknown>, name?: string) {
  await s.messages.ingest(
    account,
    {
      schema_version: '1',
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      source: { connector_id: account.id, account_id: account.id, conversation_id: group.external_id },
      type,
      data,
    },
    name,
  );
}
const say = (sender: string, text: string, name: string) =>
  event(
    'message.created',
    {
      message_id: randomUUID(),
      sender_id: sender,
      direction: 'incoming',
      segments: [{ type: 'text', text }],
    },
    name,
  );
const get = async (path: string) => {
  const response = await fetch(base + path, { headers });
  return { status: response.status, body: (await response.json()) as any };
};

test('the member directory lists speakers, joiners and blacklisted members with their state', async () => {
  await say('alice', '大家好', '爱丽丝');
  await say('alice', '今天有活动吗', '爱丽丝');
  await say('bob', '有的', '鲍勃');
  await event('member.joined', { user_id: 'carol', membership_id: randomUUID() });
  await s.features.blacklist({ conversation_id: group.id, user_id: 'dave', reason: '发广告' }, 'test');
  const { status, body } = await get(`/conversations/${group.id}/members`);
  assert.equal(status, 200);
  const byId = Object.fromEntries(body.members.map((m: any) => [m.user_id, m]));
  assert.equal(byId.alice.name, '爱丽丝');
  assert.equal(byId.alice.message_count, 2);
  assert.equal(byId.bob.message_count, 1);
  assert.equal(byId.carol.membership_status, 'active');
  assert.equal(byId.carol.message_count, 0);
  assert.equal(byId.dave.blacklist.reason, '发广告');
  const order = body.members.map((m: any) => m.user_id);
  assert.ok(order.indexOf('carol') < order.indexOf('bob'), 'most recent activity comes first');
});

test('member search matches names and IDs, and treats wildcards literally', async () => {
  assert.deepEqual(
    (await get(`/conversations/${group.id}/members?q=${encodeURIComponent('爱丽')}`)).body.members.map(
      (m: any) => m.user_id,
    ),
    ['alice'],
  );
  assert.deepEqual(
    (await get(`/conversations/${group.id}/members?q=bo`)).body.members.map((m: any) => m.user_id),
    ['bob'],
  );
  assert.equal((await get(`/conversations/${group.id}/members?q=%25`)).body.members.length, 0);
});

test('member detail shows recent messages and recorded actions; unknown members are 404', async () => {
  const { status, body } = await get(`/conversations/${group.id}/members/alice`);
  assert.equal(status, 200);
  assert.equal(body.member.name, '爱丽丝');
  assert.deepEqual(
    body.messages.map((m: any) => m.content),
    ['今天有活动吗', '大家好'],
  );
  assert.equal((await get(`/conversations/${group.id}/members/nobody`)).status, 404);
  assert.equal((await get(`/conversations/missing/members`)).status, 404);
});

test('project keys cannot read the member directory', async () => {
  const project = await s.features.createProject(
    { name: 'dir', conversation_ids: [group.id], scopes: ['conversations.read'] },
    'test',
  );
  const response = await fetch(`${base}/conversations/${group.id}/members`, {
    headers: { authorization: `Bearer ${project.key}` },
  });
  assert.equal(response.status, 403);
});
