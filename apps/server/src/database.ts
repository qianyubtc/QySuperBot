import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { migrate } from './migration.ts';

export type Row = Record<string, any>;
export interface Sql {
  query<T extends Row = Row>(text: string, values?: unknown[]): Promise<T[]>;
}
export interface Database extends Sql {
  transaction<T>(handler: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  mode: 'local' | 'postgres';
  /**
   * A process-local counter that changes after every committed write to one of the tables.
   * Readers capture it before querying: a write that commits later always moves it again.
   */
  version(tables: readonly string[]): number;
}

const writeTarget = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi;
// Records only writes that changed rows, so no-op upserts and conditional updates stay quiet.
class Changes {
  private versions = new Map<string, number>();
  collect(text: string, affected: number | null | undefined, into: Set<string>) {
    if (!affected || /^\s*SELECT\b/i.test(text)) return;
    for (const match of text.matchAll(writeTarget)) into.add(match[1]!.toLowerCase());
  }
  commit(tables: Set<string>) {
    for (const table of tables) this.versions.set(table, (this.versions.get(table) ?? 0) + 1);
  }
  version(tables: readonly string[]) {
    let total = 0;
    for (const table of tables) total += this.versions.get(table) ?? 0;
    return total;
  }
}
export async function openDatabase(config: Pick<Config, 'databaseUrl' | 'dataDir'>): Promise<Database> {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
    try {
      const client = await pool.connect();
      try {
        await migrate(
          {
            exec: (sql) => client.query(sql),
            query: async (sql, values) => (await client.query(sql, values)).rows,
          },
          { lock: true },
        );
      } finally {
        client.release();
      }
    } catch (error) {
      await pool.end();
      throw error;
    }
    const changes = new Changes();
    return {
      mode: 'postgres',
      version: (tables) => changes.version(tables),
      query: async <T extends Row>(text: string, values: unknown[] = []) => {
        const result = await pool.query<T>(text, values);
        const touched = new Set<string>();
        changes.collect(text, result.rowCount, touched);
        changes.commit(touched);
        return result.rows;
      },
      transaction: async (handler) => {
        const client = await pool.connect();
        const touched = new Set<string>();
        try {
          await client.query('BEGIN');
          const result = await handler({
            query: async <T extends Row>(text: string, values: unknown[] = []) => {
              const value = await client.query<T>(text, values);
              changes.collect(text, value.rowCount, touched);
              return value.rows;
            },
          });
          await client.query('COMMIT');
          changes.commit(touched);
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
    const local = startingDatabase;
    await migrate({
      exec: (sql) => local.exec(sql),
      query: async (sql, values) => (await local.query<{ version: number }>(sql, values)).rows,
    });
  } catch (error) {
    try {
      await startingDatabase?.close();
    } finally {
      await release();
    }
    throw error;
  }
  const db = startingDatabase;
  const changes = new Changes();
  return {
    mode: 'local',
    version: (tables) => changes.version(tables),
    query: async <T extends Row>(text: string, values: unknown[] = []) => {
      const result = await db.query<T>(text, values);
      const touched = new Set<string>();
      changes.collect(text, result.affectedRows, touched);
      changes.commit(touched);
      return result.rows;
    },
    transaction: async (handler) => {
      const touched = new Set<string>();
      const result = await db.transaction((tx) =>
        handler({
          query: async <T extends Row>(text: string, values: unknown[] = []) => {
            const value = await tx.query<T>(text, values);
            changes.collect(text, value.affectedRows, touched);
            return value.rows;
          },
        }),
      );
      changes.commit(touched);
      return result;
    },
    close: async () => {
      await db.close();
      await release();
    },
  };
}
