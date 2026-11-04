import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { groupSnapshot } from '../src/adapters.ts';

test('a slow account holds up only its own job queue while other accounts keep sending', async () => {
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    const accounts: string[] = [];
    const groups: string[] = [];
    for (const [index, ids] of [['2001', '2002'], ['3001']].entries()) {
      const created = await s.accounts.create(
        { kind: 'qq', name: `qq ${index}`, endpoint: 'https://example.com' },
        'test',
      );
      await s.db.query("UPDATE accounts SET status='online',external_id=$2 WHERE id=$1", [
        created.id,
        String(10000 + index),
      ]);
      const account = await s.accounts.get(created.id);
      accounts.push(account.id);
      for (const id of ids)
        groups.push(await s.accounts.upsertGroup(account, groupSnapshot(id, id, 'group', 3, 'qq', true)));
    }
    const [slow, fast] = accounts as [string, string];
    const started: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    s.adapters.qq = async (_account, action) =>
      action === 'get_login_info'
        ? { status: 200, data: { retcode: 0, data: { user_id: 10000 } } }
        : { status: 200, data: { retcode: 0, data: {} } };
    s.adapters.execute = async (account, command) => {
      started.push(account.id);
      if (account.id === slow) await held;
      return {
        schema_version: '1',
        command_id: command.command_id,
        attempt_id: command.attempt_id,
        attempt_number: command.attempt_number,
        revision: 1,
        observed_at: new Date().toISOString(),
        status: 'succeeded',
        result: { message_id: `sent-${started.length}` },
      };
    };
    await s.features.createAnnouncement(
      { title: '并发', content: '通知', conversation_ids: groups },
      'test',
      'concurrency-request',
    );
    await (s.worker as any).dispatch();
    const status = async () =>
      (await s.db.query('SELECT account_id,status FROM jobs ORDER BY created_at')).map(
        (row) => `${row.account_id === slow ? 'slow' : 'fast'}:${row.status}`,
      );
    for (let i = 0; i < 100 && !(await status()).includes('fast:succeeded'); i++)
      await new Promise((r) => setTimeout(r, 10));
    // The fast account finished while the slow one is still on its first job, and the slow
    // account's second job waits instead of running alongside the first.
    assert.deepEqual((await status()).sort(), ['fast:succeeded', 'slow:in_flight', 'slow:pending']);
    assert.deepEqual(started, [slow, fast]);
    assert.deepEqual([...s.worker.runningJobs.keys()], [slow]);

    release();
    for (let i = 0; i < 100 && (await status()).some((item) => !item.endsWith('succeeded')); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual((await status()).sort(), ['fast:succeeded', 'slow:succeeded', 'slow:succeeded']);
    assert.equal(started.filter((id) => id === slow).length, 2);
    await s.worker.drain();
    assert.equal(s.worker.runningJobs.size, 0);
  } finally {
    await s.close();
  }
});
