import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hasEffectiveCapability, fingerprint } from '../../../packages/contracts/src/index.ts';
import type { Context } from './context.ts';
import { audit, epoch, json } from './context.ts';
import type { JobsService } from './jobs.ts';
import { ApiError, sha } from './security.ts';
import { groupEnabled } from './scope.ts';
import type { Row } from './database.ts';
import { qqSucceeded } from './adapters.ts';
import { verificationRows } from './qq-verification.ts';

const numeric = z.string().regex(/^[1-9]\d{0,19}$/);
const request = z.object({
  group_id: numeric,
  user_id: numeric,
  flag: z.string().min(1).max(1024),
  comment: z.string().max(1000),
  time: z.number().int().positive(),
});
export class QQRequests {
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
    if (account.kind !== 'qq' || group.kind !== 'group')
      throw new ApiError(400, 'QQ_GROUP_REQUIRED', '此入口仅用于 QQ 群的入群申请');
    const binding = (
      await this.ctx.db.query('SELECT snapshot FROM bindings WHERE account_id=$1 AND conversation_id=$2', [
        account.id,
        id,
      ])
    )[0];
    const reason =
      account.status !== 'online'
        ? 'QQ 账号未在线'
        : !groupEnabled(account, group.external_id)
          ? '此群已取消同步'
          : !binding ||
              !Number.isFinite(epoch(binding.snapshot.observed_at)) ||
              epoch(binding.snapshot.observed_at) < Date.now() - 300000
            ? '请先刷新群权限'
            : !hasEffectiveCapability(binding.snapshot, 'membership.review')
              ? (binding.snapshot.permissions.find((p: Row) => p.capability === 'membership.review')
                  ?.reason ?? '连接器不支持审核或当前 QQ 管理员权限未确认')
              : null;
    return { group, account, reason };
  }
  async overview(id: string) {
    const { group, account, reason } = await this.context(id);
    const requests = await this.ctx.db.query(
      'SELECT r.id,r.user_id,r.comment,r.status,r.reason,r.source_at,r.created_at,r.job_id,j.status AS job_status,j.last_error FROM qq_join_requests r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.conversation_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 100',
      [id],
    );
    const verification = await verificationRows(
      this.ctx.db,
      id,
      requests.map((r) => r.id),
    );
    return {
      account_id: account.id,
      auto_approve: group.management_settings.qq_join_auto_approve === true,
      available: !reason,
      unavailable_reason: reason,
      verification_enabled: group.policy.verification_enabled,
      requests: requests.map((r): Row => ({
        ...r,
        verification: verification.find((v) => v.join_request_id === r.id) ?? null,
        verification_expected:
          group.policy.verification_enabled &&
          epoch(r.source_at) >= (group.management_settings.qq_verification_enabled_at ?? Infinity) * 1000,
      })),
    };
  }
  async settings(id: string, input: unknown, actor: string) {
    const value = z.strictObject({ auto_approve: z.boolean() }).parse(input);
    const { group, account, reason } = await this.context(id);
    if (value.auto_approve) {
      if (reason) throw new ApiError(409, 'QQ_REVIEW_UNAVAILABLE', reason);
      const identity = await this.ctx.adapters.qq(account, 'get_login_info');
      if (!qqSucceeded(identity) || String(identity.data.data?.user_id) !== account.external_id)
        throw new ApiError(409, 'QQ_IDENTITY_CHANGED', 'QQ 登录身份尚未确认，未开启自动审核');
      const role = await this.ctx.adapters.qqRole(account, group.external_id, account.external_id);
      if (role.admin !== true) throw new ApiError(409, 'QQ_REVIEW_PERMISSION', role.reason);
      const confirmed = await this.ctx.adapters.qq(account, 'get_login_info');
      if (!qqSucceeded(confirmed) || String(confirmed.data.data?.user_id) !== account.external_id)
        throw new ApiError(409, 'QQ_IDENTITY_CHANGED', '权限查询期间 QQ 登录身份已变化');
    }
    await this.ctx.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [account.id]))[0]!;
      const g = (await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [id]))[0]!;
      if (
        g.executor_account_id !== account.id ||
        (current.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0') ||
        (value.auto_approve &&
          (g.management_settings.qq_join_revision ?? '0') !==
            (group.management_settings.qq_join_revision ?? '0'))
      )
        throw new ApiError(409, 'QQ_REVIEW_CONTEXT_CHANGED', '执行账号或同步范围已变化，请重新配置');
      if (value.auto_approve && (current.status !== 'online' || !groupEnabled(current, g.external_id)))
        throw new ApiError(409, 'QQ_REVIEW_UNAVAILABLE', '请先恢复账号及此群同步');
      const changed = (g.management_settings.qq_join_auto_approve === true) !== value.auto_approve;
      await tx.query('UPDATE conversations SET management_settings=$2::jsonb WHERE id=$1', [
        id,
        json({
          ...g.management_settings,
          qq_join_auto_approve: value.auto_approve,
          qq_join_revision: changed ? randomUUID() : (g.management_settings.qq_join_revision ?? '0'),
          qq_join_enabled_at:
            changed && value.auto_approve
              ? Math.floor(Date.now() / 1000)
              : (g.management_settings.qq_join_enabled_at ?? null),
        }),
      ]);
      if (!value.auto_approve)
        await tx.query(
          "UPDATE jobs SET status='cancelled',last_error='本群自动入群审核已关闭',updated_at=now() WHERE conversation_id=$1 AND status='pending' AND review_ref->>'purpose'='qq-join-review'",
          [id],
        );
      await audit(tx, actor, 'qq.join.settings_updated', id, value);
    });
    return { saved: true };
  }
  async receive(account: Row, payload: any) {
    if (payload.post_type !== 'request' || payload.request_type !== 'group' || payload.sub_type !== 'add')
      return { ignored: true };
    const value = request.parse({
      group_id: String(payload.group_id ?? ''),
      user_id: String(payload.user_id ?? ''),
      flag: payload.flag,
      comment: payload.comment ?? '',
      time: payload.time,
    });
    const now = Date.now();
    if (value.time * 1000 > now + 60000 || value.time * 1000 < now - 300000)
      return { ignored: true, stale: true };
    const id = sha(json([account.id, value.group_id, value.flag]));
    const hash = fingerprint(value);
    return this.ctx.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [account.id]))[0]!;
      if (
        current.kind !== 'qq' ||
        current.status === 'paused' ||
        current.external_id !== account.external_id ||
        String(payload.self_id) !== current.external_id
      )
        return { ignored: true };
      const group = (
        await tx.query(
          'SELECT c.* FROM conversations c JOIN bindings b ON b.conversation_id=c.id WHERE b.account_id=$1 AND b.external_id=$2 FOR UPDATE OF c',
          [account.id, value.group_id],
        )
      )[0];
      if (!group || group.executor_account_id !== account.id || group.kind !== 'group')
        return { ignored: true };
      const prior = (await tx.query('SELECT fingerprint FROM qq_join_requests WHERE id=$1', [id]))[0];
      if (prior) {
        if (prior.fingerprint !== hash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一入群申请标识对应了不同内容');
        return { request_id: id, duplicate: true };
      }
      const binding = (
        await tx.query('SELECT snapshot FROM bindings WHERE account_id=$1 AND conversation_id=$2', [
          account.id,
          group.id,
        ])
      )[0];
      const blocked =
        (
          await tx.query(
            'SELECT id FROM blacklists WHERE conversation_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())',
            [group.id, value.user_id],
          )
        ).length > 0;
      const reason =
        current.status !== 'online'
          ? 'QQ 账号未在线'
          : (current.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0')
            ? '接收申请期间同步范围已变化'
            : !groupEnabled(current, group.external_id)
              ? '此群未勾选同步'
              : !group.management_settings.qq_join_auto_approve
                ? '自动审核未开启'
                : value.time < (group.management_settings.qq_join_enabled_at ?? Infinity)
                  ? '开启自动审核前的旧申请'
                  : blocked
                    ? '申请者在此群黑名单中'
                    : !binding ||
                        !Number.isFinite(epoch(binding.snapshot.observed_at)) ||
                        epoch(binding.snapshot.observed_at) < now - 300000 ||
                        !hasEffectiveCapability(binding.snapshot, 'membership.review')
                      ? '群审核权限尚未确认'
                      : null;
      const flagBox = this.ctx.box.seal(value.flag);
      let job: Row | undefined;
      if (!reason)
        job = await this.jobs.enqueue(
          {
            key: `qq-join:${id}`,
            conversationId: group.id,
            action: 'membership.approve',
            params: { request_id: id, reason: '按群设置自动通过新的入群申请' },
            reviewRef: {
              purpose: 'qq-join-review',
              request_id: id,
              user_id: value.user_id,
              flag_box: flagBox,
              group_revision: current.settings.group_revision ?? '0',
              settings_revision: group.management_settings.qq_join_revision ?? '0',
              expires_at: new Date(Math.min(value.time * 1000 + 300000, now + 60000)).toISOString(),
            },
          },
          tx,
        );
      await tx.query(
        'INSERT INTO qq_join_requests(id,account_id,conversation_id,user_id,flag_box,fingerprint,comment,status,reason,job_id,source_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          id,
          account.id,
          group.id,
          value.user_id,
          flagBox,
          hash,
          value.comment,
          job ? 'queued' : 'observed',
          reason ?? '已提交自动审核，等待平台回执',
          job?.id ?? null,
          new Date(value.time * 1000).toISOString(),
        ],
      );
      await audit(tx, 'QQ 连接器', job ? 'qq.join.queued' : 'qq.join.observed', group.id, {
        request_id: id,
        user_id: value.user_id,
        reason,
        job_id: job?.id ?? null,
      });
      return { request_id: id, queued: !!job };
    });
  }
}
