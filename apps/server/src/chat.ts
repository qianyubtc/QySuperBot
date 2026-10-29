import type { Request, Response } from 'express';
import { hasEffectiveCapability } from '../../../packages/contracts/src/index.ts';
import { AuthService } from './auth.ts';
import type { Context } from './context.ts';
import { epoch } from './context.ts';
import { ApiError, sha } from './security.ts';
import { requestImage } from './network.ts';
import { groupEnabled, groupEnabledSql } from './scope.ts';
import { z } from 'zod';
import { publicImageUrl, qqImages } from './presentation.ts';
import { binanceConnection } from './binance-health.ts';
import { qqVerificationPurposes } from './qq-verification.ts';
import { moderationJobsSql } from './governance.ts';
import { qqSucceeded } from './adapters.ts';
import type { Row } from './database.ts';

const messageFields = `m.id,m.external_id,m.sender_id,m.sender_name,m.segments,left(m.content,8000) AS content,
  length(m.content)>8000 AS content_truncated,m.direction,m.verdict,m.reason,m.deleted,m.created_at,m.source_at,
  m.reply_to,m.thread_id,q.id AS reply_record_id,q.sender_name AS reply_sender_name,
  CASE WHEN q.deleted THEN '原消息已删除' ELSE left(q.content,280) END AS reply_content,q.deleted AS reply_deleted,
  ${moderationJobsSql()} AS moderation_jobs`;

// Each snapshot is one SQL statement so messages and their delivery outcomes share a database snapshot.
export class ChatService {
  ctx: Context;
  auth: AuthService;
  streams = new Set<() => void>();
  loadImage = requestImage;
  qqImagePending = new Map<string, Promise<Awaited<ReturnType<typeof requestImage>>>>();
  qqImageCache = new Map<string, { image: Awaited<ReturnType<typeof requestImage>>; expires: number }>();
  avatarPending = new Map<string, Promise<Awaited<ReturnType<typeof requestImage>>>>();
  avatarCache = new Map<
    string,
    { expires: number; image: Awaited<ReturnType<typeof requestImage>> | null }
  >();
  constructor(ctx: Context, auth: AuthService) {
    this.ctx = ctx;
    this.auth = auth;
  }
  async snapshot(id: string) {
    const row = (
      await this.ctx.db.query(
        `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
      jsonb_build_object('id',c.id,'name',c.name,'platform',c.platform,'kind',c.kind,'is_demo',c.is_demo,
        'account_name',a.name,'account_id',a.id,'account_status',a.status,'member_count',c.member_count,
        'sync_enabled',${groupEnabledSql('a', 'c')}) AS conversation,
      a.kind AS account_kind,a.settings,a.session_id,a.status,a.last_error,a.session_expires_at,b.snapshot AS binding,
      (SELECT value FROM metadata WHERE key='binance-health:'||a.id) AS binance_health,
      (SELECT count(*)>100 FROM (SELECT 1 FROM messages WHERE conversation_id=c.id LIMIT 101) older) AS has_older,
      COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at,m.id) FROM (
        SELECT ${messageFields}
        FROM messages m LEFT JOIN messages q ON q.account_id=m.account_id AND q.conversation_id=m.conversation_id AND q.external_id=m.reply_to
        WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 100
      ) m),'[]'::jsonb) AS messages,
      COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.created_at,j.id) FROM (
        SELECT id,status,created_at,updated_at,last_error,params->>'reply_to' AS reply_to,
          COALESCE(left(params->'segments'->0->>'text',8000),'[图片]') AS content,
          params->'segments'->-1->>'asset_id' AS image_asset_id,
          status='failed' AND COALESCE((receipt->'error'->>'retryable')::boolean,false) AND expires_at>now()
          AND NOT (COALESCE(review_ref->>'purpose','')=ANY($2::text[])) AS retryable
        FROM jobs WHERE conversation_id=c.id AND action='message.send' ORDER BY created_at DESC,id DESC LIMIT 40
      ) j),'[]'::jsonb) AS deliveries,
      COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.last_at DESC NULLS LAST,g.name,g.id) FROM (
        SELECT g.id,g.external_id,g.name,g.platform,g.kind,g.is_demo,a.status AS account_status,
          m.id AS last_message_id,m.created_at AS last_at,
          CASE WHEN m.deleted THEN '消息已删除' ELSE left(m.content,100) END AS last_content,
          m.direction AS last_direction
        FROM conversations g JOIN accounts a ON a.id=g.executor_account_id
        LEFT JOIN LATERAL (SELECT id,created_at,content,direction,deleted FROM messages WHERE conversation_id=g.id ORDER BY created_at DESC,id DESC LIMIT 1) m ON true
        WHERE ${groupEnabledSql('a', 'g')}
      ) g),'[]'::jsonb) AS conversations
      FROM conversations c JOIN accounts a ON a.id=c.executor_account_id
      LEFT JOIN bindings b ON b.conversation_id=c.id AND b.account_id=c.executor_account_id WHERE c.id=$1`,
        [id, [...qqVerificationPurposes]],
      )
    )[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', '群不存在');
    const connection =
      row.account_kind === 'binance'
        ? binanceConnection(row, row.binance_health, this.ctx.config.binanceBrowserEnabled)
        : undefined;
    let sendError: string | null = null;
    if (!groupEnabled({ kind: row.account_kind, settings: row.settings }, row.binding?.conversation_id))
      sendError = '此群已取消同步，可在连接账号中重新勾选';
    else if (connection?.needs_relogin) sendError = connection.message;
    else if (
      row.conversation.account_status !== 'online' ||
      (row.account_kind === 'custom' &&
        (!row.session_expires_at || epoch(row.session_expires_at) <= Date.now()))
    )
      sendError = connection?.message ?? '连接账号未在线，请先恢复连接';
    else if (
      !row.binding ||
      (!row.conversation.is_demo && epoch(row.binding.observed_at) < Date.now() - 300_000)
    )
      sendError = '群权限信息已过期，请先刷新连接';
    else if (!hasEffectiveCapability(row.binding, 'messages.send')) {
      const permission = row.binding.permissions?.find((value: any) => value.capability === 'messages.send');
      sendError =
        permission?.permission !== 'granted' && permission?.reason
          ? permission.reason
          : '当前账号没有发送消息的能力或权限';
    }
    return {
      observed_at: row.observed_at,
      conversation: {
        ...row.conversation,
        ...(connection ? { connection } : {}),
        can_send: !sendError,
        send_error: sendError,
      },
      messages: row.messages,
      deliveries: row.deliveries,
      conversations: row.conversations,
      pagination: { has_more: row.has_older, before: row.messages[0]?.id ?? null },
    };
  }
  async history(conversationId: string, input: unknown) {
    const value = z
      .object({
        before: z.string().min(1).max(256),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(input);
    const anchor = (
      await this.ctx.db.query('SELECT id FROM messages WHERE id=$1 AND conversation_id=$2', [
        value.before,
        conversationId,
      ])
    )[0];
    if (!anchor) throw new ApiError(409, 'HISTORY_CURSOR', '历史消息位置已失效，请刷新聊天');
    const rows = await this.ctx.db.query(
      `SELECT to_jsonb(page) AS message FROM (SELECT ${messageFields}
       FROM messages m LEFT JOIN messages q ON q.account_id=m.account_id AND q.conversation_id=m.conversation_id AND q.external_id=m.reply_to
       WHERE m.conversation_id=$1 AND (m.created_at,m.id)<(SELECT created_at,id FROM messages WHERE id=$2 AND conversation_id=$1)
       ORDER BY m.created_at DESC,m.id DESC LIMIT $3) page`,
      [conversationId, value.before, value.limit + 1],
    );
    const messages = rows
      .slice(0, value.limit)
      .map((row) => row.message)
      .reverse();
    return { messages, pagination: { has_more: rows.length > value.limit, before: messages[0]?.id ?? null } };
  }
  async messageRecord(conversationId: string, messageId: string) {
    const row = (
      await this.ctx.db.query(
        'SELECT m.*,c.external_id AS group_external_id,a.kind AS account_kind FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN accounts a ON a.id=m.account_id WHERE m.id=$1 AND m.conversation_id=$2',
        [messageId, conversationId],
      )
    )[0];
    if (!row || row.deleted) throw new ApiError(404, 'IMAGE_NOT_FOUND', '消息不存在或已删除');
    const account = (await this.ctx.db.query('SELECT * FROM accounts WHERE id=$1', [row.account_id]))[0]!;
    if (account.status === 'paused' || !groupEnabled(account, row.group_external_id))
      throw new ApiError(409, 'GROUP_SYNC_DISABLED', '请先恢复账号和群同步');
    return { row, account };
  }
  async image(conversationId: string, messageId: string, index = 0) {
    z.number().int().min(0).max(99).parse(index);
    const { row, account } = await this.messageRecord(conversationId, messageId);
    if (!(
      row.content === '[图片]' ||
      row.content.includes('[image]') ||
      row.segments.some((s: any) => s.type === 'image')
    ))
      throw new ApiError(404, 'IMAGE_NOT_FOUND', '这条消息没有图片');
    let url: string | undefined;
    const storedUpload = row.media[index];
    if (storedUpload?.provider === 'upload') return this.ctx.uploads.get(storedUpload.asset_id);
    if (account.kind === 'binance' && index === 0)
      url = await this.ctx.adapters.binance!.imageUrl(account, row.group_external_id, row.external_id);
    else if (account.kind === 'telegram') {
      const media = row.media[index];
      if (media?.provider === 'telegram')
        url = await this.ctx.adapters.telegramFileUrl(account, media.file_id);
    } else if (account.kind === 'qq') {
      return this.qqImage(row, account, index);
    }
    if (!url) throw new ApiError(404, 'IMAGE_UNAVAILABLE', '图片来源不可用；旧消息可能未保存图片资料');
    return this.loadImage(url);
  }
  private async qqImage(row: Row, account: Row, index: number) {
    const media = row.media[index];
    const key = `${row.id}:${index}:${sha(JSON.stringify(media ?? null))}`;
    const now = Date.now();
    for (const [id, entry] of this.qqImageCache) if (entry.expires <= now) this.qqImageCache.delete(id);
    const cached = this.qqImageCache.get(key);
    if (cached) return cached.image;
    const pending = this.qqImagePending.get(key);
    if (pending) return pending;
    if (this.qqImagePending.size >= 16) throw new ApiError(429, 'IMAGE_BUSY', '图片正在加载，请稍后重试');
    const request = (async () => {
      const signal = AbortSignal.timeout(20_000);
      const attempted = new Set<string>();
      const load = async (candidate: unknown) => {
        const url = publicImageUrl(candidate);
        if (!url || signal.aborted || attempted.has(url)) return;
        attempted.add(url);
        try {
          return await this.loadImage(url, { signal, timeoutMs: 6000 });
        } catch {
          return;
        }
      };
      let image = media?.provider === 'qq' ? await load(media.url) : undefined;
      if (!image && !signal.aborted) {
        // Only a readback of this exact group/message/sender may supply replacement media.
        try {
          const data = await this.qqImageSource(row, account, signal);
          if (data) {
            const refreshed = qqImages(data)[index];
            if (refreshed?.provider === 'qq') {
              image = await load(refreshed.url);
              // NapCat get_msg may return an expired legacy qpic URL. get_image downloads
              // the bound image and renews its modern URL; never accept a path or arbitrary URL as file.
              if (
                !image &&
                !signal.aborted &&
                /^[a-f0-9]{32}(?:\.(?:jpe?g|png|gif|webp|avif|bmp))?$/i.test(refreshed.file ?? '')
              ) {
                const renewed = await this.ctx.adapters.qq(
                  account,
                  'get_image',
                  { file: refreshed.file },
                  { signal, timeoutMs: 6000 },
                );
                if (qqSucceeded(renewed)) image = await load(renewed.data.data?.url);
              }
            }
          }
        } catch {
          /* Keep unavailable media separate from platform send results. */
        }
      }
      if (!image)
        throw new ApiError(
          502,
          'QQ_IMAGE_UNAVAILABLE',
          'QQ 图片暂时无法读取，请稍后重试；原消息或图片可能已失效',
        );
      const latest = await this.messageRecord(row.conversation_id, row.id);
      if (sha(JSON.stringify(latest.row.media[index] ?? null)) !== sha(JSON.stringify(media ?? null)))
        throw new ApiError(409, 'IMAGE_CHANGED', '图片已更新，请重新加载');
      let bytes = [...this.qqImageCache.values()].reduce(
        (total, entry) => total + entry.image.body.length,
        0,
      );
      while (
        this.qqImageCache.size &&
        (this.qqImageCache.size >= 64 || bytes + image.body.length > 16 * 1024 * 1024)
      ) {
        const oldest = this.qqImageCache.keys().next().value!;
        bytes -= this.qqImageCache.get(oldest)!.image.body.length;
        this.qqImageCache.delete(oldest);
      }
      this.qqImageCache.set(key, { image, expires: Date.now() + 300_000 });
      return image;
    })();
    this.qqImagePending.set(key, request);
    try {
      return await request;
    } finally {
      this.qqImagePending.delete(key);
    }
  }
  private async qqImageSource(row: Row, account: Row, signal: AbortSignal): Promise<Row | undefined> {
    const matches = (data: Row) =>
      String(data?.group_id) === row.group_external_id &&
      String(data?.message_id) === row.external_id &&
      String(data?.user_id ?? data?.sender?.user_id) === row.sender_id;
    try {
      const result = await this.ctx.adapters.qq(
        account,
        'get_msg',
        { message_id: row.external_id },
        { signal, timeoutMs: 6000 },
      );
      if (qqSucceeded(result) && result.data.data)
        return matches(result.data.data) ? result.data.data : undefined;
    } catch {
      /* NapCat's short-ID map is memory-only and is lost on a bridge restart. */
    }
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 3 && !signal.aborted; page++) {
      const result = await this.ctx.adapters.qq(
        account,
        'get_group_msg_history',
        {
          group_id: row.group_external_id,
          count: 100,
          ...(cursor ? { message_seq: cursor } : {}),
          parse_mult_msg: false,
          quick_reply: true,
        },
        { signal, timeoutMs: 6000 },
      );
      if (!qqSucceeded(result) || !Array.isArray(result.data.data?.messages)) return;
      const messages: Row[] = result.data.data.messages;
      const targets = messages.filter((message) => String(message?.message_id) === row.external_id);
      if (targets.length) return targets.length === 1 && matches(targets[0]!) ? targets[0] : undefined;
      if (!messages.length) return;
      const oldest = [...messages].sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0))[0];
      cursor = String(oldest?.message_id ?? '');
      if (!/^-?\d{1,20}$/.test(cursor) || cursors.has(cursor)) return;
      cursors.add(cursor);
    }
  }
  async avatar(conversationId: string, messageId: string) {
    const { row, account } = await this.messageRecord(conversationId, messageId);
    const key = `${account.id}:${row.sender_id}:${row.sender_avatar ?? ''}`;
    const cached = this.avatarCache.get(key);
    if (cached && cached.expires > Date.now()) {
      if (!cached.image) throw new ApiError(404, 'AVATAR_UNAVAILABLE', '暂无头像');
      return cached.image;
    }
    const pending = this.avatarPending.get(key);
    if (pending) return pending;
    const request = (async () => {
      try {
        let url = publicImageUrl(row.sender_avatar);
        if (account.kind === 'qq' && /^[1-9]\d{4,19}$/.test(row.sender_id))
          url = `https://q1.qlogo.cn/g?b=qq&nk=${row.sender_id}&s=100`;
        else if (account.kind === 'telegram' && /^[1-9]\d{0,19}$/.test(row.sender_id)) {
          const photos = await this.ctx.adapters.telegram(account, 'getUserProfilePhotos', {
            user_id: row.sender_id,
            limit: 1,
          });
          const photo = photos.data.ok ? photos.data.result?.photos?.[0]?.[0] : null;
          if (photo?.file_id) url = await this.ctx.adapters.telegramFileUrl(account, photo.file_id);
        }
        if (!url) throw new ApiError(404, 'AVATAR_UNAVAILABLE', '暂无头像');
        const image = await this.loadImage(url);
        if (image.body.length > 1024 * 1024) throw new ApiError(502, 'AVATAR_TOO_LARGE', '头像过大');
        if (this.avatarCache.size >= 100) this.avatarCache.delete(this.avatarCache.keys().next().value!);
        this.avatarCache.set(key, { image, expires: Date.now() + 300_000 });
        return image;
      } catch (error) {
        if (this.avatarCache.size >= 100) this.avatarCache.delete(this.avatarCache.keys().next().value!);
        this.avatarCache.set(key, { image: null, expires: Date.now() + 60_000 });
        throw error;
      }
    })();
    this.avatarPending.set(key, request);
    try {
      return await request;
    } finally {
      this.avatarPending.delete(key);
    }
  }
  async open(id: string, req: Request, res: Response) {
    const initial = await this.snapshot(id);
    // A client can leave while SQL is loading, before the close listener exists.
    if (res.destroyed || res.writableEnded) return;
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    let closed = false,
      busy = false,
      blocked = false,
      blockedAt = 0,
      pending: string | undefined;
    // Query timestamps order racing HTTP/SSE responses, but are not a content change.
    const content = (snapshot: typeof initial) => JSON.stringify({ ...snapshot, observed_at: undefined });
    let last = content(initial);
    const frame = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;
    const write = (data: string) => {
      if (closed) return;
      if (blocked) {
        pending = data;
        return;
      }
      if (!res.write(data)) {
        blocked = true;
        blockedAt = Date.now();
      }
    };
    const drain = () => {
      blocked = false;
      if (pending) {
        const value = pending;
        pending = undefined;
        write(value);
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      res.off('drain', drain);
      this.streams.delete(close);
      if (blocked) res.destroy();
      else if (!res.writableEnded) res.end();
    };
    const poll = setInterval(async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const principal = await this.auth.authenticate(req.headers);
        this.auth.requireAdmin(principal);
        const snapshot = await this.snapshot(id);
        const current = content(snapshot);
        if (current !== last) {
          last = current;
          write(frame('chat.snapshot', JSON.stringify(snapshot)));
        }
      } catch (error) {
        if (!closed) {
          // Never flush a queued snapshot after authentication has ended.
          pending = undefined;
          if (error instanceof ApiError && [401, 403].includes(error.status))
            res.write(frame('auth.expired', JSON.stringify({ message: '登录已失效，请重新登录' })));
          else
            res.write(frame('stream.error', JSON.stringify({ message: '消息连接暂时中断，正在重新连接' })));
          close();
        }
      } finally {
        busy = false;
      }
    }, 1000);
    const heartbeat = setInterval(() => {
      if (blocked && Date.now() - blockedAt > 15_000) {
        close();
        return;
      }
      if (!blocked && !closed) write(': heartbeat\n\n');
    }, 15_000);
    this.streams.add(close);
    res.once('close', close);
    res.on('drain', drain);
    write(frame('chat.snapshot', JSON.stringify(initial)));
  }
  closeStreams() {
    for (const close of [...this.streams]) close();
  }
  onModuleDestroy() {
    this.closeStreams();
  }
}
