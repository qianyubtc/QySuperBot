import { z } from 'zod';
import { idSchema, timestampSchema } from './schema.ts';

export const messageSnapshotSchema = z.strictObject({
  logical_conversation_id: idSchema, message_id: idSchema,
  content_version: z.number().int().positive(), content_fingerprint: idSchema,
  deleted: z.boolean(),
});
export const moderationDecisionSchema = messageSnapshotSchema.omit({ deleted: true }).extend({
  decision_id: idSchema, policy_version: idSchema,
  verdict: z.enum(['allowed', 'blocked', 'pending']), evaluated_at: timestampSchema,
});
export type MessageSnapshot = z.infer<typeof messageSnapshotSchema>;
export type ModerationDecision = z.infer<typeof moderationDecisionSchema>;

// Inputs must come from authoritative core records, never a caller-supplied "approved" flag.
export function authorizeSync(input: {
  message: MessageSnapshot;
  review: ModerationDecision | null;
  currentPolicyVersion: string;
  verification: 'not_required' | 'passed' | 'pending' | 'failed';
  blacklisted: boolean;
}): { allowed: true; decision_id: string } | { allowed: false; reason: string } {
  if (input.message.deleted) return { allowed: false, reason: 'MESSAGE_DELETED' };
  if (input.blacklisted) return { allowed: false, reason: 'BLACKLISTED' };
  if (!['not_required', 'passed'].includes(input.verification)) return { allowed: false, reason: 'VERIFICATION_REQUIRED' };
  const review = input.review;
  if (!review || review.verdict !== 'allowed') return { allowed: false, reason: 'REVIEW_REQUIRED' };
  if (review.logical_conversation_id !== input.message.logical_conversation_id
      || review.message_id !== input.message.message_id
      || review.content_version !== input.message.content_version
      || review.content_fingerprint !== input.message.content_fingerprint
      || review.policy_version !== input.currentPolicyVersion) {
    return { allowed: false, reason: 'STALE_REVIEW' };
  }
  return { allowed: true, decision_id: review.decision_id };
}
