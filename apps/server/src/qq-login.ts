import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Context } from './context.ts';
import { audit } from './context.ts';
import type { AccountsService } from './accounts.ts';
import type { Row } from './database.ts';
import { ApiError } from './security.ts';
import { requestJson } from './network.ts';
import { fingerprint } from '../../../packages/contracts/src/index.ts';

const paths = new Set([
  '/QQLogin/CheckLoginStatus',
  '/QQLogin/GetQQLoginInfo',
  '/QQLogin/RefreshQRcode',
  '/QQLogin/SetQuickLogin',
  '/QQLogin/GetQuickLoginList',
  '/OB11Config/GetConfig',
  '/OB11Config/SetConfig',
]);
export class QQLogin {
  private credential?: string;
  private credentialUntil = 0;
  private authentication?: Promise<void>;
  private connecting = false;
  private refreshing = false;
  constructor(
    readonly ctx: Context,
    readonly accounts: AccountsService,
  ) {}
  private get endpoint() {
    return `http://127.0.0.1:${this.ctx.config.qqLocalPort}`;
  }
  private get available() {
    return !!(this.ctx.config.qqLocalPort && this.ctx.config.qqWebuiPort && this.ctx.config.qqWebuiToken);
  }
  private requireEnabled() {
    if (!this.available) throw new ApiError(409, 'QQ_LOGIN_DISABLED', '此服务器尚未配置 VPS QQ 扫码登录');
  }
  async local() {
    const rows = this.available
      ? await this.ctx.db.query(
          "SELECT id,name,status,external_id FROM accounts WHERE kind='qq' AND endpoint=$1 AND is_demo=false ORDER BY created_at",
          [this.endpoint],
        )
      : [];
    return { available: this.available, accounts: rows, instance_limit: 1 };
  }
  private async account(id?: string) {
    this.requireEnabled();
    if (!id) return;
    const account = await this.accounts.get(id);
    if (account.kind !== 'qq' || account.is_demo || account.endpoint !== this.endpoint)
      throw new ApiError(400, 'QQ_MANAGED_REQUIRED', '此连接未使用当前 VPS 的 QQ 登录服务');
    return account;
  }
  private async authenticate() {
    if (this.credential && this.credentialUntil > Date.now()) return;
    if (!this.authentication)
      this.authentication = (async () => {
        const r = await requestJson(`http://127.0.0.1:${this.ctx.config.qqWebuiPort}/api/auth/login`, {
          method: 'POST',
          allowPrivate: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            hash: createHash('sha256')
              .update(this.ctx.config.qqWebuiToken + '.napcat')
              .digest('hex'),
          }),
        });
        if (
          r.status !== 200 ||
          r.data?.code !== 0 ||
          typeof r.data.data?.Credential !== 'string' ||
          !r.data.data.Credential
        )
          throw new ApiError(502, 'QQ_LOGIN_AUTH', 'QQ 登录服务认证失败，请检查服务器配置');
        this.credential = r.data.data.Credential;
        this.credentialUntil = Date.now() + 300000;
      })().finally(() => {
        this.authentication = undefined;
      });
    await this.authentication;
  }
  async call(path: string, body: unknown = {}) {
    this.requireEnabled();
    if (!paths.has(path)) throw new ApiError(400, 'QQ_LOGIN_ACTION', '不支持的 QQ 登录操作');
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.authenticate();
        const r = await requestJson(`http://127.0.0.1:${this.ctx.config.qqWebuiPort}/api${path}`, {
          method: 'POST',
          allowPrivate: true,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.credential}` },
          body: JSON.stringify(body),
        });
        if (
          attempt === 0 &&
          ([401, 403].includes(r.status) ||
            (r.data?.code !== 0 && ['Unauthorized', 'Authorization Failed'].includes(r.data?.message)))
        ) {
          this.credential = undefined;
          continue;
        }
        if (r.status !== 200 || r.data?.code !== 0)
          throw new ApiError(502, 'QQ_LOGIN_UPSTREAM', 'QQ 登录服务暂未完成请求，请检查登录状态后重试');
        return r.data.data;
      }
      throw new Error();
    } catch (error) {
      if (error instanceof ApiError && ['QQ_LOGIN_AUTH', 'QQ_LOGIN_UPSTREAM'].includes(error.code))
        throw error;
      throw new ApiError(502, 'QQ_LOGIN_UNAVAILABLE', 'VPS QQ 登录服务暂不可用，请稍后重试');
    }
  }
  private async loginIdentity() {
    const status = await this.call('/QQLogin/CheckLoginStatus');
    if (status?.isLogin !== true || status.coreReady !== true)
      throw new ApiError(409, 'QQ_LOGIN_NOT_READY', '请先扫码并在手机确认，等待 QQ 完成登录');
    const info = await this.call('/QQLogin/GetQQLoginInfo');
    const id = String(info?.uin ?? '');
    if (!/^[1-9]\d{4,19}$/.test(id) || info.online !== true)
      throw new ApiError(409, 'QQ_LOGIN_IDENTITY_UNKNOWN', 'QQ 身份尚未确认，请等待登录初始化完成');
    return id;
  }
  async status(id?: string) {
    if (!this.available && !id) return { available: false };
    const account = await this.account(id);
    const value = await this.call('/QQLogin/CheckLoginStatus');
    if (typeof value?.isLogin !== 'boolean' || typeof value?.coreReady !== 'boolean')
      throw new ApiError(502, 'QQ_LOGIN_STATUS_UNKNOWN', '暂时无法核对 QQ 登录状态');
    let currentId: string | null = null;
    if (value.isLogin && value.coreReady) currentId = await this.loginIdentity();
    const accepted =
      value.qrLoginAccepted === true || ['qrcode_scanned', 'initializing'].includes(value.loginPhase);
    let qr: string | null = null;
    if (
      !value.isLogin &&
      !accepted &&
      typeof value.qrcodeurl === 'string' &&
      Buffer.byteLength(value.qrcodeurl, 'utf8') <= 1600
    ) {
      try {
        const url = new URL(value.qrcodeurl);
        if (
          url.protocol === 'https:' &&
          (!url.port || url.port === '443') &&
          !url.username &&
          !url.password &&
          (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com'))
        )
          qr = value.qrcodeurl;
      } catch {
        /* Unrecognized QR contents are never displayed as a login code. */
      }
    }
    const mismatch = !!(currentId && account?.external_id && currentId !== account.external_id);
    return {
      available: true,
      is_login: value.isLogin,
      core_ready: value.coreReady,
      qr_value: qr,
      login_accepted: accepted,
      phase: typeof value.loginPhase === 'string' ? value.loginPhase.slice(0, 64) : 'unknown',
      error: typeof value.loginError === 'string' ? value.loginError.slice(0, 500) : null,
      current_id: currentId,
      expected_id: account?.external_id ?? null,
      identity_mismatch: mismatch,
      paused: account?.status === 'paused',
    };
  }
  async refresh(id: string | undefined, actor: string) {
    const account = await this.account(id);
    if (this.refreshing) throw new ApiError(409, 'QQ_LOGIN_BUSY', '二维码正在刷新，请稍后查看');
    this.refreshing = true;
    try {
      const status = await this.call('/QQLogin/CheckLoginStatus');
      if (status?.isLogin === true)
        throw new ApiError(409, 'QQ_ALREADY_LOGGED_IN', 'QQ 已登录，无需重新扫码');
      await this.call('/QQLogin/RefreshQRcode');
      await audit(this.ctx.db, actor, 'qq.login.qr_refreshed', account?.id ?? 'local');
      return await this.status(id);
    } finally {
      this.refreshing = false;
    }
  }
  async quick(id: string, actor: string) {
    const account = await this.account(id);
    if (!account?.external_id) throw new ApiError(409, 'QQ_NO_SAVED_IDENTITY', '请先通过二维码建立 QQ 登录');
    const list = await this.call('/QQLogin/GetQuickLoginList');
    if (!Array.isArray(list) || !list.map(String).includes(account.external_id))
      throw new ApiError(409, 'QQ_QUICK_LOGIN_UNAVAILABLE', '旧登录状态不可用，请使用二维码登录');
    await this.call('/QQLogin/SetQuickLogin', { uin: account.external_id });
    await audit(this.ctx.db, actor, 'qq.login.quick_requested', id);
    return { requested: true };
  }
  async connect(input: unknown, actor: string) {
    const value = z
      .strictObject({
        account_id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(100).default('QQ 机器人'),
        resume: z.boolean().default(false),
      })
      .parse(input);
    await this.account(value.account_id);
    if (this.connecting) throw new ApiError(409, 'QQ_LOGIN_BUSY', '此 QQ 连接正在验证，请稍后查看');
    this.connecting = true;
    try {
      const identity = await this.loginIdentity();
      const config = await this.call('/OB11Config/GetConfig');
      if (
        !config?.network ||
        !Array.isArray(config.network.httpServers) ||
        !Array.isArray(config.network.httpClients)
      )
        throw new ApiError(502, 'QQ_CONFIG_UNKNOWN', 'QQ 桥接配置格式无法确认，未修改配置');
      const matches = config.network.httpServers.filter(
        (s: Row) => s.enable && Number(s.port) === this.ctx.config.qqLocalPort,
      );
      if (
        matches.length > 1 ||
        (matches.length === 1 && (matches[0].name !== 'superbot-api' || matches[0].host !== '127.0.0.1'))
      )
        throw new ApiError(409, 'QQ_LOCAL_PORT_IN_USE', 'QQ API 端口已有其他配置，请先由服务器管理员核对');
      const bridgeToken =
        typeof matches[0]?.token === 'string' && matches[0].token
          ? matches[0].token
          : randomBytes(32).toString('base64url');
      const chosen = await this.ctx.db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO metadata(key,value) VALUES('qq-managed-connection','{}') ON CONFLICT DO NOTHING",
        );
        await tx.query("SELECT key FROM metadata WHERE key='qq-managed-connection' FOR UPDATE");
        const accounts = await tx.query(
          "SELECT * FROM accounts WHERE kind='qq' AND endpoint=$1 AND is_demo=false ORDER BY created_at FOR UPDATE",
          [this.endpoint],
        );
        let account = value.account_id
          ? accounts.find((a) => a.id === value.account_id)
          : accounts.find((a) => !a.external_id || a.external_id === identity);
        if (value.account_id && !account)
          throw new ApiError(409, 'QQ_MANAGED_CHANGED', 'QQ 连接已变化，请刷新后重试');
        if (accounts.some((a) => a.id !== account?.id && a.status !== 'paused'))
          throw new ApiError(409, 'QQ_LOCAL_IN_USE', '此 VPS 已有活动 QQ 连接，请先暂停旧连接后再添加');
        if (account?.external_id && account.external_id !== identity)
          throw new ApiError(
            409,
            'QQ_IDENTITY_CHANGED',
            '当前登录 QQ 与此连接不一致，请恢复原账号或添加新连接',
          );
        if (account?.status === 'paused' && !value.resume)
          throw new ApiError(409, 'ACCOUNT_PAUSED', '此连接已暂停，请明确恢复连接后再使用');
        if (!account) {
          const created = await this.accounts.create(
            { kind: 'qq', name: value.name, endpoint: this.endpoint, token: bridgeToken },
            actor,
            tx,
          );
          account = (await tx.query('SELECT * FROM accounts WHERE id=$1', [created.id]))[0]!;
        }
        if (!account.external_id) {
          await tx.query('UPDATE accounts SET external_id=$2 WHERE id=$1', [account.id, identity]);
          account = { ...account, external_id: identity };
          await audit(tx, actor, 'qq.login.identity_bound', account.id, { external_id: identity });
        }
        if (!account.secret_box) {
          const secret = this.ctx.box.seal(bridgeToken);
          await tx.query('UPDATE accounts SET secret_box=$2 WHERE id=$1', [account.id, secret]);
          account = { ...account, secret_box: secret };
          await audit(tx, actor, 'qq.login.api_secured', account.id);
        }
        return account;
      });
      if ((await this.loginIdentity()) !== identity)
        throw new ApiError(409, 'QQ_IDENTITY_CHANGED', '配置期间 QQ 身份已变化，未连接账号');
      const token = chosen.secret_box ? this.ctx.box.open(chosen.secret_box) : bridgeToken;
      const client = {
        ...config.network.httpClients.find((c: Row) => c.name === 'superbot-events'),
        name: 'superbot-events',
        enable: true,
        url: `http://127.0.0.1:${this.ctx.config.port}/api/v1/connectors/qq/${chosen.id}/events`,
        messagePostFormat: 'array',
        reportSelfMessage: false,
        token: this.ctx.box.open(chosen.incoming_secret_box),
        debug: false,
      };
      const server = {
        ...matches[0],
        name: 'superbot-api',
        enable: true,
        host: '127.0.0.1',
        port: this.ctx.config.qqLocalPort,
        messagePostFormat: 'array',
        token,
        enableCors: false,
        enableWebsocket: false,
        debug: false,
      };
      const configured = {
        ...config,
        network: {
          ...config.network,
          httpServers: [...config.network.httpServers.filter((s: Row) => s.name !== 'superbot-api'), server],
          httpClients: [
            ...config.network.httpClients.filter((c: Row) => c.name !== 'superbot-events'),
            client,
          ],
        },
      };
      if (fingerprint(await this.call('/OB11Config/GetConfig')) !== fingerprint(config))
        throw new ApiError(409, 'QQ_CONFIG_CHANGED', 'QQ 桥接配置已变化，请重新连接，避免覆盖其他修改');
      if (fingerprint(configured) !== fingerprint(config))
        await this.call('/OB11Config/SetConfig', { config: JSON.stringify(configured) });
      const result = await this.accounts.refresh(chosen.id, actor, value.resume);
      await audit(this.ctx.db, actor, 'qq.login.connected', chosen.id, { groups: result.groups });
      return { account_id: chosen.id, groups: result.groups, connected: true };
    } finally {
      this.connecting = false;
    }
  }
}
