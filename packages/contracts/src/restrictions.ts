import type { z } from 'zod';
import type { releasePreconditionsSchema } from './schema.ts';

export interface RestrictionRecord {
  restriction_id: string;
  logical_conversation_id: string;
  user_id: string;
  membership_id: string;
  version: number;
  owner: 'verification' | 'moderation' | 'administrator';
  owner_id: string;
  status: 'active' | 'released';
}

export function evaluateRestrictionRelease(input: {
  record: RestrictionRecord;
  request: z.infer<typeof releasePreconditionsSchema>;
  logicalConversationId: string;
  userId: string;
  currentMembershipId: string;
  currentPlatformFingerprint: string | null;
  otherActiveRestrictions: number;
  platformGuard: 'atomic' | 'exclusive' | 'unavailable';
}): { decision: 'release_platform' | 'release_record_only' | 'noop' | 'deny' | 'manual_review'; reason: string } {
  const { record, request } = input;
  if (record.logical_conversation_id !== input.logicalConversationId || record.user_id !== input.userId
      || record.restriction_id !== request.restriction_id || record.owner === 'administrator'
      || record.owner !== request.owner_type || record.owner_id !== request.owner_id) {
    return { decision: 'deny', reason: 'RESTRICTION_NOT_OWNED' };
  }
  if (!Number.isInteger(input.otherActiveRestrictions) || input.otherActiveRestrictions < 0) {
    return { decision: 'manual_review', reason: 'RESTRICTION_STATE_UNKNOWN' };
  }
  if (record.status === 'released') return { decision: 'noop', reason: 'ALREADY_RELEASED' };
  if (record.membership_id !== request.membership_id || request.membership_id !== input.currentMembershipId
      || record.version !== request.expected_version) {
    return { decision: 'deny', reason: 'STALE_RESTRICTION' };
  }
  // Releasing a core ledger entry does not lift any remaining platform restriction.
  if (input.otherActiveRestrictions > 0) return { decision: 'release_record_only', reason: 'OTHER_RESTRICTIONS_ACTIVE' };
  if (input.currentPlatformFingerprint === null || request.platform_fingerprint !== input.currentPlatformFingerprint) {
    return { decision: 'manual_review', reason: 'PLATFORM_STATE_CHANGED_OR_UNKNOWN' };
  }
  // Reading and then writing alone is not an atomic guard against concurrent admin changes.
  if (input.platformGuard === 'unavailable') return { decision: 'manual_review', reason: 'CONDITIONAL_RELEASE_UNSUPPORTED' };
  return { decision: 'release_platform', reason: 'OWN_RESTRICTION_UNCHANGED' };
}
