import type { ConversationRef, SyncTrace } from './schema.ts';
import { fingerprint } from './idempotency.ts';

export function conversationKey(ref: ConversationRef): string {
  return JSON.stringify([ref.connector_id, ref.account_id, ref.conversation_id]);
}

// Logical IDs and canonical event IDs are resolved by the core, not trusted from a message body.
export function startTrace(logicalConversationId: string, canonicalEventId: string): SyncTrace {
  return {
    trace_id: fingerprint([logicalConversationId, canonicalEventId]),
    origin: { logical_conversation_id: logicalConversationId, event_id: canonicalEventId },
    visited: [logicalConversationId],
  };
}

export function nextSyncTrace(trace: SyncTrace, targetLogicalId: string, maxHops = 5): SyncTrace | null {
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 31) throw new Error('maxHops must be 1..31');
  const visited = new Set(trace.visited);
  visited.add(trace.origin.logical_conversation_id);
  if (trace.visited.length - 1 >= maxHops || visited.has(targetLogicalId)) return null;
  return { ...trace, visited: [...trace.visited, targetLogicalId] };
}

export function syncDeliveryKey(traceId: string, targetLogicalId: string): string {
  return fingerprint([traceId, targetLogicalId]);
}
