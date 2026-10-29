import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class ProtocolError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ReplayStore {
  // Production implementations must atomically insert if absent with a TTL.
  consume(key: string, expiresAt: number, now: number): Promise<boolean>;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly nonces = new Map<string, number>();
  async consume(key: string, expiresAt: number, now: number): Promise<boolean> {
    for (const [entry, expiry] of this.nonces) {
      if (expiry <= now) this.nonces.delete(entry);
    }
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, expiresAt);
    return true;
  }
}

type RequestMaterial = {
  method: string; path: string; body: string | Buffer; secret: string;
  keyId: string; purpose: 'events' | 'commands' | 'control';
};

function digest(input: RequestMaterial, timestamp: string, nonce: string): Buffer {
  if (Buffer.byteLength(input.secret) < 32) throw new Error('Signing secrets need at least 32 bytes');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.keyId)) throw new Error('Invalid signing key ID');
  if (!/^[A-Za-z]+$/.test(input.method) || !input.path.startsWith('/') || /[\r\n#]/.test(input.path)) {
    throw new Error('Sign the HTTP method and exact path including its query string');
  }
  return createHmac('sha256', input.secret)
    .update(`v1\n${input.keyId}\n${input.purpose}\n${input.method.toUpperCase()}\n${input.path}\n${timestamp}\n${nonce}\n`)
    .update(input.body)
    .digest();
}

export function signRequest(input: RequestMaterial & { now?: number; nonce?: string }): Headers {
  const timestamp = String(Math.floor(input.now ?? Date.now() / 1000));
  const nonce = input.nonce ?? randomBytes(18).toString('base64url');
  return new Headers({
    'content-type': 'application/json',
    'x-superbot-key-id': input.keyId,
    'x-superbot-timestamp': timestamp,
    'x-superbot-nonce': nonce,
    'x-superbot-signature': `v1=${digest(input, timestamp, nonce).toString('hex')}`,
  });
}

export async function verifyRequest(input: RequestMaterial & {
  headers: Headers;
  scope: string;
  replayStore: ReplayStore;
  now?: number;
}): Promise<void> {
  const now = Math.floor(input.now ?? Date.now() / 1000);
  const timestamp = input.headers.get('x-superbot-timestamp') ?? '';
  const nonce = input.headers.get('x-superbot-nonce') ?? '';
  const signature = input.headers.get('x-superbot-signature') ?? '';
  if (input.headers.get('x-superbot-key-id') !== input.keyId
      || !/^(0|[1-9]\d{0,11})$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
      || !/^v1=[a-f0-9]{64}$/.test(signature)) {
    throw new ProtocolError('INVALID_SIGNATURE', 'Missing or malformed signature', 401);
  }
  const signedAt = Number(timestamp);
  if (Math.abs(now - signedAt) > 300) {
    throw new ProtocolError('STALE_REQUEST', 'Request timestamp is outside the five-minute window', 401);
  }
  if (!timingSafeEqual(digest(input, timestamp, nonce), Buffer.from(signature.slice(3), 'hex'))) {
    throw new ProtocolError('INVALID_SIGNATURE', 'Signature does not match the request', 401);
  }
  // Invalid signatures never reserve a nonce and cannot poison the replay cache.
  if (!await input.replayStore.consume(JSON.stringify([input.scope, input.keyId, input.purpose, nonce]), signedAt + 301, now)) {
    throw new ProtocolError('REPLAYED_REQUEST', 'Nonce has already been used', 401);
  }
}
