import { createHash } from 'node:crypto';
import { ProtocolError } from './signature.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// Demonstration store only. Production needs durable inbox/outbox and unique constraints.
export class MemoryIdempotencyStore<T> {
  private readonly entries = new Map<string, { fingerprint: string; result: Promise<T> }>();

  async run(scope: string, key: string, payload: unknown, operation: () => Promise<T>) {
    const identity = JSON.stringify([scope, key]);
    const hash = fingerprint(payload);
    const existing = this.entries.get(identity);
    if (existing) {
      if (existing.fingerprint !== hash) {
        throw new ProtocolError('IDEMPOTENCY_CONFLICT', 'This key was already used with a different payload', 409);
      }
      return { value: await existing.result, duplicate: true };
    }
    // Publish the promise before execution, so concurrent duplicates share one operation.
    const result = Promise.resolve().then(operation);
    this.entries.set(identity, { fingerprint: hash, result });
    // Keep rejected operations too: an exception may follow an external side effect.
    // A determinate retry policy belongs in receipts/reconciliation, not this store.
    return { value: await result, duplicate: false };
  }
}
