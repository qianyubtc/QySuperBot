import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type {
  ConnectorEvent,
  ExecutionReceipt,
  ConnectorCommand,
} from '../../../packages/contracts/src/index.ts';
import { idSchema } from '../../../packages/contracts/src/index.ts';
import type { Database, Row } from './database.ts';
import { ApiError, equal, sha, token, type SecretBox } from './security.ts';
import type { GroupSnapshot } from './adapters.ts';
import type { Presentation } from './presentation.ts';
import type { UploadsService } from './uploads.ts';
import { BinanceDirect, binanceAuthentication } from './binance-direct.ts';
import { audit, json } from './context.ts';
import { BinanceEnrollment } from './binance-enrollment.ts';

export const binanceGroupId = z.string().regex(/^[1-9]\d{0,18}$/);
const opaqueId = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform(String);
// Participant IDs are opaque strings; message cursors remain numeric.
const participantId = z
  .union([idSchema, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform(String);
const browserErrorSchema = z.object({
  code: z.enum(['HTTP', 'API', 'NETWORK', 'TIMEOUT', 'NON_JSON', 'FORMAT', 'PAGE', 'PERMISSION', 'SOCKET']),
  stage: z.enum([
    'profile',
    'groups',
    'image',
    'upload',
    'group',
    'member',
    'history',
    'token',
    'restriction',
    'domain',
    'socket',
    'send',
    'validation',
  ]),
  http_status: z.number().int().min(100).max(599).optional(),
  effect: z.enum(['none', 'possible']).optional(),
  api_code: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  detail: z
    .enum([
      'DATA_NULL',
      'DATA_ARRAY',
      'DATA_TYPE',
      'MESSAGES_MISSING',
      'MESSAGES_NULL',
      'MESSAGES_TYPE',
      'MESSAGES_LIMIT',
      'MESSAGE_ITEM',
      'MEMBER_UNKNOWN',
      'MEMBER_DENIED',
      'PAID_GROUP',
      'RESTRICTION_UNKNOWN',
      'DOMAIN_INVALID',
      'TOKEN_IDENTITY',
      'TOKEN_FORMAT',
      'TOKEN_EXPIRED',
      'SOCKET_TIMEOUT',
      'SOCKET_CLOSED',
      'SEND_REJECTED',
      'SEND_EXPIRED',
      'SEND_TIMEOUT',
    ])
    .optional(),
});
function browserErrorMessage(input: unknown) {
  const result = browserErrorSchema.safeParse(input);
  if (!result.success) return '币安网页请求未完成，请检查登录与桥接状态';
  const value = result.data;
  const labels = {
    profile: '聊天身份',
    groups: '已加入聊天室',
    image: '图片地址',
    upload: '图片上传',
    group: '群资料',
    member: '群成员权限',
    history: '消息列表',
    token: '聊天令牌',
    restriction: '账号发送限制',
    domain: '聊天服务器',
    socket: '消息连接',
    send: '发送确认',
    validation: '页面桥接',
  };
  const details = [
    value.code,
    value.http_status ? `HTTP ${value.http_status}` : '',
    value.api_code ? `币安码 ${value.api_code}` : '',
    value.detail
      ? {
          DATA_NULL: '消息响应数据为空',
          DATA_ARRAY: '消息响应直接返回数组',
          DATA_TYPE: '消息响应数据类型不兼容',
          MESSAGES_MISSING: '消息响应缺少 messages 字段',
          MESSAGES_NULL: 'messages 字段为空值',
          MESSAGES_TYPE: 'messages 字段不是数组',
          MESSAGES_LIMIT: '消息条数超过处理上限',
          MESSAGE_ITEM: '消息列表包含无效条目',
          MEMBER_UNKNOWN: '当前成员身份或权限尚未确认',
          MEMBER_DENIED: '当前成员或群的发送权限受限',
          PAID_GROUP: '付费群不支持在此移出成员',
          RESTRICTION_UNKNOWN: '账号文字发送限制尚未确认',
          DOMAIN_INVALID: '聊天服务器地址不兼容',
          TOKEN_IDENTITY: '聊天令牌与连接账号不一致',
          TOKEN_FORMAT: '聊天令牌格式不兼容',
          TOKEN_EXPIRED: '聊天令牌已过期',
          SOCKET_TIMEOUT: '聊天连接未通过心跳确认',
          SOCKET_CLOSED: '聊天连接已关闭',
          SEND_REJECTED: '币安拒绝了该次发送',
          SEND_EXPIRED: '本次发送窗口已过期',
          SEND_TIMEOUT: '消息发送确认超时，需核对结果',
        }[value.detail]
      : '',
  ]
    .filter(Boolean)
    .join('，');
  return `币安${labels[value.stage]}请求失败（${details}），请检查该 Chrome 的登录与聊天页面`;
}
function browserData<T>(schema: z.ZodType<T>, input: unknown, stage: '身份' | '群资料' | '消息列表'): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = new Set([
    'chatUserId',
    'group',
    'member',
    'group.id',
    'group.name',
    'group.totalMemberCount',
    'group.currentMemberCount',
    'group.systemMute',
    'group.ownerBan',
    'group.permissionMap',
    'member.role',
    'member.memberStatusInChannel',
    'member.permissionMap',
    'member.disabledReasonTypes',
    'group.disbanded',
    'group.windowMessageLimit',
    'restriction',
    'restriction.groupTextRestricted',
    'messages',
    'messages.msgId',
    'messages.sessionId',
    'messages.sessionType',
    'messages.msgType',
    'messages.timestamp',
    'messages.content',
    'messages.deleted',
    'messages.sender',
    'messages.sender.chatUserId',
    'messages.sender.nickname',
    'messages.sender.nickName',
    'messages.refMsg',
    'messages.refMsg.msgId',
  ]);
  // Describe only known field names and JSON types, never response values or arbitrary keys.
  const details = [
    ...new Set(
      result.error.issues.map((issue) => {
        const path = issue.path
          .filter((part) => typeof part === 'string')
          .slice(0, 3)
          .join('.');
        if (!fields.has(path)) return 'response';
        let value: unknown = input;
        for (const key of issue.path)
          value =
            value && typeof value === 'object' && Object.hasOwn(value, key)
              ? (value as Record<PropertyKey, unknown>)[key]
              : undefined;
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        const shape =
          typeof value === 'string'
            ? value.length === 0
              ? '(empty)'
              : value.length > 256
                ? '(long)'
                : /[\u0000-\u0020\u007f]/u.test(value)
                  ? '(control)'
                  : ''
            : '';
        return `${path}:${type}${shape}`;
      }),
    ),
  ]
    .slice(0, 4)
    .join('，');
  throw new ApiError(502, 'BINANCE_RESPONSE_FORMAT', `币安${stage}响应字段不兼容（${details}）`);
}
const memberSchema = z.object({
  role: z.number().int().nullish(),
  memberStatusInChannel: z.number().int().nullish(),
  permissionMap: z.record(z.string(), z.unknown()).nullish(),
  disabledReasonTypes: z.array(z.string().min(1).max(80)).max(32).nullish(),
});
const groupResponseSchema = z.object({
  management: z.object({ user_id: opaqueId, role: z.number().int(), active: z.boolean() }).optional(),
  group: z.object({
    id: opaqueId,
    name: z.string().min(1).max(1024),
    totalMemberCount: z.number().int().nonnegative().optional(),
    currentMemberCount: z.number().int().nonnegative().optional(),
    systemMute: z
      .union([z.boolean(), z.object({ muted: z.boolean().optional() })])
      .nullable()
      .optional(),
    ownerBan: z
      .union([z.boolean(), z.object({ banned: z.boolean().optional() })])
      .nullable()
      .optional(),
    permissionMap: z.record(z.string(), z.unknown()).nullish(),
    disbanded: z.boolean().nullish(),
    isVipCommunityGroup: z.boolean().nullish(),
    billingCycleType: z.unknown().optional(),
    billingFee: z.unknown().optional(),
    windowMessageLimit: z.number().int().nonnegative().nullish(),
  }),
  member: memberSchema,
  restriction: z.object({ groupTextRestricted: z.boolean().nullish() }).nullish(),
  restriction_error: browserErrorSchema.optional(),
});
type GroupResponse = z.infer<typeof groupResponseSchema>;
function flag(
  value: boolean | { muted?: boolean; banned?: boolean } | null | undefined,
  key: 'muted' | 'banned',
) {
  return typeof value === 'object' ? (value == null ? false : value[key]) : (value ?? false);
}
function sendingPermission(value: GroupResponse): {
  permission: 'granted' | 'denied' | 'unknown';
  reason: string;
} {
  const { group, member } = value;
  const manager = [1, 3].includes(member.role ?? -1);
  const modern = Array.isArray(member.disabledReasonTypes);
  const currentMember =
    member.memberStatusInChannel === 0 ||
    (member.memberStatusInChannel == null &&
      (manager || (modern && [0, 1, 2, 3].includes(member.role ?? -1))));
  const deny = (reason: string) => ({ permission: 'denied' as const, reason });
  const unknown = (reason: string) => ({ permission: 'unknown' as const, reason });
  if (member.memberStatusInChannel != null && member.memberStatusInChannel !== 0)
    return deny('币安返回当前账号未加入此群或已被移出');
  if (group.disbanded === true) return deny('币安返回此群已解散');
  if (group.windowMessageLimit === 0) return deny('币安返回当前消息发送额度已用尽');
  if (flag(group.systemMute, 'muted') === true) return deny('币安系统禁言尚未解除');
  if (member.permissionMap?.['1'] === true) return deny('币安返回当前成员已被禁言');
  if (modern && member.disabledReasonTypes!.length) {
    const labels: Record<string, string> = {
      NON_KYC_USER: '账号实名认证限制',
      CHANNEL_MUTED: '群禁言',
      SINGLE_MUTED: '成员禁言',
      PAID_GROUP_TRIAL: '付费群试用限制',
      RESTRICTED_BY_CS: '平台限制',
      MERCHANT_SUSPENDED: '商家账号受限',
    };
    return deny(
      '币安发送限制：' +
        [
          ...new Set(
            member.disabledReasonTypes!.map((code) =>
              Object.hasOwn(labels, code) ? labels[code] : '其他平台限制',
            ),
          ),
        ].join('、'),
    );
  }
  if (value.restriction?.groupTextRestricted === true) return deny('币安返回当前账号禁止发送群文字消息');
  if (value.restriction_error) return unknown('币安账号文字发送限制暂时无法核对');
  if (!manager && group.permissionMap?.['1'] === true) return deny('币安群已开启仅管理员发言');
  if (!manager && flag(group.ownerBan, 'banned') === true) return deny('币安返回群主限制尚未解除');
  if (!currentMember)
    return unknown(
      `尚未确认币安当前成员身份（角色 ${member.role ?? '未知'}，成员状态 ${member.memberStatusInChannel ?? '空'}）`,
    );
  if (
    flag(group.systemMute, 'muted') === undefined ||
    (!manager && flag(group.ownerBan, 'banned') === undefined)
  )
    return unknown('币安未返回完整的禁言状态');
  if (member.permissionMap?.['1'] != null && typeof member.permissionMap['1'] !== 'boolean')
    return unknown('币安返回的成员禁言标志不兼容');
  if (!manager && typeof group.permissionMap?.['1'] !== 'boolean')
    return unknown('币安未返回明确的群发言设置');
  if ((modern || member.memberStatusInChannel == null) && value.restriction?.groupTextRestricted !== false)
    return unknown('尚未核对币安账号的群文字发送限制，请更新浏览器桥接');
  if (modern) {
    if (![0, 1, 2, 3].includes(member.role ?? -1)) return unknown('币安未返回明确的当前成员角色');
  } else if (!manager && typeof member.permissionMap?.['1'] !== 'boolean') {
    return unknown('币安未返回明确的成员发言权限');
  }
  return { permission: 'granted', reason: '已核对币安当前成员角色、群禁言状态和发送限制' };
}

export function binancePermissionDiagnostics(input: unknown) {
  const value = browserData(groupResponseSchema, input, '群资料');
  const { member, group } = value;
  const boolean = (input: unknown) => (typeof input === 'boolean' ? input : null);
  return {
    role: member.role ?? null,
    member_status: member.memberStatusInChannel ?? null,
    disabled_reason_count: member.disabledReasonTypes?.length ?? null,
    group_muted: boolean(group.permissionMap?.['1']),
    member_muted: boolean(member.permissionMap?.['1']),
    system_muted: flag(group.systemMute, 'muted') ?? null,
    owner_banned: flag(group.ownerBan, 'banned') ?? null,
    text_restricted: value.restriction?.groupTextRestricted ?? null,
    restriction_error: value.restriction_error ? browserErrorMessage(value.restriction_error) : null,
    permission: sendingPermission(value),
  };
}

// Field and operation mappings follow the official web client.
const managementAmount = z.union([
  z.number().finite().nonnegative(),
  z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .transform(Number)
    .pipe(z.number().finite().nonnegative()),
]);
export function binanceGroup(
  id: string,
  input: unknown,
  management = false,
  expectedUser?: string,
): GroupSnapshot {
  const value = browserData(groupResponseSchema, input, '群资料');
  if (value.group.id !== id) throw new ApiError(502, 'BINANCE_GROUP_SCOPE', '币安返回了其他群的资料');
  const permission = sendingPermission(value);
  const memberKnown =
    value.member.memberStatusInChannel === 0 ||
    (value.member.memberStatusInChannel == null &&
      ([1, 3].includes(value.member.role ?? -1) ||
        ([0, 1, 2, 3].includes(value.member.role ?? -1) && Array.isArray(value.member.disabledReasonTypes))));
  const manager = value.management;
  const cycle = managementAmount.pipe(z.number().int()).safeParse(value.group.billingCycleType);
  const fee = managementAmount.safeParse(value.group.billingFee);
  const ordinaryGroup =
    value.group.disbanded !== true &&
    value.group.isVipCommunityGroup === false &&
    cycle.success &&
    fee.success;
  const paidGroup = (cycle.success && cycle.data > 0) || (fee.success && fee.data > 0);
  const managementPermission =
    manager && manager.user_id === expectedUser && ordinaryGroup
      ? manager.active && [1, 3].includes(manager.role)
        ? ('granted' as const)
        : ('denied' as const)
      : ('unknown' as const);
  const managementCapabilities = ['members.mute', 'members.remove'] as const;
  return {
    external_id: id,
    name: value.group.name,
    kind: 'group',
    member_count: value.group.totalMemberCount ?? value.group.currentMemberCount ?? null,
    capabilities: [
      ...['messages.read', 'messages.send'].map((capability) => ({
        capability: capability as 'messages.read' | 'messages.send',
        state: 'supported' as const,
      })),
      ...managementCapabilities.map((capability) => ({
        capability,
        state: management ? ('supported' as const) : ('unsupported' as const),
        reason: management ? '服务器直连支持；每次操作重新核对成员角色' : '币安成员管理需要启用服务器直连',
      })),
    ],
    permissions: [
      { capability: 'messages.read', permission: memberKnown ? 'granted' : 'unknown' },
      { capability: 'messages.send', ...permission },
      ...managementCapabilities.map((capability) => ({
        capability,
        permission: management
          ? capability === 'members.remove' && paidGroup
            ? ('denied' as const)
            : managementPermission
          : ('denied' as const),
        reason: !management
          ? '请先启用服务器直连'
          : capability === 'members.remove' && paidGroup
            ? '付费群移出成员涉及付费处理，请在币安官方页面操作'
            : managementPermission === 'granted'
              ? '实时核对当前账号为群主或管理员；不允许管理机器人自身及管理成员'
              : '未确认当前账号拥有普通群管理权限',
      })),
    ],
  };
}

export const binanceMessageSchema = z.object({
  msgId: opaqueId,
  sessionId: opaqueId,
  sessionType: z.string(),
  msgType: z.string(),
  timestamp: z.union([z.number().int().nonnegative(), z.string()]),
  content: z.string().max(32000).optional(),
  deleted: z.boolean().optional(),
  sender: z
    .object({
      chatUserId: participantId,
      nickname: z.string().max(1024).optional(),
      nickName: z.string().max(1024).optional(),
      name: z.string().max(1024).optional(),
      displayAlias: z.string().max(1024).nullish(),
      avatarUrl: z.string().max(8192).nullish(),
    })
    .optional(),
  refMsg: z.object({ msgId: opaqueId }).nullable().optional(),
});

export function binanceHistory(input: unknown) {
  return browserData(z.object({ messages: z.array(binanceMessageSchema).max(100) }), input, '消息列表');
}

export function binanceEvent(
  account: Row,
  input: unknown,
): { event: ConnectorEvent; name?: string; presentation?: Presentation } | null {
  const message = binanceMessageSchema.parse(input);
  if (message.sessionType !== 'GROUP' || !(account.settings?.group_ids ?? []).includes(message.sessionId))
    return null;
  const time =
    typeof message.timestamp === 'number' || /^\d+$/.test(message.timestamp)
      ? Number(message.timestamp)
      : Date.parse(message.timestamp);
  if (!Number.isSafeInteger(time) || time < 1 || time > Date.now() + 60_000)
    throw new ApiError(502, 'BINANCE_TIMESTAMP', '币安消息时间格式不正确');
  const base = {
    schema_version: '1' as const,
    event_id: `bn-${sha(JSON.stringify([message.sessionId, message.msgId, !!message.deleted]))}`,
    occurred_at: new Date(time).toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: message.sessionId },
  };
  if (message.deleted)
    return { event: { ...base, type: 'message.deleted', data: { message_id: message.msgId } } };
  // Payment cards, transfers, private chats, and system payloads are outside this connector's scope.
  const text =
    message.msgType === 'U_TEXT'
      ? message.content
      : (
          { U_IMAGE: '[图片]', U_VIDEO: '[视频]', U_FILE: '[文件]', U_STICKER: '[表情]' } as Record<
            string,
            string
          >
        )[message.msgType];
  if (!text || !message.sender) return null;
  return {
    event: {
      ...base,
      type: 'message.created',
      data: {
        message_id: message.msgId,
        sender_id: message.sender.chatUserId,
        direction: message.sender.chatUserId === account.external_id ? 'outgoing' : 'incoming',
        segments:
          message.msgType === 'U_IMAGE'
            ? [
                ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
                { type: 'image', asset_id: `bn-image-${message.msgId}`, alt: '币安群图片' },
              ]
            : [{ type: 'text', text }],
        ...(message.refMsg ? { reply_to: message.refMsg.msgId } : {}),
      },
    },
    name:
      message.sender.displayAlias ||
      message.sender.name ||
      message.sender.nickname ||
      message.sender.nickName,
    presentation: { avatar_url: message.sender.avatarUrl ?? undefined },
  };
}

type Operation =
  | 'profile'
  | 'groups'
  | 'image_url'
  | 'group'
  | 'history'
  | 'send'
  | 'send_image'
  | 'send_check'
  | 'member_check'
  | 'member_set_mute'
  | 'member_remove';
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Peer = {
  socket: WebSocket;
  session: string;
  pending: Map<string, Pending>;
  lastPong: number;
  extensionVersion: string | null;
};

// Browser credentials stay local; direct mode requires separate, explicit administrator configuration.
export class BinanceBridge {
  peers = new Map<string, Peer>();
  sockets = new Set<WebSocket>();
  server?: WebSocketServer;
  heartbeat?: ReturnType<typeof setInterval>;
  closing = false;
  onConnected?: (accountId: string) => Promise<unknown>;
  onDirectConnected?: (accountId: string) => Promise<unknown>;
  db: Database;
  box: SecretBox;
  direct: BinanceDirect;
  constructor(
    db: Database,
    box: SecretBox,
    readonly uploads: UploadsService,
  ) {
    this.db = db;
    this.box = box;
    this.direct = new BinanceDirect(db, box);
  }
  attach(server: Server) {
    if (this.server) throw new Error('Binance bridge already attached');
    const wss = (this.server = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 }));
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/v1/connectors/binance/socket') return;
      if (
        this.closing ||
        !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? '') ||
        this.sockets.size >= 32
      ) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.accept(ws);
      });
    });
    this.heartbeat = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (Date.now() - peer.lastPong > 45_000) peer.socket.terminate();
        else if (peer.socket.readyState === WebSocket.OPEN)
          peer.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15_000);
    this.heartbeat.unref();
  }
  async accept(socket: WebSocket) {
    this.sockets.add(socket);
    const nonce = token();
    const deadline = setTimeout(() => socket.terminate(), 10_000);
    let peer: Peer | undefined,
      accountId: string | undefined,
      authenticating = false;
    let enrollment: BinanceEnrollment | undefined;
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
      if (!peer) return;
      for (const item of peer.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new ApiError(502, 'BINANCE_DISCONNECTED', '币安浏览器连接已断开，执行结果需核对'));
      }
      peer.pending.clear();
      if (accountId && this.peers.get(accountId) === peer) {
        this.peers.delete(accountId);
        void this.db
          .query(
            "UPDATE accounts SET status='awaiting_auth',last_error='请恢复币安网页和浏览器桥接' WHERE id=$1 AND session_id=$2 AND status<>'paused'",
            [accountId, peer.session],
          )
          .catch(() => {});
      }
    });
    socket.on('message', (data) => {
      void (async () => {
        const value = JSON.parse(data.toString());
        if (!peer && (enrollment || value?.type === 'direct_hello')) {
          if (authenticating || Buffer.byteLength(data.toString()) > 65536) {
            enrollment?.abort.abort();
            socket.close(1008, 'Invalid authorization');
            return;
          }
          if (!enrollment) {
            clearTimeout(deadline);
            enrollment = new BinanceEnrollment(
              socket,
              nonce,
              this.db,
              this.box,
              async (account, input, signal) => {
                const result = await this.authentication(account, input, 'binance-extension', signal);
                try {
                  await this.onDirectConnected?.(account.id);
                  return result;
                } catch {
                  return { ...result, warning: '直连已保存，请在后台检查连接状态并刷新' };
                }
              },
            );
          }
          await enrollment.handle(value);
          return;
        }
        if (!peer) {
          if (authenticating) throw new ApiError(401, 'BINANCE_AUTH', 'Concurrent authentication');
          authenticating = true;
          const auth = z
            .object({
              type: z.literal('auth'),
              account_id: z.string().uuid(),
              proof: z.string().regex(/^[a-f0-9]{64}$/),
              version: z
                .string()
                .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/)
                .optional(),
            })
            .parse(value);
          const account = (await this.db.query('SELECT * FROM accounts WHERE id=$1', [auth.account_id]))[0];
          if (
            !account ||
            account.kind !== 'binance' ||
            account.settings.transport === 'direct' ||
            account.status === 'paused' ||
            !equal(
              auth.proof,
              createHmac('sha256', this.box.open(account.incoming_secret_box))
                .update(`qsb-binance-v1:${nonce}:${account.id}`)
                .digest('hex'),
            )
          )
            throw new ApiError(401, 'BINANCE_AUTH', 'Invalid authentication');
          if (socket.readyState !== WebSocket.OPEN) return;
          accountId = account.id;
          const previous = this.peers.get(account.id);
          peer = {
            socket,
            session: randomUUID(),
            pending: new Map(),
            lastPong: Date.now(),
            extensionVersion: auth.version ?? null,
          };
          this.peers.set(account.id, peer);
          previous?.socket.terminate();
          clearTimeout(deadline);
          const updated = await this.db.query(
            "UPDATE accounts SET session_id=$2,status='connecting',last_error=NULL WHERE id=$1 AND incoming_secret_box=$3 AND status<>'paused' AND COALESCE(settings->>'transport','bridge')<>'direct' RETURNING id",
            [account.id, peer.session, account.incoming_secret_box],
          );
          if (!updated.length) throw new ApiError(401, 'BINANCE_AUTH', 'Account paused');
          socket.send(JSON.stringify({ type: 'ready', group_ids: account.settings.group_ids }));
          void this.onConnected?.(account.id).catch(() => {});
          return;
        }
        if (value.type === 'pong') {
          peer.lastPong = Date.now();
          return;
        }
        const reply = z
          .object({
            type: z.literal('result'),
            id: z.string().uuid(),
            ok: z.boolean(),
            data: z.unknown().optional(),
            error: z.unknown().optional(),
          })
          .parse(value);
        const item = peer.pending.get(reply.id);
        if (!item) return;
        peer.pending.delete(reply.id);
        clearTimeout(item.timer);
        if (reply.ok) item.resolve(reply.data);
        else
          item.reject(
            Object.assign(new ApiError(502, 'BINANCE_BROWSER_REQUEST', browserErrorMessage(reply.error)), {
              bridgeError: reply.error,
            }),
          );
      })().catch((error) => {
        // A database failure or shutdown is retryable; only invalid credentials or
        // protocol input should tell the companion to stop reconnecting.
        const permanent =
          error instanceof SyntaxError ||
          error instanceof z.ZodError ||
          (error instanceof ApiError && error.code === 'BINANCE_AUTH');
        socket.close(
          permanent ? 1008 : 1011,
          permanent ? 'Invalid bridge message' : 'Bridge temporarily unavailable',
        );
      });
    });
    socket.send(JSON.stringify({ type: 'challenge', nonce, features: ['direct_authorization_v1'] }));
  }
  async request(account: Row, operation: Operation, params: Record<string, unknown> = {}) {
    const current = (await this.db.query('SELECT * FROM accounts WHERE id=$1', [account.id]))[0];
    if (current?.settings.transport === 'direct') return this.direct.request(current, operation, params);
    if (operation.startsWith('member_'))
      throw new ApiError(409, 'BINANCE_DIRECT_REQUIRED', '币安成员管理需要服务器直连，浏览器桥接不支持');
    const peer = this.peers.get(account.id);
    if (
      !current ||
      current.status === 'paused' ||
      !peer ||
      peer.socket.readyState !== WebSocket.OPEN ||
      current.session_id !== peer.session
    )
      throw new ApiError(409, 'BINANCE_BROWSER_OFFLINE', '请先连接已登录币安的浏览器桥接');
    if (params.group_id && !current.settings.group_ids.includes(params.group_id))
      throw new ApiError(403, 'BINANCE_GROUP_SCOPE', '此币安群不在连接授权范围内');
    if (peer.pending.size >= 16) throw new ApiError(429, 'BINANCE_BUSY', '币安桥接请求过多，请稍后再试');
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          peer.pending.delete(id);
          reject(new ApiError(504, 'BINANCE_TIMEOUT', '币安桥接请求超时，发送结果需核对'));
        },
        operation === 'send_image'
          ? 105_000
          : operation === 'groups'
            ? 90_000
            : operation === 'send_check'
              ? 35_000
              : 20_000,
      );
      peer.pending.set(id, { resolve, reject, timer });
      peer.socket.send(
        JSON.stringify({
          type: 'request',
          id,
          operation,
          group_ids: current.settings.group_ids,
          params: {
            ...params,
            ...(operation !== 'profile' && current.external_id
              ? { expected_user_id: current.external_id }
              : {}),
          },
        }),
        (error) => {
          if (error) {
            clearTimeout(timer);
            peer.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  updateScope(id: string, groupIds: string[]) {
    const peer = this.peers.get(id);
    const version = peer?.extensionVersion?.split('.').map(Number);
    if (
      peer?.socket.readyState === WebSocket.OPEN &&
      version &&
      (version[0]! > 0 || version[1]! > 1 || version[2]! >= 6)
    )
      peer.socket.send(JSON.stringify({ type: 'scope', group_ids: groupIds }));
  }
  requireVersion(account: Row, minor: number, patch: number) {
    if (account.settings.transport === 'direct') return;
    const peer = this.peers.get(account.id);
    if (!peer) throw new ApiError(409, 'BINANCE_BROWSER_OFFLINE', '请先连接已登录币安的浏览器桥接');
    const parts = peer.extensionVersion?.split('.').map(Number);
    if (!parts || (parts[0] === 0 && (parts[1]! < minor || (parts[1] === minor && parts[2]! < patch))))
      throw new ApiError(
        409,
        'BINANCE_EXTENSION_UPDATE',
        `此功能需要币安桥接 v0.${minor}.${patch} 或更新版本`,
      );
  }
  async joinedGroups(account: Row) {
    this.requireVersion(account, 1, 6);
    const identity = z
      .object({ chatUserId: opaqueId })
      .parse(await this.request(account, 'profile')).chatUserId;
    if (account.external_id && account.external_id !== identity)
      throw new ApiError(409, 'BINANCE_IDENTITY_CHANGED', '币安登录账号已变化，请重新连接');
    const groups = new Map<string, { id: string; name: string; member_count: number | null }>();
    for (const archived of [false, true]) {
      let timestamp: number | undefined;
      for (let page = 0; ; page++) {
        if (page >= 100)
          throw new ApiError(502, 'BINANCE_GROUP_LIMIT', '聊天室列表超过本次读取上限，请联系管理员');
        const result = z
          .object({
            groups: z
              .array(
                z.object({
                  id: binanceGroupId,
                  name: z.string().min(1).max(1024),
                  member_count: z.number().int().nonnegative().nullable(),
                }),
              )
              .max(20),
            has_more: z.boolean(),
            next_timestamp: z.number().int().positive().nullable(),
          })
          .parse(await this.request(account, 'groups', { archived, ...(timestamp ? { timestamp } : {}) }));
        for (const group of result.groups) groups.set(group.id, group);
        if (!result.has_more) break;
        if (!result.next_timestamp || (timestamp && result.next_timestamp >= timestamp))
          throw new ApiError(502, 'BINANCE_GROUP_PAGINATION', '聊天室列表分页未推进，请稍后重新读取');
        timestamp = result.next_timestamp;
      }
    }
    const confirmed = z
      .object({ chatUserId: opaqueId })
      .parse(await this.request(account, 'profile')).chatUserId;
    if (confirmed !== identity)
      throw new ApiError(409, 'BINANCE_IDENTITY_CHANGED', '读取列表时币安账号发生变化，请重新连接');
    return [...groups.values()];
  }
  async imageUrl(account: Row, groupId: string, messageId: string) {
    this.requireVersion(account, 1, 6);
    return z.object({ url: z.url({ protocol: /^https$/ }).max(8192) }).parse(
      await this.request(account, 'image_url', {
        group_id: groupId,
        message_id: opaqueId.parse(messageId),
      }),
    ).url;
  }
  async discover(account: Row) {
    const profile = browserData(
      z.object({ chatUserId: opaqueId }),
      await this.request(account, 'profile'),
      '身份',
    );
    if (account.external_id && account.external_id !== profile.chatUserId)
      throw new ApiError(409, 'BINANCE_IDENTITY_CHANGED', '币安登录账号已变化，请创建新连接');
    const groups: GroupSnapshot[] = [];
    for (const id of account.settings.group_ids)
      groups.push(
        binanceGroup(
          id,
          await this.request(account, 'group', { group_id: id }),
          account.settings.transport === 'direct',
          profile.chatUserId,
        ),
      );
    const confirmed = browserData(
      z.object({ chatUserId: opaqueId }),
      await this.request(account, 'profile'),
      '身份',
    );
    if (confirmed.chatUserId !== profile.chatUserId)
      throw new ApiError(409, 'BINANCE_IDENTITY_CHANGED', '币安登录账号在连接过程中发生变化，请重新连接');
    return { externalId: profile.chatUserId, displayName: account.name, groups };
  }
  async diagnose(account: Row, groupId: string) {
    if (account.kind !== 'binance') throw new ApiError(400, 'UNSUPPORTED', '此入口仅用于币安聊天');
    const input = await this.request(account, 'group', { group_id: binanceGroupId.parse(groupId) });
    binanceGroup(groupId, input);
    return {
      group_id: groupId,
      transport: account.settings.transport === 'direct' ? 'direct' : 'bridge',
      extension_version: this.peers.get(account.id)?.extensionVersion ?? null,
      ...binancePermissionDiagnostics(input),
    };
  }
  async checkSend(account: Row, input: unknown) {
    if (account.kind !== 'binance') throw new ApiError(400, 'UNSUPPORTED', '此入口仅用于币安聊天');
    const value = z.strictObject({ group_id: binanceGroupId }).parse(input);
    if (account.settings.transport !== 'direct' && !this.peers.has(account.id))
      throw new ApiError(409, 'BINANCE_BROWSER_OFFLINE', '请先连接已登录币安的浏览器桥接');
    const version = this.peers.get(account.id)?.extensionVersion;
    if (
      account.settings.transport !== 'direct' &&
      (!version || version.split('.').reduce((value, part) => value * 1000 + Number(part), 0) < 1004)
    )
      throw new ApiError(
        409,
        'BINANCE_EXTENSION_UPDATE',
        '请将币安浏览器桥接完整更新到 v0.1.4 或更新版本后再自检',
      );
    const result = await this.request(account, 'send_check', value);
    return z
      .object({
        connection: z.literal('open'),
        token_format: z.enum(['jwt', 'opaque']),
        token_expires_at: z.iso.datetime().nullable(),
      })
      .parse(result);
  }
  async execute(
    account: Row,
    command: ConnectorCommand,
    reviewRef?: Row,
    beforeMutation?: () => Promise<{ code: string; message: string; retryable?: boolean } | null>,
  ): Promise<ExecutionReceipt> {
    const base = {
      schema_version: '1' as const,
      command_id: command.command_id,
      attempt_id: command.attempt_id,
      attempt_number: command.attempt_number,
      revision: 1,
      observed_at: new Date().toISOString(),
    };
    if (command.action === 'member.set_mute' || command.action === 'member.remove') {
      const fail = (code: string, message: string): ExecutionReceipt => ({
        ...base,
        status: 'failed',
        error: { code, message, retryable: false },
      });
      if (
        account.settings.transport !== 'direct' ||
        reviewRef?.purpose !== 'binance-member-management' ||
        !beforeMutation
      )
        return fail('BINANCE_MANAGEMENT_SCOPE', '此操作需要服务器直连及已核对的后台成员管理任务');
      let beforeEffectPassed = false;
      try {
        const operation = command.action === 'member.remove' ? 'member_remove' : 'member_set_mute';
        const expected =
          command.action === 'member.set_mute' ? (command.params.muted ? 'muted' : 'unmuted') : 'removed';
        const result = z
          .object({
            group_id: opaqueId,
            user_id: opaqueId,
            state: z.enum(['muted', 'unmuted', 'removed']),
            verified_at: z.iso.datetime(),
          })
          .parse(
            await this.direct.request(
              account,
              operation,
              {
                group_id: command.target.conversation_id,
                user_id: command.params.user_id,
                ...(command.action === 'member.set_mute'
                  ? { muted: command.params.muted, expected_muted: command.params.expected_muted }
                  : {}),
                not_after: Math.min(Date.parse(command.expires_at), Date.parse(reviewRef.expires_at)),
              },
              async () => {
                const invalid = await beforeMutation();
                if (invalid) throw new ApiError(409, invalid.code, invalid.message);
                beforeEffectPassed = true;
              },
            ),
          );
        if (
          result.group_id !== command.target.conversation_id ||
          result.user_id !== command.params.user_id ||
          result.state !== expected
        )
          throw new Error('Member receipt mismatch');
        return { ...base, status: 'succeeded', result: { member: result } };
      } catch (error) {
        const detail = (error as { bridgeError?: { effect?: string } })?.bridgeError;
        if (detail?.effect === 'none' || (!beforeEffectPassed && detail?.effect !== 'possible'))
          return fail(
            'BINANCE_MEMBER_NOT_CHANGED',
            error instanceof ApiError ? error.message : '成员管理前置检查失败，未执行',
          );
        return {
          ...base,
          status: 'unknown',
          error: {
            code: 'BINANCE_MEMBER_UNCONFIRMED',
            message: '成员操作可能已生效，但未取得匹配的状态回读；请到币安核对，不会自动重试',
            retryable: false,
          },
        };
      }
    }
    if (
      command.action !== 'message.send' ||
      command.params.buttons ||
      command.params.thread_id ||
      command.params.segments.some((part) => !['text', 'image'].includes(part.type)) ||
      command.params.segments.filter((part) => part.type === 'image').length > 1
    )
      return {
        ...base,
        status: 'failed',
        error: {
          code: 'CONTENT_UNSUPPORTED',
          message: '当前币安连接支持文字、单张图片及图片说明',
          retryable: false,
        },
      };
    const text = command.params.segments.map((part) => (part.type === 'text' ? part.text : '')).join('');
    if (text.length > 2000)
      return {
        ...base,
        status: 'failed',
        error: { code: 'CONTENT_TOO_LONG', message: '币安连接暂限单条 2000 字', retryable: false },
      };
    const imageSegment = command.params.segments.find((part) => part.type === 'image');
    if (imageSegment?.type === 'image') {
      let image;
      try {
        this.requireVersion(account, 1, 8);
        image = await this.uploads.get(imageSegment.asset_id);
      } catch (error) {
        return {
          ...base,
          status: 'failed',
          error: {
            code: error instanceof ApiError ? error.code : 'IMAGE_ASSET_NOT_FOUND',
            message: error instanceof ApiError ? error.message : '图片尚未准备好，未发送',
            retryable: error instanceof ApiError && error.code === 'BINANCE_BROWSER_OFFLINE',
          },
        };
      }
      try {
        const result = z.object({ message_id: opaqueId }).parse(
          await this.request(account, 'send_image', {
            group_id: command.target.conversation_id,
            text,
            reply_to: command.params.reply_to,
            local_id: command.attempt_id,
            not_after: Math.min(Date.parse(command.expires_at), Date.now() + 90_000),
            image: {
              name: image.name,
              content_type: image.contentType,
              width: image.width,
              height: image.height,
              data: image.body.toString('base64'),
            },
          }),
        );
        return { ...base, status: 'succeeded', result };
      } catch (error) {
        const detail = (error as { bridgeError?: z.infer<typeof browserErrorSchema> })?.bridgeError;
        if (detail?.effect === 'none')
          return {
            ...base,
            status: 'failed',
            error: {
              code: 'BINANCE_IMAGE_NOT_SENT',
              message: error instanceof Error ? error.message : '币安图片发送前检查失败',
              retryable: ['NETWORK', 'TIMEOUT', 'SOCKET'].includes(detail.code),
            },
          };
        throw error; // An upload may already have published the image. Never auto-resend it.
      }
    }
    const result = z.object({ message_id: opaqueId }).parse(
      await this.request(account, 'send', {
        group_id: command.target.conversation_id,
        text,
        reply_to: command.params.reply_to,
        local_id: command.attempt_id,
        not_after: Math.min(Date.parse(command.expires_at), Date.now() + 17_000),
      }),
    );
    return { ...base, status: 'succeeded', result };
  }
  disconnect(id: string) {
    this.peers.get(id)?.socket.terminate();
    this.direct.disconnect(id);
  }
  async authentication(account: Row, input: unknown, actor: string, signal?: AbortSignal) {
    if (account.kind !== 'binance') throw new ApiError(400, 'UNSUPPORTED', '此入口仅用于币安聊天');
    if (account.status === 'paused') throw new ApiError(409, 'ACCOUNT_PAUSED', '请先恢复此账号连接');
    const value = binanceAuthentication.parse(input);
    if (value.mode === 'direct') {
      const prepared = await this.direct.prepare(account, value, binanceGroup, signal);
      await this.direct.save(account, prepared, actor, signal);
      // The old bridge cannot change the new session's state when its close handler runs.
      this.peers.get(account.id)?.socket.terminate();
      return { mode: 'direct', verified: true, socket: prepared.socket };
    }
    await this.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [account.id]))[0];
      if (!current || current.status === 'paused' || current.session_id !== account.session_id)
        throw new ApiError(409, 'BINANCE_CONNECTION_CHANGED', '连接状态已变化，请刷新后重试');
      const { direct_auth, transport, ...settings } = current.settings;
      await tx.query(
        `UPDATE accounts SET secret_box=NULL,session_id=NULL,status='awaiting_auth',last_error=NULL,
        settings=$2::jsonb WHERE id=$1`,
        [account.id, json({ ...settings, transport: 'bridge' })],
      );
      await audit(tx, actor, 'account.binance.direct_removed', account.id);
    });
    this.disconnect(account.id);
    return { mode: 'bridge', verified: false };
  }
  onModuleDestroy() {
    this.close();
  }
  close() {
    this.closing = true;
    this.direct.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.sockets) socket.terminate();
    this.server?.close();
  }
}
