import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { migration } from './migration.ts';

export type Row = Record<string, any>;
export interface Sql {
  query<T extends Row = Row>(text: string, values?: unknown[]): Promise<T[]>;
}
export interface Database extends Sql {
  transaction<T>(handler: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  mode: 'local' | 'postgres';
}
export async function openDatabase(config: Pick<Config, 'databaseUrl' | 'dataDir'>): Promise<Database> {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
    try {
      await pool.query(migration);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return {
      mode: 'postgres',
      query: async <T extends Row>(text: string, values: unknown[] = []) =>
        (await pool.query<T>(text, values)).rows,
      transaction: async (handler) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await handler({
            query: async <T extends Row>(text: string, values: unknown[] = []) =>
              (await client.query<T>(text, values)).rows,
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  let release = async () => {};
  if (config.dataDir !== 'memory://') {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const lockPath = join(config.dataDir, 'postgres.lock');
    try {
      const lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(String(process.pid));
      release = async () => {
        await lock.close();
        await unlink(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          `Local database is locked: ${lockPath}. Stop the other process; after a crash verify its PID is no longer running before removing this file.`,
        );
      throw error;
    }
  }
  let startingDatabase: PGlite | undefined;
  try {
    startingDatabase = await PGlite.create(
      config.dataDir === 'memory://' ? 'memory://' : join(config.dataDir, 'postgres'),
    );
    await startingDatabase.exec(migration);
  } catch (error) {
    try {
      await startingDatabase?.close();
    } finally {
      await release();
    }
    throw error;
  }
  const db = startingDatabase;
  return {
    mode: 'local',
    query: async <T extends Row>(text: string, values: unknown[] = []) =>
      (await db.query<T>(text, values)).rows,
    transaction: (handler) =>
      db.transaction((tx) =>
        handler({
          query: async <T extends Row>(text: string, values: unknown[] = []) =>
            (await tx.query<T>(text, values)).rows,
        }),
      ),
    close: async () => {
      await db.close();
      await release();
    },
  };
}
