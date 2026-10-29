import { randomInt, randomUUID } from 'node:crypto';
import type { ConnectorCommand, ExecutionReceipt } from '../../../packages/contracts/src/index.ts';
import type { Context } from './context.ts';
import { audit, epoch, json } from './context.ts';
import type { Row, Sql } from './database.ts';
import type { JobsService } from './jobs.ts';
import { ApiError, equal, sha } from './security.ts';
import { groupEnabled } from './scope.ts';

export interface QQMembershipProof {
  join_time?: number;
  muted_until?: number;
}
export const qqVerificationPurposes = new Set([
  'qq-verification-challenge',
  'qq-verification-timeout',
  'qq-verification-notice',
  'qq-verification-failure',
  'qq-verification-timeout-mute',
]);
export const qqVerificationRequired = (row?: Row) =>
  !!row?.qq_context && !['left', 'superseded', 'cancelled', 'removed'].includes(row.status);
const final = new Set(['passed', 'left', 'superseded', 'cancelled', 'removed']);
const labels: Record<string, string> = {
  challenge_pending: '等待发送验证',
  challenge_in_flight: '正在发送验证',
  challenge_failed: '验证提示发送失败',
  challenge_unknown: '验证提示待核对',
  pending: '等待成员验证',
  failed: '回答次数已达上限',
  expired: '已超时，等待处理',
  manual_review: '等待人工处理',
  timeout_pending: '超时，等待移出',
  timeout_in_flight: '超时，正在移出',
  timeout_failed: '移出失败',
  timeout_unknown: '移出结果待核对',
  failure_pending: '答错三次，等待禁言',
  failure_in_flight: '正在禁言',
  failure_succeeded: '已禁言 10 分钟，待人工处理',
  failure_failed: '禁言失败，待人工处理',
  failure_unknown: '禁言结果待核对',
  cooldown: '禁言中，等待重新验证',
  timeout_mute_pending: '超时，等待禁言',
  timeout_mute_in_flight: '超时，正在禁言',
  timeout_mute_failed: '超时禁言失败，待人工处理',
  timeout_mute_unknown: '超时禁言结果待核对',
  muted: '禁言已执行，循环已停止',
  passed: '已通过',
  removed: '已移出',
  left: '成员已退群',
  superseded: '旧入群批次',
  cancelled: '已停止验证',
};
function present(row: Row): Row {
  let state = row.status;
  if (row.is_qq_verification && !final.has(state)) {
    if (row.timeout_job_id) {
      const status = row.timeout_status;
      state =
        row.timeout_command === 'member.mute'
          ? status === 'succeeded'
            ? row.status === 'cooldown' && row.retry_after
              ? 'cooldown'
              : 'muted'
            : status === 'cancelled'
              ? 'manual_review'
              : `timeout_mute_${status === 'accepted' ? 'in_flight' : status}`
          : status === 'succeeded'
            ? 'removed'
            : status === 'cancelled'
              ? 'manual_review'
              : `timeout_${status === 'accepted' ? 'in_flight' : status}`;
    } else if (row.failure_job_id) {
      state =
        row.failure_status === 'succeeded' && row.status === 'cooldown' && row.retry_after
          ? 'cooldown'
          : row.failure_status === 'cancelled'
            ? 'manual_review'
            : `failure_${row.failure_status === 'accepted' ? 'in_flight' : row.failure_status}`;
    } else if (row.challenge_status === 'unknown') state = 'challenge_unknown';
    else if (row.challenge_status === 'failed') state = 'challenge_failed';
    else if (!row.challenge_sent_at && row.status === 'pending')
      state = row.challenge_status === 'in_flight' ? 'challenge_in_flight' : 'challenge_pending';
  }
  const blocked =
    ['in_flight', 'accepted', 'unknown'].includes(row.timeout_status) ||
    (row.timeout_status === 'succeeded' && row.timeout_command !== 'member.mute') ||
    ['in_flight', 'accepted', 'unknown'].includes(row.failure_status);
  const mutedUntil =
    (row.failure_status === 'succeeded' ||
      (row.timeout_status === 'succeeded' && row.timeout_command === 'member.mute')) &&
    Number.isFinite(epoch(row.failure_observed_at ?? row.timeout_observed_at))
      ? new Date(epoch(row.failure_observed_at ?? row.timeout_observed_at) + 600000).toISOString()
      : null;
  return {
    ...row,
    display_state: state,
    display_label: labels[state] ?? state,
    muted_until: mutedUntil,
    can_approve:
      !final.has(row.status) &&
      !blocked &&
      (!row.is_qq_verification || (row.current_membership && row.account_matches)),
    can_resend:
      row.is_qq_verification &&
      !['passed', 'left', 'superseded', 'removed'].includes(row.status) &&
      row.current_membership &&
      row.verification_enabled &&
      row.account_status === 'online' &&
      row.sync_enabled &&
      row.account_matches &&
      !blocked &&
      row.timeout_status !== 'pending' &&
      row.failure_status !== 'pending' &&
      (!mutedUntil || epoch(mutedUntil) <= Date.now()) &&
      (!row.retry_after || epoch(row.retry_after) <= Date.now()) &&
      !['pending', 'in_flight', 'accepted', 'unknown'].includes(row.challenge_status),
  };
}
export async function verificationRows(sql: Sql, groupId?: string, requestIds?: string[]) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (groupId) {
    values.push(groupId);
    conditions.push(`v.conversation_id=$${values.length}`);
  }
  if (requestIds) {
    values.push(requestIds);
    conditions.push(`v.qq_context->>'join_request_id'=ANY($${values.length}::text[])`);
  }
  const rows = await sql.query(
    `SELECT v.id,v.conversation_id,v.user_id,v.membership_id,v.status,v.attempts,
    v.expires_at,v.created_at,v.challenge_sent_at,v.detail_reason,v.challenge_job_id,v.timeout_job_id,v.failure_job_id,v.retry_after,
    COALESCE((v.qq_context->>'round')::int,1) AS verification_round,
    v.qq_context IS NOT NULL AS is_qq_verification,v.qq_context->>'join_request_id' AS join_request_id,
    v.qq_context->>'timeout_action' AS timeout_action,c.name AS conversation_name,c.platform,
    v.qq_context->>'failed_action' AS failed_action,
    (c.policy->>'verification_enabled')::boolean AS verification_enabled,a.status AS account_status,
    COALESCE((a.settings->'group_ids') @> jsonb_build_array(c.external_id),true) AS sync_enabled,
    c.executor_account_id=v.qq_context->>'account_id' AS account_matches,
    EXISTS(SELECT 1 FROM memberships m WHERE m.conversation_id=v.conversation_id AND m.user_id=v.user_id AND m.membership_id=v.membership_id AND m.status='active') AS current_membership,
    cj.status AS challenge_status,cj.last_error AS challenge_error,tj.status AS timeout_status,tj.last_error AS timeout_error,tj.action AS timeout_command,tj.receipt->>'observed_at' AS timeout_observed_at,
    fj.status AS failure_status,fj.last_error AS failure_error,fj.receipt->>'observed_at' AS failure_observed_at
    FROM verifications v JOIN conversations c ON c.id=v.conversation_id JOIN accounts a ON a.id=c.executor_account_id
    LEFT JOIN jobs cj ON cj.id=v.challenge_job_id LEFT JOIN jobs tj ON tj.id=v.timeout_job_id
    LEFT JOIN jobs fj ON fj.id=v.failure_job_id
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY v.created_at DESC,v.id DESC LIMIT 200`,
    values,
  );
  return rows.map(present);
}

export async function checkQQVerification(
  ctx: Context,
  job: Row,
  group: Row,
  account: Row,
  command: ConnectorCommand,
  proof?: QQMembershipProof,
) {
  const ref = job.review_ref;
  const fail = (code: string, message: string) => ({ code, message });
  const v = (
    await ctx.db.query('SELECT * FROM verifications WHERE id=$1 AND conversation_id=$2', [
      ref.verification_id,
      group.id,
    ])
  )[0];
  const data = v?.qq_context;
  const challenge = ref.purpose === 'qq-verification-challenge';
  const removal = ref.purpose === 'qq-verification-timeout';
  const failure = ref.purpose === 'qq-verification-failure';
  const timeoutMute = ref.purpose === 'qq-verification-timeout-mute';
  if (
    account.kind !== 'qq' ||
    group.kind !== 'group' ||
    !data ||
    data.account_id !== account.id ||
    v.user_id !== ref.user_id ||
    v.membership_id !== ref.membership_id ||
    (failure || timeoutMute
      ? command.action !== 'member.mute' ||
        command.params.user_id !== v.user_id ||
        command.params.duration_seconds !== 600 ||
        (failure ? v.failure_job_id !== job.id : v.timeout_job_id !== job.id)
      : removal
        ? command.action !== 'member.remove' ||
          command.params.user_id !== v.user_id ||
          v.timeout_job_id !== job.id
        : command.action !== 'message.send' || (challenge && v.challenge_job_id !== job.id))
  )
    return fail('QQ_VERIFICATION_SCOPE', '验证任务与账号、成员或入群批次不匹配，未执行');
  if (!Number.isFinite(epoch(ref.expires_at)) || epoch(ref.expires_at) <= Date.now())
    return fail('QQ_VERIFICATION_JOB_EXPIRED', '验证任务已过期，请在后台核对');
  if (
    !group.policy.verification_enabled ||
    (group.management_settings.qq_verification_revision ?? '0') !== data.verification_revision ||
    (account.settings.group_revision ?? '0') !== data.group_revision
  )
    return fail('QQ_VERIFICATION_SETTINGS_CHANGED', '验证规则或同步范围已变化，停止旧任务');
  const member = (
    await ctx.db.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
      group.id,
      v.user_id,
    ])
  )[0];
  if (!member || member.status !== 'active' || member.membership_id !== v.membership_id)
    return fail('QQ_VERIFICATION_MEMBERSHIP_CHANGED', '成员已退群或重新入群，停止旧验证任务');
  if (challenge) {
    if (v.status !== 'pending' || v.challenge_sent_at)
      return fail('QQ_VERIFICATION_FINISHED', '验证已结束，停止发送旧提示');
    if (
      Number.isSafeInteger(proof?.join_time) &&
      proof!.join_time! > 0 &&
      Math.abs(proof!.join_time! - data.source_time) <= 3
    )
      await ctx.db.query(
        `UPDATE verifications SET qq_context=jsonb_set(qq_context,'{platform_join_time}',to_jsonb($2::bigint))
        WHERE id=$1 AND status='pending' AND challenge_job_id=$3`,
        [v.id, proof!.join_time, job.id],
      );
  } else if (removal || failure || timeoutMute) {
    if (
      (failure
        ? !['failed', 'manual_review'].includes(v.status) || v.attempts !== 3 || data.failed_action !== 'mute'
        : v.status !== 'expired' || data.timeout_action !== (timeoutMute ? 'mute_retry' : 'remove')) ||
      !v.challenge_sent_at ||
      (!failure && epoch(v.expires_at) > Date.now())
    )
      return fail('QQ_VERIFICATION_FINISHED', '成员已完成验证或处理条件不成立，未执行成员处理');
    const challengeJob = (await ctx.db.query('SELECT status FROM jobs WHERE id=$1', [v.challenge_job_id]))[0];
    if (challengeJob?.status !== 'succeeded')
      return fail('QQ_VERIFICATION_CHALLENGE_UNCONFIRMED', '验证提示未确认送达，不自动处理成员');
    if (
      !Number.isSafeInteger(data.platform_join_time) ||
      data.platform_join_time <= 0 ||
      (proof && proof.join_time !== data.platform_join_time)
    )
      return fail('QQ_VERIFICATION_JOIN_TIME_UNKNOWN', '无法确认仍为原平台入群批次，请人工处理');
    if (
      (failure || timeoutMute) &&
      proof &&
      (!Number.isSafeInteger(proof.muted_until) ||
        proof.muted_until! < 0 ||
        proof.muted_until! > Date.now() / 1000)
    )
      return fail(
        'QQ_VERIFICATION_EXISTING_MUTE',
        '成员已有禁言或无法确认禁言状态，不覆盖现有处分，请人工核对',
      );
  } else if (v.status !== 'passed') return fail('QQ_VERIFICATION_FINISHED', '验证状态已变化，停止旧通知');
  return null;
}

export async function applyQQVerificationReceipt(tx: Sql, job: Row, receipt: ExecutionReceipt) {
  const ref = job.review_ref;
  if (!ref || !qqVerificationPurposes.has(ref.purpose) || receipt.status === 'accepted') return;
  const v = (await tx.query('SELECT * FROM verifications WHERE id=$1 FOR UPDATE', [ref.verification_id]))[0];
  if (!v?.qq_context) return;
  if (ref.purpose === 'qq-verification-challenge' && v.challenge_job_id === job.id) {
    if (receipt.status === 'succeeded' && v.status === 'pending' && !v.challenge_sent_at) {
      const group = (
        await tx.query('SELECT management_settings,policy FROM conversations WHERE id=$1', [
          v.conversation_id,
        ])
      )[0];
      if (
        group?.policy.verification_enabled &&
        (group.management_settings.qq_verification_revision ?? '0') === v.qq_context.verification_revision
      )
        await tx.query(
          `UPDATE verifications SET challenge_sent_at=now(),expires_at=$2,detail_reason='验证提示已确认发送，等待本人作答' WHERE id=$1`,
          [v.id, new Date(Date.now() + v.qq_context.timeout_seconds * 1000).toISOString()],
        );
    } else if (
      receipt.status === 'failed' &&
      receipt.error.code === 'QQ_VERIFICATION_PROTECTED' &&
      v.status === 'pending'
    ) {
      await tx.query(
        "UPDATE verifications SET status='passed',detail_reason='已实时确认群主或管理员身份，免验证' WHERE id=$1",
        [v.id],
      );
    }
  } else if (
    (ref.purpose === 'qq-verification-failure' &&
      v.failure_job_id === job.id &&
      ['failed', 'manual_review'].includes(v.status)) ||
    (ref.purpose === 'qq-verification-timeout-mute' &&
      v.timeout_job_id === job.id &&
      ['expired', 'manual_review'].includes(v.status))
  ) {
    const loop = receipt.status === 'succeeded' && v.qq_context.timeout_action === 'mute_retry';
    const reason =
      receipt.status === 'succeeded'
        ? loop
          ? '验证失败，平台已确认禁言 10 分钟；到期确认已解除后自动 @ 成员重新出题'
          : '连续答错三次，平台已确认禁言 10 分钟；到期由 QQ 自动解除，验证仍需管理员处理'
        : receipt.status === 'unknown'
          ? '禁言结果待核对，不会自动重试；请核对平台结果'
          : '答错禁言未执行成功，请管理员核对原因并处理验证';
    await tx.query('UPDATE verifications SET status=$3,detail_reason=$2,retry_after=$4 WHERE id=$1', [
      v.id,
      reason,
      loop ? 'cooldown' : 'manual_review',
      loop ? new Date(Date.now() + 605000).toISOString() : null,
    ]);
    await audit(tx, '系统任务', 'qq.verification.muted', v.conversation_id, {
      verification_id: v.id,
      job_id: job.id,
      status: receipt.status,
    });
  } else if (
    ref.purpose === 'qq-verification-timeout' &&
    v.timeout_job_id === job.id &&
    ['expired', 'left'].includes(v.status) &&
    receipt.status === 'succeeded'
  ) {
    await tx.query(
      "UPDATE verifications SET status='removed',detail_reason='验证超时，已取得平台移出成功回执' WHERE id=$1",
      [v.id],
    );
    await audit(tx, '系统任务', 'qq.verification.removed', v.conversation_id, {
      verification_id: v.id,
      job_id: job.id,
    });
  }
}

export class QQVerification {
  constructor(
    readonly ctx: Context,
    readonly jobs: JobsService,
    readonly refreshPermissions?: (accountId: string) => Promise<unknown>,
  ) {}
  async create(tx: Sql, group: Row, account: Row, userId: string, membershipId: string) {
    if (userId === account.external_id || !/^[1-9]\d{4,19}$/.test(userId)) return;
    const member = (
      await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [group.id, userId])
    )[0];
    const sourceTime = member ? Math.floor(epoch(member.source_at) / 1000) : 0;
    if (
      !member ||
      member.status !== 'active' ||
      member.membership_id !== membershipId ||
      epoch(member.source_at) < Date.now() - 300000 ||
      epoch(member.source_at) > Date.now() + 60000 ||
      sourceTime < (group.management_settings.qq_verification_enabled_at ?? 0)
    )
      return;
    const id = randomUUID();
    const a = randomInt(2, 21),
      b = randomInt(2, 21);
    const request = (
      await tx.query(
        `SELECT id FROM qq_join_requests WHERE conversation_id=$1 AND account_id=$2 AND user_id=$3
      AND created_at>=$4 AND source_at<=$5 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [
          group.id,
          account.id,
          userId,
          new Date(epoch(member.source_at) - 300000).toISOString(),
          new Date(epoch(member.source_at) + 60000).toISOString(),
        ],
      )
    )[0];
    const data = {
      account_id: account.id,
      policy_version: group.policy_version,
      verification_revision: group.management_settings.qq_verification_revision ?? '0',
      group_revision: account.settings.group_revision ?? '0',
      ticket: id.slice(0, 8),
      source_time: sourceTime,
      timeout_seconds: group.policy.verification_timeout,
      timeout_action: group.policy.verification_timeout_action ?? 'manual',
      failed_action: group.policy.verification_failed_action ?? 'manual',
      round: 1,
      join_request_id: request?.id ?? null,
    };
    const inserted = await tx.query(
      `INSERT INTO verifications(id,conversation_id,user_id,membership_id,token_hash,status,expires_at,qq_context,detail_reason)
      VALUES($1,$2,$3,$4,$5,'pending',$6,$7::jsonb,'等待发送验证提示，尚未开始倒计时')
      ON CONFLICT(conversation_id,user_id,membership_id) DO NOTHING RETURNING id`,
      [
        id,
        group.id,
        userId,
        membershipId,
        sha(String(a + b)),
        new Date(Date.now() + 300000).toISOString(),
        json(data),
      ],
    );
    if (!inserted.length) return;
    const text =
      `欢迎加入 ${group.name}。请计算：${a} + ${b} = ?\n` +
      `请在验证提示送达后的 ${data.timeout_seconds} 秒内 @本机器人 并发送数字答案，或引用回复本条提示，只发送计算结果。\n` +
      `无需复制指令或验证码。仅本人作答有效，最多 3 次。\n` +
      (data.failed_action === 'mute'
        ? '连续答错 3 次将禁言 10 分钟；权限或已有禁言无法核对时转人工处理。\n'
        : '') +
      (data.timeout_action === 'remove'
        ? '验证超时将移出本群；无法确认提示送达或管理权限时转人工处理。'
        : data.timeout_action === 'mute_retry'
          ? '验证超时后禁言 10 分钟，到期重新 @ 你出题；未通过则继续循环。验证通过、退群或管理员停止验证后结束循环。'
          : '验证超时将交由管理员处理。');
    const job = await this.jobs.enqueue(
      {
        key: `qq-verification:${id}`,
        conversationId: group.id,
        action: 'message.send',
        params: { segments: [{ type: 'text', text }] },
        reviewRef: {
          purpose: 'qq-verification-challenge',
          verification_id: id,
          user_id: userId,
          membership_id: membershipId,
          expires_at: new Date(Date.now() + 300000).toISOString(),
        },
      },
      tx,
    );
    await tx.query('UPDATE verifications SET challenge_job_id=$2 WHERE id=$1', [id, job.id]);
    await audit(tx, 'QQ 连接器', 'qq.verification.created', group.id, {
      verification_id: id,
      user_id: userId,
      join_request_id: request?.id ?? null,
    });
  }
  async answer(tx: Sql, group: Row, userId: string, content: string, replyTo?: string, mentionedBot = false) {
    const value = content.replace(/^(?:\s*\[at\]\s*)+/, '').trim();
    const command = value.match(/^\/verify\s+([a-f0-9]{8})\s+(\d{1,3})$/);
    const plain = value.match(/^\d{1,3}$/);
    if (!command && !(plain && (replyTo || mentionedBot))) return false;
    const v = (
      await tx.query(
        `SELECT v.* FROM verifications v JOIN memberships m ON m.conversation_id=v.conversation_id AND m.user_id=v.user_id AND m.membership_id=v.membership_id AND m.status='active'
          WHERE v.conversation_id=$1 AND v.user_id=$2 ORDER BY v.created_at DESC,v.id DESC LIMIT 1 FOR UPDATE OF v`,
        [group.id, userId],
      )
    )[0];
    if (
      !v?.qq_context ||
      v.qq_context.account_id !== group.executor_account_id ||
      v.status !== 'pending' ||
      !v.challenge_sent_at ||
      epoch(v.expires_at) <= Date.now() ||
      v.attempts >= 3 ||
      v.qq_context.verification_revision !== (group.management_settings.qq_verification_revision ?? '0') ||
      !group.policy.verification_enabled
    )
      return false;
    const member = (
      await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [group.id, userId])
    )[0];
    if (!member || member.status !== 'active' || member.membership_id !== v.membership_id) return false;
    const sent = (await tx.query('SELECT status,receipt FROM jobs WHERE id=$1', [v.challenge_job_id]))[0];
    if (
      sent?.status !== 'succeeded' ||
      (command
        ? command[1] !== v.qq_context.ticket
        : replyTo
          ? replyTo !== sent.receipt?.result?.message_id
          : !mentionedBot)
    )
      return false;
    const matched = equal(v.token_hash, sha(command ? command[2]! : plain![0]));
    await tx.query('UPDATE verifications SET attempts=attempts+1,status=$2,detail_reason=$3 WHERE id=$1', [
      v.id,
      matched ? 'passed' : v.attempts >= 2 ? 'failed' : 'pending',
      matched
        ? '成员本人完成了计算验证'
        : v.attempts >= 2
          ? '回答次数已达上限，等待管理员或验证截止处理'
          : '答案不正确，请在剩余时间内重试',
    ]);
    if (!matched && v.attempts >= 2 && v.qq_context.failed_action === 'mute') {
      const job = await this.jobs.enqueue(
        {
          key: `qq-verification-failure:${v.id}:${v.qq_context.round ?? 1}:${v.qq_context.ticket}`,
          conversationId: group.id,
          action: 'member.mute',
          params: { user_id: userId, duration_seconds: 600, reason: '新成员活人验证连续答错三次' },
          reviewRef: {
            purpose: 'qq-verification-failure',
            verification_id: v.id,
            user_id: userId,
            membership_id: v.membership_id,
            expires_at: new Date(Date.now() + 30000).toISOString(),
          },
        },
        tx,
      );
      await tx.query(
        "UPDATE verifications SET failure_job_id=$2,detail_reason='连续答错三次，已提交 10 分钟禁言任务，等待平台回执' WHERE id=$1",
        [v.id, job.id],
      );
    }
    if (matched) {
      await audit(tx, `成员 ${userId}`, 'verification.passed', group.id, { verification_id: v.id });
      await this.jobs.enqueue(
        {
          key: `qq-verification-notice:${v.id}`,
          conversationId: group.id,
          action: 'message.send',
          params: { segments: [{ type: 'text', text: '活人验证已通过，欢迎加入。' }] },
          reviewRef: {
            purpose: 'qq-verification-notice',
            verification_id: v.id,
            user_id: userId,
            membership_id: v.membership_id,
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
        },
        tx,
      );
    }
    return matched;
  }
  async approve(id: string, actor: string) {
    const initial = (
      await this.ctx.db.query('SELECT conversation_id FROM verifications WHERE id=$1', [id])
    )[0];
    if (!initial) throw new ApiError(404, 'NOT_FOUND', '验证记录不存在');
    await this.ctx.db.transaction(async (tx) => {
      const initialGroup = (
        await tx.query('SELECT executor_account_id FROM conversations WHERE id=$1', [initial.conversation_id])
      )[0]!;
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR SHARE', [initialGroup.executor_account_id]);
      const group = (
        await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [initial.conversation_id])
      )[0]!;
      const snapshot = (
        await tx.query(
          'SELECT challenge_job_id,timeout_job_id,failure_job_id FROM verifications WHERE id=$1',
          [id],
        )
      )[0]!;
      // Receipt processing locks its job before the verification row. Lock both
      // jobs in that order so approving during prompt delivery cannot deadlock.
      const jobs = await tx.query(
        'SELECT id,status,action FROM jobs WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
        [[snapshot.challenge_job_id, snapshot.timeout_job_id, snapshot.failure_job_id].filter(Boolean)],
      );
      const timeout = jobs.find((job) => job.id === snapshot.timeout_job_id);
      const failure = jobs.find((job) => job.id === snapshot.failure_job_id);
      const v = (await tx.query('SELECT * FROM verifications WHERE id=$1 FOR UPDATE', [id]))[0]!;
      const member = (
        await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
          v.conversation_id,
          v.user_id,
        ])
      )[0];
      if (
        !v.qq_context ||
        final.has(v.status) ||
        group.executor_account_id !== v.qq_context.account_id ||
        !member ||
        member.status !== 'active' ||
        member.membership_id !== v.membership_id
      )
        throw new ApiError(409, 'STALE_VERIFICATION', '此记录已不属于成员当前的验证批次');
      if (timeout) {
        if (
          ['in_flight', 'accepted', 'unknown'].includes(timeout.status) ||
          (timeout.status === 'succeeded' && timeout.action !== 'member.mute')
        )
          throw new ApiError(
            409,
            'QQ_VERIFICATION_ACTION_PENDING',
            '移出任务正在执行或结果待核对，请先核实平台结果',
          );
      }
      if (failure && ['in_flight', 'accepted', 'unknown'].includes(failure.status))
        throw new ApiError(
          409,
          'QQ_VERIFICATION_ACTION_PENDING',
          '禁言正在执行或结果待核对，请先核实平台结果',
        );
      await tx.query(
        "UPDATE jobs SET status='cancelled',last_error='成员已被人工通过验证',updated_at=now() WHERE id=ANY($1::text[]) AND status='pending'",
        [[v.challenge_job_id, v.timeout_job_id, v.failure_job_id].filter(Boolean)],
      );
      await tx.query(
        "UPDATE verifications SET status='passed',retry_after=NULL,detail_reason=$2 WHERE id=$1",
        [
          id,
          failure?.status === 'succeeded' ||
          (timeout?.status === 'succeeded' && timeout.action === 'member.mute')
            ? '管理员已人工通过验证；既有禁言不会自动解除，请等待 QQ 到期或在 QQ 客户端核对后处理'
            : '管理员已人工通过当前入群批次验证',
        ],
      );
      await audit(tx, actor, 'verification.approved', v.conversation_id, { verification_id: id });
    });
    return { approved: true };
  }
  async resend(id: string, key: string, actor: string, automatic?: { ticket: string; join_time: number }) {
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key))
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 位 Idempotency-Key');
    const initial = (
      await this.ctx.db.query('SELECT conversation_id FROM verifications WHERE id=$1', [id])
    )[0];
    if (!initial) throw new ApiError(404, 'NOT_FOUND', '验证记录不存在');
    return this.ctx.db.transaction(async (tx) => {
      const first = (
        await tx.query('SELECT executor_account_id FROM conversations WHERE id=$1', [initial.conversation_id])
      )[0]!;
      const account = (
        await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [first.executor_account_id])
      )[0]!;
      const group = (
        await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [initial.conversation_id])
      )[0]!;
      const idem = `qq-verification-resend:${id}:${sha(key)}`;
      const prior = (await tx.query('SELECT id FROM jobs WHERE idempotency_key=$1', [idem]))[0];
      if (prior) return { queued: true, job_id: prior.id, duplicate: true };
      const snapshot = (
        await tx.query(
          'SELECT challenge_job_id,timeout_job_id,failure_job_id FROM verifications WHERE id=$1',
          [id],
        )
      )[0]!;
      const jobs = await tx.query(
        'SELECT id,status,action,receipt FROM jobs WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
        [[snapshot.challenge_job_id, snapshot.timeout_job_id, snapshot.failure_job_id].filter(Boolean)],
      );
      const v = (await tx.query('SELECT * FROM verifications WHERE id=$1 FOR UPDATE', [id]))[0]!;
      if (
        automatic &&
        (v.status !== 'cooldown' ||
          v.qq_context?.ticket !== automatic.ticket ||
          !v.retry_after ||
          epoch(v.retry_after) > Date.now() ||
          v.qq_context.platform_join_time !== automatic.join_time ||
          (group.management_settings.qq_verification_revision ?? '0') !==
            v.qq_context.verification_revision ||
          (account.settings.group_revision ?? '0') !== v.qq_context.group_revision)
      )
        throw new ApiError(409, 'STALE_VERIFICATION', '自动重新验证的轮次、时间或平台入群批次已变化');
      const member = (
        await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
          group.id,
          v.user_id,
        ])
      )[0];
      if (
        !v.qq_context ||
        (final.has(v.status) && v.status !== 'cancelled') ||
        group.executor_account_id !== v.qq_context.account_id ||
        account.status !== 'online' ||
        !groupEnabled(account, group.external_id) ||
        !group.policy.verification_enabled ||
        !member ||
        member.status !== 'active' ||
        member.membership_id !== v.membership_id
      )
        throw new ApiError(409, 'STALE_VERIFICATION', '请先恢复此群验证及同步，并确认仍是当前入群批次');
      if (jobs.some((j) => ['pending', 'in_flight', 'accepted', 'unknown'].includes(j.status)))
        throw new ApiError(
          409,
          'QQ_VERIFICATION_ACTION_PENDING',
          '仍有待处理、执行中或结果待核对的任务，请先核实结果',
        );
      const failure = jobs.find((job) => job.id === v.failure_job_id);
      const timeout = jobs.find((job) => job.id === v.timeout_job_id);
      if (timeout?.status === 'succeeded' && timeout.action !== 'member.mute')
        throw new ApiError(409, 'STALE_VERIFICATION', '成员移出任务已完成，不能重发旧批次验证');
      const muted = [failure, timeout].find(
        (job) => job?.status === 'succeeded' && job.action === 'member.mute',
      );
      if (
        (v.retry_after && epoch(v.retry_after) > Date.now()) ||
        (!automatic && muted && epoch(muted.receipt?.observed_at) + 600000 > Date.now())
      )
        throw new ApiError(
          409,
          'QQ_VERIFICATION_MEMBER_MUTED',
          '成员仍在本次 10 分钟禁言期内，请等待到期或在 QQ 客户端人工核对后处理',
        );
      const a = randomInt(2, 21),
        b = randomInt(2, 21),
        ticket = randomUUID().slice(0, 8);
      const data = {
        ...v.qq_context,
        ticket,
        policy_version: group.policy_version,
        verification_revision: group.management_settings.qq_verification_revision ?? '0',
        group_revision: account.settings.group_revision ?? '0',
        timeout_seconds: group.policy.verification_timeout,
        timeout_action: group.policy.verification_timeout_action ?? 'manual',
        failed_action: group.policy.verification_failed_action ?? 'manual',
        round: (v.qq_context.round ?? 1) + 1,
      };
      delete data.platform_join_time;
      const text =
        `请计算：${a} + ${b} = ?\n请在提示送达后 ${data.timeout_seconds} 秒内 @本机器人 并发送数字答案，或引用回复本条提示，只发送计算结果。无需复制指令或验证码。仅本人作答，最多 3 次。\n` +
        (data.failed_action === 'mute'
          ? '连续答错 3 次将禁言 10 分钟；权限或已有禁言无法核对时转人工处理。\n'
          : '') +
        (data.timeout_action === 'remove'
          ? '验证超时将移出本群；提示送达或权限无法确认时转人工处理。'
          : data.timeout_action === 'mute_retry'
            ? '验证超时后禁言 10 分钟，到期重新 @ 你出题；未通过则继续循环。验证通过、退群或管理员停止验证后结束循环。'
            : '验证超时交由管理员处理。');
      const job = await this.jobs.enqueue(
        {
          key: idem,
          conversationId: group.id,
          action: 'message.send',
          params: { segments: [{ type: 'text', text }] },
          reviewRef: {
            purpose: 'qq-verification-challenge',
            verification_id: id,
            user_id: v.user_id,
            membership_id: v.membership_id,
            expires_at: new Date(Date.now() + 300000).toISOString(),
          },
        },
        tx,
      );
      await tx.query(
        "UPDATE verifications SET status='pending',attempts=0,token_hash=$2,qq_context=$3::jsonb,challenge_job_id=$4,timeout_job_id=NULL,failure_job_id=NULL,retry_after=NULL,challenge_sent_at=NULL,expires_at=$5,detail_reason='已重新提交验证提示，确认发送后开始计时' WHERE id=$1",
        [id, sha(String(a + b)), json(data), job.id, new Date(Date.now() + 300000).toISOString()],
      );
      await audit(tx, actor, 'qq.verification.resent', group.id, { verification_id: id, job_id: job.id });
      return { queued: true, job_id: job.id, duplicate: false };
    });
  }
  private async stopCycle(v: Row, reason: string, status = 'manual_review') {
    const changed = await this.ctx.db.query(
      "UPDATE verifications SET status=$3,retry_after=NULL,detail_reason=$4 WHERE id=$1 AND status='cooldown' AND qq_context->>'ticket'=$2 RETURNING id",
      [v.id, v.qq_context.ticket, status, reason],
    );
    if (changed.length)
      await audit(this.ctx.db, '系统任务', 'qq.verification.cycle_stopped', v.conversation_id, {
        verification_id: v.id,
        status,
        reason,
      });
  }
  private async retryReady() {
    const due = await this.ctx.db
      .query(`SELECT v.* FROM verifications v JOIN conversations c ON c.id=v.conversation_id JOIN accounts a ON a.id=c.executor_account_id
      WHERE v.qq_context IS NOT NULL AND v.status='cooldown' AND
      (v.retry_after<=now() OR c.policy->>'verification_enabled'<>'true' OR COALESCE(c.management_settings->>'qq_verification_revision','0')<>v.qq_context->>'verification_revision'
      OR a.id<>v.qq_context->>'account_id' OR a.status<>'online' OR COALESCE(a.settings->>'group_revision','0')<>v.qq_context->>'group_revision'
      OR NOT COALESCE((a.settings->'group_ids') @> jsonb_build_array(c.external_id),true)) ORDER BY v.retry_after LIMIT 10`);
    for (const v of due) {
      try {
        const group = (
          await this.ctx.db.query('SELECT * FROM conversations WHERE id=$1', [v.conversation_id])
        )[0]!;
        const account = (
          await this.ctx.db.query('SELECT * FROM accounts WHERE id=$1', [group.executor_account_id])
        )[0]!;
        const member = (
          await this.ctx.db.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
            group.id,
            v.user_id,
          ])
        )[0];
        if (
          account.kind !== 'qq' ||
          account.id !== v.qq_context.account_id ||
          account.status !== 'online' ||
          !groupEnabled(account, group.external_id) ||
          !group.policy.verification_enabled ||
          group.policy.verification_timeout_action !== 'mute_retry' ||
          (group.management_settings.qq_verification_revision ?? '0') !==
            v.qq_context.verification_revision ||
          (account.settings.group_revision ?? '0') !== v.qq_context.group_revision ||
          !member ||
          member.status !== 'active' ||
          member.membership_id !== v.membership_id
        ) {
          await this.stopCycle(v, '账号、规则、同步范围或入群批次已变化，停止自动验证循环，请管理员核对');
          continue;
        }
        if (!v.retry_after || epoch(v.retry_after) > Date.now()) continue;
        const binding = (
          await this.ctx.db.query(
            'SELECT snapshot FROM bindings WHERE account_id=$1 AND conversation_id=$2',
            [account.id, group.id],
          )
        )[0];
        if (
          !binding ||
          !Number.isFinite(epoch(binding.snapshot.observed_at)) ||
          epoch(binding.snapshot.observed_at) < Date.now() - 300000
        ) {
          if (!this.refreshPermissions) {
            await this.stopCycle(v, '群权限快照已过期，停止循环；请刷新权限后重新发送验证');
            continue;
          }
          await this.refreshPermissions(account.id);
        }
        const identity = async () => {
          const result = await this.ctx.adapters.qq(account, 'get_login_info');
          return (
            result.status === 200 &&
            result.data?.status === 'ok' &&
            result.data.retcode === 0 &&
            String(result.data.data?.user_id) === account.external_id
          );
        };
        if (!(await identity())) {
          await this.stopCycle(v, '无法确认原 QQ 登录身份，停止自动重新出题');
          continue;
        }
        const role = await this.ctx.adapters.qqRole(account, group.external_id, account.external_id);
        const target = await this.ctx.adapters.qqMember(account, group.external_id, v.user_id);
        if (role.admin !== true || !target || !(await identity())) {
          await this.stopCycle(v, '无法实时核对 QQ 管理权限或成员身份，停止循环并转人工');
          continue;
        }
        if (target.role !== 'member' || v.user_id === account.external_id) {
          await this.stopCycle(v, '已实时确认群主、管理员或机器人身份，免验证并结束循环', 'passed');
          continue;
        }
        if (
          !Number.isSafeInteger(target.join_time) ||
          target.join_time <= 0 ||
          target.join_time !== v.qq_context.platform_join_time ||
          !Number.isSafeInteger(target.shut_up_timestamp) ||
          target.shut_up_timestamp < 0 ||
          target.shut_up_timestamp > Date.now() / 1000
        ) {
          await this.stopCycle(
            v,
            '原入群批次或禁言到期状态无法确认，或成员已有其他禁言；停止循环，不解除现有处分',
          );
          continue;
        }
        await this.resend(v.id, `auto-retry:${v.qq_context.round ?? 1}:${v.qq_context.ticket}`, '系统任务', {
          ticket: v.qq_context.ticket,
          join_time: target.join_time,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          ['STALE_VERIFICATION', 'QQ_VERIFICATION_ACTION_PENDING'].includes(error.code)
        )
          continue;
        await this.stopCycle(v, '自动重新验证检查失败，已停止循环；恢复连接和权限后可在后台重新发送');
      }
    }
  }
  async sweep() {
    await this.ctx.db
      .query(`UPDATE verifications v SET status='manual_review',retry_after=NULL,detail_reason='超时禁言未确认执行成功，停止循环；请核对平台回执后人工处理'
      FROM jobs j WHERE v.timeout_job_id=j.id AND v.qq_context->>'timeout_action'='mute_retry' AND v.status='expired' AND j.status IN ('failed','unknown','cancelled')`);
    const due = await this.ctx.db
      .query(`SELECT v.id,v.conversation_id FROM verifications v JOIN conversations c ON c.id=v.conversation_id
      JOIN accounts a ON a.id=c.executor_account_id LEFT JOIN jobs j ON j.id=v.challenge_job_id
      WHERE v.qq_context IS NOT NULL AND v.status IN ('pending','failed') AND
      (v.expires_at<=now() OR v.failure_job_id IS NOT NULL OR j.status IN ('failed','unknown','cancelled') OR
        c.policy->>'verification_enabled'<>'true' OR COALESCE(c.management_settings->>'qq_verification_revision','0')<>v.qq_context->>'verification_revision' OR
        a.id<>v.qq_context->>'account_id' OR a.status='paused' OR COALESCE(a.settings->>'group_revision','0')<>v.qq_context->>'group_revision' OR
        NOT COALESCE((a.settings->'group_ids') @> jsonb_build_array(c.external_id),true)) ORDER BY v.expires_at LIMIT 30`);
    for (const item of due)
      await this.ctx.db.transaction(async (tx) => {
        const first = (
          await tx.query('SELECT executor_account_id FROM conversations WHERE id=$1', [item.conversation_id])
        )[0]!;
        const account = (
          await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [first.executor_account_id])
        )[0]!;
        const group = (
          await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [item.conversation_id])
        )[0]!;
        const v = (await tx.query('SELECT * FROM verifications WHERE id=$1 FOR UPDATE', [item.id]))[0]!;
        if (!['pending', 'failed'].includes(v.status)) return;
        const data = v.qq_context;
        const member = (
          await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
            group.id,
            v.user_id,
          ])
        )[0];
        const stopped =
          !group.policy.verification_enabled ||
          (group.management_settings.qq_verification_revision ?? '0') !== data.verification_revision ||
          group.executor_account_id !== data.account_id ||
          (account.settings.group_revision ?? '0') !== data.group_revision ||
          !groupEnabled(account, group.external_id);
        const failure = v.failure_job_id
          ? (await tx.query('SELECT status FROM jobs WHERE id=$1', [v.failure_job_id]))[0]
          : undefined;
        if (stopped || !member || member.status !== 'active' || member.membership_id !== v.membership_id) {
          await tx.query('UPDATE verifications SET status=$2,detail_reason=$3 WHERE id=$1', [
            v.id,
            failure && ['in_flight', 'accepted', 'unknown', 'succeeded'].includes(failure.status)
              ? 'manual_review'
              : 'cancelled',
            '规则、同步范围或入群批次已变化，停止旧验证；已执行或结果待核对的禁言任务保留原始回执',
          ]);
          return;
        }
        if (v.failure_job_id) {
          if (!['pending', 'in_flight', 'accepted'].includes(failure?.status))
            await tx.query(
              "UPDATE verifications SET status='manual_review',detail_reason='答错三次后的禁言任务已结束或结果待核对，请管理员处理验证并核实回执' WHERE id=$1",
              [v.id],
            );
          return;
        }
        const challenge = (await tx.query('SELECT status FROM jobs WHERE id=$1', [v.challenge_job_id]))[0];
        if (!v.challenge_sent_at || challenge?.status !== 'succeeded') {
          if (
            ['failed', 'unknown', 'cancelled'].includes(challenge?.status) ||
            epoch(v.expires_at) <= Date.now()
          )
            await tx.query(
              "UPDATE verifications SET status='manual_review',detail_reason='验证提示未确认送达，不自动移出成员；请核对发送任务或人工通过' WHERE id=$1",
              [v.id],
            );
          return;
        }
        if (epoch(v.expires_at) > Date.now()) return;
        if (!['remove', 'mute_retry'].includes(data.timeout_action) || account.status !== 'online') {
          await tx.query("UPDATE verifications SET status='manual_review',detail_reason=$2 WHERE id=$1", [
            v.id,
            account.status !== 'online'
              ? '验证超时，但 QQ 未在线，不自动移出；请人工处理'
              : '验证超时，按群设置交由管理员处理',
          ]);
          return;
        }
        const job = await this.jobs.enqueue(
          {
            key: `qq-verification-timeout:${v.id}:${data.round ?? 1}:${data.ticket}`,
            conversationId: group.id,
            action: data.timeout_action === 'mute_retry' ? 'member.mute' : 'member.remove',
            params: {
              user_id: v.user_id,
              ...(data.timeout_action === 'mute_retry' ? { duration_seconds: 600 } : {}),
              reason: '新成员未在规定时间完成活人验证',
            },
            reviewRef: {
              purpose:
                data.timeout_action === 'mute_retry'
                  ? 'qq-verification-timeout-mute'
                  : 'qq-verification-timeout',
              verification_id: v.id,
              user_id: v.user_id,
              membership_id: v.membership_id,
              expires_at: new Date(Date.now() + 30000).toISOString(),
            },
          },
          tx,
        );
        await tx.query(
          "UPDATE verifications SET status='expired',timeout_job_id=$2,detail_reason=$3 WHERE id=$1",
          [
            v.id,
            job.id,
            data.timeout_action === 'mute_retry'
              ? '验证超时，已提交 10 分钟禁言任务，确认后进入循环等待'
              : '验证超时，已提交移出任务，等待平台回执',
          ],
        );
        await audit(tx, '系统任务', 'qq.verification.timeout', group.id, {
          verification_id: v.id,
          job_id: job.id,
        });
      });
    await this.retryReady();
  }
}
