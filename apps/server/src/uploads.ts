import { createHash } from 'node:crypto';
import type { Database, Sql } from './database.ts';
import { ApiError } from './security.ts';
import { imageType } from './network.ts';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const uploadImageId = /^upload-image-[a-f0-9]{64}$/;
export type UploadedImage = {
  id: string;
  name: string;
  contentType: string;
  body: Buffer;
  width: number;
  height: number;
};

function dimensions(body: Buffer, type: string) {
  if (
    type === 'image/png' &&
    body.length >= 45 &&
    body.readUInt32BE(8) === 13 &&
    body.toString('ascii', 12, 16) === 'IHDR' &&
    body.toString('ascii', body.length - 8, body.length - 4) === 'IEND'
  )
    return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
  if (type === 'image/jpeg' && body.at(-2) === 255 && body.at(-1) === 217) {
    let offset = 2;
    while (offset + 4 <= body.length) {
      if (body[offset] !== 255) break;
      while (body[offset] === 255) offset++;
      const marker = body[offset++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > body.length) break;
      const size = body.readUInt16BE(offset);
      if (size < 2 || offset + size > body.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 8)
        return { width: body.readUInt16BE(offset + 5), height: body.readUInt16BE(offset + 3) };
      offset += size;
    }
  }
  throw new ApiError(400, 'INVALID_IMAGE', '图片文件不完整或无法识别，请重新导出 JPG 或 PNG');
}

export class UploadsService {
  constructor(readonly db: Database) {}
  async create(body: unknown, declaredType?: string) {
    if (!Buffer.isBuffer(body) || !body.length || body.length > MAX_IMAGE_BYTES)
      throw new ApiError(400, 'IMAGE_SIZE', '图片大小须为 1 字节至 8 MiB');
    const contentType = imageType(body);
    if (!contentType || !['image/png', 'image/jpeg'].includes(contentType))
      throw new ApiError(400, 'IMAGE_TYPE', '群发图片暂支持 JPG 和 PNG');
    if (
      declaredType &&
      declaredType.split(';')[0] !== contentType &&
      declaredType !== 'application/octet-stream'
    )
      throw new ApiError(400, 'IMAGE_TYPE', '文件内容与图片类型不一致');
    const { width, height } = dimensions(body, contentType);
    if (!width || !height || width + height > 10000 || Math.max(width / height, height / width) > 20)
      throw new ApiError(400, 'IMAGE_DIMENSIONS', '图片宽高之和不能超过 10000，宽高比不能超过 20');
    const id = `upload-image-${createHash('sha256').update(body).digest('hex')}`;
    await this.db.query(
      'INSERT INTO uploaded_images(id,content_type,byte_size,width,height,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
      [id, contentType, body.length, width, height, body.toString('base64')],
    );
    return {
      id,
      name: `superbot-${id.slice(-12)}.${contentType === 'image/png' ? 'png' : 'jpg'}`,
      content_type: contentType,
      byte_size: body.length,
      width,
      height,
    };
  }
  async get(id: string, sql: Sql = this.db): Promise<UploadedImage> {
    if (!uploadImageId.test(id)) throw new ApiError(404, 'IMAGE_ASSET_NOT_FOUND', '上传图片不存在');
    const row = (await sql.query('SELECT * FROM uploaded_images WHERE id=$1', [id]))[0];
    if (!row) throw new ApiError(404, 'IMAGE_ASSET_NOT_FOUND', '上传图片不存在');
    return {
      id,
      name: `superbot-${id.slice(-12)}.${row.content_type === 'image/png' ? 'png' : 'jpg'}`,
      contentType: row.content_type,
      body: Buffer.from(row.data, 'base64'),
      width: row.width,
      height: row.height,
    };
  }
}
