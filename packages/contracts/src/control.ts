import { z } from 'zod';
import {
  capabilityStateSchema, conversationSchema, idSchema, permissionStateSchema,
  PROTOCOL_REVISION, timestampSchema,
} from './schema.ts';
import type { Capability } from './schema.ts';

export const accountRefSchema = z.strictObject({ connector_id: idSchema, account_id: idSchema });
export const accountStateSchema = z.enum([
  'configuring', 'connecting', 'online', 'reconnecting', 'awaiting_auth', 'expired', 'paused', 'error',
]);
export const handshakeSchema = accountRefSchema.extend({
  schema_version: z.literal('1'), protocol_revision: z.literal(PROTOCOL_REVISION),
  connector_type: idSchema, instance_id: idSchema,
  display_name: z.string().min(1).max(1024),
  capabilities: z.array(capabilityStateSchema),
});
export const handshakeReplySchema = accountRefSchema.extend({
  schema_version: z.literal('1'), session_id: idSchema, lease_expires_at: timestampSchema,
});
export const heartbeatSchema = accountRefSchema.extend({
  schema_version: z.literal('1'), session_id: idSchema,
  sequence: z.number().int().positive(), state: accountStateSchema,
  observed_at: timestampSchema, last_event_at: timestampSchema.nullable(),
});
export const discoveryQuerySchema = z.strictObject({
  cursor: idSchema.optional(), snapshot_id: idSchema.optional(),
  limit: z.number().int().min(1).max(100).default(100),
}).refine(value => !value.cursor || !!value.snapshot_id, { message: 'Pagination cursors need a stable snapshot_id' });

export const conversationPageSchema = accountRefSchema.extend({
  schema_version: z.literal('1'), session_id: idSchema,
  snapshot_id: idSchema, revision: z.number().int().positive(), observed_at: timestampSchema,
  coverage: z.enum(['complete', 'partial']),
  items: z.array(conversationSchema).max(100), next_cursor: idSchema.nullable(),
}).refine(page => page.items.every(item => item.connector_id === page.connector_id && item.account_id === page.account_id), {
  message: 'All conversations must belong to the authenticated account',
});
export const memberPageSchema = z.strictObject({
  schema_version: z.literal('1'), connector_id: idSchema, account_id: idSchema, conversation_id: idSchema,
  session_id: idSchema, snapshot_id: idSchema, revision: z.number().int().positive(), observed_at: timestampSchema,
  coverage: z.enum(['complete', 'partial']), next_cursor: idSchema.nullable(),
  items: z.array(z.strictObject({
    user_id: idSchema, name: z.string().max(1024).nullable(),
    membership_id: idSchema.nullable(), role: z.enum(['owner', 'admin', 'moderator', 'member', 'unknown']),
  })).max(100),
});
export const permissionSnapshotSchema = accountRefSchema.extend({
  schema_version: z.literal('1'), conversation_id: idSchema, session_id: idSchema,
  revision: z.number().int().positive(), observed_at: timestampSchema,
  permissions: z.array(permissionStateSchema),
});

// A disconnected old process must not overwrite a newer session's state.
export function acceptHeartbeat(current: { connector_id: string; account_id: string; session_id: string; sequence: number },
  incoming: z.infer<typeof heartbeatSchema>): boolean {
  return incoming.connector_id === current.connector_id && incoming.account_id === current.account_id
    && incoming.session_id === current.session_id && incoming.sequence > current.sequence;
}

export function hasEffectiveCapability(conversation: z.infer<typeof conversationSchema>, capability: Capability): boolean {
  const support = conversation.capabilities.filter(item => item.capability === capability);
  const permission = conversation.permissions.filter(item => item.capability === capability);
  return support.length === 1 && support[0]?.state === 'supported'
    && permission.length === 1 && permission[0]?.permission === 'granted';
}
