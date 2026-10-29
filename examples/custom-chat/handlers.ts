import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  connectorCommandSchema, connectorEventSchema, conversationKey, conversationSchema,
  fingerprint, MemoryIdempotencyStore, MemoryReplayStore, ProtocolError,
  receiptSchema, signRequest, verifyRequest, MemoryExecutionStore, authorizeSync,
  conversationPageSchema,
  requiredCapabilities, hasEffectiveCapability,
} from '../../packages/contracts/src/index.ts';
import type {
  ConnectorCommand, ConnectorEvent, ConversationRef, ExecutionReceipt,
} from '../../packages/contracts/src/index.ts';

export const EVENT_PATH = '/api/v1/connector-events';
export const COMMAND_PATH = '/superbot/v1/commands';
export const CONVERSATION_PATH = '/superbot/v1/conversations';

async function readBody(request: Request): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new ProtocolError('INVALID_PAYLOAD', 'JSON body is required');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        throw new ProtocolError('PAYLOAD_TOO_LARGE', 'Maximum body size is 256 KiB', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProtocolError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return Response.json({ error: { code: 'INVALID_PAYLOAD', message: 'Invalid protocol payload' } }, { status: 400 });
  }
  return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Request could not be processed' } }, { status: 500 });
}

function assertScope(actual: ConversationRef, allowed: ConversationRef): void {
  if (conversationKey(actual) !== conversationKey(allowed)) {
    throw new ProtocolError('FORBIDDEN_SCOPE', 'Conversation is outside the credential scope', 403);
  }
}

// A local reference implementation, deliberately limited to one account/conversation.
// Request/Response handlers can be mounted behind an HTTP framework's route adapter.
export function createDemoBridge(config: {
  conversation: ConversationRef;
  eventSecret: string;
  commandSecret: string;
  logicalConversationId?: string;
  reviewMessage?: (event: Extract<ConnectorEvent, { type: 'message.created' }>) => Promise<'allowed' | 'blocked' | 'pending'>;
}) {
  const eventNonces = new MemoryReplayStore();
  const commandNonces = new MemoryReplayStore();
  const inbox = new MemoryIdempotencyStore<ExecutionReceipt | null>();
  const commands = new MemoryExecutionStore();
  const outbox = new Map<string, ConnectorCommand>();
  const messages: { message_id: string; segments: unknown[] }[] = [];
  const events: ConnectorEvent[] = [];
  const scope = JSON.stringify([config.conversation.connector_id, config.conversation.account_id]);
  const logicalId = config.logicalConversationId ?? 'demo-logical-room';
  const conversation = conversationSchema.parse({
    ...config.conversation,
    name: '自有聊天项目测试群', kind: 'group', member_count: null,
    observed_at: new Date().toISOString(),
    capabilities: [
      { capability: 'messages.read', state: 'supported' },
      { capability: 'messages.send', state: 'supported' },
      { capability: 'members.remove', state: 'unsupported', reason: '示例未实现成员管理' },
    ],
    permissions: [{ capability: 'messages.send', permission: 'granted' }],
  });

  async function authenticate(request: Request, path: string, secret: string, store: MemoryReplayStore) {
    const url = new URL(request.url);
    if (url.pathname + url.search !== path) throw new ProtocolError('NOT_FOUND', 'Unknown endpoint', 404);
    if (request.method !== 'POST') throw new ProtocolError('METHOD_NOT_ALLOWED', 'POST is required', 405);
    const body = await readBody(request);
    await verifyRequest({
      method: request.method, path, body, secret, headers: request.headers,
      scope, replayStore: store,
      keyId: path === EVENT_PATH ? 'demo-events' : 'demo-commands',
      purpose: path === EVENT_PATH ? 'events' : 'commands',
    });
    return JSON.parse(body.toString('utf8')) as unknown;
  }

  async function handleCommand(request: Request): Promise<Response> {
    try {
      const command = connectorCommandSchema.parse(
        await authenticate(request, COMMAND_PATH, config.commandSecret, commandNonces),
      );
      assertScope(command.target, config.conversation);
      if (command.logical_conversation_id !== logicalId) throw new ProtocolError('FORBIDDEN_SCOPE', 'Logical destination is not registered', 403);
      const receipt = await commands.execute(scope, command, async () => {
        const base = {
          schema_version: '1' as const, command_id: command.command_id, observed_at: new Date().toISOString(),
          attempt_id: command.attempt_id, attempt_number: command.attempt_number, revision: 1,
        };
        if (command.action !== 'message.send' || requiredCapabilities(command).some(capability => !hasEffectiveCapability(conversation, capability))) {
          return { ...base, status: 'failed', error: { code: 'CAPABILITY_UNSUPPORTED', message: 'Demo supports message.send only', retryable: false } };
        }
        const message_id = randomUUID();
        messages.push({ message_id, segments: command.params.segments });
        return { ...base, status: 'succeeded', result: { message_id } };
      });
      return Response.json(receiptSchema.parse(receipt));
    } catch (error) {
      return errorResponse(error);
    }
  }

  async function handleEvent(request: Request): Promise<Response> {
    try {
      const event = connectorEventSchema.parse(
        await authenticate(request, EVENT_PATH, config.eventSecret, eventNonces),
      );
      assertScope(event.source, config.conversation);
      const result = await inbox.run(scope, event.event_id, event, async () => {
        // Only original incoming messages receive a demo acknowledgement.
        // Outgoing echoes and synchronized events must never start another reply.
        if (event.type !== 'message.created' || event.data.direction !== 'incoming' || event.trace) {
          events.push(event);
          return null;
        }
        // This is a demo review policy. The production core must persist an actual verdict.
        const snapshot = {
          logical_conversation_id: logicalId, message_id: event.data.message_id,
          content_version: 1, content_fingerprint: fingerprint(event.data), deleted: false,
        };
        const review = {
          ...snapshot, decision_id: fingerprint([event.event_id, 'review']),
          policy_version: 'demo-policy-1',
          verdict: config.reviewMessage ? await config.reviewMessage(event) : 'allowed' as const,
          evaluated_at: new Date().toISOString(),
        };
        const gate = authorizeSync({ message: snapshot, review, currentPolicyVersion: 'demo-policy-1', verification: 'not_required', blacklisted: false });
        if (!gate.allowed) { events.push(event); return null; }
        const key = fingerprint([event.source, event.event_id, 'demo-ack']);
        let command = outbox.get(key);
        if (!command) {
          command = connectorCommandSchema.parse({
            schema_version: '1', command_id: `cmd-${key}`, idempotency_key: key,
            attempt_id: `attempt-${key}`, attempt_number: 1, logical_conversation_id: logicalId,
            created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
            target: event.source, action: 'message.send',
            params: { segments: [{ type: 'text', text: '超级机器人已收到消息。' }], reply_to: event.data.message_id },
          });
          outbox.set(key, command);
        }
        const body = JSON.stringify(command);
        const response = await handleCommand(new Request(`http://custom-chat.local${COMMAND_PATH}`, {
          method: 'POST', body,
          headers: signRequest({ method: 'POST', path: COMMAND_PATH, body, secret: config.commandSecret, keyId: 'demo-commands', purpose: 'commands' }),
        }));
        if (!response.ok) throw new Error('Command endpoint rejected the request');
        const receipt = receiptSchema.parse(await response.json());
        if (receipt.command_id !== command.command_id) throw new Error('Receipt command ID does not match');
        events.push(event);
        return receipt;
      });
      return Response.json({ event_id: event.event_id, duplicate: result.duplicate, receipt: result.value });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async function handleDiscovery(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname !== CONVERSATION_PATH || url.search) throw new ProtocolError('NOT_FOUND', 'Demo has a single discovery page', 404);
      if (request.method !== 'GET') throw new ProtocolError('METHOD_NOT_ALLOWED', 'GET is required', 405);
      const body = request.body ? await readBody(request) : Buffer.alloc(0);
      await verifyRequest({
        method: 'GET', path: url.pathname, body, headers: request.headers,
        secret: config.commandSecret, keyId: 'demo-commands', purpose: 'control', scope, replayStore: commandNonces,
      });
      return Response.json(conversationPageSchema.parse({
        schema_version: '1', connector_id: config.conversation.connector_id, account_id: config.conversation.account_id,
        session_id: 'demo-session', snapshot_id: 'demo-snapshot', revision: 1,
        observed_at: new Date().toISOString(), coverage: 'complete', items: [conversation], next_cursor: null,
      }));
    } catch (error) { return errorResponse(error); }
  }

  return { conversation, events, messages, handleEvent, handleCommand, handleDiscovery };
}
