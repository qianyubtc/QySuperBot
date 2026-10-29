import { z } from 'zod';

// Platform IDs are opaque strings: numeric conversion can lose precision.
export const idSchema = z.string().min(1).max(256).regex(/^[^\u0000-\u0020\u007f]+$/u);
export const timestampSchema = z.iso.datetime();
const id = idSchema;
const timestamp = timestampSchema;
export const PROTOCOL_REVISION = '0.2';

export const conversationRefSchema = z.strictObject({
  connector_id: id,
  account_id: id,
  conversation_id: id,
});
export type ConversationRef = z.infer<typeof conversationRefSchema>;

export const capabilitySchema = z.enum([
  'conversations.list', 'messages.read', 'messages.send', 'messages.delete',
  'messages.hide', 'members.list', 'members.mute', 'members.remove',
  'members.ban', 'members.release_conditionally', 'membership.review',
  'interactions.buttons', 'interactions.ack',
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const capabilityStateSchema = z.strictObject({
  capability: capabilitySchema,
  state: z.enum(['supported', 'unsupported', 'unknown']),
  reason: z.string().max(1024).optional(),
});

export const permissionStateSchema = z.strictObject({
  capability: capabilitySchema,
  permission: z.enum(['granted', 'denied', 'unknown']),
  reason: z.string().max(1024).optional(),
});

export const conversationSchema = conversationRefSchema.extend({
  kind: z.enum(['group', 'community', 'channel', 'direct', 'other']),
  name: z.string().min(1).max(1024),
  member_count: z.number().int().nonnegative().nullable(),
  observed_at: timestamp,
  capabilities: z.array(capabilityStateSchema),
  permissions: z.array(permissionStateSchema),
});

export const segmentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(32000) }),
  z.strictObject({
    type: z.literal('image'), asset_id: id, alt: z.string().max(1024).optional(),
  }),
  z.strictObject({
    type: z.literal('file'), asset_id: id, name: z.string().min(1).max(1024),
  }),
  z.strictObject({ type: z.literal('mention'), user_id: id }),
]);
const segments = z.array(segmentSchema).min(1).max(100);

export const traceSchema = z.strictObject({
  trace_id: id,
  origin: z.strictObject({ logical_conversation_id: id, event_id: id }),
  visited: z.array(id).min(1).max(32),
}).refine(value => value.visited[0] === value.origin.logical_conversation_id
  && new Set(value.visited).size === value.visited.length, { message: 'Trace must start at its origin and contain distinct logical conversations' });
export type SyncTrace = z.infer<typeof traceSchema>;

const eventBase = {
  schema_version: z.literal('1'),
  event_id: id,
  occurred_at: timestamp,
  source: conversationRefSchema,
  trace: traceSchema.optional(),
};
const messageData = z.strictObject({
  message_id: id,
  sender_id: id,
  direction: z.enum(['incoming', 'outgoing']),
  segments,
  reply_to: id.optional(),
  thread_id: id.optional(),
});

export const connectorEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventBase, type: z.literal('message.created'), data: messageData }),
  z.strictObject({ ...eventBase, type: z.literal('message.edited'), data: messageData }),
  z.strictObject({
    ...eventBase, type: z.literal('message.deleted'),
    data: z.strictObject({ message_id: id }),
  }),
  z.strictObject({
    ...eventBase, type: z.literal('member.joined'),
    data: z.strictObject({ user_id: id, membership_id: id }),
  }),
  z.strictObject({
    ...eventBase, type: z.literal('member.left'),
    data: z.strictObject({ user_id: id, membership_id: id }),
  }),
  z.strictObject({
    ...eventBase, type: z.literal('membership.requested'),
    data: z.strictObject({ request_id: id, user_id: id }),
  }),
  z.strictObject({
    ...eventBase, type: z.literal('interaction.created'),
    data: z.strictObject({
      interaction_id: id, user_id: id, value: z.string().min(1).max(1024),
      message_id: id.optional(), expires_at: timestamp, acknowledged: z.boolean(),
    }),
  }),
]);
export type ConnectorEvent = z.infer<typeof connectorEventSchema>;

const commandBase = {
  schema_version: z.literal('1'),
  command_id: id,
  idempotency_key: id,
  attempt_id: id,
  attempt_number: z.number().int().positive(),
  logical_conversation_id: id,
  created_at: timestamp,
  expires_at: timestamp,
  target: conversationRefSchema,
  trace: traceSchema.optional(),
};

export const buttonSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('callback'), label: z.string().min(1).max(128), value: z.string().min(1).max(1024) }),
  z.strictObject({ type: z.literal('url'), label: z.string().min(1).max(128), url: z.httpUrl() }),
]);

export const releasePreconditionsSchema = z.strictObject({
  restriction_id: id,
  owner_type: z.enum(['verification', 'moderation']),
  owner_id: id,
  membership_id: id,
  expected_version: z.number().int().positive(),
  platform_fingerprint: id,
});

export const connectorCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...commandBase, action: z.literal('message.send'),
    params: z.strictObject({
      segments, reply_to: id.optional(), thread_id: id.optional(),
      buttons: z.array(z.array(buttonSchema).min(1).max(5)).min(1).max(5).optional(),
    }),
  }),
  z.strictObject({
    ...commandBase, action: z.literal('message.delete'),
    params: z.strictObject({ message_id: id, reason: z.string().min(1).max(1024) }),
  }),
  z.strictObject({
    ...commandBase, action: z.literal('message.hide'),
    params: z.strictObject({ message_id: id, reason: z.string().min(1).max(1024) }),
  }),
  z.strictObject({
    ...commandBase, action: z.literal('member.mute'),
    params: z.strictObject({
      user_id: id, duration_seconds: z.number().int().positive(),
      reason: z.string().min(1).max(1024),
    }),
  }),
  // Explicit administrator changes are separate from ownership-checked automatic release.
  z.strictObject({
    ...commandBase, action: z.literal('member.set_mute'),
    params: z.strictObject({
      user_id: id, muted: z.boolean(), expected_muted: z.boolean(),
      reason: z.string().min(1).max(1024),
    }).refine(value => value.muted !== value.expected_muted, { message: 'Mute state must change' }),
  }),
  z.strictObject({
    ...commandBase, action: z.literal('member.unmute'),
    params: z.strictObject({
      user_id: id, reason: z.string().min(1).max(1024), preconditions: releasePreconditionsSchema,
    }),
  }),
  z.strictObject({
    ...commandBase, action: z.enum(['member.remove', 'member.ban', 'member.unban']),
    params: z.strictObject({ user_id: id, reason: z.string().min(1).max(1024) }),
  }),
  z.strictObject({
    ...commandBase, action: z.enum(['membership.approve', 'membership.reject']),
    params: z.strictObject({ request_id: id, reason: z.string().min(1).max(1024) }),
  }),
  z.strictObject({
    ...commandBase, action: z.literal('interaction.ack'),
    params: z.strictObject({ interaction_id: id, text: z.string().max(512).optional() }),
  }),
]).refine(value => Date.parse(value.expires_at) > Date.parse(value.created_at), {
  message: 'expires_at must be later than created_at', path: ['expires_at'],
});
export type ConnectorCommand = z.infer<typeof connectorCommandSchema>;

const receiptBase = {
  schema_version: z.literal('1'), command_id: id, observed_at: timestamp,
  attempt_id: id, attempt_number: z.number().int().positive(), revision: z.number().int().positive(),
};
const executionError = z.strictObject({
  code: id, message: z.string().min(1).max(1024), retryable: z.boolean(),
});
export const receiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...receiptBase, status: z.literal('accepted') }),
  z.strictObject({
    ...receiptBase, status: z.literal('succeeded'),
    result: z.strictObject({ message_id: id.optional(), member: z.strictObject({
      group_id: id, user_id: id, state: z.enum(['muted', 'unmuted', 'removed']), verified_at: timestamp,
    }).optional() }),
  }),
  z.strictObject({ ...receiptBase, status: z.literal('failed'), error: executionError }),
  z.strictObject({
    ...receiptBase, status: z.literal('unknown'),
    error: executionError.extend({ retryable: z.literal(false) }),
  }),
]);
export type ExecutionReceipt = z.infer<typeof receiptSchema>;

export const commandCapabilities: Record<ConnectorCommand['action'], Capability> = {
  'message.send': 'messages.send',
  'message.delete': 'messages.delete',
  'message.hide': 'messages.hide',
  'member.mute': 'members.mute',
  'member.set_mute': 'members.mute',
  'member.unmute': 'members.release_conditionally',
  'member.remove': 'members.remove',
  'member.ban': 'members.ban',
  'member.unban': 'members.ban',
  'membership.approve': 'membership.review',
  'membership.reject': 'membership.review',
  'interaction.ack': 'interactions.ack',
};

export function requiredCapabilities(command: ConnectorCommand): Capability[] {
  const result = [commandCapabilities[command.action]];
  if (command.action === 'message.send' && command.params.buttons) result.push('interactions.buttons');
  if (command.action === 'member.unmute') result.push('members.mute');
  return result;
}
