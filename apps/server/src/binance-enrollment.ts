import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { Database, Row } from './database.ts';
import { ApiError, equal, sha, type SecretBox } from './security.ts';
import { binanceAuthentication } from './binance-direct.ts';

const helloSchema = z.strictObject({
  type: z.literal('direct_hello'),
  id: z.string().uuid(),
  account_id: z.string().uuid(),
  proof: z.string().regex(/^[a-f0-9]{64}$/),
});
const credentialsSchema = z.strictObject({
  type: z.literal('direct_credentials'),
  id: z.string().uuid(),
  consent: z.literal(true),
  proof: z.string().regex(/^[a-f0-9]{64}$/),
  credentials: binanceAuthentication.refine((value) => value.mode === 'direct'),
});
export const enrollmentProof = (
  secret: string,
  purpose: 'client' | 'server' | 'submit',
  nonce: string,
  accountId: string,
  id: string,
  digest?: string,
) =>
  createHmac('sha256', secret)
    .update(`qsb-binance-direct-${purpose}-v1:${nonce}:${accountId}:${id}${digest ? ':' + digest : ''}`)
    .digest('hex');

// A provision-only channel never becomes a browser execution peer, including during token renewal.
export class BinanceEnrollment {
  account?: Row;
  id?: string;
  secret?: string;
  submitting = false;
  abort = new AbortController();
  deadline: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    readonly socket: WebSocket,
    readonly nonce: string,
    readonly db: Database,
    readonly box: SecretBox,
    readonly activate: (account: Row, input: unknown, signal: AbortSignal) => Promise<unknown>,
  ) {
    this.deadline = setTimeout(() => {
      this.abort.abort();
      socket.close(1008, 'Authorization timed out');
    }, 10000);
    socket.once('close', () => {
      clearTimeout(this.deadline);
      clearInterval(this.heartbeat);
      this.abort.abort();
    });
  }
  async handle(value: unknown) {
    try {
      if (!this.account) {
        const hello = helloSchema.parse(value);
        // Set synchronously before the DB await to refuse overlapping handshake frames.
        if (this.id) throw new ApiError(401, 'BINANCE_AUTH', 'Invalid authorization');
        this.id = hello.id;
        const account = (await this.db.query('SELECT * FROM accounts WHERE id=$1', [hello.account_id]))[0];
        if (!account || account.kind !== 'binance' || account.status === 'paused')
          throw new ApiError(401, 'BINANCE_AUTH', 'Invalid authorization');
        const secret = this.box.open(account.incoming_secret_box);
        if (!equal(hello.proof, enrollmentProof(secret, 'client', this.nonce, account.id, hello.id)))
          throw new ApiError(401, 'BINANCE_AUTH', 'Invalid authorization');
        if (this.abort.signal.aborted || this.socket.readyState !== WebSocket.OPEN) return;
        this.account = account;
        this.secret = secret;
        this.socket.send(
          JSON.stringify({
            type: 'direct_ready',
            id: this.id,
            proof: enrollmentProof(secret, 'server', this.nonce, account.id, hello.id),
          }),
        );
        return;
      }
      if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'pong') return;
      if (this.submitting) throw new ApiError(401, 'BINANCE_AUTH', 'Repeated authorization');
      this.submitting = true;
      const frame = credentialsSchema.parse(value);
      if (
        frame.id !== this.id ||
        !equal(
          frame.proof,
          enrollmentProof(
            this.secret!,
            'submit',
            this.nonce,
            this.account.id,
            frame.id,
            sha(JSON.stringify((value as { credentials: unknown }).credentials)),
          ),
        )
      )
        throw new ApiError(401, 'BINANCE_AUTH', 'Invalid authorization');
      const current = (await this.db.query('SELECT * FROM accounts WHERE id=$1', [this.account.id]))[0];
      if (
        !current ||
        current.incoming_secret_box !== this.account.incoming_secret_box ||
        current.status === 'paused'
      )
        throw new ApiError(401, 'BINANCE_AUTH', 'Authorization revoked');
      clearTimeout(this.deadline);
      this.deadline = setTimeout(() => {
        this.abort.abort();
        this.socket.close(1013, 'Validation timed out');
      }, 170000);
      this.heartbeat = setInterval(() => {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'ping' }));
      }, 15000);
      this.heartbeat.unref();
      const result = await this.activate(current, frame.credentials, this.abort.signal);
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'direct_result', id: this.id, ok: true, result }));
        this.socket.close(1000, 'Direct authorization finished');
      }
    } catch (error) {
      this.abort.abort();
      // Only the known chat service's sanitized ApiError is allowed to become a UI diagnostic.
      const allowed =
        error instanceof ApiError &&
        [
          'BINANCE_DIRECT_AUTH',
          'BINANCE_IDENTITY_CHANGED',
          'BINANCE_TOKEN_EXPIRED',
          'BINANCE_CONNECTION_CHANGED',
          'BINANCE_BUSY',
          'ACCOUNT_PAUSED',
          'BINANCE_AUTH_CANCELLED',
        ].includes(error.code);
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            type: 'direct_result',
            id: this.id ?? null,
            ok: false,
            error: {
              code: allowed ? error.code : 'BINANCE_DIRECT_AUTHORIZATION',
              message: allowed ? error.message : '授权未完成，请检查配对、登录状态和后台版本后重试',
            },
          }),
        );
        this.socket.close(1008, 'Direct authorization rejected');
      }
    }
  }
}
