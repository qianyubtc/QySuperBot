import type { Config } from './config.ts';
import { openDatabase } from './database.ts';
import type { Database } from './database.ts';
import { SecretBox } from './security.ts';
import { Adapters } from './adapters.ts';
import { AuthService } from './auth.ts';
import { AccountsService } from './accounts.ts';
import { JobsService } from './jobs.ts';
import { MessagesService } from './messages.ts';
import { FeaturesService } from './features.ts';
import { Worker } from './worker.ts';
import { ChatService } from './chat.ts';
import { BinanceBridge } from './binance.ts';
import { UploadsService } from './uploads.ts';
import { BinanceBrowser } from './binance-browser.ts';
import { MemberManagement } from './member-management.ts';
import { BinanceMembers } from './binance-members.ts';
import { QQLogin } from './qq-login.ts';
import { QQRequests } from './qq-requests.ts';
import { QQVerification } from './qq-verification.ts';
import { KeywordRules } from './keyword-rules.ts';

export async function createServices(
  config: Config,
  options: { db?: Database; box?: SecretBox; worker?: boolean } = {},
) {
  const db = options.db ?? (await openDatabase(config));
  try {
    const box = options.box ?? (await SecretBox.create(config));
    const uploads = new UploadsService(db);
    const ctx = { db, box, config, uploads, adapters: new Adapters(config, box, uploads) };
    const binance = new BinanceBridge(db, box, uploads);
    ctx.adapters.binance = binance;
    const auth = new AuthService(db, config);
    const accounts = new AccountsService(ctx);
    binance.onConnected = (id) => accounts.refresh(id, 'binance-bridge');
    binance.onDirectConnected = (id) => accounts.refresh(id, 'binance-extension-direct');
    const binanceBrowser = new BinanceBrowser(
      config,
      db,
      auth,
      async (account, credentials, actor, signal) => {
        const result = await binance.authentication(account, credentials, actor, signal);
        try {
          await accounts.refresh(account.id, actor);
        } catch {
          return { ...result, warning: '直连已保存，资料刷新暂未完成，请点击连接 / 刷新检查状态' };
        }
        return result;
      },
    );
    const jobs = new JobsService(ctx);
    const keywords = new KeywordRules(ctx, jobs);
    const qqVerification = new QQVerification(ctx, jobs, (id) => accounts.refresh(id, '自动验证权限刷新'));
    const messages = new MessagesService(ctx, jobs, qqVerification);
    const features = new FeaturesService(ctx, jobs, auth, qqVerification);
    const chat = new ChatService(ctx, auth);
    const members = new MemberManagement(ctx, jobs);
    const binanceMembers = new BinanceMembers(ctx, jobs);
    const qqLogin = new QQLogin(ctx, accounts);
    const qqRequests = new QQRequests(ctx, jobs);
    const worker = new Worker(ctx, accounts, messages, jobs, features, members);
    await accounts.seedDemo();
    if (options.worker !== false) await worker.start();
    return {
      ...ctx,
      auth,
      accounts,
      jobs,
      keywords,
      messages,
      features,
      chat,
      members,
      binanceMembers,
      qqLogin,
      qqRequests,
      qqVerification,
      worker,
      binance,
      binanceBrowser,
      close: async () => {
        chat.closeStreams();
        binanceBrowser.close();
        binance.close();
        await worker.drain();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
export type Services = Awaited<ReturnType<typeof createServices>>;
