import { z } from 'zod';
import type { Context } from './context.ts';
import { ApiError } from './security.ts';

const likePattern = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

// Everyone the workspace has seen in a group: speakers, joiners, and members with a blacklist
// entry, a recorded action or a verification. Platforms cannot list every member, so this is
// a directory of known members rather than a full roster.
const memberSql = (where: string) => `
  WITH speakers AS (
    SELECT sender_id AS user_id, count(*)::int AS message_count, max(created_at) AS last_message_at,
      count(*) FILTER (WHERE verdict IN ('blocked','observed'))::int AS flagged_count,
      (array_agg(sender_name ORDER BY created_at DESC))[1] AS last_name,
      (array_agg(sender_avatar ORDER BY created_at DESC) FILTER (WHERE sender_avatar IS NOT NULL))[1] AS last_avatar
    FROM messages WHERE conversation_id=$1 AND direction='incoming' GROUP BY sender_id
  ), people AS (
    SELECT user_id FROM speakers
    UNION SELECT user_id FROM memberships WHERE conversation_id=$1
    UNION SELECT user_id FROM blacklists WHERE conversation_id=$1
    UNION SELECT user_id FROM member_actions WHERE conversation_id=$1
    UNION SELECT user_id FROM verifications WHERE conversation_id=$1
  )
  SELECT p.user_id,
    COALESCE(sp.sender_name, s.last_name, p.user_id) AS name,
    COALESCE(sp.sender_avatar, s.last_avatar) AS avatar,
    COALESCE(s.message_count, 0) AS message_count,
    s.last_message_at,
    COALESCE(s.flagged_count, 0) AS flagged_count,
    ms.status AS membership_status,
    ms.source_at AS membership_at,
    (SELECT count(*)::int FROM member_actions a
      WHERE a.conversation_id=$1 AND a.user_id=p.user_id AND a.action='warn' AND a.warning_active) AS warnings,
    (SELECT jsonb_build_object('id', b.id, 'reason', b.reason, 'expires_at', b.expires_at) FROM blacklists b
      WHERE b.conversation_id=$1 AND b.user_id=p.user_id AND (b.expires_at IS NULL OR b.expires_at>now())) AS blacklist,
    (SELECT v.status FROM verifications v WHERE v.conversation_id=$1 AND v.user_id=p.user_id
      ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS verification_status,
    GREATEST(s.last_message_at, ms.source_at) AS last_activity_at
  FROM people p
  LEFT JOIN speakers s ON s.user_id=p.user_id
  LEFT JOIN memberships ms ON ms.conversation_id=$1 AND ms.user_id=p.user_id
  LEFT JOIN sender_profiles sp ON sp.account_id=$2 AND sp.conversation_id=$1 AND sp.sender_id=p.user_id
  ${where}`;

export class MembersDirectory {
  constructor(readonly ctx: Context) {}
  private async group(id: string) {
    const group = (
      await this.ctx.db.query('SELECT id,executor_account_id FROM conversations WHERE id=$1', [id])
    )[0];
    if (!group) throw new ApiError(404, 'NOT_FOUND', '群不存在');
    return group;
  }
  async list(id: string, input: unknown) {
    const value = z
      .object({
        q: z.string().trim().max(100).default(''),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(input ?? {});
    const group = await this.group(id);
    const rows = await this.ctx.db.query(
      memberSql(`WHERE ($3='' OR p.user_id ILIKE $4 OR COALESCE(sp.sender_name, s.last_name, '') ILIKE $4)
        ORDER BY last_activity_at DESC NULLS LAST, p.user_id LIMIT $5`),
      [id, group.executor_account_id, value.q, likePattern(value.q), value.limit + 1],
    );
    return { members: rows.slice(0, value.limit), truncated: rows.length > value.limit };
  }
  async detail(id: string, userId: string) {
    const user = z.string().min(1).max(256).parse(userId);
    const group = await this.group(id);
    const member = (
      await this.ctx.db.query(memberSql('WHERE p.user_id=$3'), [id, group.executor_account_id, user])
    )[0];
    if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', '没有这位成员的记录');
    const [messages, actions, verifications, keywordHits] = await Promise.all([
      this.ctx.db.query(
        `SELECT id,content,verdict,reason,deleted,created_at FROM messages
        WHERE conversation_id=$1 AND sender_id=$2 AND direction='incoming' ORDER BY created_at DESC,id DESC LIMIT 30`,
        [id, user],
      ),
      this.ctx.db.query(
        `SELECT a.id,a.action,a.reason,a.actor,a.source,a.warning_active,a.created_at,j.status AS job_status,j.last_error
        FROM member_actions a LEFT JOIN jobs j ON j.id=a.job_id
        WHERE a.conversation_id=$1 AND a.user_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT 50`,
        [id, user],
      ),
      this.ctx.db.query(
        `SELECT id,status,attempts,created_at,expires_at FROM verifications
        WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 10`,
        [id, user],
      ),
      this.ctx.db.query(
        `SELECT id,rule_name,action,keyword,status,created_at FROM keyword_hits
        WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20`,
        [id, user],
      ),
    ]);
    return { member, messages, actions, verifications, keyword_hits: keywordHits };
  }
}
