import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Context } from './context.ts';
import { audit } from './context.ts';
import { templateInput } from './inputs.ts';
import { ApiError } from './security.ts';

const limit = 200;

/** Reusable broadcast bodies and chat quick replies. Admin-only; never sent anywhere by themselves. */
export class TemplatesService {
  constructor(readonly ctx: Context) {}
  list(kind?: unknown) {
    const value = z
      .enum(['broadcast', 'reply'])
      .optional()
      .parse(kind || undefined);
    return this.ctx.db.query(
      `SELECT * FROM message_templates ${value ? 'WHERE kind=$1' : ''} ORDER BY updated_at DESC,id LIMIT ${limit}`,
      value ? [value] : [],
    );
  }
  async create(input: unknown, actor: string) {
    const value = templateInput.parse(input);
    if (value.image_asset_id) await this.ctx.uploads.get(value.image_asset_id);
    return this.ctx.db.transaction(async (tx) => {
      const count = (
        await tx.query('SELECT count(*)::int AS n FROM message_templates WHERE kind=$1', [value.kind])
      )[0]!.n;
      if (count >= limit)
        throw new ApiError(409, 'TEMPLATE_LIMIT', `每类最多保存 ${limit} 条，请先删除不用的`);
      const row = (
        await tx.query(
          'INSERT INTO message_templates(id,kind,title,content,image_asset_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [randomUUID(), value.kind, value.title, value.content, value.image_asset_id ?? null],
        )
      )[0]!;
      await audit(tx, actor, 'template.created', row.id, { kind: value.kind, title: value.title });
      return row;
    });
  }
  async update(id: string, input: unknown, actor: string) {
    const value = templateInput.parse(input);
    if (value.image_asset_id) await this.ctx.uploads.get(value.image_asset_id);
    return this.ctx.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          'UPDATE message_templates SET title=$3,content=$4,image_asset_id=$5,updated_at=now() WHERE id=$1 AND kind=$2 RETURNING *',
          [id, value.kind, value.title, value.content, value.image_asset_id ?? null],
        )
      )[0];
      if (!row) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', '模板不存在或类型不匹配');
      await audit(tx, actor, 'template.updated', id, { kind: value.kind, title: value.title });
      return row;
    });
  }
  async remove(id: string, actor: string) {
    const row = (
      await this.ctx.db.query('DELETE FROM message_templates WHERE id=$1 RETURNING kind,title', [id])
    )[0];
    if (!row) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', '模板不存在');
    await audit(this.ctx.db, actor, 'template.deleted', id, row);
    return { deleted: true };
  }
}
