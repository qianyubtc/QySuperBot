import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Database, Sql } from './database.ts';
import type { SecretBox } from './security.ts';
import type { Adapters } from './adapters.ts';
import type { UploadsService } from './uploads.ts';
export interface Context {
  db: Database;
  config: Config;
  box: SecretBox;
  adapters: Adapters;
  uploads: UploadsService;
}
export const json = (value: unknown) => JSON.stringify(value);
export const iso = (value: Date | string) => new Date(value).toISOString();
export const epoch = (value: Date | string) => new Date(value).getTime();
export async function audit(sql: Sql, actor: string, action: string, target: string, detail: unknown = {}) {
  await sql.query('INSERT INTO audit(id,actor,action,target,detail) VALUES($1,$2,$3,$4,$5::jsonb)', [
    randomUUID(),
    actor,
    action,
    target,
    json(detail),
  ]);
}
