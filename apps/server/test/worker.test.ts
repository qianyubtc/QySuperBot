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
    for (const id of connected) await s.db.query("UPDATE accounts SET status='error' WHERE id=$1", [id]);
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

test('maintenance checks QQ login every cycle but rereads group permissions only when they near expiry', async () => {
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    const created = await s.accounts.create(
      { kind: 'qq', name: 'qq', endpoint: 'https://example.com' },
      'test',
    );
    await s.db.query("UPDATE accounts SET external_id='10001',status='online' WHERE id=$1", [created.id]);
    const discovered: string[] = [];
    const lookups: string[] = [];
    let loginUser = '10001';
    s.adapters.discover = async (account) => {
      discovered.push(account.id);
      return { externalId: '10001', displayName: 'qq', groups: [] };
    };
    s.adapters.qq = async (_account, action) => {
      lookups.push(action);
      return { status: 200, data: { retcode: 0, status: 'ok', data: { user_id: loginUser } } };
    };
    const audits = async () =>
      (await s.db.query("SELECT id FROM audit WHERE action='account.refreshed' AND target=$1", [created.id]))
        .length;

    // A restart has no refresh history, so the first cycle rereads everything once, silently.
    await (s.worker as any).maintenance();
    assert.deepEqual(discovered, [created.id]);
    assert.deepEqual(lookups, []);
    assert.equal(await audits(), 0);

    // Inside the permission window only the login is checked.
    await (s.worker as any).maintenance();
    await (s.worker as any).maintenance();
    assert.deepEqual(discovered, [created.id]);
    assert.deepEqual(lookups, ['get_login_info', 'get_login_info']);
    assert.equal((await s.accounts.get(created.id)).status, 'online');

    // Near expiry the full refresh runs again, still without filling the audit log.
    s.accounts.refreshedAt.set(created.id, Date.now() - 181_000);
    await (s.worker as any).maintenance();
    assert.deepEqual(discovered, [created.id, created.id]);
    assert.equal(await audits(), 0);

    // An administrator's refresh is still recorded.
    await s.accounts.refresh(created.id, 'admin');
    assert.equal(await audits(), 1);

    // A changed login surfaces within one cycle and the next cycle attempts recovery.
    loginUser = '10002';
    await (s.worker as any).maintenance();
    const changed = await s.accounts.get(created.id);
    assert.equal(changed.status, 'error');
    assert.match(changed.last_error, /账号已变化/);
    await (s.worker as any).maintenance();
    assert.equal(discovered.length, 4);
    assert.equal((await s.accounts.get(created.id)).status, 'online');
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
