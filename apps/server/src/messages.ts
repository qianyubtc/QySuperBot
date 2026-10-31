import { randomInt, randomUUID } from 'node:crypto';
import {
  connectorEventSchema,
  fingerprint,
  startTrace,
  syncDeliveryKey,
  nextSyncTrace,
} from '../../../packages/contracts/src/index.ts';
import type { ConnectorEvent } from '../../../packages/contracts/src/index.ts';
import type { Context } from './context.ts';
import { audit, epoch, iso, json } from './context.ts';
import type { Row, Sql } from './database.ts';
import { JobsService } from './jobs.ts';
import { ApiError, equal, sha } from './security.ts';
import { evaluateText } from './policy.ts';
import { groupEnabled } from './scope.ts';
import { normalizePresentation, type Presentation } from './presentation.ts';
import { QQVerification, qqVerificationRequired } from './qq-verification.ts';
import { KeywordRules, keywordText } from './keyword-rules.ts';

export class MessagesService {
  ctx: Context;
  jobs: JobsService;
  constructor(
    ctx: Context,
    jobs: JobsService,
    readonly qqVerification = new QQVerification(ctx, jobs),
  ) {
    this.ctx = ctx;
    this.jobs = jobs;
  }
  async enrich(
    account: Row,
    groupId: string,
    messageId: string,
    senderName?: string,
    presentation?: Presentation,
  ) {
    const display = normalizePresentation(presentation);
    if (!senderName?.trim() && !display.avatar_url) return;
    await this.ctx.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR SHARE', [account.id]))[0];
      if (
        !current ||
        current.status !== 'online' ||
        current.session_id !== account.session_id ||
        (current.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0') ||
        !groupEnabled(current, groupId)
      )
        return;
      const row = (
        await tx.query(
          'SELECT m.sender_id,m.conversation_id FROM messages m JOIN bindings b ON b.account_id=m.account_id AND b.conversation_id=m.conversation_id WHERE m.account_id=$1 AND b.external_id=$2 AND m.external_id=$3 AND m.deleted=false',
          [account.id, groupId, messageId],
        )
      )[0];
      if (!row) return;
      await tx.query(
        'UPDATE messages SET sender_name=COALESCE($4,sender_name),sender_avatar=COALESCE($5,sender_avatar) WHERE account_id=$1 AND conversation_id=$2 AND sender_id=$3 AND deleted=false',
        [
          account.id,
          row.conversation_id,
          row.sender_id,
          senderName?.trim().slice(0, 1024) || null,
          display.avatar_url ?? null,
        ],
      );
    });
  }
  async ingest(
    account: Row,
    input: unknown,
    senderName?: string,
    historical = false,
    presentation?: Presentation,
  ) {
    const event = connectorEventSchema.parse(input);
    if (event.source.connector_id !== account.id || event.source.account_id !== account.id)
      throw new ApiError(403, 'EVENT_SCOPE', '事件账号不在凭据范围内');
    return this.ctx.db.transaction(async (tx) => {
      // Authentication/polling can finish after an administrator pauses the account.
      // Lock the current state with the event transaction before creating any business work.
      const current = (
        await tx.query('SELECT settings,session_id,status FROM accounts WHERE id=$1 FOR SHARE', [account.id])
      )[0];
      if (
        !current ||
        current.status === 'paused' ||
        !groupEnabled({ ...current, kind: account.kind }, event.source.conversation_id) ||
        (['qq', 'telegram'].includes(account.kind) &&
          (current.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0')) ||
        (account.kind === 'binance' &&
          (current.session_id !== account.session_id ||
            current.status !== 'online' ||
            (current.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0') ||
            !(current.settings.group_ids ?? []).includes(event.source.conversation_id)))
      )
        return { event_id: event.event_id, duplicate: false, ignored: true };
      const binding = (
        await tx.query('SELECT conversation_id FROM bindings WHERE account_id=$1 AND external_id=$2', [
          account.id,
          event.source.conversation_id,
        ])
      )[0];
      if (!binding) throw new ApiError(403, 'UNREGISTERED_CONVERSATION', '请先发现并登记此群');
      const group = (
        await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [binding.conversation_id])
      )[0]!;
      if (event.type === 'message.created' || event.type === 'message.edited') {
        const display = normalizePresentation(presentation);
        if (senderName?.trim() || display.avatar_url)
          await tx.query(
            'UPDATE messages SET sender_name=COALESCE($4,sender_name),sender_avatar=COALESCE($5,sender_avatar) WHERE account_id=$1 AND conversation_id=$2 AND sender_id=$3 AND deleted=false',
            [
              account.id,
              group.id,
              event.data.sender_id,
              senderName?.trim().slice(0, 1024) || null,
              display.avatar_url ?? null,
            ],
          );
        // Profile enrichment never changes moderation decisions or replays business actions.
        await tx.query(
          `UPDATE messages SET sender_name=COALESCE($4,sender_name),sender_avatar=COALESCE($5,sender_avatar),media=CASE WHEN media->0->>'provider'='upload' THEN media WHEN jsonb_array_length($6::jsonb)>0 THEN $6::jsonb ELSE media END
          WHERE account_id=$1 AND conversation_id=$2 AND external_id=$3 AND deleted=false`,
          [
            account.id,
            group.id,
            event.data.message_id,
            senderName?.trim().slice(0, 1024) || null,
            display.avatar_url ?? null,
            json(display.images),
          ],
        );
      }
      const payloadHash = fingerprint(event);
      const inserted = await tx.query(
        'INSERT INTO inbox(id,account_id,event_id,fingerprint,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(account_id,event_id) DO NOTHING RETURNING id',
        [randomUUID(), account.id, event.event_id, payloadHash, json(event)],
      );
      if (!inserted.length) {
        const previous = (
          await tx.query('SELECT fingerprint FROM inbox WHERE account_id=$1 AND event_id=$2', [
            account.id,
            event.event_id,
          ])
        )[0]!;
        if (previous.fingerprint !== payloadHash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '事件 ID 已经用于另一份载荷');
        return { event_id: event.event_id, duplicate: true };
      }
      // Until a trusted canonical event mapping exists, auxiliary observers never execute group business.
      if (group.executor_account_id !== account.id)
        return { event_id: event.event_id, duplicate: false, observer_only: true };
      if (event.type === 'member.joined') {
        const oldMembership = (
          await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
            group.id,
            event.data.user_id,
          ])
        )[0];
        if (oldMembership && epoch(oldMembership.source_at) >= epoch(event.occurred_at))
          return { event_id: event.event_id, duplicate: false, stale: true };
        await tx.query(
          `INSERT INTO memberships(conversation_id,user_id,membership_id,status,source_at) VALUES($1,$2,$3,'active',$4)
          ON CONFLICT(conversation_id,user_id) DO UPDATE SET membership_id=EXCLUDED.membership_id,status='active',source_at=EXCLUDED.source_at`,
          [group.id, event.data.user_id, event.data.membership_id, event.occurred_at],
        );
        await tx.query(
          "UPDATE verifications SET status='superseded',retry_after=NULL WHERE conversation_id=$1 AND user_id=$2 AND (status IN ('pending','passed','expired','failed') OR (qq_context IS NOT NULL AND status NOT IN ('left','superseded','removed')))",
          [group.id, event.data.user_id],
        );
        if (group.policy.verification_enabled)
          await this.createVerification(tx, group, account, event.data.user_id, event.data.membership_id);
      } else if (event.type === 'member.left') {
        const previous = (
          await tx.query('SELECT * FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
            group.id,
            event.data.user_id,
          ])
        )[0];
        if (
          previous &&
          ((event.data.membership_id !== 'unknown' && event.data.membership_id !== previous.membership_id) ||
            epoch(previous.source_at) > epoch(event.occurred_at))
        )
          return { event_id: event.event_id, duplicate: false, stale: true };
        const changed = await tx.query(
          `INSERT INTO memberships(conversation_id,user_id,membership_id,status,source_at) VALUES($1,$2,$3,'left',$4)
          ON CONFLICT(conversation_id,user_id) DO UPDATE SET status='left',source_at=EXCLUDED.source_at RETURNING user_id`,
          [
            group.id,
            event.data.user_id,
            previous?.membership_id ?? event.data.membership_id,
            event.occurred_at,
          ],
        );
        if (changed.length)
          await tx.query(
            "UPDATE verifications SET status='left',retry_after=NULL WHERE conversation_id=$1 AND user_id=$2 AND (status IN ('pending','passed','expired','failed') OR (qq_context IS NOT NULL AND status NOT IN ('left','superseded','removed')))",
            [group.id, event.data.user_id],
          );
      } else if (event.type === 'interaction.created') {
        if (event.data.value.startsWith('v:')) {
          const [, id, code] = event.data.value.split(':');
          if (id && code) await this.verify(tx, group.id, event.data.user_id, code, id);
        } else if (event.data.value.startsWith('l:'))
          await this.joinLottery(tx, group, event.data.user_id, event.data.value.slice(2));
      } else if (event.type === 'message.deleted') {
        await tx.query(
          `INSERT INTO message_tombstones(account_id,conversation_id,external_id,source_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(account_id,conversation_id,external_id) DO NOTHING`,
          [account.id, group.id, event.data.message_id, event.occurred_at],
        );
        await tx.query(
          'UPDATE messages SET deleted=true,content_version=content_version+1 WHERE account_id=$1 AND external_id=$2 AND conversation_id=$3',
          [account.id, event.data.message_id, group.id],
        );
      } else if (event.type === 'message.created' || event.type === 'message.edited') {
        await this.message(tx, account, group, event, senderName, historical);
        const display = normalizePresentation(presentation);
        await tx.query(
          `UPDATE messages SET sender_avatar=COALESCE($4,sender_avatar),media=CASE WHEN media->0->>'provider'='upload' THEN media WHEN jsonb_array_length($5::jsonb)>0 THEN $5::jsonb ELSE media END WHERE account_id=$1 AND conversation_id=$2 AND external_id=$3 AND deleted=false`,
          [account.id, group.id, event.data.message_id, display.avatar_url ?? null, json(display.images)],
        );
      }
      await tx.query('UPDATE accounts SET last_seen_at=now() WHERE id=$1', [account.id]);
      return { event_id: event.event_id, duplicate: false };
    });
  }
  private async message(
    tx: Sql,
    account: Row,
    group: Row,
    event: Extract<ConnectorEvent, { type: 'message.created' | 'message.edited' }>,
    senderName?: string,
    historical = false,
  ) {
    const data = event.data;
    const content = data.segments
      .map((part) =>
        part.type === 'text'
          ? part.text
          : account.kind === 'qq' && part.type === 'mention'
            ? '[at]'
            : `[${part.type}]`,
      )
      .join('');
    const previous = (
      await tx.query(
        'SELECT * FROM messages WHERE account_id=$1 AND external_id=$2 AND conversation_id=$3 FOR UPDATE',
        [account.id, data.message_id, group.id],
      )
    )[0];
    const tombstone = (
      await tx.query(
        'SELECT external_id FROM message_tombstones WHERE account_id=$1 AND conversation_id=$2 AND external_id=$3',
        [account.id, group.id, data.message_id],
      )
    )[0];
    if (previous?.deleted || tombstone) return;
    if (event.type === 'message.created' && previous) return;
    if (previous?.direction === 'outgoing') return;
    const contentHash = fingerprint(data.segments);
    if (
      previous &&
      event.type === 'message.edited' &&
      epoch(event.occurred_at) <= epoch(previous.source_at)
    ) {
      if (epoch(event.occurred_at) === epoch(previous.source_at) && previous.fingerprint !== contentHash) {
        await tx.query(
          "UPDATE messages SET verdict='pending',reason='编辑顺序无法确认，需要核对',content_version=content_version+1 WHERE id=$1",
          [previous.id],
        );
      }
      return;
    }
    if (historical) {
      await tx.query(
        `INSERT INTO messages(id,conversation_id,account_id,external_id,sender_id,sender_name,content,segments,direction,verdict,reason,fingerprint,source_at,reply_to,thread_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'historical','首次接入的历史快照，不执行群管理或同步',$10,$11,$12,$13,$11) ON CONFLICT(account_id,conversation_id,external_id) DO NOTHING`,
        [
          randomUUID(),
          group.id,
          account.id,
          data.message_id,
          data.sender_id,
          senderName || data.sender_id,
          content,
          json(data.segments),
          data.direction,
          contentHash,
          event.occurred_at,
          data.reply_to ?? null,
          data.thread_id ?? null,
        ],
      );
      return;
    }
    if (data.direction === 'incoming' && event.type === 'message.created') {
      if (account.kind === 'qq')
        await this.qqVerification.answer(
          tx,
          group,
          data.sender_id,
          data.segments
            .map((part) =>
              part.type === 'text' ? part.text : part.type === 'mention' ? '' : `[${part.type}]`,
            )
            .join(''),
          data.reply_to,
          data.segments.some((part) => part.type === 'mention' && part.user_id === account.external_id),
        );
      const code = content.trim().match(/^(?:\/verify\s+)?(\d{6})$/)?.[1];
      if (code && account.kind !== 'qq') await this.verify(tx, group.id, data.sender_id, code);
      const lottery = content.trim().match(/^\/join\s+([a-f0-9-]{36})$/)?.[1];
      if (lottery) await this.joinLottery(tx, group, data.sender_id, lottery);
    }
    let verification = (
      await tx.query(
        `SELECT * FROM verifications WHERE conversation_id=$1 AND user_id=$2 AND ($3::boolean=false OR membership_id=(SELECT membership_id FROM memberships WHERE conversation_id=$1 AND user_id=$2 AND status='active')) ORDER BY created_at DESC,id DESC LIMIT 1`,
        [group.id, data.sender_id, account.kind === 'qq'],
      )
    )[0];
    if (
      data.direction === 'incoming' &&
      account.kind !== 'qq' &&
      group.policy.verification_enabled &&
      (!verification || ['left', 'superseded'].includes(verification.status))
    ) {
      await this.createVerification(tx, group, account, data.sender_id, `observed-${event.event_id}`);
      verification = (
        await tx.query(
          'SELECT * FROM verifications WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1',
          [group.id, data.sender_id],
        )
      )[0];
    }
    const blacklisted =
      (
        await tx.query(
          'SELECT id FROM blacklists WHERE conversation_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())',
          [group.id, data.sender_id],
        )
      ).length > 0;
    const matched = evaluateText(group.policy, content);
    let verdict = 'allowed';
    let reason: string | null = null;
    if (data.direction === 'outgoing') verdict = 'official';
    else if (blacklisted) {
      verdict = 'blocked';
      reason = '群黑名单';
    } else if (
      group.policy.verification_enabled &&
      verification?.status !== 'passed' &&
      (account.kind !== 'qq' || qqVerificationRequired(verification))
    ) {
      verdict = 'pending';
      reason = '成员尚未完成验证';
    } else if (matched) {
      verdict = group.policy.mode === 'enforce' ? 'blocked' : 'observed';
      reason = matched;
    }
    const id = previous?.id ?? randomUUID();
    const version = (previous?.content_version ?? 0) + 1;
    if (previous)
      await tx.query(
        `UPDATE messages SET content=$2,segments=$3::jsonb,verdict=$4,reason=$5,content_version=$6,fingerprint=$7,source_at=$8,reply_to=COALESCE($9,reply_to),thread_id=COALESCE($10,thread_id) WHERE id=$1`,
        [
          id,
          content,
          json(data.segments),
          verdict,
          reason,
          version,
          contentHash,
          event.occurred_at,
          data.reply_to ?? null,
          data.thread_id ?? null,
        ],
      );
    else
      await tx.query(
        `INSERT INTO messages(id,conversation_id,account_id,external_id,sender_id,sender_name,content,segments,direction,verdict,reason,fingerprint,source_at,reply_to,thread_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          group.id,
          account.id,
          data.message_id,
          data.sender_id,
          senderName || data.sender_id,
          content,
          json(data.segments),
          data.direction,
          verdict,
          reason,
          contentHash,
          event.occurred_at,
          data.reply_to ?? null,
          data.thread_id ?? null,
        ],
      );
    if (data.direction === 'outgoing') return;
    const reviewRef = {
      message_record_id: id,
      content_version: version,
      fingerprint: contentHash,
      policy_version: group.policy_version,
      decision_id: randomUUID(),
    };
    if (
      (verdict === 'blocked' || verdict === 'pending') &&
      (group.policy.mode === 'enforce' || blacklisted)
    ) {
      const memberAction = group.policy.action !== 'delete' && verdict === 'blocked';
      const membership = (
        await tx.query('SELECT membership_id FROM memberships WHERE conversation_id=$1 AND user_id=$2', [
          group.id,
          data.sender_id,
        ])
      )[0];
      const deletion = await this.jobs.enqueue(
        {
          key: `moderation:${id}:${version}`,
          conversationId: group.id,
          action: 'message.delete',
          params: { message_id: data.message_id, reason: reason! },
          reviewRef: { ...reviewRef, purpose: 'moderation', membership_id: membership?.membership_id },
        },
        tx,
      );
      if (memberAction)
        await this.jobs.enqueue(
          {
            key: `moderation:${id}:${version}:member`,
            conversationId: group.id,
            action: group.policy.action === 'ban' ? 'member.ban' : 'member.remove',
            params: { user_id: data.sender_id, reason: reason! },
            reviewRef: {
              ...reviewRef,
              purpose: 'moderation',
              membership_id: membership?.membership_id,
              deletion_job_id: deletion.id,
            },
          },
          tx,
        );
      await audit(tx, '规则引擎', 'moderation.matched', group.id, { message_id: id, reason, verdict });
    }
    if (!['allowed', 'observed'].includes(verdict) || event.type !== 'message.created') return;
    // Historical import, edits, bot echoes, and relayed messages never replay triggers.
    if (
      !event.trace &&
      epoch(event.occurred_at) >= Date.now() - 120000 &&
      epoch(event.occurred_at) <= Date.now() + 10000
    ) {
      const trigger = await new KeywordRules(this.ctx, this.jobs).match(tx, group, account, {
        id,
        external_id: data.message_id,
        sender_id: data.sender_id,
        content: keywordText(data.segments),
        content_version: version,
        fingerprint: contentHash,
        direction: data.direction,
        thread_id: data.thread_id,
      });
      if (trigger?.blocksSync) return;
    }
    const routes = await tx.query(
      'SELECT r.*,c.policy,c.policy_version FROM routes r JOIN conversations c ON c.id=r.target_id WHERE r.source_id=$1 AND r.enabled=true',
      [group.id],
    );
    const trace = event.trace ?? startTrace(group.id, event.event_id);
    // The first version deliberately forwards only one hop, including on connector echoes.
    if (trace.origin.logical_conversation_id !== group.id) return;
    for (const route of routes) {
      const nextTrace = nextSyncTrace(trace, route.target_id);
      if (!nextTrace) continue;
      const text = `【${group.name} · ${senderName || data.sender_id}】\n${content}`;
      if (route.policy.mode === 'enforce' && evaluateText(route.policy, text)) continue;
      await this.jobs.enqueue(
        {
          key: `sync:${syncDeliveryKey(trace.trace_id, route.target_id)}`,
          conversationId: route.target_id,
          action: 'message.send',
          params: { segments: [{ type: 'text', text }] },
          reviewRef: {
            ...reviewRef,
            purpose: 'sync',
            route_id: route.id,
            target_policy_version: route.policy_version,
          },
          trace: nextTrace,
        },
        tx,
      );
    }
  }
  private async createVerification(tx: Sql, group: Row, account: Row, userId: string, membershipId: string) {
    if (account.kind === 'qq') return this.qqVerification.create(tx, group, account, userId, membershipId);
    const id = randomUUID();
    const code = String(randomInt(100000, 1000000));
    const inserted = await tx.query(
      `INSERT INTO verifications(id,conversation_id,user_id,membership_id,token_hash,status,expires_at)
      VALUES($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT(conversation_id,user_id,membership_id) DO NOTHING RETURNING id`,
      [
        id,
        group.id,
        userId,
        membershipId,
        sha(code),
        new Date(Date.now() + group.policy.verification_timeout * 1000).toISOString(),
      ],
    );
    if (!inserted.length) return;
    const text = `欢迎加入 ${group.name}。\n用户 ${userId} 请在 ${group.policy.verification_timeout} 秒内完成验证。\n回复 /verify ${code}，或点击验证按钮。`;
    const binding = (
      await tx.query('SELECT snapshot FROM bindings WHERE account_id=$1 AND conversation_id=$2', [
        account.id,
        group.id,
      ])
    )[0];
    const buttons = binding?.snapshot.capabilities.some(
      (item: any) => item.capability === 'interactions.buttons' && item.state === 'supported',
    );
    await this.jobs.enqueue(
      {
        key: `verification:${id}`,
        conversationId: group.id,
        action: 'message.send',
        params: {
          segments: [{ type: 'text', text }],
          ...(buttons
            ? { buttons: [[{ type: 'callback', label: '完成验证', value: `v:${id}:${code}` }]] }
            : {}),
        },
        reviewRef: { purpose: 'verification', verification_id: id },
      },
      tx,
    );
  }
  private async verify(tx: Sql, groupId: string, userId: string, code: string, id?: string) {
    const current = (
      await tx.query(
        'SELECT * FROM verifications WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        [groupId, userId],
      )
    )[0];
    if (
      !current ||
      (id && current.id !== id) ||
      current.status !== 'pending' ||
      epoch(current.expires_at) <= Date.now() ||
      current.attempts >= 3
    )
      return false;
    const matched = equal(current.token_hash, sha(code));
    await tx.query('UPDATE verifications SET attempts=attempts+1,status=$2 WHERE id=$1', [
      current.id,
      matched ? 'passed' : current.attempts >= 2 ? 'failed' : 'pending',
    ]);
    if (matched)
      await audit(tx, `成员 ${userId}`, 'verification.passed', groupId, { verification_id: current.id });
    return matched;
  }
  async joinLottery(tx: Sql, group: Row, userId: string, lotteryId: string) {
    const lottery = (
      await tx.query(
        "SELECT * FROM lotteries WHERE id=$1 AND conversation_id=$2 AND status='open' AND closes_at>now() FOR UPDATE",
        [lotteryId, group.id],
      )
    )[0];
    if (!lottery) return false;
    if (
      (
        await tx.query(
          'SELECT id FROM blacklists WHERE conversation_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())',
          [group.id, userId],
        )
      ).length
    )
      return false;
    if (group.policy.verification_enabled) {
      const verification = (
        await tx.query(
          `SELECT status,qq_context FROM verifications WHERE conversation_id=$1 AND user_id=$2 AND ($3::boolean=false OR membership_id=(SELECT membership_id FROM memberships WHERE conversation_id=$1 AND user_id=$2 AND status='active')) ORDER BY created_at DESC,id DESC LIMIT 1`,
          [group.id, userId, group.platform === 'qq'],
        )
      )[0];
      if (
        verification?.status !== 'passed' &&
        (group.platform !== 'qq' || qqVerificationRequired(verification))
      )
        return false;
    }
    await tx.query('INSERT INTO lottery_entries(lottery_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      lottery.id,
      userId,
    ]);
    return true;
  }
}
