import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
}
export async function hashPassword(password: string): Promise<string> {
  const salt = token();
  return `${salt}:${(await derive(password, salt)).toString('hex')}`;
}
export async function checkPassword(password: string, encoded: string): Promise<boolean> {
  const [salt, hash] = encoded.split(':');
  return !!salt && !!hash && equal((await derive(password, salt)).toString('hex'), hash);
}
export class SecretBox {
  private key: Buffer;
  constructor(key: Buffer) {
    this.key = key;
  }
  seal(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open(value: string): string {
    const raw = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    cipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8');
  }
  static async create(config: Pick<Config, 'dataDir' | 'encryptionKey'>): Promise<SecretBox> {
    if (config.encryptionKey) {
      if (!/^[a-fA-F0-9]{64}$/.test(config.encryptionKey))
        throw new Error('ENCRYPTION_KEY must contain 64 hex characters');
      return new SecretBox(Buffer.from(config.encryptionKey, 'hex'));
    }
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const path = join(config.dataDir, 'master.key');
    try {
      await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const key = await readFile(path);
    if (key.length !== 32) throw new Error('Invalid local encryption key file');
    return new SecretBox(key);
  }
}
