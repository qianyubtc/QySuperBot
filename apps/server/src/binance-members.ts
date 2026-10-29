import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fingerprint, hasEffectiveCapability } from '../../../packages/contracts/src/index.ts';
import type { Context } from './context.ts';
import { audit, epoch, json } from './context.ts';
import type { JobsService } from './jobs.ts';
import { ApiError } from './security.ts';
import { groupEnabled } from './scope.ts';

const userId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((v) => Number.isSafeInteger(Number(v)));
const inputSchema = z.strictObject({
  user_id: userId,
  action: z.enum(['mute', 'unmute', 'remove']),
  reason: z.string().trim().min(1).max(500),
});
const memberSchema = z.object({
  user_id: userId,
  role: z.number().int().min(0).max(3),
  active: z.boolean(),
  muted: z.boolean(),
  name: z.string().max(256),
});
const stateSchema = z.object({
  group_id: userId,
  actor: memberSchema,
  target: memberSchema.nullable(),
  paid_group: z.boolean(),
});
const pendingSql =
  "SELECT id,status FROM jobs WHERE conversation_id=$1 AND params->>'user_id'=$2 AND action IN ('member.mute','member.set_mute','member.unmute','member.remove','member.ban') AND status IN ('pending','in_flight','accepted','unknown') LIMIT 1";
export class BinanceMembers {
  constructor(
    readonly ctx: Context,
    readonly jobs: JobsService,
  ) {}
  private async context(id: string) {
    const group = (await this.ctx.db.query('SELECT * FROM conversations WHERE id=$1', [id]))[0];
    if (!group) throw new ApiError(404, 'NOT_FOUND', '群不存在');
    const account = (
      await this.ctx.db.query('SELECT * FROM accounts WHERE id=$1', [group.executor_account_id])
    )[0]!;
    if (account.kind !== 'binance' || group.kind !== 'group' || account.is_demo)
      throw new ApiError(400, 'BINANCE_GROUP_REQUIRED', '此入口仅支持真实币安群');
    return { group, account };
  }
  async overview(id: string, target?: unknown) {
    const selected = userId.optional().parse(target);
    const { group, account } = await this.context(id);
    const binding = (
      await this.ctx.db.query('SELECT snapshot FROM bindings WHERE conversation_id=$1 AND account_id=$2', [
        id,
        account.id,
      ])
    )[0];
    let reason: string | null =
      account.status !== 'online'
        ? '账号未在线'
        : account.settings.transport !== 'direct'
          ? '成员管理需要启用服务器直连'
          : !groupEnabled(account, group.external_id)
            ? '此群已取消同步'
            : !binding ||
                !Number.isFinite(epoch(binding.snapshot.observed_at)) ||
                epoch(binding.snapshot.observed_at) < Date.now() - 300000
              ? '群权限已过期，请刷新账号权限'
              : null;
    let state: z.infer<typeof stateSchema> | null = null;
    if (!reason) {
      try {
        state = stateSchema.parse(
          await this.ctx.adapters.binance!.request(account, 'member_check', {
            group_id: group.external_id,
            ...(selected ? { user_id: selected } : {}),
          }),
        );
        if (
          state.group_id !== group.external_id ||
          state.actor.user_id !== account.external_id ||
          (selected ? state.target?.user_id !== selected : state.target !== null)
        )
          throw new Error('Identity mismatch');
        if (!state.actor.active || ![1, 3].includes(state.actor.role))
          reason = '当前币安账号不是此群群主或管理员';
      } catch {
        state = null;
        reason = '暂时无法核对币安身份或群成员权限，请检查连接并刷新';
      }
    }
    const pendingAction = selected
      ? ((await this.ctx.db.query(pendingSql, [id, selected]))[0] ?? null)
      : null;
    const availability = Object.fromEntries(
      ['mute', 'unmute', 'remove'].map((action) => {
        let error = reason;
        const target = state?.target;
        if (!error && action === 'remove' && state?.paid_group)
          error = '此群为付费群，踢人涉及付费成员处理；请到币安官方页面操作';
        if (
          !error &&
          !hasEffectiveCapability(binding?.snapshot, action === 'remove' ? 'members.remove' : 'members.mute')
        )
          error = '请刷新当前账号权限；连接器不支持或未授予此操作';
        if (!error && selected) {
          if (!target || !target.active) error = '目标当前不在此群，不能执行操作';
          else if (target.user_id === account.external_id || target.role !== 0)
            error = '机器人自身、群主和管理成员受保护';
          else if (action === 'mute' && target.muted) error = '该成员已被单独禁言，请先核对现有限制';
          else if (action === 'unmute' && !target.muted)
            error = '未查到该成员的单独禁言；解禁不会解除全群或系统限制';
          if (pendingAction) error = '该成员已有处理中或待核对的管理任务，请先查看执行结果';
        }
        return [action, { available: !error, reason: error }];
      }),
    );
    return {
      platform: 'binance',
      group_id: group.external_id,
      group_name: group.name,
      account_id: account.id,
      account_name: account.name,
      actor: state?.actor ?? null,
      target: state?.target ?? null,
      selected_user_id: selected ?? null,
      pending_action: pendingAction,
      paid_group: state?.paid_group ?? null,
      availability,
      checked_at: state ? new Date().toISOString() : null,
      actions: await this.ctx.db.query(
        'SELECT a.*,j.status AS job_status,j.last_error,j.receipt FROM member_actions a LEFT JOIN jobs j ON j.id=a.job_id WHERE a.conversation_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100',
        [id],
      ),
    };
  }
  async act(id: string, input: unknown, key: string, actor: { id: string; name: string }) {
    const value = inputSchema.parse(input);
    if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(key))
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供操作请求键');
    const requestKey = `binance-member-request:${actor.id}:${key}`,
      hash = fingerprint({ id, value });
    const prior = (await this.ctx.db.query('SELECT value FROM metadata WHERE key=$1', [requestKey]))[0]
      ?.value;
    if (prior) {
      if (prior.hash !== hash)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一请求键不能更换成员或动作');
      return prior.result;
    }
    const { group, account } = await this.context(id);
    const overview = await this.overview(id, value.user_id);
    // Another identical request may have committed while the live member reads were in flight.
    const repeated = (await this.ctx.db.query('SELECT value FROM metadata WHERE key=$1', [requestKey]))[0]
      ?.value;
    if (repeated) {
      if (repeated.hash !== hash)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一请求键不能更换成员或动作');
      return repeated.result;
    }
    if (overview.pending_action)
      throw new ApiError(409, 'MEMBER_ACTION_PENDING', '该成员已有处理中或待核对任务，请先核对结果');
    const option = overview.availability[value.action]!;
    if (!option.available) throw new ApiError(409, 'BINANCE_MEMBER_UNAVAILABLE', option.reason!);
    return this.ctx.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [account.id]))[0]!;
      const currentGroup = (await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [id]))[0]!;
      if (
        current.status !== 'online' ||
        current.settings.transport !== 'direct' ||
        current.session_id !== account.session_id ||
        currentGroup.executor_account_id !== account.id ||
        !groupEnabled(current, group.external_id) ||
        (current.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0')
      )
        throw new ApiError(409, 'BINANCE_CONTEXT_CHANGED', '账号、登录会话或同步群范围已变化，请刷新后重试');
      const inserted = await tx.query(
        'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key',
        [requestKey, json({ hash })],
      );
      if (!inserted.length) {
        const previous = (await tx.query('SELECT value FROM metadata WHERE key=$1', [requestKey]))[0]!.value;
        if (previous.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '请求键已用于其他操作');
        return previous.result;
      }
      const pending = await tx.query(pendingSql, [id, value.user_id]);
      if (pending.length)
        throw new ApiError(409, 'MEMBER_ACTION_PENDING', '该成员已有处理中或待核对任务，请先核对结果');
      const actionId = randomUUID();
      const job = await this.jobs.enqueue(
        {
          key: `binance-member-action:${actionId}`,
          conversationId: id,
          action: value.action === 'remove' ? 'member.remove' : 'member.set_mute',
          params: {
            user_id: value.user_id,
            reason: value.reason,
            ...(value.action === 'remove'
              ? {}
              : { muted: value.action === 'mute', expected_muted: overview.target!.muted }),
          },
          reviewRef: {
            purpose: 'binance-member-management',
            action_id: actionId,
            user_id: value.user_id,
            action: value.action,
            session_id: account.session_id,
            group_revision: current.settings.group_revision ?? '0',
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
        },
        tx,
      );
      await tx.query(
        'INSERT INTO member_actions(id,conversation_id,user_id,action,reason,actor,source,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [actionId, id, value.user_id, value.action, value.reason, actor.name, 'web', job.id],
      );
      const result = { id: actionId, job_id: job.id, status: 'pending' };
      await tx.query('UPDATE metadata SET value=$2::jsonb WHERE key=$1', [
        requestKey,
        json({ hash, result }),
      ]);
      await audit(tx, actor.name, 'binance.member.requested', id, {
        action_id: actionId,
        user_id: value.user_id,
        action: value.action,
        reason: value.reason,
        job_id: job.id,
      });
      return result;
    });
  }
}
