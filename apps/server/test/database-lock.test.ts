import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.ts';

/**
 * The local lock is what stops two processes from opening the same PGlite directory. A lock left
 * behind by a crash used to block every later start with no way to tell it apart from a live one.
 */
test('the local database lock is held while open, released on close and diagnosed when stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qsb-lock-'));
  const lock = join(dir, 'postgres.lock');
  try {
    const first = await openDatabase({ dataDir: dir });
    try {
      assert.equal(await readFile(lock, 'utf8'), String(process.pid));
      await assert.rejects(openDatabase({ dataDir: dir }), /is still running/);
    } finally {
      await first.close();
    }
    await assert.rejects(readFile(lock, 'utf8'));

    // A lock whose recorded process is gone must be reported as stale rather than as "in use".
    await writeFile(lock, '999999');
    await assert.rejects(openDatabase({ dataDir: dir }), /no longer running, so the lock is stale/);

    // The next start succeeds once that file is removed, and still keeps its own lock.
    await rm(lock);
    const second = await openDatabase({ dataDir: dir });
    try {
      assert.equal(await readFile(lock, 'utf8'), String(process.pid));
    } finally {
      await second.close();
    }
    await assert.rejects(readFile(lock, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable lock file is never reported as safe to delete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qsb-lock-'));
  try {
    await writeFile(join(dir, 'postgres.lock'), 'not-a-pid');
    await assert.rejects(openDatabase({ dataDir: dir }), /unreadable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
