import { fingerprint } from './idempotency.ts';
import { connectorCommandSchema, receiptSchema } from './schema.ts';
import type { ConnectorCommand, ExecutionReceipt } from './schema.ts';
import { ProtocolError } from './signature.ts';

function matchesAttempt(command: ConnectorCommand, receipt: ExecutionReceipt): boolean {
  return command.command_id === receipt.command_id && command.attempt_id === receipt.attempt_id
    && command.attempt_number === receipt.attempt_number;
}

export function mergeReceipt(previous: ExecutionReceipt | undefined, incoming: ExecutionReceipt,
  options: { reconciled?: boolean } = {}): ExecutionReceipt {
  const next = receiptSchema.parse(incoming);
  if (!previous) return next;
  if (previous.command_id !== next.command_id || previous.attempt_id !== next.attempt_id
      || previous.attempt_number !== next.attempt_number) {
    throw new ProtocolError('RECEIPT_SCOPE_MISMATCH', 'Receipt belongs to another execution attempt', 409);
  }
  if (next.revision < previous.revision) return previous;
  if (next.revision === previous.revision) {
    if (fingerprint(next) !== fingerprint(previous)) {
      throw new ProtocolError('RECEIPT_CONFLICT', 'Receipt revision cannot be reused with another payload', 409);
    }
    return previous;
  }
  if (previous.status === 'succeeded' || previous.status === 'failed'
      || (previous.status === 'unknown' && next.status === 'accepted')
      || (previous.status === 'unknown' && next.status !== 'unknown' && !options.reconciled)) {
    throw new ProtocolError('INVALID_RECEIPT_TRANSITION', 'Receipt transition needs a valid state or reconciliation', 409);
  }
  return next;
}

function operationFingerprint(command: ConnectorCommand): string {
  // Executor binding and attempt metadata may change after a determinate no-effect failure.
  // Logical destination, action, content, expiry, IDs and trace remain immutable.
  const { attempt_id, attempt_number, target, ...intent } = command;
  return fingerprint(intent);
}

interface Attempt {
  command: ConnectorCommand;
  fingerprint: string;
  result: Promise<ExecutionReceipt>;
  receipt?: ExecutionReceipt;
}
interface Operation {
  commandId: string;
  fingerprint: string;
  attempts: Map<string, Attempt>;
  latestNumber: number;
  latestId: string;
}

// Local reference state machine. Production must enforce the same transitions in DB transactions.
export class MemoryExecutionStore {
  private readonly operations = new Map<string, Operation>();
  private readonly commandKeys = new Map<string, string>();

  async execute(scope: string, input: ConnectorCommand,
    handler: (command: ConnectorCommand) => Promise<ExecutionReceipt>): Promise<ExecutionReceipt> {
    const command = connectorCommandSchema.parse(input);
    const identity = JSON.stringify([scope, command.idempotency_key]);
    const commandIdentity = JSON.stringify([scope, command.command_id]);
    const knownKey = this.commandKeys.get(commandIdentity);
    if (knownKey && knownKey !== identity) {
      throw new ProtocolError('IDEMPOTENCY_CONFLICT', 'Command ID cannot be assigned to another operation', 409);
    }
    let operation = this.operations.get(identity);
    const intentHash = operationFingerprint(command);
    if (operation && (operation.commandId !== command.command_id || operation.fingerprint !== intentHash)) {
      throw new ProtocolError('IDEMPOTENCY_CONFLICT', 'Operation intent cannot change between attempts', 409);
    }
    const attemptHash = fingerprint(command);
    const existing = operation?.attempts.get(command.attempt_id);
    if (existing) {
      if (existing.fingerprint !== attemptHash) {
        throw new ProtocolError('IDEMPOTENCY_CONFLICT', 'An attempt must keep its original payload', 409);
      }
      await existing.result;
      return existing.receipt!;
    }
    if (command.attempt_number !== (operation?.latestNumber ?? 0) + 1) {
      throw new ProtocolError('ATTEMPT_OUT_OF_ORDER', 'New attempts must use consecutive numbers', 409);
    }
    if (operation) {
      const previous = operation.attempts.get(operation.latestId)?.receipt;
      if (previous?.status !== 'failed' || !previous.error.retryable) {
        throw new ProtocolError('RETRY_NOT_ALLOWED', 'Only a determinate retryable no-effect failure permits another attempt', 409);
      }
    } else {
      operation = { commandId: command.command_id, fingerprint: intentHash, attempts: new Map(), latestNumber: 0, latestId: '' };
      this.operations.set(identity, operation);
      this.commandKeys.set(commandIdentity, identity);
    }

    const attempt: Attempt = {
      command, fingerprint: attemptHash,
      result: Promise.resolve().then(async () => {
        const base = {
          schema_version: '1' as const, command_id: command.command_id, attempt_id: command.attempt_id,
          attempt_number: command.attempt_number, revision: 1, observed_at: new Date().toISOString(),
        };
        let receipt: ExecutionReceipt;
        if (Date.parse(command.expires_at) <= Date.now()) {
          receipt = { ...base, status: 'failed', error: { code: 'COMMAND_EXPIRED', message: 'Command has expired', retryable: false } };
        } else {
          try {
            const parsed = receiptSchema.safeParse(await handler(command));
            if (!parsed.success || !matchesAttempt(command, parsed.data)) throw new Error('Invalid executor receipt');
            receipt = parsed.data;
          } catch {
            // An exception or malformed response cannot prove the external action did not happen.
            receipt = { ...base, status: 'unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'Execution requires reconciliation', retryable: false } };
          }
        }
        attempt.receipt = mergeReceipt(attempt.receipt, receipt);
        return attempt.receipt;
      }),
    };
    operation.attempts.set(command.attempt_id, attempt);
    operation.latestNumber = command.attempt_number;
    operation.latestId = command.attempt_id;
    return attempt.result;
  }

  recordReceipt(scope: string, key: string, receipt: ExecutionReceipt,
    options: { reconciled?: boolean } = {}): ExecutionReceipt {
    const operation = this.operations.get(JSON.stringify([scope, key]));
    const attempt = operation?.attempts.get(receipt.attempt_id);
    if (!attempt || !matchesAttempt(attempt.command, receipt)) {
      throw new ProtocolError('RECEIPT_SCOPE_MISMATCH', 'Receipt is outside the registered operation', 409);
    }
    attempt.receipt = mergeReceipt(attempt.receipt, receipt, options);
    return attempt.receipt;
  }

  latestReceipt(scope: string, key: string): ExecutionReceipt | null {
    const operation = this.operations.get(JSON.stringify([scope, key]));
    return operation?.attempts.get(operation.latestId)?.receipt ?? null;
  }
}
