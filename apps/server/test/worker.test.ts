import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { groupSnapshot } from '../src/adapters.ts';

test('maintenance recovers previously connected QQ and Binance accounts without resuming paused or unpaired accounts', async () => {
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    const connected: string[] = [];
    for (const kind of ['qq', 'binance'] as const) {
      const created = await s.accounts.create(
        { kind, name: kind, ...(kind === 'qq' ? { endpoint: 'https://example.com' } : {}) },
        'test',
      );
      await s.db.query("UPDATE accounts SET external_id=$2,status='error' WHERE id=$1", [created.id, kind]);
      connected.push(created.id);
      const paused = await s.accounts.create(
        { kind, name: `paused ${kind}`, ...(kind === 'qq' ? { endpoint: 'https://example.com' } : {}) },
        'test',
      );
      await s.db.query("UPDATE accounts SET external_id=$2,status='paused' WHERE id=$1", [paused.id, kind]);
      await s.accounts.create(
        { kind, name: `new ${kind}`, ...(kind === 'qq' ? { endpoint: 'https://example.com' } : {}) },
        'test',
      );
    }
    const calls: string[] = [];
    let unavailable = true;
    s.adapters.discover = async (account) => {
      calls.push(account.id);
      if (unavailable) throw new Error('temporary transport failure');
      return { externalId: account.external_id, displayName: account.name, groups: [] };
    };
    await (s.worker as any).maintenance();
    assert.deepEqual(calls.sort(), [...connected].sort());
    for (const id of connected) assert.equal((await s.accounts.get(id)).status, 'error');
    unavailable = false;
    calls.length = 0;
    await (s.worker as any).maintenance();
    assert.deepEqual(calls.sort(), [...connected].sort());
    for (const id of connected) assert.equal((await s.accounts.get(id)).status, 'online');
    const excluded = (await s.accounts.list()).filter((account) => !connected.includes(account.id));
    assert.deepEqual(excluded.map((account) => account.status).sort(), [
      'configuring',
      'configuring',
      'paused',
      'paused',
    ]);

    // A user pause while discovery is in flight must win over automatic recovery.
    s.adapters.discover = async (account) => {
      await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [account.id]);
      return { externalId: account.external_id, displayName: account.name, groups: [] };
    };
    await (s.worker as any).maintenance();
    for (const id of connected) assert.equal((await s.accounts.get(id)).status, 'paused');
  } finally {
    await s.close();
  }
});

test('events authenticated before an administrator pause cannot persist messages or trigger group actions afterwards', async () => {
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    for (const kind of ['telegram', 'qq', 'custom'] as const) {
      const created = await s.accounts.create(
        {
          kind,
          name: kind,
          ...(kind === 'telegram' ? { token: 'fixture-token' } : { endpoint: 'https://example.com' }),
        },
        'test',
      );
      await s.db.query("UPDATE accounts SET status='online',external_id='123' WHERE id=$1", [created.id]);
      const stale = await s.accounts.get(created.id);
      const groupId = await s.accounts.upsertGroup(stale, groupSnapshot('456', kind, 'group', 3, kind, true));
      await s.db.query(
        `UPDATE conversations SET policy=jsonb_set(policy,'{verification_enabled}','true') WHERE id=$1`,
        [groupId],
      );
      await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [created.id]);
      const result = await s.messages.ingest(stale, {
        schema_version: '1',
        event_id: 'paused-event',
        occurred_at: new Date().toISOString(),
        source: { connector_id: created.id, account_id: created.id, conversation_id: '456' },
        type: 'message.created',
        data: {
          message_id: '789',
          sender_id: '999',
          direction: 'incoming',
          segments: [{ type: 'text', text: 'late event' }],
        },
      });
      assert.equal(result.ignored, true);
      for (const table of ['messages', 'verifications', 'jobs'])
        assert.equal(
          (await s.db.query(`SELECT id FROM ${table} WHERE conversation_id=$1`, [groupId])).length,
          0,
        );
    }
  } finally {
    await s.close();
  }
});
