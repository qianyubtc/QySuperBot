import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fingerprint, hasEffectiveCapability } from '../../../packages/contracts/src/index.ts';
import type { Context } from './context.ts';
import { audit, epoch, json } from './context.ts';
import type { JobsService } from './jobs.ts';
import type { Row } from './database.ts';
import { ApiError } from './security.ts';
import { groupEnabled } from './scope.ts';
import { checkTelegramManagement, telegramMember } from './telegram-members.ts';

const inputSchema = z
  .strictObject({
    user_id: z.string().regex(/^[1-9]\d{0,19}$/),
    action: z.enum(['mute', 'ban', 'warn', 'clearwarnings', 'warnings']),
    reason: z.string().trim().min(1).max(500),
    duration_seconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 86400)
      .optional(),
  })
  .superRefine((v, c) => {
    if (v.action === 'mute' && v.duration_seconds === undefined)
      c.addIssue({ code: 'custom', path: ['duration_seconds'], message: '禁言需要指定 60 秒至 30 天的时长' });
    if (v.action !== 'mute' && v.duration_seconds !== undefined)
      c.addIssue({ code: 'custom', path: ['duration_seconds'], message: '此操作不使用禁言时长' });
  });
type Actor = { id: string; name: string; reply_to?: string; thread_id?: string } & (
  { source: 'web' } | { source: 'telegram'; command_revision: string; group_revision: string }
);
export const memberActionNames: Record<string, string> = {
  mute: '限时禁言',
  ban: '封禁成员',
  warn: '记录警告',
  clearwarnings: '清除警告',
  warnings: '查询警告',
};
export class MemberManagement {
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
    if (account.kind !== 'telegram' || group.kind !== 'group')
      throw new ApiError(400, 'TG_GROUP_REQUIRED', '成员管理目前仅用于 Telegram 群组');
    return { group, account };
  }
  async overview(id: string, target?: unknown) {
    const targetId = z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .optional()
      .parse(target);
    const { group, account } = await this.context(id);
    const binding = (
      await this.ctx.db.query('SELECT snapshot FROM bindings WHERE conversation_id=$1 AND account_id=$2', [
        id,
        account.id,
      ])
    )[0];
    const snapshot = binding?.snapshot;
    const availability = Object.fromEntries(
      Object.entries({
        mute: 'members.mute',
        ban: 'members.ban',
        warn: 'messages.send',
        clearwarnings: 'messages.send',
        warnings: 'messages.send',
      }).map(([action, capability]) => {
        const reason =
          account.status !== 'online'
            ? '账号未在线'
            : !groupEnabled(account, group.external_id)
              ? '此群已取消同步'
              : !snapshot ||
                  !Number.isFinite(epoch(snapshot.observed_at)) ||
                  epoch(snapshot.observed_at) < Date.now() - 300000
                ? '群权限需刷新'
                : !hasEffectiveCapability(snapshot, capability as any)
                  ? '连接器不支持或机器人缺少权限'
                  : null;
        return [action, { available: !reason, reason }];
      }),
    );
    return {
      commands_enabled: group.management_settings.telegram_commands === true,
      availability,
      selected_user_id: targetId ?? null,
      selected_warning_count: targetId
        ? (
            await this.ctx.db.query(
              "SELECT count(*)::int AS n FROM member_actions WHERE conversation_id=$1 AND user_id=$2 AND action='warn' AND warning_active=true",
              [id, targetId],
            )
          )[0]!.n
        : null,
      warnings: await this.ctx.db.query(
        "SELECT user_id,count(*)::int AS count FROM member_actions WHERE conversation_id=$1 AND action='warn' AND warning_active=true GROUP BY user_id ORDER BY count(*) DESC,user_id LIMIT 100",
        [id],
      ),
      actions: await this.ctx.db.query(
        'SELECT a.*,j.status AS job_status,j.last_error FROM member_actions a LEFT JOIN jobs j ON j.id=a.job_id WHERE a.conversation_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100',
        [id],
      ),
    };
  }
  async settings(id: string, input: unknown, actor: string) {
    const value = z.strictObject({ commands_enabled: z.boolean() }).parse(input);
    const { account } = await this.context(id);
    await this.ctx.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR SHARE', [account.id]);
      const group = (await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [id]))[0]!;
      if (group.executor_account_id !== account.id)
        throw new ApiError(409, 'EXECUTOR_CHANGED', '执行账号已变化，请刷新后重新配置');
      await tx.query('UPDATE conversations SET management_settings=$2::jsonb WHERE id=$1', [
        id,
        json({
          ...group.management_settings,
          telegram_commands: value.commands_enabled,
          telegram_commands_revision:
            (group.management_settings.telegram_commands === true) !== value.commands_enabled
              ? randomUUID()
              : (group.management_settings.telegram_commands_revision ?? '0'),
        }),
      ]);
      if (!value.commands_enabled)
        await tx.query(
          "UPDATE jobs SET status='cancelled',last_error='本群管理员命令已关闭',updated_at=now() WHERE conversation_id=$1 AND status='pending' AND review_ref->>'action_id' IN (SELECT id FROM member_actions WHERE conversation_id=$1 AND source='telegram')",
          [id],
        );
      await audit(tx, actor, 'member.commands.updated', id, value);
    });
    return { saved: true };
  }
  async act(id: string, input: unknown, key: string, actor: Actor) {
    const value = inputSchema.parse(input);
    if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(key))
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供操作请求键');
    const requestKey = `member-request:${actor.source}:${actor.id}:${key}`;
    const hash = fingerprint({
      id,
      value,
      reply_to: actor.reply_to ?? null,
      thread_id: actor.thread_id ?? null,
    });
    const prior = (await this.ctx.db.query('SELECT value FROM metadata WHERE key=$1', [requestKey]))[0]
      ?.value;
    if (prior) {
      if (prior.hash !== hash)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一请求键不能改变成员或操作');
      return prior.result;
    }
    const { group, account } = await this.context(id);
    if (
      actor.source === 'telegram' &&
      ((group.management_settings.telegram_commands_revision ?? '0') !== actor.command_revision ||
        (account.settings.group_revision ?? '0') !== actor.group_revision)
    )
      throw new ApiError(409, 'TG_COMMAND_CONTEXT_CHANGED', '命令设置或同步范围已变化，请重新发送命令');
    if (account.status !== 'online' || !groupEnabled(account, group.external_id))
      throw new ApiError(409, 'ACCOUNT_OFFLINE', '请先恢复账号与此群同步');
    const options = (await this.overview(id)).availability;
    if (!options[value.action]!.available)
      throw new ApiError(409, 'CAPABILITY_UNAVAILABLE', options[value.action]!.reason!);
    const call = (action: string, params?: unknown) => this.ctx.adapters.telegram(account, action, params);
    await checkTelegramManagement(
      call,
      account,
      group.external_id,
      value.user_id,
      value.action,
      actor.source === 'telegram' ? actor.id : undefined,
    );
    if (value.action === 'mute') {
      const chat = await call('getChat', { chat_id: group.external_id });
      if (
        chat.status !== 200 ||
        chat.data?.ok !== true ||
        String(chat.data.result?.id) !== group.external_id ||
        chat.data.result.type !== 'supergroup'
      )
        throw new ApiError(409, 'TG_SUPERGROUP_REQUIRED', 'Telegram 限时禁言仅支持超级群');
    }
    return this.ctx.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [account.id]))[0]!;
      const currentGroup = (await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [id]))[0]!;
      if (
        current.status !== 'online' ||
        currentGroup.executor_account_id !== account.id ||
        !groupEnabled(current, group.external_id) ||
        (current.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0')
      )
        throw new ApiError(409, 'STALE_CONNECTION', '账号或同步范围已变化，请刷新后重试');
      if (actor.source === 'telegram' && !currentGroup.management_settings.telegram_commands)
        throw new ApiError(409, 'TG_COMMANDS_DISABLED', '本群管理员命令已关闭');
      if (
        actor.source === 'telegram' &&
        (currentGroup.management_settings.telegram_commands_revision ?? '0') !==
          (group.management_settings.telegram_commands_revision ?? '0')
      )
        throw new ApiError(409, 'TG_COMMANDS_CHANGED', '管理员命令设置已变化，请重新发送命令');
      const inserted = await tx.query(
        'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key',
        [requestKey, json({ hash })],
      );
      if (!inserted.length) {
        const previous = (await tx.query('SELECT value FROM metadata WHERE key=$1', [requestKey]))[0]!.value;
        if (previous.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '请求键已用于另一项操作');
        return previous.result;
      }
      const actionId = randomUUID();
      if (value.action === 'clearwarnings')
        await tx.query(
          "UPDATE member_actions SET warning_active=false WHERE conversation_id=$1 AND user_id=$2 AND action='warn' AND warning_active=true",
          [id, value.user_id],
        );
      const membership = (
        await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
          id,
          value.user_id,
        ])
      )[0];
      const ref = {
        purpose: 'member-management',
        action_id: actionId,
        user_id: value.user_id,
        actor_id: actor.source === 'telegram' ? actor.id : null,
        source: actor.source,
        group_revision: current.settings.group_revision ?? '0',
        ...(actor.source === 'telegram'
          ? { command_revision: currentGroup.management_settings.telegram_commands_revision ?? '0' }
          : {}),
        membership_id: membership?.membership_id ?? null,
        expires_at: new Date(Date.now() + 25000).toISOString(),
        ...(value.action === 'mute'
          ? { until_date: Math.floor(Date.now() / 1000) + value.duration_seconds! }
          : {}),
      };
      let job: Row | undefined;
      if (['mute', 'ban'].includes(value.action)) {
        const pending = await tx.query(
          "SELECT id FROM jobs WHERE conversation_id=$1 AND params->>'user_id'=$2 AND action IN ('member.mute','member.ban','member.remove','member.unmute','member.unban') AND status IN ('pending','in_flight','accepted','unknown') LIMIT 1",
          [id, value.user_id],
        );
        if (pending.length)
          throw new ApiError(
            409,
            'MEMBER_ACTION_PENDING',
            '该成员已有处理中或待核对的管理任务，请先查看结果',
          );
        job = await this.jobs.enqueue(
          {
            key: `member-action:${actionId}`,
            conversationId: id,
            action: value.action === 'mute' ? 'member.mute' : 'member.ban',
            params: {
              user_id: value.user_id,
              reason: value.reason,
              ...(value.action === 'mute' ? { duration_seconds: value.duration_seconds } : {}),
            },
            reviewRef: ref,
          },
          tx,
        );
      }
      await tx.query(
        'INSERT INTO member_actions(id,conversation_id,user_id,action,reason,actor,source,job_id,warning_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          actionId,
          id,
          value.user_id,
          value.action,
          value.reason,
          actor.name,
          actor.source,
          job?.id ?? null,
          value.action === 'warn',
        ],
      );
      const count = (
        await tx.query(
          "SELECT count(*)::int AS n FROM member_actions WHERE conversation_id=$1 AND user_id=$2 AND action='warn' AND warning_active=true",
          [id, value.user_id],
        )
      )[0]!.n;
      const result = {
        id: actionId,
        job_id: job?.id ?? null,
        warning_count: count,
        status: job ? 'pending' : 'recorded',
      };
      await tx.query('UPDATE metadata SET value=$2::jsonb WHERE key=$1', [
        requestKey,
        json({ hash, result }),
      ]);
      await audit(tx, actor.name, 'member.' + value.action, id, {
        action_id: actionId,
        user_id: value.user_id,
        reason: value.reason,
        job_id: job?.id ?? null,
      });
      if (actor.source === 'telegram') {
        const text = job
          ? `${memberActionNames[value.action]}请求已提交。\n成员：${value.user_id}\n操作编号：${actionId}\n实际处理结果以后台平台回执为准。`
          : `成员 ${value.user_id} 当前有 ${count} 次有效警告。${value.action === 'warn' ? '本次警告已记录。原因：' + value.reason : value.action === 'clearwarnings' ? '警告已清除。' : ''}`;
        await this.jobs.enqueue(
          {
            key: `member-notice:${actionId}`,
            conversationId: id,
            action: 'message.send',
            params: {
              segments: [{ type: 'text', text }],
              ...(actor.reply_to ? { reply_to: actor.reply_to } : {}),
              ...(actor.thread_id ? { thread_id: actor.thread_id } : {}),
            },
            reviewRef: { ...ref, purpose: 'member-notice' },
          },
          tx,
        );
      }
      return result;
    });
  }
  async handleUpdate(account: Row, update: any) {
    const message = update.message;
    if (
      !message ||
      !['group', 'supergroup'].includes(message.chat?.type) ||
      message.sender_chat ||
      message.from?.is_bot ||
      !/^[1-9]\d{0,19}$/.test(String(message.from?.id ?? '')) ||
      !Number.isSafeInteger(update.update_id) ||
      !Number.isFinite(Number(message.date)) ||
      !/^\/(mute|ban|warn|warnings|clearwarns)(?:@|\s|$)/i.test(message.text ?? '') ||
      Math.abs(Date.now() - Number(message.date) * 1000) > 60000
    )
      return;
    const group = (
      await this.ctx.db.query('SELECT * FROM conversations WHERE executor_account_id=$1 AND external_id=$2', [
        account.id,
        String(message.chat.id),
      ])
    )[0];
    if (!group) return;
    // Consume each command update once, including ignored/rejected commands. A redelivery
    // must not gain permission after a role or setting change; an interrupted command
    // requires the administrator to send a new command rather than resuming it later.
    const claimed = await this.ctx.db.query(
      'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key',
      [
        `member-command:${account.id}:${update.update_id}`,
        json({ conversation_id: group.id, received_at: new Date().toISOString() }),
      ],
    );
    if (!claimed.length || !group.management_settings.telegram_commands) return;
    let authorized = false;
    try {
      const call = (action: string, params?: unknown) => this.ctx.adapters.telegram(account, action, params);
      const me = await call('getMe');
      if (me.status !== 200 || me.data?.ok !== true || String(me.data.result?.id) !== account.external_id)
        return;
      const match = String(message.text)
        .trim()
        .match(/^\/(mute|ban|warn|warnings|clearwarns)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
      if (
        !match ||
        (match[2] && match[2].toLowerCase() !== String(me.data.result.username ?? '').toLowerCase())
      )
        return;
      const actor = await telegramMember(call, group.external_id, String(message.from.id));
      if (!['creator', 'administrator'].includes(actor.status)) return;
      authorized = true;
      const target = message.reply_to_message;
      if (!target?.from?.id || target.sender_chat || String(target.chat?.id) !== group.external_id)
        throw new ApiError(400, 'TG_REPLY_REQUIRED', '请回复目标成员的一条消息后发送管理命令');
      let action = match[1]!.toLowerCase();
      if (action === 'clearwarns') action = 'clearwarnings';
      let reason = (match[3] ?? '').trim();
      let duration: number | undefined;
      if (action === 'mute') {
        const time = reason.match(/^(\d+)([smhd])(?:\s+([\s\S]*))?$/i);
        if (!time)
          throw new ApiError(
            400,
            'TG_DURATION_REQUIRED',
            '用法：回复成员消息后发送 /mute 10m 原因（支持 s、m、h、d，60 秒至 30 天）',
          );
        duration = Number(time[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[time[2]!.toLowerCase()] ?? 0);
        reason = (time[3] ?? '管理员命令').trim();
      }
      await this.act(
        group.id,
        {
          action,
          user_id: String(target.from.id),
          reason: reason || '管理员命令',
          ...(duration !== undefined ? { duration_seconds: duration } : {}),
        },
        `tg-command:${account.id}:${update.update_id}`,
        {
          source: 'telegram',
          command_revision: group.management_settings.telegram_commands_revision ?? '0',
          group_revision: account.settings.group_revision ?? '0',
          id: String(message.from.id),
          name: `Telegram 管理员 ${message.from.id}`,
          reply_to: String(message.message_id),
          ...(message.message_thread_id ? { thread_id: String(message.message_thread_id) } : {}),
        },
      );
    } catch (error) {
      const messageText =
        error instanceof ApiError
          ? error.message
          : error instanceof z.ZodError
            ? '命令参数无效。禁言时长需为 60 秒至 30 天；请填写简短原因。'
            : '命令参数或成员状态无法核对，未执行操作';
      await audit(this.ctx.db, 'Telegram 管理命令', 'member.command.rejected', group.id, {
        update_id: update.update_id,
        code: error instanceof ApiError ? error.code : 'INVALID_COMMAND',
        message: messageText,
      });
      if (authorized)
        await this.ctx.db.transaction(async (tx) => {
          const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [account.id]))[0]!;
          const g = (await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [group.id]))[0]!;
          if (
            current.status !== 'online' ||
            !groupEnabled(current, g.external_id) ||
            g.executor_account_id !== account.id ||
            !g.management_settings.telegram_commands
          )
            return;
          const key = `member-rejected:${account.id}:${update.update_id}`;
          if (
            !(
              await tx.query(
                'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key',
                [key, '{}'],
              )
            ).length
          )
            return;
          const id = randomUUID();
          await tx.query(
            "INSERT INTO member_actions(id,conversation_id,user_id,action,reason,actor,source) VALUES($1,$2,$3,'command_rejected',$4,$5,'telegram')",
            [id, group.id, String(message.from.id), messageText, `Telegram 管理员 ${message.from.id}`],
          );
          await this.jobs.enqueue(
            {
              key,
              conversationId: group.id,
              action: 'message.send',
              params: {
                segments: [{ type: 'text', text: '命令未执行：' + messageText }],
                reply_to: String(message.message_id),
                ...(message.message_thread_id ? { thread_id: String(message.message_thread_id) } : {}),
              },
              reviewRef: {
                purpose: 'member-notice',
                action_id: id,
                group_revision: current.settings.group_revision ?? '0',
                command_revision: g.management_settings.telegram_commands_revision ?? '0',
                expires_at: new Date(Date.now() + 25000).toISOString(),
              },
            },
            tx,
          );
        });
    }
  }
}
