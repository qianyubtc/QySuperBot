import { randomUUID } from 'node:crypto';
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
    this.timers.push(setInterval(() => void this.dispatch(), 800));
    this.timers.push(setInterval(() => void this.poll(), 3000));
    this.timers.push(setInterval(() => void this.maintenance(), 30_000));
    void this.dispatch();
  }
  stop() {
    this.stopped = true;
    this.timers.forEach((timer) => clearInterval(timer));
  }
  async drain() {
    this.stop();
    while (this.busyJobs || this.busyPoll || this.busyMaintenance)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
  private async dispatch() {
    if (this.stopped || this.busyJobs) return;
    this.busyJobs = true;
    try {
      await this.messages.qqVerification.sweep();
      for (let i = 0; i < 8 && !this.stopped; i++) if (!(await this.jobs.processOnce())) break;
    } catch {
      console.error('任务处理失败，已保留持久任务供后续检查');
    } finally {
      this.busyJobs = false;
    }
  }
  private async poll() {
    if (this.stopped || this.busyPoll) return;
    this.busyPoll = true;
    try {
      const accounts = await this.ctx.db.query(
        "SELECT * FROM accounts WHERE kind='telegram' AND status IN ('online','error') AND external_id IS NOT NULL",
      );
      for (const account of accounts) {
        if (this.stopped) break;
        try {
          const response = await this.ctx.adapters.telegram(account, 'getUpdates', {
            offset: Number(account.cursor ?? 0),
            timeout: 0,
            limit: 50,
            allowed_updates: [
              'message',
              'edited_message',
              'channel_post',
              'edited_channel_post',
              'callback_query',
              'my_chat_member',
            ],
          });
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
            continue;
          }
          for (const update of response.data.result) {
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
            } catch {
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
          await this.ctx.db.query(
            "UPDATE accounts SET status='online',last_seen_at=now(),last_error=NULL WHERE id=$1 AND status<>'paused'",
            [account.id],
          );
        } catch {
          await this.ctx.db.query(
            "UPDATE accounts SET status='error',last_error='Telegram 连接暂不可用' WHERE id=$1 AND status<>'paused'",
            [account.id],
          );
        }
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
    } catch {
      console.error('消息轮询暂未完成，下一周期将重试');
    } finally {
      this.busyPoll = false;
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
      const due = await this.ctx.db.query(
        "SELECT id FROM lotteries WHERE status='open' AND closes_at<=now() LIMIT 10",
      );
      for (const lottery of due) await this.features.drawLottery(lottery.id, '定时任务');
      const accounts = await this.ctx.db.query(
        `SELECT id FROM accounts WHERE
          (kind IN ('telegram','qq','custom','binance') AND status='online') OR
          (kind IN ('qq','binance') AND status='error' AND external_id IS NOT NULL)
        ORDER BY last_seen_at LIMIT 20`,
      );
      for (const account of accounts) {
        if (this.stopped) break;
        try {
          await this.accounts.refresh(account.id, '定时刷新');
        } catch {
          /* visible in the account's last_error */
        }
      }
    } catch {
      console.error('维护任务未完成，下一周期将重试');
    } finally {
      this.busyMaintenance = false;
    }
  }
}
