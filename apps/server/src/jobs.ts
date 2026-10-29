import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  authorizeSync,
  connectorCommandSchema,
  fingerprint,
  hasEffectiveCapability,
  mergeReceipt,
  receiptSchema,
  requiredCapabilities,
} from '../../../packages/contracts/src/index.ts';
import type { ConnectorCommand, ExecutionReceipt } from '../../../packages/contracts/src/index.ts';
import type { Context } from './context.ts';
import { audit, epoch, iso, json } from './context.ts';
import type { Row, Sql } from './database.ts';
import { ApiError } from './security.ts';
import { groupEnabled } from './scope.ts';
import {
  applyQQVerificationReceipt,
  checkQQVerification,
  qqVerificationPurposes,
  qqVerificationRequired,
} from './qq-verification.ts';
import type { QQMembershipProof } from './qq-verification.ts';

export class JobsService {
  ctx: Context;
  constructor(ctx: Context) {
    this.ctx = ctx;
  }
  async enqueue(
    input: {
      key: string;
      conversationId: string;
      action: string;
      params: unknown;
      announcementId?: string;
      dueAt?: string;
      reviewRef?: unknown;
      trace?: unknown;
      ownerId?: string;
    },
    sql: Sql = this.ctx.db,
  ): Promise<Row> {
    if (sql === this.ctx.db) return this.ctx.db.transaction((tx) => this.enqueue(input, tx));
    const group = (await sql.query('SELECT * FROM conversations WHERE id=$1', [input.conversationId]))[0];
    if (!group) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', '目标群不存在');
    const account = (
      await sql.query('SELECT kind,settings FROM accounts WHERE id=$1 FOR SHARE', [group.executor_account_id])
    )[0]!;
    if (!groupEnabled(account, group.external_id))
      throw new ApiError(409, 'GROUP_SYNC_DISABLED', '目标群已取消同步，请先在连接账号中重新勾选');
    const intentHash = fingerprint({
      group: input.conversationId,
      action: input.action,
      params: input.params,
      scheduled_at: input.dueAt ?? null,
    });
    const due = input.dueAt ?? new Date().toISOString();
    const inserted = await sql.query(
      `INSERT INTO jobs(id,idempotency_key,intent_hash,conversation_id,account_id,announcement_id,action,params,due_at,expires_at,review_ref,trace,owner_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12::jsonb,$13) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        input.key,
        intentHash,
        input.conversationId,
        group.executor_account_id,
        input.announcementId ?? null,
        input.action,
        json(input.params),
        due,
        new Date(epoch(due) + 24 * 3600_000).toISOString(),
        input.reviewRef ? json(input.reviewRef) : null,
        input.trace ? json(input.trace) : null,
        input.ownerId ?? 'admin',
      ],
    );
    const job =
      inserted[0] ?? (await sql.query('SELECT * FROM jobs WHERE idempotency_key=$1', [input.key]))[0]!;
    if (job.intent_hash !== intentHash)
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键已经用于另一条消息');
    return job;
  }
  async recover() {
    await this.ctx.db.transaction(async (tx) => {
      const jobs = await tx.query(
        "SELECT * FROM jobs WHERE status='in_flight' AND locked_at<now()-interval '2 minutes' FOR UPDATE",
      );
      for (const job of jobs) {
        const attempt = (
          await tx.query('SELECT * FROM attempts WHERE job_id=$1 AND number=$2', [
            job.id,
            job.current_attempt,
          ])
        )[0];
        if (!attempt) continue;
        // Local uncertainty must never consume a connector-owned receipt revision.
        await tx.query("UPDATE attempts SET status='unknown' WHERE id=$1", [attempt.id]);
        await tx.query("UPDATE jobs SET status='unknown',last_error=$2,updated_at=now() WHERE id=$1", [
          job.id,
          '执行期间进程中断，结果需要核对',
        ]);
      }
      const waiting = await tx.query(
        "SELECT * FROM jobs WHERE status='accepted' AND expires_at<now() FOR UPDATE",
      );
      for (const job of waiting) {
        await tx.query("UPDATE jobs SET status='unknown',last_error=$2,updated_at=now() WHERE id=$1", [
          job.id,
          '平台已接收但未在有效期内给出最终回执，需要核对',
        ]);
        await tx.query("UPDATE attempts SET status='unknown' WHERE job_id=$1 AND number=$2", [
          job.id,
          job.current_attempt,
        ]);
      }
    });
  }
  async processOnce(): Promise<boolean> {
    const claimed = await this.ctx.db.transaction(async (tx) => {
      const job = (
        await tx.query(
          "SELECT * FROM jobs WHERE status='pending' AND due_at<=now() ORDER BY CASE WHEN action IN ('message.delete','member.remove') THEN 0 ELSE 1 END,due_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1",
        )
      )[0];
      if (!job) return null;
      const group = (await tx.query('SELECT * FROM conversations WHERE id=$1', [job.conversation_id]))[0]!;
      const account = (await tx.query('SELECT * FROM accounts WHERE id=$1', [job.account_id]))[0]!;
      const binding = (
        await tx.query('SELECT * FROM bindings WHERE account_id=$1 AND conversation_id=$2', [
          account.id,
          group.id,
        ])
      )[0];
      const attemptId = randomUUID();
      const number = Number(job.current_attempt) + 1;
      const rawCommand = {
        schema_version: '1',
        command_id: job.id,
        idempotency_key: job.idempotency_key,
        attempt_id: attemptId,
        attempt_number: number,
        logical_conversation_id: group.id,
        created_at: iso(job.created_at),
        expires_at: iso(job.expires_at),
        target: {
          connector_id: account.id,
          account_id: account.id,
          conversation_id: binding?.external_id ?? group.external_id,
        },
        action: job.action,
        params: job.params,
        ...(job.trace ? { trace: job.trace } : {}),
      };
      const validated = connectorCommandSchema.safeParse(rawCommand);
      if (!validated.success) {
        const receipt: ExecutionReceipt = {
          schema_version: '1',
          command_id: job.id,
          attempt_id: attemptId,
          attempt_number: number,
          revision: 1,
          observed_at: new Date().toISOString(),
          status: 'failed',
          error: {
            code: 'INVALID_COMMAND',
            message: '任务载荷不符合连接器协议，未执行平台动作',
            retryable: false,
          },
        };
        await tx.query(
          "INSERT INTO attempts(id,job_id,number,command,status,receipt) VALUES($1,$2,$3,$4::jsonb,'failed',$5::jsonb)",
          [attemptId, job.id, number, json(rawCommand), json(receipt)],
        );
        await tx.query(
          "UPDATE jobs SET status='failed',current_attempt=$2,receipt=$3::jsonb,last_error=$4,updated_at=now() WHERE id=$1",
          [job.id, number, json(receipt), receipt.error.message],
        );
        return { kind: 'invalid' as const };
      }
      const command = validated.data;
      await tx.query(
        "INSERT INTO attempts(id,job_id,number,command,status) VALUES($1,$2,$3,$4::jsonb,'in_flight')",
        [attemptId, job.id, number, json(command)],
      );
      await tx.query(
        "UPDATE jobs SET status='in_flight',current_attempt=$2,locked_at=now(),updated_at=now() WHERE id=$1",
        [job.id, number],
      );
      return { kind: 'ready' as const, job, group, account, binding, command };
    });
    if (!claimed) return false;
    if (claimed.kind === 'invalid') return true;
    const { job, group, account, binding, command } = claimed;
    const base = {
      schema_version: '1' as const,
      command_id: job.id,
      attempt_id: command.attempt_id,
      attempt_number: command.attempt_number,
      revision: 1,
      observed_at: new Date().toISOString(),
    };
    let receipt: ExecutionReceipt;
    try {
      const precondition = await this.preconditions(job, group, account, binding, command);
      if (precondition)
        receipt = {
          ...base,
          status: 'failed',
          error: {
            code: precondition.code,
            message: precondition.message,
            retryable: precondition.retryable ?? false,
          },
        };
      else if (account.kind === 'demo')
        receipt = {
          ...base,
          status: 'succeeded',
          result: job.action === 'message.send' ? { message_id: `demo-${randomUUID()}` } : {},
        };
      else
        receipt = receiptSchema.parse(
          await this.ctx.adapters.execute(account, command, job.review_ref ?? undefined, (proof) =>
            this.preconditions(job, group, account, binding, command, proof),
          ),
        );
    } catch {
      await this.markUncertain(account.id, command, '未取得可确认的执行回执，需要核对');
      return true;
    }
    await this.saveReceipt(account.id, receipt);
    return true;
  }
  private async markUncertain(accountId: string, command: ConnectorCommand, message: string) {
    await this.ctx.db.transaction(async (tx) => {
      const job = (await tx.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [command.command_id]))[0];
      if (!job || job.account_id !== accountId || Number(job.current_attempt) !== command.attempt_number)
        return;
      const attempt = (
        await tx.query('SELECT * FROM attempts WHERE id=$1 AND job_id=$2', [command.attempt_id, job.id])
      )[0];
      if (!attempt || ['succeeded', 'failed'].includes(attempt.status)) return;
      await tx.query("UPDATE attempts SET status='unknown' WHERE id=$1", [attempt.id]);
      await tx.query("UPDATE jobs SET status='unknown',last_error=$2,updated_at=now() WHERE id=$1", [
        job.id,
        message,
      ]);
    });
  }
  private async preconditions(
    job: Row,
    group: Row,
    account: Row,
    binding: Row | undefined,
    command: ConnectorCommand,
    proof?: QQMembershipProof,
  ) {
    group = (await this.ctx.db.query('SELECT * FROM conversations WHERE id=$1', [job.conversation_id]))[0]!;
    binding = (
      await this.ctx.db.query('SELECT * FROM bindings WHERE account_id=$1 AND conversation_id=$2', [
        account.id,
        group.id,
      ])
    )[0];
    if (epoch(job.expires_at) <= Date.now()) return { code: 'COMMAND_EXPIRED', message: '任务已经过期' };
    if (job.owner_id !== 'admin') {
      const project = (
        await this.ctx.db.query('SELECT * FROM projects WHERE id=$1 AND revoked_at IS NULL', [job.owner_id])
      )[0];
      if (
        !project ||
        !project.conversation_ids.includes(group.id) ||
        !project.scopes.includes('messages.send')
      )
        return { code: 'PROJECT_REVOKED', message: '项目密钥或目标群授权已撤销' };
    }
    if (group.executor_account_id !== account.id)
      return { code: 'EXECUTOR_CHANGED', message: '执行账号已经变更，需要重新确认投递' };
    const current = (await this.ctx.db.query('SELECT * FROM accounts WHERE id=$1', [account.id]))[0]!;
    if (!groupEnabled(current, group.external_id))
      return { code: 'GROUP_SYNC_DISABLED', message: '此群已取消同步，请重新勾选后再发送' };
    if (
      current.status !== 'online' ||
      (current.kind === 'custom' &&
        (!current.session_expires_at || epoch(current.session_expires_at) < Date.now()))
    )
      return { code: 'ACCOUNT_OFFLINE', message: '账号未在线，请恢复连接后再重试', retryable: true };
    if (!binding || (!account.is_demo && epoch(binding.snapshot.observed_at) < Date.now() - 5 * 60_000))
      return { code: 'PERMISSIONS_STALE', message: '群权限已过期，请刷新群信息后重试', retryable: true };
    if (
      requiredCapabilities(command).some(
        (capability) => !hasEffectiveCapability(binding.snapshot, capability),
      )
    )
      return { code: 'CAPABILITY_UNAVAILABLE', message: '连接器不支持此操作，或当前账号缺少权限' };
    if (job.review_ref) {
      const ref = job.review_ref;
      if (ref.purpose === 'binance-member-management') {
        if (
          account.kind !== 'binance' ||
          group.kind !== 'group' ||
          command.target.conversation_id !== group.external_id ||
          current.settings.transport !== 'direct' ||
          current.session_id !== ref.session_id ||
          !Number.isFinite(epoch(ref.expires_at)) ||
          epoch(ref.expires_at) <= Date.now() ||
          (current.settings.group_revision ?? '0') !== (ref.group_revision ?? '0')
        )
          return {
            code: 'BINANCE_MEMBER_CONTEXT_CHANGED',
            message: '币安登录、群范围或管理请求时限已变化，请核对后重新提交',
          };
        const record = (
          await this.ctx.db.query('SELECT * FROM member_actions WHERE id=$1 AND conversation_id=$2', [
            ref.action_id,
            group.id,
          ])
        )[0];
        if (
          !record ||
          record.source !== 'web' ||
          record.job_id !== job.id ||
          record.user_id !== job.params.user_id ||
          record.user_id !== ref.user_id ||
          record.action !== ref.action ||
          record.reason !== job.params.reason ||
          (record.action === 'remove'
            ? job.action !== 'member.remove'
            : !['mute', 'unmute'].includes(record.action) ||
              job.action !== 'member.set_mute' ||
              job.params.muted !== (record.action === 'mute'))
        )
          return { code: 'BINANCE_MEMBER_SCOPE', message: '币安成员操作记录与目标或任务不匹配，未执行操作' };
        return null;
      }
      if (qqVerificationPurposes.has(ref.purpose))
        return checkQQVerification(this.ctx, job, group, current, command, proof);
      if (ref.purpose === 'qq-join-review') {
        if (
          account.kind !== 'qq' ||
          group.kind !== 'group' ||
          command.action !== 'membership.approve' ||
          !Number.isFinite(epoch(ref.expires_at)) ||
          epoch(ref.expires_at) <= Date.now()
        )
          return { code: 'QQ_REQUEST_EXPIRED', message: '入群审核请求已过期，请在 QQ 客户端核对' };
        const request = (
          await this.ctx.db.query(
            'SELECT * FROM qq_join_requests WHERE id=$1 AND account_id=$2 AND conversation_id=$3',
            [ref.request_id, account.id, group.id],
          )
        )[0];
        if (
          !request ||
          request.job_id !== job.id ||
          request.id !== job.params.request_id ||
          request.user_id !== ref.user_id ||
          request.flag_box !== ref.flag_box
        )
          return { code: 'QQ_REQUEST_SCOPE', message: '入群申请与群组或任务不匹配，未执行审核' };
        if (
          group.management_settings.qq_join_auto_approve !== true ||
          (group.management_settings.qq_join_revision ?? '0') !== ref.settings_revision ||
          (current.settings.group_revision ?? '0') !== ref.group_revision
        )
          return { code: 'QQ_REVIEW_SETTINGS_CHANGED', message: '自动入群审核或同步范围已变化，停止旧任务' };
        if (
          (
            await this.ctx.db.query(
              'SELECT id FROM blacklists WHERE conversation_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())',
              [group.id, request.user_id],
            )
          ).length
        )
          return { code: 'QQ_REQUEST_BLACKLISTED', message: '申请者在此群黑名单中，未自动通过' };
        return null;
      }
      if (ref.purpose === 'member-management' || ref.purpose === 'member-notice') {
        if (
          account.kind !== 'telegram' ||
          group.kind !== 'group' ||
          !Number.isFinite(epoch(ref.expires_at)) ||
          epoch(ref.expires_at) <= Date.now()
        )
          return { code: 'MEMBER_ACTION_EXPIRED', message: '成员管理请求已过期，请核对后重新提交' };
        const record = (
          await this.ctx.db.query('SELECT * FROM member_actions WHERE id=$1 AND conversation_id=$2', [
            ref.action_id,
            group.id,
          ])
        )[0];
        if (
          !record ||
          (ref.purpose === 'member-management' &&
            (record.job_id !== job.id || record.user_id !== job.params.user_id))
        )
          return { code: 'MEMBER_ACTION_SCOPE', message: '成员管理记录与任务不匹配，未执行操作' };
        if (record.source === 'telegram' && !group.management_settings.telegram_commands)
          return { code: 'TG_COMMANDS_DISABLED', message: '本群管理员命令已关闭，停止旧命令任务' };
        if (
          record.source === 'telegram' &&
          (group.management_settings.telegram_commands_revision ?? '0') !== (ref.command_revision ?? '0')
        )
          return { code: 'TG_COMMANDS_CHANGED', message: '管理员命令设置已变化，停止旧命令任务' };
        if ((current.settings.group_revision ?? '0') !== (ref.group_revision ?? '0'))
          return { code: 'GROUP_SCOPE_CHANGED', message: '同步范围已变化，请核对后重新操作' };
        if (ref.purpose === 'member-management' && ref.membership_id) {
          const member = (
            await this.ctx.db.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
              group.id,
              ref.user_id,
            ])
          )[0];
          if (!member || member.status !== 'active' || member.membership_id !== ref.membership_id)
            return { code: 'MEMBERSHIP_CHANGED', message: '成员入群记录已变化，请核对后重新操作' };
        }
        return null;
      }
      if (ref.purpose === 'reply') {
        const original = (
          await this.ctx.db.query(
            'SELECT * FROM messages WHERE id=$1 AND conversation_id=$2 AND account_id=$3 AND deleted=false',
            [ref.message_record_id, group.id, account.id],
          )
        )[0];
        if (!original || original.external_id !== job.params.reply_to)
          return { code: 'REPLY_UNAVAILABLE', message: '原消息已删除或发送绑定已变化，停止引用回复' };
        return null;
      }
      if (ref.purpose === 'verification') {
        const current = (
          await this.ctx.db.query(
            'SELECT * FROM verifications WHERE conversation_id=$1 AND user_id=(SELECT user_id FROM verifications WHERE id=$2) ORDER BY created_at DESC LIMIT 1',
            [group.id, ref.verification_id],
          )
        )[0];
        if (
          !group.policy.verification_enabled ||
          !current ||
          current.id !== ref.verification_id ||
          current.status !== 'pending' ||
          epoch(current.expires_at) <= Date.now()
        )
          return { code: 'STALE_VERIFICATION', message: '验证已结束或入群批次已变化，停止发送旧挑战' };
        return null;
      }
      const message = (
        await this.ctx.db.query(
          'SELECT m.*,c.policy_version,c.policy,c.platform AS source_platform FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1',
          [ref.message_record_id],
        )
      )[0];
      const ownDeletion =
        ref.deletion_job_id &&
        (
          await this.ctx.db.query(
            "SELECT id FROM jobs WHERE id=$1 AND status='succeeded' AND conversation_id=$2 AND action='message.delete'",
            [ref.deletion_job_id, group.id],
          )
        ).length > 0;
      if (
        !message ||
        (message.deleted && !ownDeletion) ||
        message.content_version !== ref.content_version ||
        message.fingerprint !== ref.fingerprint ||
        message.policy_version !== ref.policy_version
      )
        return { code: 'STALE_REVIEW', message: '消息内容或规则已变化，本次旧任务停止执行' };
      if (ref.purpose === 'sync') {
        if (ref.target_policy_version !== group.policy_version)
          return { code: 'STALE_REVIEW', message: '目标群规则已变化，请重新审核' };
        const route = (
          await this.ctx.db.query(
            'SELECT id FROM routes WHERE id=$1 AND enabled=true AND source_id=$2 AND target_id=$3',
            [ref.route_id, message.conversation_id, group.id],
          )
        )[0];
        if (!route) return { code: 'ROUTE_DISABLED', message: '同步路线已停用' };
        const blocked =
          (
            await this.ctx.db.query(
              'SELECT id FROM blacklists WHERE conversation_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())',
              [message.conversation_id, message.sender_id],
            )
          ).length > 0;
        const verification = (
          await this.ctx.db.query(
            `SELECT status,qq_context FROM verifications WHERE conversation_id=$1 AND user_id=$2 AND ($3::boolean=false OR membership_id=(SELECT membership_id FROM memberships WHERE conversation_id=$1 AND user_id=$2 AND status='active')) ORDER BY created_at DESC,id DESC LIMIT 1`,
            [message.conversation_id, message.sender_id, message.source_platform === 'qq'],
          )
        )[0];
        const gate = authorizeSync({
          message: {
            logical_conversation_id: message.conversation_id,
            message_id: message.id,
            content_version: message.content_version,
            content_fingerprint: message.fingerprint,
            deleted: message.deleted,
          },
          review: {
            logical_conversation_id: message.conversation_id,
            message_id: message.id,
            content_version: ref.content_version,
            content_fingerprint: ref.fingerprint,
            decision_id: ref.decision_id,
            policy_version: ref.policy_version,
            verdict: ['allowed', 'observed'].includes(message.verdict) ? 'allowed' : 'blocked',
            evaluated_at: iso(message.created_at),
          },
          currentPolicyVersion: message.policy_version,
          blacklisted: blocked,
          verification:
            !message.policy.verification_enabled ||
            (message.source_platform === 'qq' && !qqVerificationRequired(verification))
              ? 'not_required'
              : verification?.status === 'passed'
                ? 'passed'
                : 'pending',
        });
        if (!gate.allowed) return { code: 'REVIEW_REJECTED', message: '消息不再符合转发条件' };
      }
      if (job.action === 'member.remove' || job.action === 'member.ban') {
        const membership = (
          await this.ctx.db.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
            group.id,
            job.params.user_id,
          ])
        )[0];
        if (
          !membership ||
          membership.status !== 'active' ||
          !ref.membership_id ||
          ref.membership_id !== membership.membership_id
        )
          return { code: 'MEMBERSHIP_UNCONFIRMED', message: '无法确认仍为原入群批次，请人工处理' };
      }
    }
    return null;
  }
  async saveReceipt(
    accountId: string,
    incoming: ExecutionReceipt,
    reconciled = false,
    manual?: { actor: string; detail: unknown },
  ) {
    return this.ctx.db.transaction(async (tx) => {
      const job = (await tx.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [incoming.command_id]))[0];
      if (!job || job.account_id !== accountId)
        throw new ApiError(403, 'RECEIPT_SCOPE', '回执不属于此账号的投递任务');
      if (manual && job.status !== 'unknown')
        throw new ApiError(409, 'RECONCILIATION_NOT_ALLOWED', '任务状态已变化，请刷新核对记录');
      const attempt = (
        await tx.query('SELECT * FROM attempts WHERE id=$1 AND job_id=$2 AND number=$3 FOR UPDATE', [
          incoming.attempt_id,
          job.id,
          incoming.attempt_number,
        ])
      )[0];
      if (!attempt) throw new ApiError(403, 'RECEIPT_SCOPE', '回执尝试标识不匹配');
      const next = mergeReceipt(attempt.receipt ?? undefined, incoming, { reconciled });
      const firstSuccess = next.status === 'succeeded' && attempt.receipt?.status !== 'succeeded';
      await tx.query('UPDATE attempts SET status=$2,receipt=$3::jsonb WHERE id=$1', [
        attempt.id,
        next.status,
        json(next),
      ]);
      if (Number(job.current_attempt) === incoming.attempt_number)
        await tx.query(
          'UPDATE jobs SET status=$2,receipt=$3::jsonb,last_error=$4,updated_at=now() WHERE id=$1',
          [job.id, next.status, json(next), 'error' in next ? next.error.message : null],
        );
      if (firstSuccess && next.status === 'succeeded') {
        const account = (await tx.query('SELECT * FROM accounts WHERE id=$1', [accountId]))[0]!;
        if (job.action === 'message.send') {
          const content = job.params.segments
            .map((part: any) => (part.type === 'text' ? part.text : `[${part.type}]`))
            .join('');
          await tx.query(
            `INSERT INTO messages(id,conversation_id,account_id,external_id,sender_id,sender_name,content,segments,direction,verdict,fingerprint,source_at,reply_to,thread_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'outgoing','official',$9,now(),$10,$11) ON CONFLICT(account_id,conversation_id,external_id) DO NOTHING`,
            [
              randomUUID(),
              job.conversation_id,
              accountId,
              next.result?.message_id ?? `job-${job.id}`,
              account.external_id ?? account.id,
              account.name,
              content,
              json(job.params.segments),
              fingerprint(job.params.segments),
              job.params.reply_to ?? null,
              job.params.thread_id ?? null,
            ],
          );
          const images = job.params.segments.filter(
            (part: any) => part.type === 'image' && /^upload-image-[a-f0-9]{64}$/.test(part.asset_id),
          );
          if (images.length)
            await tx.query(
              'UPDATE messages SET media=$4::jsonb WHERE account_id=$1 AND conversation_id=$2 AND external_id=$3 AND deleted=false',
              [
                accountId,
                job.conversation_id,
                next.result?.message_id ?? `job-${job.id}`,
                json(images.map((image: any) => ({ provider: 'upload', asset_id: image.asset_id }))),
              ],
            );
        } else if (job.action === 'message.delete')
          await tx.query(
            'UPDATE messages SET deleted=true WHERE account_id=$1 AND external_id=$2 AND conversation_id=$3',
            [accountId, job.params.message_id, job.conversation_id],
          );
        await audit(tx, '系统任务', 'delivery.succeeded', job.id, {
          action: job.action,
          conversation_id: job.conversation_id,
          is_demo: account.is_demo,
        });
      }
      await applyQQVerificationReceipt(tx, job, next);
      if (manual) await audit(tx, manual.actor, 'delivery.reconciled', job.id, manual.detail);
      return next;
    });
  }
  async retry(id: string, actor: string) {
    await this.ctx.db.transaction(async (tx) => {
      const job = (await tx.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!job) throw new ApiError(404, 'NOT_FOUND', '投递任务不存在');
      if (qqVerificationPurposes.has(job.review_ref?.purpose))
        throw new ApiError(
          409,
          'QQ_VERIFICATION_RETRY_REQUIRED',
          '验证任务请在活人验证页重新发送或人工处理；结果待核对的任务需先核实平台记录',
        );
      if (job.status !== 'failed' || !job.receipt?.error?.retryable || epoch(job.expires_at) < Date.now())
        throw new ApiError(409, 'RETRY_NOT_ALLOWED', '此任务不满足安全重试条件');
      const account = (
        await tx.query('SELECT kind,settings FROM accounts WHERE id=$1 FOR SHARE', [job.account_id])
      )[0]!;
      const group = (
        await tx.query('SELECT external_id FROM conversations WHERE id=$1', [job.conversation_id])
      )[0]!;
      if (!groupEnabled(account, group.external_id))
        throw new ApiError(409, 'GROUP_SYNC_DISABLED', '目标群已取消同步，请先在连接账号中重新勾选');
      await tx.query("UPDATE jobs SET status='pending',due_at=now(),updated_at=now() WHERE id=$1", [id]);
      await audit(tx, actor, 'delivery.retry_requested', id);
    });
    return { queued: true };
  }
  async reconcile(id: string, input: unknown, actor: string) {
    const value = z
      .strictObject({
        outcome: z.enum(['succeeded', 'no_effect']),
        evidence: z.string().trim().min(10).max(1000),
        message_id: z.string().min(1).max(256).optional(),
      })
      .parse(input);
    const job = (await this.ctx.db.query('SELECT * FROM jobs WHERE id=$1', [id]))[0];
    if (!job || job.status !== 'unknown')
      throw new ApiError(409, 'RECONCILIATION_NOT_ALLOWED', '只有待核对任务可以人工确认结果');
    if (value.outcome === 'succeeded' && job.action === 'message.send' && !value.message_id)
      throw new ApiError(400, 'MESSAGE_ID_REQUIRED', '确认消息发送成功时，请提供平台消息 ID');
    const attempt = (
      await this.ctx.db.query('SELECT * FROM attempts WHERE job_id=$1 AND number=$2', [
        job.id,
        job.current_attempt,
      ])
    )[0]!;
    const base = {
      schema_version: '1' as const,
      command_id: job.id,
      attempt_id: attempt.id,
      attempt_number: job.current_attempt,
      revision: (attempt.receipt?.revision ?? 0) + 1,
      observed_at: new Date().toISOString(),
    };
    const receipt: ExecutionReceipt =
      value.outcome === 'succeeded'
        ? { ...base, status: 'succeeded', result: value.message_id ? { message_id: value.message_id } : {} }
        : {
            ...base,
            status: 'failed',
            error: {
              code: 'MANUALLY_CONFIRMED_NO_EFFECT',
              message: '管理员已核对并确认未产生平台动作',
              retryable: true,
            },
          };
    return this.saveReceipt(job.account_id, receipt, true, {
      actor,
      detail: { outcome: value.outcome, evidence: value.evidence, message_id: value.message_id },
    });
  }
}
