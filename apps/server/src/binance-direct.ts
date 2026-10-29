import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { createBinanceChatClient, type ChatClient } from '../../../packages/binance-chat/client.js';
import type { Database, Row } from './database.ts';
import { ApiError, type SecretBox } from './security.ts';
import { requestRemote } from './network.ts';
import { audit, json } from './context.ts';
import {
  beginBinanceCheck,
  binanceFailureKind,
  binanceFailureMessage,
  recordBinanceFailure,
  recordBinanceSuccess,
} from './binance-health.ts';

const credential = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/)
  .refine((s) => !/[;,]/.test(s));
export const binanceAuthentication = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('bridge') }),
  z
    .strictObject({
      mode: z.literal('direct'),
      web_token: credential,
      csrf_token: z
        .string()
        .regex(/^[a-fA-F0-9]{32}$/)
        .optional(),
      csrf_cookie: credential.optional(),
      device_id: z
        .string()
        .max(1024)
        .regex(/^[\x21-\x7e]*$/)
        .optional(),
    })
    .refine((value) => !!(value.csrf_token || value.csrf_cookie), {
      message: '请填写 cr00 或 csrftoken',
      path: ['csrf_cookie'],
    }),
]);
type Credentials = Extract<z.infer<typeof binanceAuthentication>, { mode: 'direct' }>;
type ClientFactory = (credentials: Credentials, beforeSend: (groupId: string) => Promise<void>) => ChatClient;
type SocketOptions = import('ws').ClientOptions & Pick<import('node:http').ClientRequestArgs, 'lookup'>;

function safeDiagnostic(error: unknown) {
  const detail = (error as { bridgeError?: Record<string, unknown> })?.bridgeError;
  const labels: Record<string, string> = {
    profile: '聊天身份',
    group: '群资料',
    member: '成员权限',
    history: '消息列表',
    token: '聊天令牌',
    domain: '聊天域名',
    socket: '聊天心跳',
    restriction: '发送限制',
    groups: '群列表',
    image: '图片',
    upload: '图片上传',
    send: '发送回执',
  };
  if (!detail || typeof detail.stage !== 'string' || !Object.hasOwn(labels, detail.stage)) return '';
  const status =
    Number.isInteger(detail.http_status) &&
    Number(detail.http_status) >= 100 &&
    Number(detail.http_status) <= 599
      ? `HTTP ${detail.http_status}`
      : '';
  const code =
    typeof detail.api_code === 'string' && /^\d{1,20}$/.test(detail.api_code)
      ? `币安码 ${detail.api_code}`
      : '';
  return `（${[labels[detail.stage], status, code].filter(Boolean).join('，')}）`;
}

// Reading exp is advisory only. Neither identity nor validity is established by JWT decoding.
export function binanceTokenMetadata(value: string) {
  const result: { format: 'jwt' | 'opaque'; expires_at: string | null } = {
    format: 'opaque',
    expires_at: null,
  };
  try {
    const parts = value.split('.');
    if (parts.length !== 3) return result;
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    if (typeof header?.alg !== 'string' || !payload || typeof payload !== 'object') return result;
    result.format = 'jwt';
    if (Number.isSafeInteger(payload.exp) && payload.exp > 0 && payload.exp < 253402300800)
      result.expires_at = new Date(payload.exp * 1000).toISOString();
  } catch {
    /* Opaque credentials are supported too. */
  }
  return result;
}

export function createDirectClient(
  credentials: Credentials,
  beforeSend?: (groupId: string) => Promise<void>,
  network: {
    request?: typeof requestRemote;
    resolve?: typeof lookup;
    connect?: (url: URL, options: SocketOptions) => unknown;
  } = {},
): ChatClient {
  const lifetime = new AbortController();
  const client = createBinanceChatClient({
    beforeSend,
    managementEnabled: true,
    WebSocket,
    csrfToken: credentials.csrf_token ? () => credentials.csrf_token! : undefined,
    cookie: (name) => {
      if (name === 'BNC_FV_KEY') return credentials.device_id ?? '';
      if (name === 'cr00') {
        try {
          return decodeURIComponent(credentials.csrf_cookie ?? '');
        } catch {
          return '';
        }
      }
      return '';
    },
    async fetch(input, init = {}) {
      // Relative, fixed chat routes are checked by the shared protocol before arriving here.
      const path = String(input);
      const authenticated = path.startsWith('/bapi/');
      const url = authenticated ? new URL(path, 'https://www.binance.com') : new URL(path);
      if (authenticated && url.origin !== 'https://www.binance.com')
        throw new ApiError(400, 'BINANCE_ENDPOINT', '币安聊天接口地址无效');
      if (!authenticated && (init.method !== 'PUT' || url.protocol !== 'https:'))
        throw new ApiError(400, 'BINANCE_ENDPOINT', '币安上传接口地址无效');
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      if (authenticated) {
        // Do not send website credentials to signed upload URLs or the IM socket.
        headers.cookie =
          `p20t=${credentials.web_token}` +
          (credentials.csrf_cookie ? `; cr00=${credentials.csrf_cookie}` : '');
        headers.origin = 'https://www.binance.com';
        headers.referer = 'https://www.binance.com/zh-CN/square/chat';
      }
      const body =
        init.body instanceof Blob
          ? Buffer.from(await init.body.arrayBuffer())
          : (init.body as string | undefined);
      const response = await (network.request ?? requestRemote)(url.toString(), {
        method: init.method,
        headers,
        body,
        timeoutMs: authenticated ? 12000 : 80000,
        signal: init.signal ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal,
      });
      return new Response(new Uint8Array(response.body), { status: response.status });
    },
    async createSocket(raw) {
      const url = new URL(raw);
      if (
        url.protocol !== 'wss:' ||
        !url.hostname.endsWith('.binance.com') ||
        url.port ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== '/binance_chat'
      )
        throw new ApiError(400, 'BINANCE_SOCKET_ENDPOINT', '币安聊天服务器地址无效');
      const addresses = await (network.resolve ?? lookup)(url.hostname, { all: true });
      if (!addresses.length || addresses.some((item) => ipaddr.process(item.address).range() !== 'unicast'))
        throw new ApiError(400, 'BINANCE_SOCKET_ENDPOINT', '币安聊天服务器地址不在公网范围');
      const address = addresses.find((item) => item.family === 4) ?? addresses[0]!;
      const options: SocketOptions = {
        origin: 'https://www.binance.com',
        followRedirects: false,
        handshakeTimeout: 10000,
        maxPayload: 2 * 1024 * 1024,
        lookup: (_hostname: any, options: any, callback: any) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      };
      const socket = network.connect ? network.connect(url, options) : new WebSocket(url, options);
      // Closing during asynchronous DNS resolution must not produce an unhandled ws error.
      if (socket instanceof WebSocket) socket.on('error', () => {});
      return socket;
    },
  });
  return {
    ...client,
    close() {
      lifetime.abort();
      client.close();
    },
  };
}

export class BinanceDirect {
  clients = new Map<string, { session: string; client: ChatClient }>();
  validating = new Set<string>();
  inFlight = new Map<string, number>();
  constructor(
    readonly db: Database,
    readonly box: SecretBox,
    readonly factory: ClientFactory = createDirectClient,
  ) {}

  async prepare(
    account: Row,
    input: unknown,
    validateGroup: (id: string, data: unknown) => unknown,
    signal?: AbortSignal,
  ) {
    const credentials = binanceAuthentication.parse(input);
    if (credentials.mode !== 'direct') throw new ApiError(400, 'BINANCE_MODE', '请选择服务器直连模式');
    if (this.validating.has(account.id))
      throw new ApiError(409, 'BINANCE_BUSY', '此账号正在验证令牌，请稍后再试');
    const metadata = binanceTokenMetadata(credentials.web_token);
    if (metadata.expires_at && Date.parse(metadata.expires_at) <= Date.now())
      throw new ApiError(400, 'BINANCE_TOKEN_EXPIRED', '此令牌已过期，请重新登录币安获取');
    this.validating.add(account.id);
    const fence = { session: null as string | null };
    let client: ChatClient | undefined;
    const aborted = () => client?.close();
    const checkAbort = () => {
      if (signal?.aborted) throw new ApiError(409, 'BINANCE_AUTH_CANCELLED', '授权已取消，连接未切换');
    };
    try {
      checkAbort();
      client = this.factory(credentials, (group) => this.beforeSend(account.id, fence.session, group));
      signal?.addEventListener('abort', aborted, { once: true });
      const profile = z
        .object({ chatUserId: z.string().regex(/^\d+$/) })
        .parse(await client.request({ operation: 'profile' }));
      if (account.external_id && profile.chatUserId !== account.external_id)
        throw new ApiError(409, 'BINANCE_IDENTITY_CHANGED', '令牌所属币安账号与此连接不一致');
      const params = { expected_user_id: profile.chatUserId };
      for (const group_id of account.settings.group_ids)
        validateGroup(
          group_id,
          await client.request({
            operation: 'group',
            group_ids: account.settings.group_ids,
            params: { ...params, group_id },
          }),
        );
      if (account.settings.group_ids[0])
        await client.request({
          operation: 'history',
          group_ids: account.settings.group_ids,
          params: { ...params, group_id: account.settings.group_ids[0] },
        });
      const socket = await client.checkConnection(profile.chatUserId);
      checkAbort();
      return { client, fence, credentials, identity: profile.chatUserId, metadata, socket };
    } catch (error) {
      client?.close();
      if (error instanceof ApiError) throw error;
      // Never persist or report vendor exceptions, request URLs, headers, or token values.
      throw new ApiError(
        502,
        'BINANCE_DIRECT_AUTH',
        `直连验证未通过${safeDiagnostic(error)}，请检查网页登录令牌、CSRF、有效期及 VPS 网络；原连接未改变`,
      );
    } finally {
      signal?.removeEventListener('abort', aborted);
      this.validating.delete(account.id);
    }
  }

  async save(
    account: Row,
    prepared: Awaited<ReturnType<BinanceDirect['prepare']>>,
    actor: string,
    signal?: AbortSignal,
  ) {
    const session = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [account.id]))[0];
        if (
          !current ||
          current.status === 'paused' ||
          current.session_id !== account.session_id ||
          current.secret_box !== account.secret_box ||
          current.incoming_secret_box !== account.incoming_secret_box ||
          current.external_id !== account.external_id ||
          current.settings.group_revision !== account.settings.group_revision
        )
          throw new ApiError(409, 'BINANCE_CONNECTION_CHANGED', '验证期间连接或群选择已变化，请重新验证');
        if (signal?.aborted) throw new ApiError(409, 'BINANCE_AUTH_CANCELLED', '授权已取消，连接未切换');
        await tx.query(
          `UPDATE accounts SET secret_box=$2,session_id=$3,external_id=$4,status='connecting',last_error=NULL,
          settings=$5::jsonb WHERE id=$1`,
          [
            account.id,
            this.box.seal(json(prepared.credentials)),
            session,
            prepared.identity,
            json({
              ...current.settings,
              transport: 'direct',
              direct_auth: {
                ...prepared.metadata,
                configured_at: new Date().toISOString(),
              },
            }),
          ],
        );
        await audit(tx, actor, 'account.binance.direct_enabled', account.id, { identity: prepared.identity });
        if (signal?.aborted) throw new ApiError(409, 'BINANCE_AUTH_CANCELLED', '授权已取消，连接未切换');
      });
    } catch (error) {
      prepared.client.close();
      throw error;
    }
    this.disconnect(account.id);
    prepared.fence.session = session;
    this.clients.set(account.id, { session, client: prepared.client });
  }

  async beforeSend(id: string, session: string | null, group: string) {
    const current = (
      await this.db.query('SELECT status,session_id,settings FROM accounts WHERE id=$1', [id])
    )[0];
    if (
      !session ||
      !current ||
      current.status !== 'online' ||
      current.session_id !== session ||
      current.settings.transport !== 'direct' ||
      !current.settings.group_ids.includes(group)
    )
      throw new ApiError(409, 'BINANCE_CONNECTION_CHANGED', '连接或群范围已变化，本次未发送');
  }

  async request(
    account: Row,
    operation: string,
    params: Record<string, unknown>,
    beforeEffect?: () => Promise<void>,
  ) {
    if (account.status === 'paused' || account.settings.transport !== 'direct' || !account.secret_box)
      throw new ApiError(409, 'BINANCE_DIRECT_OFFLINE', '币安服务器直连未启用');
    if (params.group_id && !account.settings.group_ids.includes(params.group_id))
      throw new ApiError(403, 'BINANCE_GROUP_SCOPE', '此币安群不在连接授权范围内');
    const started = beginBinanceCheck();
    const expiresAt = account.settings.direct_auth?.expires_at;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      if (this.clients.get(account.id)?.session === account.session_id) this.disconnect(account.id);
      const error = new ApiError(409, 'BINANCE_TOKEN_EXPIRED', '币安登录已失效，请重新登录并连接此账号');
      const recorded = await recordBinanceFailure(
        this.db,
        account,
        operation,
        params.group_id,
        started,
        error,
      ).catch(() => true);
      if (!recorded) Object.assign(error, { staleConnection: true });
      throw error;
    }
    if ((this.inFlight.get(account.id) ?? 0) >= 16)
      throw new ApiError(429, 'BINANCE_BUSY', '币安直连请求过多，请稍后再试');
    let entry = this.clients.get(account.id);
    if (!entry || entry.session !== account.session_id) {
      this.disconnect(account.id);
      const credentials = binanceAuthentication.parse(JSON.parse(this.box.open(account.secret_box)));
      if (credentials.mode !== 'direct')
        throw new ApiError(409, 'BINANCE_DIRECT_OFFLINE', '请重新配置直连令牌');
      const metadata = binanceTokenMetadata(credentials.web_token);
      if (metadata.expires_at && Date.parse(metadata.expires_at) <= Date.now())
        throw new ApiError(409, 'BINANCE_TOKEN_EXPIRED', '币安网页登录令牌已过期，请更新直连令牌');
      const session = account.session_id;
      entry = {
        session,
        client: this.factory(credentials, (group) => this.beforeSend(account.id, session, group)),
      };
      this.clients.set(account.id, entry);
    }
    try {
      this.inFlight.set(account.id, (this.inFlight.get(account.id) ?? 0) + 1);
      const result = await entry.client.request({
        operation,
        group_ids: account.settings.group_ids,
        params: { ...params, ...(operation !== 'profile' ? { expected_user_id: account.external_id } : {}) },
        before_effect: beforeEffect,
      });
      if (
        operation === 'profile' &&
        account.external_id &&
        result?.chatUserId &&
        result.chatUserId !== account.external_id
      )
        throw new ApiError(409, 'BINANCE_IDENTITY_CHANGED', '币安登录身份与此连接不一致，请重新登录原账号');
      await recordBinanceSuccess(this.db, account, operation, params.group_id, started).catch(() => {});
      return result;
    } catch (error) {
      const detail = (error as { bridgeError?: Record<string, unknown> })?.bridgeError;
      const memberOperation = ['member_set_mute', 'member_remove'].includes(operation);
      if (
        memberOperation &&
        error instanceof ApiError &&
        [403, 409].includes(error.status) &&
        detail?.effect !== 'possible'
      ) {
        Object.assign(error, { bridgeError: { effect: 'none' } });
        throw error;
      }
      const kind = binanceFailureKind(error);
      const recorded = await recordBinanceFailure(
        this.db,
        account,
        operation,
        params.group_id,
        started,
        error,
      ).catch(() => true);
      const failure = new ApiError(
        502,
        kind === 'login_required'
          ? 'BINANCE_TOKEN_EXPIRED'
          : kind === 'identity_changed'
            ? 'BINANCE_IDENTITY_CHANGED'
            : 'BINANCE_DIRECT_REQUEST',
        memberOperation && detail?.detail === 'PAID_GROUP'
          ? '此群为付费群，未执行踢人；请到币安官方页面处理。'
          : memberOperation &&
              detail?.code === 'PERMISSION' &&
              !['login_required', 'identity_changed'].includes(kind)
            ? '成员管理前置条件已变化，未执行操作；请刷新群权限和成员状态后重新提交。'
            : memberOperation &&
                detail?.code === 'API' &&
                !['login_required', 'identity_changed'].includes(kind)
              ? '币安拒绝了本次成员管理请求，请核对管理权限和目标成员状态。'
              : `${binanceFailureMessage(error)}${safeDiagnostic(error)}${['send', 'send_image'].includes(operation) ? ' 发送结果请查看任务回执，勿重复提交。' : ''}`,
      );
      if (!recorded) Object.assign(failure, { staleConnection: true });
      if (['member_set_mute', 'member_remove'].includes(operation))
        Object.assign(failure, {
          bridgeError: { effect: detail?.effect === 'possible' ? 'possible' : 'none' },
        });
      // Only a bounded effect marker is needed by the image delivery state machine.
      // run() can fail during identity checks before entering sendImage(). Like the browser entry,
      // absence of a publication marker is then a known pre-upload failure. sendImage() marks every
      // error after PUT starts as possible, which must remain unknown and must never auto-retry.
      if (operation === 'send_image' && (detail?.effect === undefined || detail.effect === 'none'))
        Object.assign(failure, {
          bridgeError: {
            effect: 'none',
            code: ['NETWORK', 'TIMEOUT', 'SOCKET'].includes(String(detail?.code)) ? detail!.code : 'FORMAT',
            stage: 'image',
          },
        });
      throw failure;
    } finally {
      const count = (this.inFlight.get(account.id) ?? 1) - 1;
      if (count) this.inFlight.set(account.id, count);
      else this.inFlight.delete(account.id);
    }
  }
  disconnect(id: string) {
    this.clients.get(id)?.client.close();
    this.clients.delete(id);
  }
  close() {
    for (const id of this.clients.keys()) this.disconnect(id);
  }
}
