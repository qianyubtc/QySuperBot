import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, migrations } from '../src/migration.ts';

const connection = (db: PGlite) => ({
  exec: (sql: string) => db.exec(sql),
  query: async (sql: string, values?: unknown[]) => (await db.query<{ version: number }>(sql, values)).rows,
});

test('versioned migrations run once, in order, and the cleanup keeps manual refresh records', async () => {
  const db = await PGlite.create('memory://');
  try {
    // A database created before versioned migrations: baseline only, with old refresh noise.
    const { migration } = await import('../src/migration.ts');
    await db.exec(migration);
    await db.exec(`INSERT INTO audit(id,actor,action,target) VALUES
      ('a1','定时刷新','account.refreshed','acc'),('a2','定时刷新','account.refreshed','acc'),
      ('a3','admin','account.refreshed','acc'),('a4','定时刷新','delivery.succeeded','job')`);
    await migrate(connection(db));
    const versions = (
      await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    ).rows;
    assert.deepEqual(
      versions.map((row) => row.version),
      migrations.map((step) => step.version),
    );
    assert.deepEqual(
      (await db.query<{ id: string }>('SELECT id FROM audit ORDER BY id')).rows.map((row) => row.id),
      ['a3', 'a4'],
    );
    // Re-running is a no-op: no duplicate versions and later rows are not deleted again.
    await db.exec(
      `INSERT INTO audit(id,actor,action,target) VALUES ('a5','定时刷新','account.refreshed','acc')`,
    );
    await migrate(connection(db));
    assert.equal((await db.query('SELECT version FROM schema_migrations')).rows.length, migrations.length);
    assert.equal((await db.query("SELECT id FROM audit WHERE id='a5'")).rows.length, 1);
    const indexes = (
      await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE indexname IN ('messages_created_at','messages_blocked','inbox_received','audit_created')",
      )
    ).rows;
    assert.equal(indexes.length, 4);
  } finally {
    await db.close();
  }
});

test('a failing migration rolls back and is not recorded', async () => {
  const db = await PGlite.create('memory://');
  try {
    migrations.push({
      version: 999,
      name: 'broken',
      sql: 'CREATE TABLE half_done(id int); SELECT missing_column FROM audit;',
    });
    await assert.rejects(migrate(connection(db)));
    assert.equal((await db.query('SELECT version FROM schema_migrations WHERE version=999')).rows.length, 0);
    assert.equal(
      (await db.query("SELECT to_regclass('half_done') AS t")).rows[0] &&
        (await db.query<{ t: string | null }>("SELECT to_regclass('half_done') AS t")).rows[0]!.t,
      null,
    );
  } finally {
    migrations.pop();
    await db.close();
  }
});
