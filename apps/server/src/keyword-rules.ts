import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fingerprint, hasEffectiveCapability } from '../../../packages/contracts/src/index.ts';
import type { Context } from './context.ts';
import { audit, epoch, json } from './context.ts';
import type { Row, Sql } from './database.ts';
import type { JobsService } from './jobs.ts';
import { ApiError } from './security.ts';
import { groupEnabled } from './scope.ts';
import { telegramMember } from './telegram-members.ts';
import { qqSucceeded } from './adapters.ts';

export const keywordActions = {
  reply: '自动回复',
  warn: '警告并回复',
  delete: '删除消息',
  mute: '限时禁言',
  remove: '移出成员',
  ban: '封禁成员',
};
export const keywordRuleInput = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    mode: z.enum(['observe', 'enforce']).default('observe'),
    priority: z.number().int().min(1).max(100).default(50),
    match: z.enum(['contains', 'exact']).default('contains'),
    keywords: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    action: z.enum(['reply', 'warn', 'delete', 'mute', 'remove', 'ban']),
    response: z.string().trim().max(4000).default(''),
    image_asset_id: z
      .string()
      .regex(/^upload-image-[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    duration_seconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 86400)
      .default(600),
    cooldown_seconds: z.number().int().min(5).max(86400).default(60),
    exempt_admins: z.boolean().default(true),
    expected_revision: z.string().uuid().optional(),
  })
  .superRefine((v, c) => {
    if (['reply', 'warn'].includes(v.action)) {
      if (!v.response && !v.image_asset_id)
        c.addIssue({ code: 'custom', path: ['response'], message: '请填写回复内容或上传图片' });
      if (v.image_asset_id && v.response.length > 1000)
        c.addIssue({ code: 'custom', path: ['response'], message: '图文说明最多 1000 字' });
    } else if (v.response || v.image_asset_id)
      c.addIssue({ code: 'custom', path: ['response'], message: '此动作不附带回复内容' });
  });
export function normalizeKeyword(text: string) {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .trim();
}
export function matchedKeyword(rule: Row, text: string): string | null {
  const normalized = normalizeKeyword(text);
  return (
    rule.keywords.find((word: string) => {
      const keyword = normalizeKeyword(word);
      return keyword && (rule.match === 'exact' ? normalized === keyword : normalized.includes(keyword));
    }) ?? null
  );
}
export function keywordText(segments: Row[]) {
  return segments
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
const capabilities: Record<string, string> = {
  reply: 'messages.send',
  warn: 'messages.send',
  delete: 'messages.delete',
  mute: 'members.mute',
  remove: 'members.remove',
  ban: 'members.ban',
};
export function keywordAvailability(group: Row, account: Row, snapshot?: Row) {
  return Object.fromEntries(
    Object.entries(capabilities).map(([action, capability]) => {
      let reason: string | null =
        account.status !== 'online'
          ? '账号未在线，请先恢复连接'
          : !groupEnabled(account, group.external_id)
            ? '此群已取消同步'
            : !snapshot ||
                (!account.is_demo &&
                  (!Number.isFinite(epoch(snapshot.observed_at)) ||
                    epoch(snapshot.observed_at) < Date.now() - 300000))
              ? '群权限已过期，请刷新账号权限'
              : !hasEffectiveCapability(snapshot as any, capability as any)
                ? '当前连接器不支持此动作，或账号缺少权限'
                : null;
      if (!account.is_demo && account.kind === 'binance' && !['reply', 'warn'].includes(action))
        reason =
          action === 'mute'
            ? '币安尚未接入可靠的限时禁言与自动解禁，暂不开放关键词禁言'
            : '币安自动处罚尚未接入，仅开放后台手动成员管理';
      if (
        !account.is_demo &&
        account.kind === 'binance' &&
        action === 'warn' &&
        account.settings.transport !== 'direct'
      )
        reason = '币安自动警告的实时成员核验需要服务器直连';
      if (!account.is_demo && account.kind === 'custom' && action !== 'reply')
        reason = '自定义源尚无实时成员身份核验，仅开放自动回复（需关闭管理员豁免）';
      if (group.kind !== 'group' && action !== 'reply') reason = '此动作仅用于群组';
      if (account.kind === 'telegram' && group.kind !== 'group')
        reason = 'Telegram 关键词触发目前仅用于群组，频道发帖不参与触发';
      return [action, { available: !reason, reason }];
    }),
  );
}

export class KeywordRules {
  constructor(
    readonly ctx: Context,
    readonly jobs: JobsService,
  ) {}
  async context(id: string, sql: Sql = this.ctx.db) {
    const group = (await sql.query('SELECT * FROM conversations WHERE id=$1', [id]))[0];
    if (!group) throw new ApiError(404, 'NOT_FOUND', '群不存在');
    const account = (await sql.query('SELECT * FROM accounts WHERE id=$1', [group.executor_account_id]))[0]!;
    const binding = (
      await sql.query('SELECT snapshot FROM bindings WHERE conversation_id=$1 AND account_id=$2', [
        id,
        account.id,
      ])
    )[0];
    return { group, account, availability: keywordAvailability(group, account, binding?.snapshot) };
  }
  async overview(id: string) {
    const { availability } = await this.context(id);
    return {
      availability,
      rules: await this.ctx.db.query(
        'SELECT * FROM keyword_rules WHERE conversation_id=$1 ORDER BY priority,created_at,id',
        [id],
      ),
      hits: await this.ctx.db.query(
        `SELECT h.*,m.sender_name,j.status AS job_status,j.last_error,j.receipt->'error'->>'code' AS error_code FROM keyword_hits h
        LEFT JOIN messages m ON m.id=h.message_id LEFT JOIN jobs j ON j.id=h.job_id
        WHERE h.conversation_id=$1 ORDER BY h.created_at DESC,h.id DESC LIMIT 100`,
        [id],
      ),
    };
  }
  async save(id: string, ruleId: string | undefined, input: unknown, actor: string) {
    const value = keywordRuleInput.parse(input);
    if (value.action !== 'reply') value.exempt_admins = true;
    if (value.keywords.some((word) => !normalizeKeyword(word)))
      throw new ApiError(400, 'EMPTY_KEYWORD', '关键词不能只包含不可见字符');
    if (value.image_asset_id) await this.ctx.uploads.get(value.image_asset_id);
    return this.ctx.db.transaction(async (tx) => {
      const initial = await this.context(id, tx);
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR SHARE', [initial.account.id]);
      await tx.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [id]);
      const { group, account, availability } = await this.context(id, tx);
      if (account.id !== initial.account.id)
        throw new ApiError(409, 'EXECUTOR_CHANGED', '执行账号已变化，请刷新');
      if (value.enabled && value.mode === 'enforce') {
        if (!availability[value.action]!.available)
          throw new ApiError(409, 'KEYWORD_ACTION_UNAVAILABLE', availability[value.action]!.reason!);
        if (account.kind === 'custom' && !account.is_demo && value.exempt_admins)
          throw new ApiError(
            409,
            'KEYWORD_ROLE_UNAVAILABLE',
            '自定义源尚不能核对管理员身份，请先用观察模式或关闭管理员豁免',
          );
        if (
          account.kind === 'binance' &&
          !account.is_demo &&
          account.settings.transport !== 'direct' &&
          value.exempt_admins
        )
          throw new ApiError(
            409,
            'KEYWORD_ROLE_UNAVAILABLE',
            '币安管理员豁免需要服务器直连，请先用观察模式或关闭自动回复的管理员豁免',
          );
        if (value.image_asset_id && !account.is_demo && !['telegram', 'qq', 'binance'].includes(account.kind))
          throw new ApiError(409, 'KEYWORD_IMAGE_UNAVAILABLE', '当前群不支持发送图片，或尚未取得图片权限');
      }
      if (account.kind === 'binance' && value.response.length > 2000)
        throw new ApiError(400, 'KEYWORD_CONTENT_TOO_LONG', '币安回复最多 2000 字');
      const revision = randomUUID();
      const rule = ruleId
        ? (await tx.query('SELECT * FROM keyword_rules WHERE id=$1 AND conversation_id=$2', [ruleId, id]))[0]
        : undefined;
      if (ruleId && !rule) throw new ApiError(404, 'NOT_FOUND', '规则不存在');
      if (rule && value.expected_revision !== rule.revision)
        throw new ApiError(409, 'KEYWORD_EDIT_CONFLICT', '规则已被其他操作修改，请重新打开后编辑');
      if (
        !ruleId &&
        (await tx.query('SELECT id FROM keyword_rules WHERE conversation_id=$1', [id])).length >= 50
      )
        throw new ApiError(400, 'KEYWORD_LIMIT', '每个群最多配置 50 条规则');
      const result = (
        await tx.query(
          `INSERT INTO keyword_rules(id,conversation_id,name,enabled,mode,priority,match,keywords,action,response,image_asset_id,duration_seconds,cooldown_seconds,exempt_admins,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,mode=EXCLUDED.mode,priority=EXCLUDED.priority,match=EXCLUDED.match,keywords=EXCLUDED.keywords,action=EXCLUDED.action,response=EXCLUDED.response,image_asset_id=EXCLUDED.image_asset_id,duration_seconds=EXCLUDED.duration_seconds,cooldown_seconds=EXCLUDED.cooldown_seconds,exempt_admins=EXCLUDED.exempt_admins,revision=EXCLUDED.revision RETURNING *`,
          [
            ruleId ?? randomUUID(),
            id,
            value.name,
            value.enabled,
            value.mode,
            value.priority,
            value.match,
            json([...new Set(value.keywords)]),
            value.action,
            value.response,
            value.image_asset_id,
            value.duration_seconds,
            value.cooldown_seconds,
            value.exempt_admins,
            revision,
          ],
        )
      )[0]!;
      await this.cancelPending(tx, id, result.id);
      await audit(tx, actor, 'keyword.rule.saved', id, {
        rule_id: result.id,
        mode: value.mode,
        action: value.action,
      });
      return result;
    });
  }
  private async cancelPending(tx: Sql, id: string, ruleId: string) {
    await tx.query(
      "UPDATE jobs SET status='cancelled',last_error='关键词规则已修改或删除，旧任务停止执行',updated_at=now() WHERE conversation_id=$1 AND status='pending' AND review_ref->>'purpose'='keyword' AND review_ref->>'rule_id'=$2",
      [id, ruleId],
    );
  }
  async remove(id: string, ruleId: string, actor: string) {
    await this.ctx.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [id]);
      const removed = await tx.query(
        'DELETE FROM keyword_rules WHERE id=$1 AND conversation_id=$2 RETURNING id',
        [ruleId, id],
      );
      if (!removed.length) throw new ApiError(404, 'NOT_FOUND', '规则不存在');
      await this.cancelPending(tx, id, ruleId);
      await audit(tx, actor, 'keyword.rule.deleted', id, { rule_id: ruleId });
    });
    return { deleted: true };
  }
  async preview(id: string, input: unknown) {
    const { text } = z.strictObject({ text: z.string().min(1).max(8000) }).parse(input);
    const { rules } = await this.overview(id);
    const rule = rules.find((r) => r.enabled && matchedKeyword(r, text));
    return rule
      ? {
          matched: true,
          rule_id: rule.id,
          name: rule.name,
          keyword: matchedKeyword(rule, text),
          action: rule.action,
          mode: rule.mode,
        }
      : { matched: false };
  }
  // Called under the conversation lock held by message ingestion, so competing events
  // cannot both pass the same persisted cooldown. Only the first matching rule runs.
  async match(tx: Sql, group: Row, account: Row, message: Row) {
    if (account.external_id === message.sender_id || message.direction !== 'incoming') return;
    const rules = await tx.query(
      'SELECT * FROM keyword_rules WHERE conversation_id=$1 AND enabled=true ORDER BY priority,created_at,id',
      [group.id],
    );
    const rule = rules.find((r) => matchedKeyword(r, message.content));
    if (!rule) return;
    const blocksSync = rule.mode === 'enforce' && rule.action !== 'reply';
    if (blocksSync)
      await tx.query("UPDATE messages SET verdict='blocked',reason=$2 WHERE id=$1", [
        message.id,
        `关键词规则：${rule.name}`,
      ]);
    let status = rule.mode === 'observe' ? 'observed' : 'pending';
    let detail = rule.mode === 'observe' ? '仅记录命中，未执行平台动作' : '';
    if (status === 'pending') {
      const recent = (
        await tx.query(
          `SELECT id FROM keyword_hits WHERE conversation_id=$1 AND status='pending'
        AND ((rule_id=$2 AND user_id=$3 AND created_at>now()-($4::int * interval '1 second')) OR created_at>now()-interval '3 seconds') LIMIT 1`,
          [group.id, rule.id, message.sender_id, rule.cooldown_seconds],
        )
      )[0];
      if (recent) {
        status = 'cooldown';
        detail = '处于成员冷却期或群内 3 秒防刷屏间隔，未重复执行';
      }
    }
    const hitId = randomUUID();
    await tx.query(
      `INSERT INTO keyword_hits(id,rule_id,conversation_id,message_id,user_id,rule_name,action,keyword,status,detail)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        hitId,
        rule.id,
        group.id,
        message.id,
        message.sender_id,
        rule.name,
        rule.action,
        matchedKeyword(rule, message.content),
        status,
        detail,
      ],
    );
    if (status !== 'pending') return { blocksSync };
    const member = (
      await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
        group.id,
        message.sender_id,
      ])
    )[0];
    const punitive = !['reply', 'warn'].includes(rule.action);
    const action = ['reply', 'warn'].includes(rule.action)
      ? 'message.send'
      : rule.action === 'delete'
        ? 'message.delete'
        : `member.${rule.action}`;
    const params = keywordParams(rule, message);
    const expiresAt = new Date(Date.now() + 120000).toISOString();
    const job = await this.jobs.enqueue(
      {
        key: `keyword:${message.id}`,
        conversationId: group.id,
        action,
        params,
        reviewRef: {
          purpose: 'keyword',
          rule_id: rule.id,
          revision: rule.revision,
          hit_id: hitId,
          message_record_id: message.id,
          content_version: message.content_version,
          fingerprint: message.fingerprint,
          policy_version: group.policy_version,
          group_revision: account.settings.group_revision ?? '0',
          session_id: account.session_id,
          user_id: message.sender_id,
          membership_id: member?.membership_id ?? null,
          punitive,
          rule_name: rule.name,
          until_date: Math.floor(Date.now() / 1000) + rule.duration_seconds,
          expires_at: expiresAt,
        },
      },
      tx,
    );
    await tx.query('UPDATE jobs SET expires_at=$2 WHERE id=$1', [job.id, expiresAt]);
    await tx.query('UPDATE keyword_hits SET job_id=$2 WHERE id=$1', [hitId, job.id]);
    await audit(tx, '关键词规则', 'keyword.matched', group.id, {
      hit_id: hitId,
      rule_id: rule.id,
      job_id: job.id,
    });
    return { blocksSync };
  }
}

function keywordParams(rule: Row, message: Row) {
  return ['reply', 'warn'].includes(rule.action)
    ? {
        segments: [
          ...(rule.image_asset_id ? [{ type: 'image', asset_id: rule.image_asset_id }] : []),
          ...(rule.response ? [{ type: 'text', text: rule.response }] : []),
        ],
        reply_to: message.external_id,
        ...(message.thread_id ? { thread_id: message.thread_id } : {}),
      }
    : rule.action === 'delete'
      ? { message_id: message.external_id, reason: `关键词规则：${rule.name}` }
      : {
          user_id: message.sender_id,
          reason: `关键词规则：${rule.name}`,
          ...(rule.action === 'mute' ? { duration_seconds: rule.duration_seconds } : {}),
        };
}

export async function checkKeywordJob(
  ctx: Context,
  job: Row,
  group: Row,
  account: Row,
  checkRole = true,
): Promise<{ code: string; message: string; retryable?: boolean } | null> {
  const ref = job.review_ref;
  const fail = (code: string, message: string): { code: string; message: string; retryable?: boolean } => ({
    code,
    message,
  });
  const rule = (
    await ctx.db.query('SELECT * FROM keyword_rules WHERE id=$1 AND conversation_id=$2', [
      ref.rule_id,
      group.id,
    ])
  )[0];
  const hit = (
    await ctx.db.query('SELECT * FROM keyword_hits WHERE id=$1 AND conversation_id=$2', [
      ref.hit_id,
      group.id,
    ])
  )[0];
  if (!rule || !rule.enabled || rule.mode !== 'enforce' || rule.revision !== ref.revision)
    return fail('KEYWORD_RULE_CHANGED', '关键词规则已停用、修改或删除，停止旧任务');
  const expected = ['reply', 'warn'].includes(rule.action)
    ? 'message.send'
    : rule.action === 'delete'
      ? 'message.delete'
      : `member.${rule.action}`;
  if (
    !hit ||
    hit.rule_id !== rule.id ||
    hit.job_id !== job.id ||
    hit.message_id !== ref.message_record_id ||
    hit.user_id !== ref.user_id ||
    job.action !== expected
  )
    return fail('KEYWORD_SCOPE', '关键词命中记录与操作任务不匹配');
  if (
    !Number.isFinite(epoch(ref.expires_at)) ||
    epoch(ref.expires_at) <= Date.now() ||
    (account.settings.group_revision ?? '0') !== ref.group_revision ||
    account.session_id !== ref.session_id
  )
    return fail('KEYWORD_CONTEXT_CHANGED', '登录会话、同步范围或触发有效期已变化，停止旧任务');
  const message = (
    await ctx.db.query('SELECT * FROM messages WHERE id=$1 AND conversation_id=$2 AND account_id=$3', [
      hit.message_id,
      group.id,
      account.id,
    ])
  )[0];
  if (
    !message ||
    message.deleted ||
    message.direction !== 'incoming' ||
    message.sender_id !== ref.user_id ||
    message.content_version !== ref.content_version ||
    message.fingerprint !== ref.fingerprint ||
    !(rule.action === 'reply'
      ? ['allowed', 'observed'].includes(message.verdict)
      : message.verdict === 'blocked' && message.reason === `关键词规则：${rule.name}`) ||
    !matchedKeyword(rule, keywordText(message.segments))
  )
    return fail('KEYWORD_MESSAGE_CHANGED', '原消息已变化、删除或不再符合触发条件');
  if (fingerprint(job.params) !== fingerprint(keywordParams(rule, message)))
    return fail('KEYWORD_PARAMS_CHANGED', '执行内容与关键词规则不一致，未执行');
  if (group.policy_version !== ref.policy_version)
    return fail('KEYWORD_POLICY_CHANGED', '广告或验证规则已修改，请等待新消息重新匹配');
  if (
    (
      await ctx.db.query(
        'SELECT id FROM blacklists WHERE conversation_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())',
        [group.id, message.sender_id],
      )
    ).length
  )
    return fail('KEYWORD_BLACKLISTED', '成员已加入群黑名单，不再执行关键词动作');
  const binding = (
    await ctx.db.query('SELECT snapshot FROM bindings WHERE conversation_id=$1 AND account_id=$2', [
      group.id,
      account.id,
    ])
  )[0];
  const option = keywordAvailability(group, account, binding?.snapshot)[rule.action]!;
  if (!option.available) return fail('KEYWORD_ACTION_UNAVAILABLE', option.reason!);
  if (['mute', 'remove', 'ban'].includes(rule.action)) {
    if (
      job.params.user_id !== message.sender_id ||
      (rule.action === 'mute' && job.params.duration_seconds !== rule.duration_seconds)
    )
      return fail('KEYWORD_TARGET', '处罚对象或禁言时长与规则不一致');
    const membership = (
      await ctx.db.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
        group.id,
        message.sender_id,
      ])
    )[0];
    if ((membership?.membership_id ?? null) !== ref.membership_id || membership?.status === 'left')
      return fail('KEYWORD_MEMBERSHIP_CHANGED', '成员已退群或入群批次已变化');
    const pending = await ctx.db.query(
      "SELECT id FROM jobs WHERE conversation_id=$1 AND params->>'user_id'=$2 AND id<>$3 AND action LIKE 'member.%' AND status IN ('pending','in_flight','accepted','unknown') LIMIT 1",
      [group.id, message.sender_id, job.id],
    );
    if (pending.length) return fail('KEYWORD_MEMBER_BUSY', '此成员已有待处理或待核对的管理任务，请人工核对');
  }
  if (account.external_id === message.sender_id) return fail('KEYWORD_SELF', '机器人自身不参与关键词触发');
  if (group.executor_account_id !== account.id) return fail('KEYWORD_EXECUTOR_CHANGED', '执行账号已经变化');
  if (
    checkRole &&
    !account.is_demo &&
    (account.kind === 'telegram' || rule.exempt_admins || rule.action !== 'reply')
  ) {
    try {
      if (account.kind === 'telegram') {
        const me = await ctx.adapters.telegram(account, 'getMe');
        if (me.status !== 200 || me.data?.ok !== true || String(me.data.result?.id) !== account.external_id)
          return fail('KEYWORD_IDENTITY_CHANGED', 'Telegram 机器人登录身份已变化');
        const member = await telegramMember(
          (action, params) => ctx.adapters.telegram(account, action, params),
          group.external_id,
          message.sender_id,
        );
        if (
          member.user.is_bot ||
          ((rule.exempt_admins || rule.action !== 'reply') &&
            ['creator', 'administrator'].includes(member.status))
        )
          return fail('KEYWORD_PROTECTED', '群主、管理员或机器人已豁免');
        if (
          !['member', 'restricted', 'creator', 'administrator'].includes(member.status) ||
          (member.status === 'restricted' && member.is_member !== true)
        )
          return fail('KEYWORD_NOT_MEMBER', '成员当前不在群内');
      } else if (account.kind === 'qq') {
        const member = await ctx.adapters.qqMember(account, group.external_id, message.sender_id);
        if (!member) return fail('KEYWORD_MEMBER_UNKNOWN', '无法实时核对成员身份，未执行');
        if (member.role !== 'member') return fail('KEYWORD_PROTECTED', '群主或管理员已豁免');
        if (
          !Number.isSafeInteger(member.join_time) ||
          member.join_time <= 0 ||
          member.join_time * 1000 > epoch(message.source_at)
        )
          return fail('KEYWORD_MEMBERSHIP_UNKNOWN', '无法确认消息属于当前入群批次');
        if (
          rule.action === 'mute' &&
          (!Number.isSafeInteger(member.shut_up_timestamp) ||
            member.shut_up_timestamp < 0 ||
            member.shut_up_timestamp > Date.now() / 1000)
        )
          return fail('KEYWORD_ALREADY_MUTED', '成员禁言状态不明或已有禁言，避免覆盖其他限制');
        const identity = await ctx.adapters.qq(account, 'get_login_info');
        if (!qqSucceeded(identity) || String(identity.data.data?.user_id) !== account.external_id)
          return fail('KEYWORD_IDENTITY_CHANGED', 'QQ 成员查询期间登录账号已变化，未执行');
      } else if (account.kind === 'binance') {
        const state = await ctx.adapters.binance!.request(account, 'member_check', {
          group_id: group.external_id,
          user_id: message.sender_id,
        });
        if (
          state.group_id !== group.external_id ||
          state.actor?.user_id !== account.external_id ||
          state.target?.user_id !== message.sender_id ||
          state.target.active !== true
        )
          return fail('KEYWORD_MEMBER_UNKNOWN', '币安成员身份尚未确认');
        if (state.target.role !== 0) return fail('KEYWORD_PROTECTED', '币安管理员或特殊成员已豁免');
      } else return fail('KEYWORD_ROLE_UNKNOWN', '此来源无法实时确认成员角色，未执行');
    } catch {
      return fail('KEYWORD_MEMBER_UNKNOWN', '暂时无法实时核对成员身份，未执行自动处理');
    }
  }
  if (checkRole) {
    const latestGroup = (await ctx.db.query('SELECT * FROM conversations WHERE id=$1', [group.id]))[0]!;
    const latestAccount = (await ctx.db.query('SELECT * FROM accounts WHERE id=$1', [account.id]))[0]!;
    return checkKeywordJob(ctx, job, latestGroup, latestAccount, false);
  }
  return null;
}
