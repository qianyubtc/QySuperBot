import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fingerprint } from '../../../packages/contracts/src/index.ts';
import type { Principal } from './auth.ts';
import { AuthService } from './auth.ts';
import type { Context } from './context.ts';
import { audit, epoch, json } from './context.ts';
import type { Row, Sql } from './database.ts';
import {
  announcementInput,
  blacklistInput,
  lotteryInput,
  policyInput,
  projectInput,
  routeInput,
  sendInput,
} from './inputs.ts';
import { JobsService } from './jobs.ts';
import { ApiError, sha, token } from './security.ts';
import { moderationJobsSql, policyAvailability } from './governance.ts';
import { QQVerification, verificationRows } from './qq-verification.ts';

export class FeaturesService {
  ctx: Context;
  jobs: JobsService;
  auth: AuthService;
  constructor(
    ctx: Context,
    jobs: JobsService,
    auth: AuthService,
    readonly qqVerification = new QQVerification(ctx, jobs),
  ) {
    this.ctx = ctx;
    this.jobs = jobs;
    this.auth = auth;
  }
  async overview(): Promise<Row> {
    const counts = (
      await this.ctx.db.query(`SELECT
      (SELECT count(*)::int FROM accounts) AS accounts,
      (SELECT count(*)::int FROM accounts WHERE status='online') AS online_accounts,
      (SELECT count(*)::int FROM conversations) AS conversations,
      (SELECT count(*)::int FROM messages WHERE created_at>=(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')) AS messages_today,
      (SELECT count(*)::int FROM messages WHERE verdict='blocked' AND created_at>=(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')) AS blocked_today,
      (SELECT count(*)::int FROM verifications WHERE status='pending' OR (qq_context IS NOT NULL AND status IN ('failed','expired','manual_review','cooldown'))) AS pending_verifications,
      (SELECT count(*)::int FROM jobs WHERE status='unknown') AS unknown_deliveries,
      (SELECT count(*)::int FROM jobs WHERE status='succeeded') AS deliveries_succeeded,
      (SELECT count(*)::int FROM jobs WHERE status='pending') AS deliveries_pending,
      (SELECT count(*)::int FROM accounts WHERE is_demo=true) AS demo_accounts`)
    )[0]!;
    const series = await this.ctx.db.query(`SELECT day::date::text AS date,
      (SELECT count(*)::int FROM messages m WHERE m.created_at AT TIME ZONE 'Asia/Shanghai'>=day AND m.created_at AT TIME ZONE 'Asia/Shanghai'<day+interval '1 day') AS messages,
      (SELECT count(*)::int FROM messages m WHERE m.verdict='blocked' AND m.created_at AT TIME ZONE 'Asia/Shanghai'>=day AND m.created_at AT TIME ZONE 'Asia/Shanghai'<day+interval '1 day') AS blocked
      FROM generate_series(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')-interval '6 days',date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai'),interval '1 day') AS day`);
    const platforms = await this.ctx.db.query(
      'SELECT platform,count(*)::int AS groups FROM conversations GROUP BY platform ORDER BY groups DESC',
    );
    return {
      ...counts,
      series,
      platforms,
      recent_activity: await this.ctx.db.query('SELECT * FROM audit ORDER BY created_at DESC LIMIT 8'),
    };
  }
  async groups(principal?: Principal) {
    if (principal?.kind === 'project') this.auth.authorize(principal, 'conversations.read', []);
    const where = principal?.kind === 'project' ? 'WHERE c.id=ANY($1::text[])' : '';
    return this.ctx.db.query(
      `SELECT c.*,a.name AS account_name,a.status AS account_status,
      CASE WHEN a.kind IN ('qq','telegram','binance') THEN COALESCE((a.settings->'group_ids') @> jsonb_build_array(c.external_id),true) ELSE true END AS sync_enabled,
      (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.created_at>now()-interval '1 day') AS messages_24h,
      (SELECT count(*)::int FROM verifications v WHERE v.conversation_id=c.id AND (v.status='pending' OR (v.qq_context IS NOT NULL AND v.status IN ('failed','expired','manual_review','cooldown')))) AS pending_verifications,
      (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.verdict='blocked') AS blocked_count
      FROM conversations c JOIN accounts a ON a.id=c.executor_account_id ${where} ORDER BY c.created_at`,
      principal?.kind === 'project' ? [principal.conversation_ids] : [],
    );
  }
  async group(id: string): Promise<Row> {
    const group = (
      await this.ctx.db.query(
        'SELECT c.*,a.name AS account_name,a.status AS account_status,a.kind AS executor_kind,a.settings AS executor_settings FROM conversations c JOIN accounts a ON a.id=c.executor_account_id WHERE c.id=$1',
        [id],
      )
    )[0];
    if (!group) throw new ApiError(404, 'NOT_FOUND', '群不存在');
    const bindings = await this.ctx.db.query(
      'SELECT b.*,a.name AS account_name,a.status AS account_status FROM bindings b JOIN accounts a ON a.id=b.account_id WHERE b.conversation_id=$1',
      [id],
    );
    const { executor_kind, executor_settings, ...publicGroup } = group;
    return {
      ...publicGroup,
      policy_options: policyAvailability(
        group,
        {
          kind: executor_kind,
          settings: executor_settings,
          status: group.account_status,
          is_demo: group.is_demo,
        },
        bindings.find((b) => b.account_id === group.executor_account_id)?.snapshot,
      ),
      bindings,
      messages: await this.ctx.db.query(
        `SELECT m.*,${moderationJobsSql()} AS moderation_jobs FROM messages m WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,
        [id],
      ),
      verifications: await verificationRows(this.ctx.db, id),
      blacklists: await this.ctx.db.query(
        'SELECT * FROM blacklists WHERE conversation_id=$1 ORDER BY created_at DESC',
        [id],
      ),
    };
  }
  async policy(id: string, input: unknown, actor: string) {
    const value = policyInput.parse(input);
    for (const domain of value.blocked_domains)
      if (!/^(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/.*)?$/.test(domain))
        throw new ApiError(400, 'INVALID_DOMAIN', '请填写有效的域名');
    await this.ctx.db.transaction(async (tx) => {
      const initial = (await tx.query('SELECT executor_account_id FROM conversations WHERE id=$1', [id]))[0];
      if (!initial) throw new ApiError(404, 'NOT_FOUND', '群不存在');
      // Match event ingestion and account refresh lock ordering: account before group.
      const account = (
        await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [initial.executor_account_id])
      )[0]!;
      const group = (await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [id]))[0]!;
      if (group.executor_account_id !== account.id)
        throw new ApiError(409, 'EXECUTOR_CHANGED', '执行账号已变化，请刷新后保存规则');
      const binding = (
        await tx.query('SELECT snapshot FROM bindings WHERE conversation_id=$1 AND account_id=$2 FOR SHARE', [
          id,
          account.id,
        ])
      )[0];
      const options = policyAvailability(group, account, binding?.snapshot);
      if (
        (value.verification_failed_action === 'mute' || value.verification_timeout_action === 'mute_retry') &&
        (account.kind !== 'qq' || (value.verification_enabled && !options.verification_mute!.available))
      )
        throw new ApiError(
          409,
          'VERIFICATION_MUTE_UNAVAILABLE',
          account.kind !== 'qq'
            ? '答错自动禁言仅接入 QQ 群'
            : `无法自动禁言：${options.verification_mute!.reason}`,
        );
      if (
        value.verification_timeout_action === 'remove' &&
        (account.kind !== 'qq' || (value.verification_enabled && !options.verification_remove!.available))
      )
        throw new ApiError(
          409,
          'VERIFICATION_TIMEOUT_UNAVAILABLE',
          account.kind !== 'qq'
            ? '自动移出超时成员仅接入 QQ 群'
            : `无法自动移出超时成员：${options.verification_remove!.reason}`,
        );
      const action =
        value.mode === 'enforce' && !options[value.action]!.available
          ? value.action
          : value.verification_enabled && !options.verification!.available
            ? 'verification'
            : null;
      if (action)
        throw new ApiError(
          409,
          'POLICY_ACTION_UNAVAILABLE',
          `无法启用${action === 'verification' ? '成员验证' : '自动处理'}：${options[action]!.reason}`,
        );
      await tx.query('UPDATE conversations SET policy=$2::jsonb,policy_version=$3 WHERE id=$1', [
        id,
        json(value),
        randomUUID(),
      ]);
      if (
        account.kind === 'qq' &&
        (value.verification_enabled !== group.policy.verification_enabled ||
          value.verification_timeout !== group.policy.verification_timeout ||
          (value.verification_timeout_action ?? 'manual') !==
            (group.policy.verification_timeout_action ?? 'manual') ||
          (value.verification_failed_action ?? 'manual') !==
            (group.policy.verification_failed_action ?? 'manual'))
      ) {
        await tx.query('UPDATE conversations SET management_settings=$2::jsonb WHERE id=$1', [
          id,
          json({
            ...group.management_settings,
            qq_verification_revision: randomUUID(),
            qq_verification_enabled_at:
              value.verification_enabled && !group.policy.verification_enabled
                ? Math.floor(Date.now() / 1000)
                : (group.management_settings.qq_verification_enabled_at ?? null),
          }),
        ]);
        await tx.query(
          "UPDATE jobs SET status='cancelled',last_error='验证规则已变化，停止旧验证任务',updated_at=now() WHERE conversation_id=$1 AND status='pending' AND review_ref->>'purpose' LIKE 'qq-verification-%'",
          [id],
        );
        await tx.query(
          `UPDATE verifications v SET status=CASE WHEN EXISTS(SELECT 1 FROM jobs j WHERE (j.id=v.timeout_job_id OR j.id=v.failure_job_id) AND j.status IN ('in_flight','accepted','unknown','succeeded')) THEN 'manual_review' ELSE 'cancelled' END,
          retry_after=NULL,detail_reason='验证规则已变化，旧验证和自动重试已停止；已执行或待核对的任务保留原始回执'
          WHERE conversation_id=$1 AND qq_context IS NOT NULL AND status IN ('pending','failed','expired','manual_review','cooldown')`,
          [id],
        );
      }
      await audit(tx, actor, 'policy.updated', id, { mode: value.mode });
    });
    return { saved: true };
  }
  async send(principal: Principal, input: unknown, key: string) {
    const value = sendInput.parse(input);
    const ids = [...new Set(value.conversation_ids)].sort();
    this.auth.authorize(principal, 'messages.send', ids);
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key))
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 位 Idempotency-Key');
    const requestKey = `request:${principal.id}:${key}`;
    if (value.reply_to_message_id && ids.length !== 1)
      throw new ApiError(400, 'REPLY_TARGET_REQUIRED', '引用回复只能选择一个目标群');
    const requestHash = fingerprint({
      ids,
      text: value.text,
      ...(value.reply_to_message_id ? { reply_to_message_id: value.reply_to_message_id } : {}),
    });
    return this.ctx.db.transaction(async (tx) => {
      const inserted = await tx.query(
        'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key',
        [requestKey, json({ hash: requestHash })],
      );
      if (!inserted.length) {
        const previous = (
          await tx.query('SELECT value FROM metadata WHERE key=$1 FOR UPDATE', [requestKey])
        )[0]!.value;
        if (previous.hash !== requestHash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一请求键不能更换消息或目标群');
        return previous.response;
      }
      const reply = value.reply_to_message_id
        ? (
            await tx.query('SELECT * FROM messages WHERE id=$1 AND conversation_id=$2 AND deleted=false', [
              value.reply_to_message_id,
              ids[0],
            ])
          )[0]
        : undefined;
      if (value.reply_to_message_id && !reply)
        throw new ApiError(409, 'REPLY_UNAVAILABLE', '原消息已删除或不属于当前群，请取消引用后重试');
      const deliveries: string[] = [];
      for (const id of ids)
        deliveries.push(
          (
            await this.jobs.enqueue(
              {
                key: `${requestKey}:${id}`,
                conversationId: id,
                action: 'message.send',
                params: {
                  segments: [{ type: 'text', text: value.text }],
                  ...(reply
                    ? {
                        reply_to: reply.external_id,
                        ...(reply.thread_id ? { thread_id: reply.thread_id } : {}),
                      }
                    : {}),
                },
                ...(reply ? { reviewRef: { purpose: 'reply', message_record_id: reply.id } } : {}),
                ownerId: principal.kind === 'project' ? principal.id : 'admin',
              },
              tx,
            )
          ).id,
        );
      const response = { delivery_ids: deliveries };
      await tx.query('UPDATE metadata SET value=$2::jsonb WHERE key=$1', [
        requestKey,
        json({ hash: requestHash, response }),
      ]);
      await audit(tx, principal.name, 'message.queued', deliveries.join(','), { targets: ids.length });
      return response;
    });
  }
  async announcements() {
    return this.ctx.db
      .query(`SELECT a.*,(SELECT jsonb_agg(jsonb_build_object('id',j.id,'name',c.name,'conversation_id',c.id,'platform',c.platform,'status',j.status,'is_demo',c.is_demo,'last_error',j.last_error))
      FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.announcement_id=a.id) AS deliveries FROM announcements a ORDER BY a.created_at DESC LIMIT 100`);
  }
  async createAnnouncement(input: unknown, actor: string, requestId?: string) {
    const value = announcementInput.parse(input);
    if (requestId && !/^[A-Za-z0-9_.:-]{8,128}$/.test(requestId))
      throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', '群发请求键格式不正确');
    const requestKey = requestId ? `announcement:${actor}:${requestId}` : null;
    const requestHash = fingerprint({
      ...value,
      conversation_ids: [...new Set(value.conversation_ids)].sort(),
    });
    const id = randomUUID();
    const due = value.scheduled_at ?? new Date().toISOString();
    return this.ctx.db.transaction(async (tx) => {
      if (requestKey) {
        const inserted = await tx.query(
          'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key',
          [requestKey, json({ hash: requestHash, id })],
        );
        if (!inserted.length) {
          const previous = (
            await tx.query('SELECT value FROM metadata WHERE key=$1 FOR UPDATE', [requestKey])
          )[0]!.value;
          if (previous.hash !== requestHash)
            throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一群发请求键不能更换内容或目标群');
          return { id: previous.id as string };
        }
      }
      const targets = await tx.query(
        'SELECT a.id,a.kind,a.settings FROM conversations c JOIN accounts a ON a.id=c.executor_account_id WHERE c.id=ANY($1::text[])',
        [[...new Set(value.conversation_ids)]],
      );
      if (targets.length !== new Set(value.conversation_ids).size)
        throw new ApiError(404, 'CONVERSATION_NOT_FOUND', '目标群不存在');
      if (
        targets.some(
          (a) =>
            (a.kind === 'telegram' && value.content.length > (value.image_asset_id ? 1024 : 4096)) ||
            (a.kind === 'binance' && value.content.length > 2000),
        )
      )
        throw new ApiError(
          400,
          'CONTENT_TOO_LONG',
          '内容超过目标平台单条限制：Telegram 文字 4096、图片说明 1024，币安 2000 字符',
        );
      if (value.image_asset_id) {
        await this.ctx.uploads.get(value.image_asset_id, tx);
        for (const target of targets) {
          if (!['telegram', 'qq', 'binance', 'demo'].includes(target.kind))
            throw new ApiError(400, 'MEDIA_UNSUPPORTED', '图片群发当前支持 Telegram、QQ、币安及演示群');
          if (target.kind === 'binance') this.ctx.adapters.binance!.requireVersion(target, 1, 8);
        }
      }
      if (epoch(due) < Date.now() - 60_000)
        throw new ApiError(400, 'INVALID_SCHEDULE', '发送时间不能早于当前时间');
      await tx.query(
        'INSERT INTO announcements(id,title,content,targets,scheduled_at,image_asset_id) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
        [
          id,
          value.title,
          value.content,
          json([...new Set(value.conversation_ids)]),
          due,
          value.image_asset_id ?? null,
        ],
      );
      for (const target of new Set(value.conversation_ids))
        await this.jobs.enqueue(
          {
            key: `announcement:${id}:${target}`,
            conversationId: target,
            action: 'message.send',
            params: {
              segments: [
                ...(value.content ? [{ type: 'text', text: value.content }] : []),
                ...(value.image_asset_id
                  ? [{ type: 'image', asset_id: value.image_asset_id, alt: '群发图片' }]
                  : []),
              ],
            },
            announcementId: id,
            dueAt: due,
          },
          tx,
        );
      await audit(tx, actor, 'announcement.created', id, {
        title: value.title,
        targets: value.conversation_ids.length,
      });
      return { id };
    });
  }
  async cancelAnnouncement(id: string, actor: string) {
    const changed = await this.ctx.db.query(
      "UPDATE jobs SET status='cancelled',updated_at=now() WHERE announcement_id=$1 AND status='pending' RETURNING id",
      [id],
    );
    await audit(this.ctx.db, actor, 'announcement.cancelled', id, { cancelled: changed.length });
    return { cancelled: changed.length };
  }
  async deliveries(id?: string, principal?: Principal) {
    const rows = await this.ctx.db.query(
      `SELECT j.*,c.name AS conversation_name,c.platform,c.external_id AS conversation_external_id,c.is_demo FROM jobs j JOIN conversations c ON c.id=j.conversation_id
      ${id ? 'WHERE j.id=$1' : ''} ORDER BY j.created_at DESC LIMIT 100`,
      id ? [id] : [],
    );
    if (principal?.kind === 'project') {
      this.auth.authorize(
        principal,
        'deliveries.read',
        rows.map((row) => row.conversation_id),
      );
      if (rows.some((row) => row.owner_id !== principal.id))
        throw new ApiError(403, 'DELIVERY_SCOPE', '不能读取其他项目的投递记录');
    }
    if (id && !rows.length) throw new ApiError(404, 'NOT_FOUND', '投递记录不存在');
    return id
      ? {
          ...rows[0],
          attempts: await this.ctx.db.query('SELECT * FROM attempts WHERE job_id=$1 ORDER BY number', [id]),
        }
      : rows;
  }
  async blacklists() {
    return this.ctx.db.query(
      'SELECT b.*,c.name AS conversation_name FROM blacklists b JOIN conversations c ON c.id=b.conversation_id ORDER BY b.created_at DESC',
    );
  }
  async blacklist(input: unknown, actor: string) {
    const value = blacklistInput.parse(input);
    await this.group(value.conversation_id);
    await this.ctx.db.query(
      `INSERT INTO blacklists(id,conversation_id,user_id,reason,expires_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET reason=EXCLUDED.reason,expires_at=EXCLUDED.expires_at`,
      [randomUUID(), value.conversation_id, value.user_id, value.reason, value.expires_at ?? null],
    );
    await audit(this.ctx.db, actor, 'blacklist.added', value.conversation_id, {
      user_id: value.user_id,
      reason: value.reason,
    });
    return { saved: true };
  }
  async removeBlacklist(id: string, actor: string) {
    await this.ctx.db.query('DELETE FROM blacklists WHERE id=$1', [id]);
    await audit(this.ctx.db, actor, 'blacklist.removed', id);
    return { removed: true };
  }
  async approveVerification(id: string, actor: string) {
    const qq = (await this.ctx.db.query('SELECT qq_context FROM verifications WHERE id=$1', [id]))[0];
    if (qq?.qq_context) return this.qqVerification.approve(id, actor);
    await this.ctx.db.transaction(async (tx) => {
      const v = (await tx.query('SELECT * FROM verifications WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!v) throw new ApiError(404, 'NOT_FOUND', '验证记录不存在');
      const latest = (
        await tx.query(
          'SELECT id FROM verifications WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1',
          [v.conversation_id, v.user_id],
        )
      )[0];
      if (latest?.id !== id || !['pending', 'expired', 'failed'].includes(v.status))
        throw new ApiError(409, 'STALE_VERIFICATION', '此记录已不属于成员当前的验证批次');
      await tx.query("UPDATE verifications SET status='passed' WHERE id=$1", [id]);
      await audit(tx, actor, 'verification.approved', v.conversation_id, { verification_id: id });
    });
    return { approved: true };
  }
  async projects() {
    return this.ctx.db.query(
      'SELECT id,name,prefix,conversation_ids,scopes,revoked_at,last_used_at,created_at FROM projects ORDER BY created_at DESC',
    );
  }
  async createProject(input: unknown, actor: string) {
    const value = projectInput.parse(input);
    for (const id of value.conversation_ids) await this.group(id);
    const raw = `qsb_${token()}`;
    const id = randomUUID();
    await this.ctx.db.query(
      'INSERT INTO projects(id,name,token_hash,prefix,conversation_ids,scopes) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [id, value.name, sha(raw), raw.slice(0, 12), json(value.conversation_ids), json(value.scopes)],
    );
    await audit(this.ctx.db, actor, 'project.created', id, { name: value.name });
    return { id, key: raw };
  }
  async revokeProject(id: string, actor: string) {
    await this.ctx.db.transaction(async (tx) => {
      await tx.query('UPDATE projects SET revoked_at=now() WHERE id=$1', [id]);
      await tx.query(
        "UPDATE jobs SET status='cancelled',updated_at=now() WHERE owner_id=$1 AND status='pending'",
        [id],
      );
      await audit(tx, actor, 'project.revoked', id);
    });
    return { revoked: true };
  }
  async routes() {
    return this.ctx.db.query(
      'SELECT r.*,s.name AS source_name,t.name AS target_name FROM routes r JOIN conversations s ON s.id=r.source_id JOIN conversations t ON t.id=r.target_id ORDER BY r.created_at DESC',
    );
  }
  async saveRoute(input: unknown, actor: string) {
    const value = routeInput.parse(input);
    await this.group(value.source_id);
    await this.group(value.target_id);
    await this.ctx.db.query(
      'INSERT INTO routes(id,source_id,target_id,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,target_id) DO UPDATE SET enabled=EXCLUDED.enabled',
      [randomUUID(), value.source_id, value.target_id, value.enabled],
    );
    await audit(this.ctx.db, actor, 'route.updated', value.source_id, {
      target_id: value.target_id,
      enabled: value.enabled,
    });
    return { saved: true };
  }
  async deleteRoute(id: string, actor: string) {
    await this.ctx.db.query('DELETE FROM routes WHERE id=$1', [id]);
    await audit(this.ctx.db, actor, 'route.removed', id);
    return { removed: true };
  }
  async lotteries() {
    return this.ctx.db
      .query(`SELECT l.*,c.name AS conversation_name,(SELECT count(*)::int FROM lottery_entries e WHERE e.lottery_id=l.id) AS entries_count
    FROM lotteries l JOIN conversations c ON c.id=l.conversation_id ORDER BY l.created_at DESC`);
  }
  async createLottery(input: unknown, actor: string) {
    const value = lotteryInput.parse(input);
    const group = await this.group(value.conversation_id);
    if (epoch(value.closes_at) <= Date.now())
      throw new ApiError(400, 'INVALID_DEADLINE', '报名截止时间必须在未来');
    const id = randomUUID();
    await this.ctx.db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO lotteries(id,conversation_id,title,winners_count,closes_at) VALUES($1,$2,$3,$4,$5)',
        [id, group.id, value.title, value.winners_count, value.closes_at],
      );
      await this.jobs.enqueue(
        {
          key: `lottery:${id}:open`,
          conversationId: group.id,
          action: 'message.send',
          params: {
            segments: [
              {
                type: 'text',
                text: `🎉 ${value.title}\n中奖名额：${value.winners_count}\n回复 /join ${id} 报名。\n截止：${new Date(value.closes_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）`,
              },
            ],
          },
        },
        tx,
      );
      await audit(tx, actor, 'lottery.created', id, { title: value.title });
    });
    return { id };
  }
  async drawLottery(id: string, actor: string) {
    return this.ctx.db.transaction(async (tx) => {
      const lottery = (await tx.query('SELECT * FROM lotteries WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!lottery) throw new ApiError(404, 'NOT_FOUND', '抽奖不存在');
      if (lottery.status === 'drawn') return { winners: lottery.winners, duplicate: true };
      if (epoch(lottery.closes_at) > Date.now()) throw new ApiError(409, 'LOTTERY_NOT_DUE', '报名尚未截止');
      const group = (
        await tx.query('SELECT * FROM conversations WHERE id=$1', [lottery.conversation_id])
      )[0]!;
      const entries = await tx.query(
        `SELECT e.user_id FROM lottery_entries e WHERE e.lottery_id=$1
        AND NOT EXISTS(SELECT 1 FROM blacklists b WHERE b.conversation_id=$2 AND b.user_id=e.user_id AND (b.expires_at IS NULL OR b.expires_at>now()))
        AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.conversation_id=$2 AND m.user_id=e.user_id AND m.status='left')
        AND ($3=false OR COALESCE((SELECT CASE WHEN $4::boolean AND (v.qq_context IS NULL OR v.status IN ('left','superseded','cancelled','removed')) THEN true ELSE v.status='passed' END
          FROM verifications v WHERE v.conversation_id=$2 AND v.user_id=e.user_id AND ($4::boolean=false OR v.membership_id=(SELECT m.membership_id FROM memberships m WHERE m.conversation_id=$2 AND m.user_id=e.user_id AND m.status='active'))
          ORDER BY v.created_at DESC,v.id DESC LIMIT 1),$4::boolean)) ORDER BY e.user_id`,
        [id, group.id, group.policy.verification_enabled, group.platform === 'qq'],
      );
      const candidates = entries.map((item) => item.user_id as string);
      const pool = [...candidates];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      const winners = pool.slice(0, lottery.winners_count);
      await tx.query(
        "UPDATE lotteries SET status='drawn',entrants_snapshot=$2::jsonb,winners=$3::jsonb,drawn_at=now() WHERE id=$1",
        [id, json(candidates), json(winners)],
      );
      await this.jobs.enqueue(
        {
          key: `lottery:${id}:result`,
          conversationId: group.id,
          action: 'message.send',
          params: {
            segments: [
              {
                type: 'text',
                text: `🎉 ${lottery.title} 开奖结果\n${winners.length ? winners.map((user, i) => `${i + 1}. ${user}`).join('\n') : '本次没有符合条件的报名成员。'}\n请联系管理员领取奖品。`,
              },
            ],
          },
        },
        tx,
      );
      await audit(tx, actor, 'lottery.drawn', id, { candidates: candidates.length, winners });
      return { winners, duplicate: false };
    });
  }
}
