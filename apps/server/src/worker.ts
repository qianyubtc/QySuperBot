import { AccountsService } from './accounts.ts';
import { telegramEvents } from './adapters.ts';
import type { Context } from './context.ts';
import { audit, json } from './context.ts';
import { FeaturesService } from './features.ts';
import { JobsService } from './jobs.ts';
import { MessagesService } from './messages.ts';
import { binanceEvent, binanceHistory } from './binance.ts';
import { ApiError } from './security.ts';
import type { Row } from './database.ts';
import { beginBinanceCheck, recordBinanceSuccess } from './binance-health.ts';
import type { MemberManagement } from './member-management.ts';
import { log } from './log.ts';

// Permission snapshots expire after five minutes. Full discovery re-reads every group's
// permissions (for QQ, each group's member list), so it runs well inside that window instead of
// on every maintenance cycle; QQ login loss is still checked every cycle.
const permissionRefreshMs = 180_000;
const fullRefreshesPerCycle = 20;
/** Jobs of different accounts run side by side; each account still runs its jobs in order. */
const concurrentAccounts = 4;

export class Worker {
  ctx: Context;
  accounts: AccountsService;
  messages: MessagesService;
  jobs: JobsService;
  features: FeaturesService;
  timers: ReturnType<typeof setInterval>[] = [];
  busyJobs = false;
  busyPoll = false;
  busyMaintenance = false;
  stopped = false;
  enrichedBinanceSessions = new Map<string, string>();
  telegramLoops = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** Set once started: Telegram is then read only by the per-bot long-poll loops. */
  longPolling = false;
  housekeptAt = 0;
  /** Account id → the job currently executing for it. */
  runningJobs = new Map<string, Promise<void>>();
  constructor(
    ctx: Context,
    accounts: AccountsService,
    messages: MessagesService,
    jobs: JobsService,
    features: FeaturesService,
    readonly members?: MemberManagement,
  ) {
    this.ctx = ctx;
    this.accounts = accounts;
    this.messages = messages;
    this.jobs = jobs;
    this.features = features;
  }
  async start() {
    await this.jobs.recover();
    this.longPolling = true;
    this.timers.push(setInterval(() => void this.dispatch(), 800));
    this.timers.push(setInterval(() => void this.poll(), 3000));
    this.timers.push(setInterval(() => void this.maintenance(), 30_000));
    this.timers.push(setInterval(() => void this.syncTelegramLoops(), 5000));
    void this.syncTelegramLoops();
    void this.dispatch();
  }
  stop() {
    this.stopped = true;
    this.timers.forEach((timer) => clearInterval(timer));
    for (const loop of this.telegramLoops.values()) loop.controller.abort();
  }
  async drain() {
    this.stop();
    await Promise.allSettled([...this.telegramLoops.values()].map((loop) => loop.done));
    while (this.busyJobs || this.busyPoll || this.busyMaintenance)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.allSettled(this.runningJobs.values());
  }
  private async dispatch(sweep = true) {
    if (this.stopped || this.busyJobs) return;
    this.busyJobs = true;
    try {
      if (sweep) await this.messages.qqVerification.sweep();
      // A slow platform (a NapCat timeout, say) now holds up only its own account's queue.
      while (!this.stopped && this.runningJobs.size < concurrentAccounts) {
        const next = await this.jobs.claim([...this.runningJobs.keys()]);
        if (!next) break;
        const running = next
          .run()
          .catch((error) => log.error('job run failed', { account: next.accountId, error }))
          .finally(() => {
            this.runningJobs.delete(next.accountId);
            // Pick up the next job straight away rather than on the next tick.
            if (!this.stopped) void this.dispatch(false);
          });
        this.runningJobs.set(next.accountId, running);
      }
    } catch (error) {
      log.error('job dispatch failed; durable jobs are kept for the next cycle', { error });
    } finally {
      this.busyJobs = false;
    }
  }
  private async poll() {
    if (this.stopped || this.busyPoll) return;
    this.busyPoll = true;
    try {
      const accounts = this.longPolling
        ? []
        : await this.ctx.db.query(
            "SELECT * FROM accounts WHERE kind='telegram' AND status IN ('online','error') AND external_id IS NOT NULL",
          );
      // A running worker reads Telegram in its long-poll loops; a second getUpdates would conflict.
      if (!this.longPolling)
        for (const account of accounts) {
          if (this.stopped) break;
          await this.pollTelegram(account);
        }
      const binance = await this.ctx.db.query(
        "SELECT * FROM accounts WHERE kind='binance' AND status='online'",
      );
      for (const account of binance) {
        if (this.stopped) break;
        try {
          await this.pollBinance(account);
        } catch (error) {
          if ((error as { staleConnection?: boolean })?.staleConnection) continue;
          log.warn('binance poll failed', { account: account.id, error });
          await this.ctx.db.query(
            "UPDATE accounts SET status='error',last_error=$3 WHERE id=$1 AND session_id=$2 AND status='online'",
            [
              account.id,
              account.session_id,
              error instanceof ApiError ? error.message : '币安消息读取失败，请检查网页登录并刷新连接',
            ],
          );
        }
      }
    } catch (error) {
      log.error('message polling failed; retrying next cycle', { error });
    } finally {
      this.busyPoll = false;
    }
  }
  /** Reads one batch of Telegram updates; `wait` > 0 holds the request open (long polling). */
  async pollTelegram(account: Row, wait = 0, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.ctx.adapters.telegram(
        account,
        'getUpdates',
        {
          offset: Number(account.cursor ?? 0),
          timeout: wait,
          limit: 50,
          allowed_updates: [
            'message',
            'edited_message',
            'channel_post',
            'edited_channel_post',
            'callback_query',
            'my_chat_member',
          ],
        },
        undefined,
        { timeoutMs: (wait + 10) * 1000, signal },
      );
      if (!response.data.ok) {
        await this.ctx.db.query(
          "UPDATE accounts SET status='error',last_error=$2 WHERE id=$1 AND status<>'paused'",
          [
            account.id,
            response.data.error_code === 409
              ? 'Telegram 接收冲突：请检查是否配置了 Webhook，或有其他程序同时轮询此机器人'
              : 'Telegram 暂时无法读取消息',
          ],
        );
        return false;
      }
      for (const update of response.data.result) {
        if (signal?.aborted) return true;
        try {
          const callback = update.callback_query;
          if (callback)
            await this.ctx.adapters.telegram(account, 'answerCallbackQuery', {
              callback_query_id: callback.id,
            });
          const events = telegramEvents(account, update);
          const chat =
            update.message?.chat ??
            update.edited_message?.chat ??
            update.channel_post?.chat ??
            update.my_chat_member?.chat ??
            callback?.message?.chat;
          if (chat && ['group', 'supergroup', 'channel'].includes(chat.type)) {
            const known = (
              await this.ctx.db.query(
                'SELECT account_id FROM bindings WHERE account_id=$1 AND external_id=$2',
                [account.id, String(chat.id)],
              )
            ).length;
            if (!known)
              await this.accounts.upsertGroup(
                account,
                await this.ctx.adapters.telegramGroup(account, String(chat.id)),
              );
          }
          for (const item of events)
            await this.messages.ingest(account, item.event, item.name, false, item.presentation);
          await this.members?.handleUpdate(account, update);
        } catch (error) {
          log.warn('telegram update quarantined', {
            account: account.id,
            update: update.update_id,
            error,
          });
          // Isolate poison updates without losing them or blocking all following group events.
          await this.ctx.db.query(
            'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
            [
              `quarantine:${account.id}:${update.update_id}`,
              json({ update, received_at: new Date().toISOString() }),
            ],
          );
          await audit(this.ctx.db, '连接器', 'event.quarantined', account.id, {
            update_id: update.update_id,
          });
        }
        await this.ctx.db.query('UPDATE accounts SET cursor=$2 WHERE id=$1', [
          account.id,
          String(Number(update.update_id) + 1),
        ]);
      }
      // Polling runs every few seconds; only persist a status change or a coarse last-seen time.
      await this.ctx.db.query(
        `UPDATE accounts SET status='online',last_seen_at=now(),last_error=NULL WHERE id=$1 AND status<>'paused'
        AND (status<>'online' OR last_error IS NOT NULL OR last_seen_at IS NULL OR last_seen_at<now()-interval '30 seconds')`,
        [account.id],
      );
      return true;
    } catch (error) {
      // Shutting down or stopping the loop aborts the long poll; that is not a connection failure.
      if (signal?.aborted) return false;
      log.warn('telegram poll failed', { account: account.id, error });
      await this.ctx.db.query(
        "UPDATE accounts SET status='error',last_error='Telegram 连接暂不可用' WHERE id=$1 AND status<>'paused'",
        [account.id],
      );
    }
    return false;
  }
  /** Keeps one long-poll loop per connected Telegram bot, so new messages arrive within moments. */
  private async syncTelegramLoops() {
    if (this.stopped) return;
    let ids: string[];
    try {
      ids = (
        await this.ctx.db.query(
          "SELECT id FROM accounts WHERE kind='telegram' AND status IN ('online','error') AND external_id IS NOT NULL",
        )
      ).map((row) => row.id);
    } catch (error) {
      log.warn('telegram loop sync failed', { error });
      return;
    }
    for (const [id, loop] of this.telegramLoops) if (!ids.includes(id)) loop.controller.abort();
    for (const id of ids) {
      if (this.telegramLoops.has(id) || this.stopped) continue;
      const controller = new AbortController();
      const loop = { controller, done: this.telegramLoop(id, controller.signal) };
      this.telegramLoops.set(id, loop);
      void loop.done.finally(() => {
        if (this.telegramLoops.get(id) === loop) this.telegramLoops.delete(id);
      });
    }
  }
  private async telegramLoop(id: string, signal: AbortSignal) {
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    while (!signal.aborted && !this.stopped) {
      try {
        const account = (await this.ctx.db.query('SELECT * FROM accounts WHERE id=$1', [id]))[0];
        if (!account || !['online', 'error'].includes(account.status) || !account.external_id) return;
        // A healthy bot waits on Telegram; one in error retries a quick read every few seconds.
        const ok = await this.pollTelegram(account, account.status === 'online' ? 25 : 0, signal);
        if (!ok || account.status !== 'online') await pause(3000);
      } catch (error) {
        log.warn('telegram loop iteration failed', { account: id, error });
        await pause(3000);
      }
    }
  }
  async pollBinance(account: Row) {
    const started = beginBinanceCheck();
    const version =
      account.settings.transport === 'direct'
        ? 1008
        : (this.ctx.adapters.binance?.peers
            .get(account.id)
            ?.extensionVersion?.split('.')
            .reduce((v, p) => v * 1000 + Number(p), 0) ?? 0);
    if (this.enrichedBinanceSessions.get(account.id) !== account.session_id && version >= 1007) {
      for (const groupId of account.settings.group_ids) {
        try {
          const recent = binanceHistory(
            await this.ctx.adapters.binance!.request(account, 'history', { group_id: groupId }),
          );
          for (const message of recent.messages) {
            const item = binanceEvent(account, message);
            if (item?.event.type === 'message.created')
              await this.messages.enrich(account, groupId, message.msgId, item.name, item.presentation);
          }
        } catch {
          /* Optional profile enrichment never blocks live message ingestion. */
        }
      }
      this.enrichedBinanceSessions.set(account.id, account.session_id);
    }
    for (const groupId of account.settings.group_ids) {
      if (this.stopped) break;
      const scope = (await this.ctx.db.query('SELECT settings FROM accounts WHERE id=$1', [account.id]))[0];
      if (!(scope?.settings.group_ids ?? []).includes(groupId)) continue;
      const cursor = (
        await this.ctx.db.query('SELECT cursor FROM binance_cursors WHERE account_id=$1 AND external_id=$2', [
          account.id,
          groupId,
        ])
      )[0]?.cursor as string | undefined;
      let raw;
      try {
        raw = await this.ctx.adapters.binance!.request(account, 'history', {
          group_id: groupId,
          ...(cursor ? { min_id: cursor } : {}),
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'BINANCE_GROUP_SCOPE') continue;
        throw error;
      }
      const response = binanceHistory(raw);
      // A first connection imports a bounded history snapshot without retroactive moderation, verification or forwarding.
      const batch = response.messages
        .filter(
          (message) =>
            message.sessionType === 'GROUP' &&
            message.sessionId === groupId &&
            (!cursor || BigInt(message.msgId) > BigInt(cursor)),
        )
        .sort((a, b) =>
          BigInt(a.msgId) < BigInt(b.msgId) ? -1 : BigInt(a.msgId) === BigInt(b.msgId) ? 0 : 1,
        );
      let next = cursor;
      for (const message of batch) {
        const current = (
          await this.ctx.db.query('SELECT status,session_id,settings FROM accounts WHERE id=$1', [account.id])
        )[0];
        if (
          this.stopped ||
          current?.status !== 'online' ||
          current.session_id !== account.session_id ||
          !current.settings.group_ids.includes(groupId)
        )
          return;
        const item = binanceEvent(account, message);
        if (item) await this.messages.ingest(account, item.event, item.name, !cursor, item.presentation);
        next = message.msgId;
      }
      // An empty group still needs a baseline so its first future message is handled as a live event.
      await this.ctx.db.transaction(async (tx) => {
        const current = (
          await tx.query('SELECT settings,session_id FROM accounts WHERE id=$1 FOR SHARE', [account.id])
        )[0];
        if (
          !current ||
          current.session_id !== account.session_id ||
          (current?.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0') ||
          !current.settings.group_ids.includes(groupId)
        )
          return;
        await tx.query(
          'INSERT INTO binance_cursors(account_id,external_id,cursor) VALUES($1,$2,$3) ON CONFLICT(account_id,external_id) DO UPDATE SET cursor=EXCLUDED.cursor',
          [account.id, groupId, next ?? '0'],
        );
      });
    }
    if (account.settings.group_ids.length)
      await recordBinanceSuccess(this.ctx.db, account, 'sync', undefined, started);
  }
  /**
   * Hourly retention. Raw inbound events only back idempotency and diagnostics, so 30 days is
   * ample; uploaded images that nothing references any more are removed after a week.
   */
  async housekeeping() {
    this.housekeptAt = Date.now();
    const events = await this.ctx.db.query(
      "DELETE FROM inbox WHERE id IN (SELECT id FROM inbox WHERE received_at < now() - interval '30 days' LIMIT 5000) RETURNING id",
    );
    const images = await this.ctx.db.query(
      `DELETE FROM uploaded_images u WHERE u.created_at < now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM announcements a WHERE a.image_asset_id=u.id)
        AND NOT EXISTS (SELECT 1 FROM keyword_rules k WHERE k.image_asset_id=u.id)
        AND NOT EXISTS (SELECT 1 FROM message_templates t WHERE t.image_asset_id=u.id)
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.params::text LIKE '%' || u.id || '%')
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.media @> jsonb_build_array(jsonb_build_object('asset_id', u.id)))
      RETURNING u.id`,
    );
    if (events.length || images.length)
      log.info('housekeeping removed old data', { inbox_events: events.length, images: images.length });
  }
  private async maintenance() {
    if (this.stopped || this.busyMaintenance) return;
    this.busyMaintenance = true;
    try {
      await this.jobs.recover();
      await this.ctx.db.query(
        "UPDATE accounts SET status='expired',last_error='连接心跳已过期' WHERE kind='custom' AND status='online' AND session_expires_at<now()",
      );
      await this.ctx.db.query(
        "UPDATE verifications SET status='expired' WHERE status='pending' AND qq_context IS NULL AND expires_at<now()",
      );
      await this.ctx.db.query('DELETE FROM sessions WHERE expires_at<now()');
      await this.ctx.db.query('DELETE FROM nonces WHERE expires_at<now()');
      await this.ctx.db.query('DELETE FROM login_limits WHERE expires_at<now()');
      if (Date.now() - this.housekeptAt >= 3600_000) await this.housekeeping();
      const due = await this.ctx.db.query(
        "SELECT id FROM lotteries WHERE status='open' AND closes_at<=now() LIMIT 10",
      );
      for (const lottery of due) await this.features.drawLottery(lottery.id, '定时任务');
      const accounts = await this.ctx.db.query(
        `SELECT id,kind,status FROM accounts WHERE
          (kind IN ('telegram','qq','custom','binance') AND status='online') OR
          (kind IN ('qq','binance') AND status='error' AND external_id IS NOT NULL)
        ORDER BY last_seen_at`,
      );
      const now = Date.now();
      const refreshed = (account: Row) => this.accounts.refreshedAt.get(account.id) ?? 0;
      // Accounts in error retry every cycle; online accounts refresh once their permissions near expiry.
      const refreshDue = accounts
        .filter((account) => account.status !== 'online' || now - refreshed(account) >= permissionRefreshMs)
        .sort((a, b) => refreshed(a) - refreshed(b))
        .slice(0, fullRefreshesPerCycle);
      for (const account of accounts) {
        if (this.stopped) break;
        try {
          if (refreshDue.includes(account))
            await this.accounts.refresh(account.id, '定时刷新', false, { audit: false });
          else if (account.kind === 'qq' && account.status === 'online')
            await this.accounts.checkQQLogin(account.id);
        } catch (error) {
          log.warn('scheduled account check failed', { account: account.id, error });
        }
      }
    } catch (error) {
      log.error('maintenance failed; retrying next cycle', { error });
    } finally {
      this.busyMaintenance = false;
    }
  }
}
