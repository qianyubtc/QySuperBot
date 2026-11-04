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
