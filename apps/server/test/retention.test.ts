import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { testPng } from './image-fixture.ts';

test('housekeeping drops expired inbox events and unreferenced old uploads, keeping referenced ones', async () => {
  const s = await createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: true },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    const account = await s.accounts.get('local-demo');
    for (const [id, age] of [
      ['old-event', '40 days'],
      ['recent-event', '2 days'],
    ] as const)
      await s.db.query(
        `INSERT INTO inbox(id,account_id,event_id,fingerprint,payload,received_at) VALUES($1,$2,$1,'x','{}'::jsonb,now()-$3::interval)`,
        [id, account.id, age],
      );
    const orphan = await s.uploads.create(testPng(4, 4), 'image/png');
    const kept = await s.uploads.create(testPng(5, 5), 'image/png');
    const fresh = await s.uploads.create(testPng(6, 6), 'image/png');
    await s.db.query("UPDATE uploaded_images SET created_at=now()-interval '10 days' WHERE id=ANY($1)", [
      [orphan.id, kept.id],
    ]);
    await s.templates.create(
      { kind: 'broadcast', title: '海报', content: '', image_asset_id: kept.id },
      'test',
    );
    await s.worker.housekeeping();
    const events = (
      await s.db.query('SELECT id FROM inbox WHERE id IN ($1,$2)', ['old-event', 'recent-event'])
    ).map((row) => row.id);
    assert.deepEqual(events, ['recent-event']);
    const images = (await s.db.query('SELECT id FROM uploaded_images')).map((row) => row.id).sort();
    assert.deepEqual(images, [kept.id, fresh.id].sort());
  } finally {
    await s.close();
  }
});

test('the seven-day overview series counts messages per Beijing day', async () => {
  const s = await createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: true },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    const before = await s.features.overview();
    assert.equal(before.series.length, 7);
    const account = await s.accounts.get('local-demo');
    const group = (await s.features.groups())[0]!;
    await s.messages.ingest(account, {
      schema_version: '1',
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      source: { connector_id: account.id, account_id: account.id, conversation_id: group.external_id },
      type: 'message.created',
      data: {
        message_id: randomUUID(),
        sender_id: 'u',
        direction: 'incoming',
        segments: [{ type: 'text', text: 'hi' }],
      },
    });
    const after = await s.features.overview();
    assert.equal(after.series.at(-1).messages, before.series.at(-1).messages + 1);
    assert.equal(after.messages_today, before.messages_today + 1);
  } finally {
    await s.close();
  }
});

const ingest = async (s: Awaited<ReturnType<typeof createServices>>, text: string) => {
  const account = await s.accounts.get('local-demo');
  const group = (await s.features.groups())[0]!;
  await s.messages.ingest(account, {
    schema_version: '1',
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: group.external_id },
    type: 'message.created',
    data: {
      message_id: randomUUID(),
      sender_id: 'u',
      direction: 'incoming',
      segments: [{ type: 'text', text }],
    },
  });
  return { account, group };
};

test('message and audit retention delete only rows past an explicit window', async () => {
  const s = await createServices(
    {
      ...loadConfig(),
      databaseUrl: undefined,
      dataDir: 'memory://',
      seedDemo: true,
      retention: { inbox: 30, messages: 90, audit: 30, jobs: 0 },
    },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    const { account, group } = await ingest(s, '旧消息');
    await ingest(s, '被关键词命中的旧消息');
    await ingest(s, '新消息');
    const ids = Object.fromEntries(
      (await s.db.query('SELECT id,content FROM messages')).map((row) => [row.content, row.id]),
    ) as Record<string, string>;
    await s.db.query("UPDATE messages SET created_at=now()-interval '120 days' WHERE id<>$1", [
      ids['新消息'],
    ]);
    await s.db.query(
      `INSERT INTO keyword_hits(id,rule_id,conversation_id,message_id,user_id,rule_name,action,keyword,status,detail)
      VALUES('hit','rule',$1,$2,'u','规则','warn','旧','recorded','')`,
      [group.id, ids['被关键词命中的旧消息']],
    );
    await s.db.query(
      `INSERT INTO message_tombstones(account_id,conversation_id,external_id,source_at)
      VALUES($1,$2,'old-tomb',now()-interval '120 days'),($1,$2,'new-tomb',now()-interval '2 days')`,
      [account.id, group.id],
    );
    await s.db.query(
      `INSERT INTO audit(id,actor,action,target,created_at)
      VALUES('old-audit','t','old','x',now()-interval '60 days'),('new-audit','t','new','x',now())`,
    );

    await s.worker.housekeeping();

    assert.deepEqual(
      (await s.db.query('SELECT content FROM messages')).map((row) => row.content).sort(),
      ['新消息', '被关键词命中的旧消息'].sort(),
    );
    assert.deepEqual(
      (await s.db.query('SELECT external_id FROM message_tombstones')).map((row) => row.external_id),
      ['new-tomb'],
    );
    assert.deepEqual(
      (await s.db.query('SELECT id FROM audit')).map((row) => row.id),
      ['new-audit'],
    );
  } finally {
    await s.close();
  }
});

test('unconfigured message and audit retention keeps the archive intact', async () => {
  const s = await createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: true },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    await ingest(s, '归档消息');
    await s.db.query("UPDATE messages SET created_at=now()-interval '900 days'");
    await s.db.query(
      "INSERT INTO audit(id,actor,action,target,created_at) VALUES('a','t','old','x',now()-interval '900 days')",
    );
    await s.worker.housekeeping();
    assert.equal((await s.db.query("SELECT id FROM messages WHERE content='归档消息'")).length, 1);
    assert.equal((await s.db.query("SELECT id FROM audit WHERE id='a'")).length, 1);
  } finally {
    await s.close();
  }
});

test('retention windows default to keeping archives and reject invalid values', () => {
  const keys = [
    'RETENTION_INBOX_DAYS',
    'RETENTION_MESSAGE_DAYS',
    'RETENTION_AUDIT_DAYS',
    'RETENTION_JOBS_DAYS',
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(loadConfig().retention, { inbox: 30, messages: 0, audit: 0, jobs: 0 });
    process.env.RETENTION_MESSAGE_DAYS = '90';
    process.env.RETENTION_AUDIT_DAYS = '365';
    assert.deepEqual(loadConfig().retention, { inbox: 30, messages: 90, audit: 365, jobs: 0 });
    for (const bad of ['-1', '1.5', 'abc', '9999', 'Infinity'])
      for (const key of keys) {
        process.env[key] = bad;
        assert.throws(() => loadConfig(), new RegExp(key), `${key}=${bad} must be rejected`);
        delete process.env[key];
      }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('job retention deletes settled deliveries and keeps evidence and unsettled work', async () => {
  const s = await createServices(
    {
      ...loadConfig(),
      databaseUrl: undefined,
      dataDir: 'memory://',
      seedDemo: true,
      retention: { inbox: 30, messages: 0, audit: 0, jobs: 90 },
    },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    const { group } = await ingest(s, '证据消息');
    const messageId = (await s.db.query("SELECT id FROM messages WHERE content='证据消息'"))[0]!.id as string;
    const create = async (key: string) =>
      (await s.jobs.enqueue({ key, conversationId: group.id, action: 'message.send', params: {} }))
        .id as string;
    const settled = await create('settled');
    const recent = await create('recent');
    const unsettled = await create('unsettled');
    const referenced = await create('referenced');
    await s.db.query("UPDATE jobs SET status='succeeded' WHERE id=ANY($1)", [[settled, recent, referenced]]);
    await s.db.query("UPDATE jobs SET status='unknown' WHERE id=$1", [unsettled]);
    await s.db.query("UPDATE jobs SET created_at=now()-interval '120 days' WHERE id=ANY($1)", [
      [settled, unsettled, referenced],
    ]);
    await s.db.query(
      "INSERT INTO attempts(id,job_id,number,command,status) VALUES('attempt-settled',$1,1,'{}'::jsonb,'succeeded')",
      [settled],
    );
    await s.db.query(
      `INSERT INTO keyword_hits(id,rule_id,conversation_id,message_id,user_id,rule_name,action,keyword,status,detail,job_id)
      VALUES('hit-job','rule',$1,$2,'u','规则','warn','k','recorded','',$3)`,
      [group.id, messageId, referenced],
    );

    await s.worker.housekeeping();

    assert.deepEqual(
      (await s.db.query("SELECT id FROM jobs WHERE id <> 'hit-job' ORDER BY id")).map((row) => row.id).sort(),
      [recent, unsettled, referenced].sort(),
    );
    assert.equal((await s.db.query('SELECT id FROM attempts')).length, 0);
  } finally {
    await s.close();
  }
});
