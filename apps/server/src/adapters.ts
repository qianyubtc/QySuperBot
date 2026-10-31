import { randomUUID } from 'node:crypto';
import { conversationPageSchema, receiptSchema, signRequest } from '../../../packages/contracts/src/index.ts';
import type {
  Capability,
  ConnectorCommand,
  ConnectorEvent,
  ExecutionReceipt,
} from '../../../packages/contracts/src/index.ts';
import type { Config } from './config.ts';
import type { Row } from './database.ts';
import { requestJson } from './network.ts';
import { ApiError, SecretBox, sha } from './security.ts';
import type { BinanceBridge } from './binance.ts';
import { qqImages, type Presentation } from './presentation.ts';
import { FormData } from 'undici';
import type { UploadedImage, UploadsService } from './uploads.ts';
import { checkTelegramManagement, mutePermissions } from './telegram-members.ts';
import { qqVerificationPurposes } from './qq-verification.ts';
import type { QQMembershipProof } from './qq-verification.ts';

export function qqSucceeded(response: { status: number; data: any }) {
  return (
    response.status === 200 &&
    response.data?.retcode === 0 &&
    (response.data.status === undefined || response.data.status === 'ok')
  );
}

export interface GroupSnapshot {
  external_id: string;
  name: string;
  kind: string;
  member_count: number | null;
  capabilities: { capability: Capability; state: 'supported' | 'unsupported' | 'unknown' }[];
  permissions: { capability: Capability; permission: 'granted' | 'denied' | 'unknown'; reason?: string }[];
  observed_at?: string;
}
const common: Capability[] = [
  'conversations.list',
  'messages.read',
  'messages.send',
  'messages.delete',
  'members.list',
  'members.remove',
  'members.ban',
  'members.mute',
];
export function groupSnapshot(
  externalId: string,
  name: string,
  kind: string,
  count: number | null,
  platform: string,
  admin: boolean | null,
): GroupSnapshot {
  const capabilities: Capability[] =
    platform === 'demo'
      ? ['messages.read', 'messages.send', 'messages.delete']
      : platform === 'telegram'
        ? [
            'messages.read',
            'messages.send',
            'messages.delete',
            'members.ban',
            'interactions.buttons',
            'interactions.ack',
          ]
        : [
            'conversations.list',
            'messages.read',
            'messages.send',
            'messages.delete',
            'members.remove',
            ...(platform === 'qq' ? ['membership.review' as const, 'members.mute' as const] : []),
          ];
  const management = new Set([
    'messages.delete',
    'members.remove',
    'members.ban',
    'members.mute',
    'membership.review',
  ]);
  return {
    external_id: externalId,
    name,
    kind,
    member_count: count,
    capabilities: capabilities.map((capability) => ({ capability, state: 'supported' })),
    permissions: capabilities.map((capability) => ({
      capability,
      permission: management.has(capability)
        ? admin === null
          ? 'unknown'
          : admin
            ? 'granted'
            : 'denied'
        : 'granted',
    })),
  };
}
export function endpoint(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/$/, '') + path;
  url.search = '';
  url.hash = '';
  return url.toString();
}
export class Adapters {
  config: Config;
  box: SecretBox;
  binance?: BinanceBridge;
  constructor(
    config: Config,
    box: SecretBox,
    readonly uploads: UploadsService,
  ) {
    this.config = config;
    this.box = box;
  }
  async telegram(account: Row, action: string, params: unknown = {}, image?: UploadedImage) {
    let body: string | FormData = JSON.stringify(params);
    if (image) {
      body = new FormData();
      for (const [key, value] of Object.entries(params as Record<string, unknown>))
        if (value !== undefined)
          body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      body.set('photo', new Blob([new Uint8Array(image.body)], { type: image.contentType }), image.name);
    }
    return requestJson(`https://api.telegram.org/bot${this.box.open(account.secret_box)}/${action}`, {
      method: 'POST',
      body,
      headers: image ? {} : { 'content-type': 'application/json' },
      ...(image ? { timeoutMs: 45_000 } : {}),
    });
  }
  async telegramFileUrl(account: Row, fileId: string) {
    const result = await this.telegram(account, 'getFile', { file_id: fileId });
    const path = result.data.result?.file_path;
    if (
      !result.data.ok ||
      typeof path !== 'string' ||
      path.length > 2048 ||
      !path.split('/').every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part)) ||
      Number(result.data.result?.file_size ?? 0) > 8 * 1024 * 1024
    )
      throw new ApiError(502, 'IMAGE_UNAVAILABLE', '图片已失效或超过 8 MiB');
    return `https://api.telegram.org/file/bot${this.box.open(account.secret_box)}/${path}`;
  }
  async qq(
    account: Row,
    action: string,
    params: unknown = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    return requestJson(endpoint(account.endpoint, '/' + action), {
      method: 'POST',
      ...(action === 'send_group_msg' ? { timeoutMs: 45_000 } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      signal: options.signal,
      body: JSON.stringify(params),
      allowPrivate:
        this.config.allowPrivateConnectors ||
        (account.kind === 'qq' &&
          this.config.qqLocalPort !== undefined &&
          account.endpoint === `http://127.0.0.1:${this.config.qqLocalPort}`),
      headers: {
        'content-type': 'application/json',
        ...(account.secret_box ? { authorization: `Bearer ${this.box.open(account.secret_box)}` } : {}),
      },
    });
  }
  async qqMember(account: Row, groupId: string, userId: string): Promise<Row | null> {
    for (const source of ['list', 'member'] as const) {
      try {
        const response = await this.qq(
          account,
          source === 'list' ? 'get_group_member_list' : 'get_group_member_info',
          { group_id: groupId, ...(source === 'member' ? { user_id: userId } : {}), no_cache: true },
        );
        if (!qqSucceeded(response)) continue;
        const matches =
          source === 'list'
            ? (Array.isArray(response.data.data) ? response.data.data : []).filter(
                (m: Row) => String(m?.user_id) === userId,
              )
            : [response.data.data];
        const member = matches[0];
        if (
          matches.length === 1 &&
          String(member?.user_id) === userId &&
          String(member?.group_id) === groupId &&
          ['owner', 'admin', 'member'].includes(member?.role)
        )
          return member;
      } catch {
        /* Unknown membership cannot authorize automatic removal. */
      }
    }
    return null;
  }
  async qqRole(account: Row, groupId: string, userId: string) {
    // Some NapCat versions reject no_cache single-member lookups. Read the fresh
    // member list instead; never grant permissions from a cached fallback.
    for (const source of ['list', 'member'] as const) {
      try {
        const response = await this.qq(
          account,
          source === 'list' ? 'get_group_member_list' : 'get_group_member_info',
          { group_id: groupId, ...(source === 'member' ? { user_id: userId } : {}), no_cache: true },
        );
        if (!qqSucceeded(response)) continue;
        const matches =
          source === 'list'
            ? (Array.isArray(response.data.data) ? response.data.data : []).filter(
                (member: any) => String(member?.user_id) === userId,
              )
            : [response.data.data];
        if (matches.length !== 1) continue;
        const member = matches[0];
        if (
          String(member?.user_id) !== userId ||
          String(member?.group_id) !== groupId ||
          !['owner', 'admin', 'member'].includes(member?.role)
        )
          continue;
        return {
          admin: member.role !== 'member',
          reason:
            member.role === 'member'
              ? '当前 QQ 为普通成员，需要群主授予管理员权限'
              : `已通过实时${source === 'list' ? '成员列表' : '成员资料'}确认当前 QQ 为${member.role === 'owner' ? '群主' : '管理员'}`,
        };
      } catch {
        /* A failed identity lookup cannot grant management permission. */
      }
    }
    return { admin: null, reason: '暂时无法确认当前 QQ 在此群的身份，请刷新权限；未按管理员授权' };
  }
  async discover(
    account: Row,
    knownExternalIds: string[] = [],
  ): Promise<{ externalId: string; displayName: string; groups: GroupSnapshot[] }> {
    if (account.kind === 'binance' && this.binance) return this.binance.discover(account);
    if (account.kind === 'telegram') {
      const me = await this.telegram(account, 'getMe');
      if (!me.data.ok) throw new ApiError(502, 'TELEGRAM_AUTH_FAILED', 'Telegram Token 验证失败');
      const webhook = await this.telegram(account, 'getWebhookInfo');
      if (!webhook.data.ok || typeof webhook.data.result?.url !== 'string')
        throw new ApiError(502, 'TELEGRAM_WEBHOOK_CHECK', '暂时无法核对 Telegram 消息接收模式，请稍后重试');
      if (webhook.data.result.url)
        throw new ApiError(
          409,
          'TELEGRAM_WEBHOOK_ACTIVE',
          '此机器人已有 Webhook；当前后台使用轮询，请先确认原服务的接收方式再切换',
        );
      const groups: GroupSnapshot[] = [];
      for (const id of knownExternalIds)
        groups.push(await this.telegramGroup(account, id, String(me.data.result.id)));
      return { externalId: String(me.data.result.id), displayName: me.data.result.first_name, groups };
    }
    if (account.kind === 'qq') {
      const me = await this.qq(account, 'get_login_info');
      if (!qqSucceeded(me) || !/^\d+$/.test(String(me.data.data?.user_id ?? '')))
        throw new ApiError(502, 'QQ_UNAVAILABLE', 'QQ 桥接尚未登录或接口不可用');
      if (account.external_id && account.external_id !== String(me.data.data.user_id))
        throw new ApiError(409, 'QQ_IDENTITY_CHANGED', 'QQ 登录账号已变化，请恢复原账号或创建新连接');
      const list = await this.qq(account, 'get_group_list', { no_cache: true });
      if (!qqSucceeded(list) || !Array.isArray(list.data.data))
        throw new ApiError(502, 'QQ_UNAVAILABLE', 'QQ 桥接尚未登录或接口不可用');
      const groups: GroupSnapshot[] = [];
      for (const item of list.data.data.slice(0, 500)) {
        const role = await this.qqRole(account, String(item.group_id), String(me.data.data.user_id));
        const snapshot = groupSnapshot(
          String(item.group_id),
          item.group_name,
          'group',
          item.member_count ?? null,
          'qq',
          role.admin,
        );
        for (const permission of snapshot.permissions)
          if (['messages.delete', 'members.remove', 'membership.review'].includes(permission.capability))
            permission.reason = role.reason;
        groups.push(snapshot);
      }
      const confirmed = await this.qq(account, 'get_login_info');
      if (!qqSucceeded(confirmed) || String(confirmed.data.data?.user_id) !== String(me.data.data.user_id))
        throw new ApiError(409, 'QQ_IDENTITY_CHANGED', '权限查询期间 QQ 登录状态或账号已变化，请刷新原连接');
      return { externalId: String(me.data.data.user_id), displayName: me.data.data.nickname, groups };
    }
    if (account.kind === 'custom') {
      if (!account.session_id)
        throw new ApiError(409, 'HANDSHAKE_REQUIRED', '请先在聊天项目中完成连接器握手');
      const groups: GroupSnapshot[] = [];
      let cursor: string | null = null;
      let snapshotId: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const url = new URL(endpoint(account.endpoint, '/superbot/v1/conversations'));
        url.searchParams.set('limit', '100');
        if (cursor) {
          url.searchParams.set('cursor', cursor);
          url.searchParams.set('snapshot_id', snapshotId!);
        }
        const path = url.pathname + url.search;
        const response = await requestJson(url.toString(), {
          allowPrivate: this.config.allowPrivateConnectors,
          headers: Object.fromEntries(
            signRequest({
              method: 'GET',
              path,
              body: '',
              keyId: account.outgoing_key_id,
              purpose: 'control',
              secret: this.box.open(account.outgoing_secret_box),
            }),
          ),
        });
        if (response.status !== 200)
          throw new ApiError(502, 'DISCOVERY_FAILED', '聊天项目的群发现接口返回失败');
        const page = conversationPageSchema.parse(response.data);
        if (
          page.connector_id !== account.id ||
          page.account_id !== account.id ||
          page.session_id !== account.session_id ||
          (snapshotId && snapshotId !== page.snapshot_id)
        )
          throw new ApiError(502, 'DISCOVERY_SCOPE', '群快照与当前账号、会话或分页不匹配');
        snapshotId = page.snapshot_id;
        for (const item of page.items)
          groups.push({
            external_id: item.conversation_id,
            name: item.name,
            kind: item.kind,
            member_count: item.member_count,
            capabilities: item.capabilities,
            permissions: item.permissions,
            observed_at: item.observed_at,
          });
        cursor = page.next_cursor;
        if (!cursor) return { externalId: account.id, displayName: account.name, groups };
      }
      throw new ApiError(502, 'DISCOVERY_LIMIT', '分页超出限制，请缩小连接器的群范围');
    }
    throw new ApiError(400, 'UNSUPPORTED_CONNECTOR', '此连接器不支持外部刷新');
  }
  async telegramGroup(account: Row, externalId: string, botId = account.external_id): Promise<GroupSnapshot> {
    const [chat, member, count] = await Promise.all([
      this.telegram(account, 'getChat', { chat_id: externalId }),
      this.telegram(account, 'getChatMember', { chat_id: externalId, user_id: botId }),
      this.telegram(account, 'getChatMemberCount', { chat_id: externalId }),
    ]);
    if (!chat.data.ok)
      throw new ApiError(502, 'GROUP_UNAVAILABLE', '无法访问此 Telegram 群，请确认机器人已经加入');
    if (!['group', 'supergroup', 'channel'].includes(chat.data.result.type))
      throw new ApiError(400, 'TELEGRAM_GROUP_REQUIRED', '此入口仅支持 Telegram 群或频道');
    const admin = member.data.ok ? ['administrator', 'creator'].includes(member.data.result.status) : null;
    const snapshot = groupSnapshot(
      externalId,
      chat.data.result.title ?? externalId,
      chat.data.result.type === 'channel' ? 'channel' : 'group',
      count.data.ok ? count.data.result : null,
      'telegram',
      admin,
    );
    if (chat.data.result.type === 'supergroup') {
      snapshot.capabilities.push({ capability: 'members.mute', state: 'supported' });
      snapshot.permissions.push({
        capability: 'members.mute',
        permission: admin === null ? 'unknown' : admin ? 'granted' : 'denied',
      });
    }
    if (member.data.ok && member.data.result.status === 'administrator') {
      const restrictions: Record<string, boolean> = {
        'messages.delete': !!member.data.result.can_delete_messages,
        'members.remove': !!member.data.result.can_restrict_members,
        'members.ban': !!member.data.result.can_restrict_members,
        'members.mute': !!member.data.result.can_restrict_members,
        'membership.review': !!member.data.result.can_invite_users,
      };
      for (const permission of snapshot.permissions)
        if (permission.capability in restrictions)
          permission.permission = restrictions[permission.capability] ? 'granted' : 'denied';
    }
    if (snapshot.kind === 'channel') {
      const canPost =
        member.data.ok && (member.data.result.status === 'creator' || !!member.data.result.can_post_messages);
      const permission = snapshot.permissions.find((item) => item.capability === 'messages.send');
      if (permission) permission.permission = canPost ? 'granted' : 'denied';
    }
    const status = member.data.result?.status;
    for (const permission of snapshot.permissions) {
      if (!member.data.ok) {
        permission.permission = 'unknown';
        permission.reason = '尚未确认机器人在该群的当前身份和权限';
      } else if (
        ['left', 'kicked'].includes(status) ||
        (status === 'restricted' && member.data.result.is_member !== true)
      ) {
        permission.permission = 'denied';
        permission.reason = '机器人已离开此群或已被移除';
      } else if (
        permission.capability === 'messages.send' &&
        status === 'restricted' &&
        member.data.result.can_send_messages !== true
      ) {
        permission.permission = 'denied';
        permission.reason = '机器人在此群已被限制发言';
      } else if (
        permission.capability === 'messages.send' &&
        snapshot.kind !== 'channel' &&
        status === 'member' &&
        chat.data.result.permissions?.can_send_messages === false
      ) {
        permission.permission = 'denied';
        permission.reason = '该群当前不允许普通成员发言，请核对机器人的管理员权限';
      }
    }
    return snapshot;
  }
  async execute(
    account: Row,
    command: ConnectorCommand,
    reviewRef?: Row,
    beforeMutation?: (
      proof?: QQMembershipProof,
    ) => Promise<{ code: string; message: string; retryable?: boolean } | null>,
  ): Promise<ExecutionReceipt> {
    if (account.kind === 'binance' && this.binance) {
      if (reviewRef?.purpose === 'keyword') {
        const blocked = await beforeMutation?.();
        if (!beforeMutation || blocked)
          return {
            schema_version: '1',
            command_id: command.command_id,
            attempt_id: command.attempt_id,
            attempt_number: command.attempt_number,
            revision: 1,
            observed_at: new Date().toISOString(),
            status: 'failed',
            error: {
              code: blocked?.code ?? 'KEYWORD_SCOPE',
              message: blocked?.message ?? '无法核对关键词任务',
              retryable: false,
            },
          };
      }
      return this.binance.execute(account, command, reviewRef, beforeMutation);
    }
    const base = {
      schema_version: '1' as const,
      command_id: command.command_id,
      attempt_id: command.attempt_id,
      attempt_number: command.attempt_number,
      revision: 1,
      observed_at: new Date().toISOString(),
    };
    const fail = (code: string, message: string, retryable = false): ExecutionReceipt => ({
      ...base,
      status: 'failed',
      error: { code, message, retryable },
    });
    if (account.kind === 'custom') {
      const url = new URL(endpoint(account.endpoint, '/superbot/v1/commands'));
      const body = JSON.stringify(command);
      const response = await requestJson(url.toString(), {
        method: 'POST',
        body,
        allowPrivate: this.config.allowPrivateConnectors,
        headers: Object.fromEntries(
          signRequest({
            method: 'POST',
            path: url.pathname + url.search,
            body,
            keyId: account.outgoing_key_id,
            purpose: 'commands',
            secret: this.box.open(account.outgoing_secret_box),
          }),
        ),
      });
      if (![200, 202].includes(response.status)) throw new Error('External command result is unconfirmed');
      const receipt = receiptSchema.parse(response.data);
      if (
        receipt.command_id !== command.command_id ||
        receipt.attempt_id !== command.attempt_id ||
        receipt.attempt_number !== command.attempt_number
      )
        throw new Error('Receipt identity mismatch');
      return receipt;
    }
    const target = command.target.conversation_id;
    if (account.kind === 'telegram') {
      if (command.action === 'member.mute' || command.action === 'member.ban') {
        try {
          await checkTelegramManagement(
            (action, params) => this.telegram(account, action, params),
            account,
            target,
            command.params.user_id,
            command.action === 'member.mute' ? 'mute' : 'ban',
            reviewRef?.actor_id ?? undefined,
          );
          if (command.action === 'member.mute') {
            if (command.params.duration_seconds < 60 || command.params.duration_seconds > 30 * 86400)
              return fail('TG_DURATION', '禁言时长需为 60 秒至 30 天');
            const chat = await this.telegram(account, 'getChat', { chat_id: target });
            if (
              chat.status !== 200 ||
              chat.data?.ok !== true ||
              String(chat.data.result?.id) !== target ||
              chat.data.result.type !== 'supergroup'
            )
              return fail('TG_SUPERGROUP_REQUIRED', '限时禁言仅支持 Telegram 超级群');
          }
        } catch (error) {
          return fail(
            error instanceof ApiError ? error.code : 'TG_PREFLIGHT_UNAVAILABLE',
            error instanceof ApiError ? error.message : 'Telegram 身份或权限查询失败，未执行管理操作',
            true,
          );
        }
      }
      let action: string;
      let params: any;
      let image: UploadedImage | undefined;
      switch (command.action) {
        case 'message.send': {
          const images = command.params.segments.filter((item) => item.type === 'image');
          if (
            images.length > 1 ||
            command.params.segments.some((item) => !['text', 'image'].includes(item.type))
          )
            return fail('CONTENT_UNSUPPORTED', 'Telegram 当前支持文字或单张图片加说明');
          const text = command.params.segments
            .map((item) => (item.type === 'text' ? item.text : ''))
            .join('');
          if (text.length > (images.length ? 1024 : 4096))
            return fail('CONTENT_TOO_LONG', 'Telegram 消息超过单条长度限制，请拆分内容');
          if (images[0]) {
            try {
              image = await this.uploads.get(images[0].asset_id);
            } catch {
              return fail('IMAGE_ASSET_NOT_FOUND', '上传图片不存在，未执行发送');
            }
          }
          const keyboard = command.params.buttons?.map((row) =>
            row.map((button) =>
              button.type === 'callback'
                ? { text: button.label, callback_data: button.value }
                : { text: button.label, url: button.url },
            ),
          );
          if (
            keyboard
              ?.flat()
              .some((button) => 'callback_data' in button && Buffer.byteLength(button.callback_data!) > 64)
          )
            return fail('CALLBACK_TOO_LONG', '按钮回调数据超出平台限制');
          action = image ? 'sendPhoto' : 'sendMessage';
          for (const id of [command.params.reply_to, command.params.thread_id].filter(Boolean)) {
            if (!/^\d+$/.test(id!) || !Number.isSafeInteger(Number(id)) || Number(id) < 1)
              return fail('INVALID_REPLY', 'Telegram 引用或话题消息 ID 无效');
          }
          params = {
            chat_id: target,
            ...(image ? { caption: text } : { text }),
            ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
            ...(command.params.reply_to
              ? {
                  reply_parameters: {
                    message_id: Number(command.params.reply_to),
                    allow_sending_without_reply: false,
                  },
                }
              : {}),
            ...(command.params.thread_id ? { message_thread_id: Number(command.params.thread_id) } : {}),
          };
          break;
        }
        case 'message.delete':
          action = 'deleteMessage';
          params = { chat_id: target, message_id: command.params.message_id };
          break;
        case 'member.remove':
          // Telegram has no single atomic kick-with-rejoin operation; never silently ban instead.
          return fail(
            'CAPABILITY_UNSUPPORTED',
            '第一版未执行 Telegram 的组合踢出操作，请人工处理或明确选择封禁',
          );
        case 'member.ban':
          action = 'banChatMember';
          params = { chat_id: target, user_id: command.params.user_id };
          break;
        case 'member.mute': {
          const until =
            reviewRef?.until_date ?? Math.floor(Date.now() / 1000) + command.params.duration_seconds;
          if (
            !Number.isSafeInteger(until) ||
            until - Math.floor(Date.now() / 1000) < 31 ||
            until - Math.floor(Date.now() / 1000) > 30 * 86400
          )
            return fail('TG_MUTE_EXPIRED', '禁言请求已过期，未执行操作');
          action = 'restrictChatMember';
          params = {
            chat_id: target,
            user_id: command.params.user_id,
            permissions: mutePermissions,
            use_independent_chat_permissions: true,
            until_date: until,
          };
          break;
        }
        case 'interaction.ack':
          action = 'answerCallbackQuery';
          params = { callback_query_id: command.params.interaction_id, text: command.params.text };
          break;
        default:
          return fail('CAPABILITY_UNSUPPORTED', '此平台动作尚未接入执行器');
      }
      if (
        command.action === 'member.mute' ||
        command.action === 'member.ban' ||
        reviewRef?.purpose === 'keyword'
      ) {
        const blocked = await beforeMutation?.();
        if (blocked) return fail(blocked.code, blocked.message, blocked.retryable ?? false);
        if (reviewRef?.purpose === 'keyword' && !beforeMutation)
          return fail('KEYWORD_SCOPE', '无法核对关键词任务');
        if (
          reviewRef?.purpose === 'member-management' &&
          (!Number.isFinite(new Date(reviewRef.expires_at).getTime()) ||
            new Date(reviewRef.expires_at).getTime() <= Date.now())
        )
          return fail('MEMBER_ACTION_EXPIRED', '成员管理请求已过期，请核对后重新提交');
      }
      const result = await this.telegram(account, action, params, image);
      if (command.action === 'member.mute' || command.action === 'member.ban') {
        if (result.status === 200 && result.data?.ok === true && result.data.result === true)
          return { ...base, status: 'succeeded', result: {} };
        if (
          result.data?.ok === false &&
          [400, 403, 429].includes(result.data.error_code) &&
          [200, result.data.error_code].includes(result.status)
        )
          return fail(
            'TELEGRAM_REJECTED',
            `Telegram 拒绝请求（${result.data.error_code}）`,
            result.data.error_code === 429,
          );
        throw Error('Telegram management receipt is unconfirmed');
      }
      if (!result.data.ok)
        return fail(
          'TELEGRAM_REJECTED',
          `Telegram 拒绝请求（${result.data.error_code ?? result.status}）`,
          result.data.error_code === 429,
        );
      if (
        command.action === 'message.send' &&
        (!Number.isSafeInteger(result.data.result?.message_id) || result.data.result.message_id < 1)
      )
        throw new Error('Telegram send result has no confirmed message ID');
      return {
        ...base,
        status: 'succeeded',
        result: {
          ...(result.data.result?.message_id ? { message_id: String(result.data.result.message_id) } : {}),
        },
      };
    }
    if (account.kind === 'qq') {
      const qqVerification = qqVerificationPurposes.has(reviewRef?.purpose);
      const keyword = reviewRef?.purpose === 'keyword';
      let membershipProof: QQMembershipProof | undefined;
      let verificationProtected = false;
      let action: string;
      let params: any;
      if (command.action === 'message.send') {
        if (
          command.params.buttons ||
          command.params.segments.some((item) => !['text', 'image'].includes(item.type))
        )
          return fail('CONTENT_UNSUPPORTED', 'QQ 当前支持文字和图片消息');
        const parts: any[] = [];
        for (const item of command.params.segments) {
          if (item.type === 'text') parts.push({ type: 'text', data: { text: item.text } });
          else if (item.type === 'image') {
            let image;
            try {
              image = await this.uploads.get(item.asset_id);
            } catch {
              return fail('IMAGE_ASSET_NOT_FOUND', '上传图片不存在，未执行发送');
            }
            parts.push({ type: 'image', data: { file: `base64://${image.body.toString('base64')}` } });
          }
        }
        action = 'send_group_msg';
        params = {
          group_id: target,
          message: [
            ...(command.params.reply_to ? [{ type: 'reply', data: { id: command.params.reply_to } }] : []),
            ...(qqVerification
              ? [
                  { type: 'at', data: { qq: reviewRef!.user_id } },
                  { type: 'text', data: { text: '\n' } },
                ]
              : []),
            ...parts,
          ],
        };
      } else if (command.action === 'message.delete') {
        action = 'delete_msg';
        params = { message_id: command.params.message_id };
      } else if (command.action === 'member.remove') {
        action = 'set_group_kick';
        params = { group_id: target, user_id: command.params.user_id, reject_add_request: false };
      } else if (command.action === 'member.mute') {
        if (
          keyword
            ? !beforeMutation ||
              command.params.duration_seconds < 60 ||
              command.params.duration_seconds > 30 * 86400
            : !['qq-verification-failure', 'qq-verification-timeout-mute'].includes(reviewRef?.purpose) ||
              command.params.duration_seconds !== 600
        )
          return fail('QQ_VERIFICATION_SCOPE', 'QQ 禁言仅允许经过核对的验证失败任务');
        action = 'set_group_ban';
        params = {
          group_id: target,
          user_id: command.params.user_id,
          duration: command.params.duration_seconds,
        };
      } else if (command.action === 'membership.approve') {
        if (reviewRef?.purpose !== 'qq-join-review' || reviewRef.request_id !== command.params.request_id)
          return fail('QQ_REQUEST_SCOPE', '无法核对入群申请与目标群，未执行审核');
        let flag: string;
        try {
          flag = this.box.open(reviewRef.flag_box);
          if (!flag || flag.length > 1024) throw Error();
        } catch {
          return fail('QQ_REQUEST_INVALID', '入群申请资料不可用，未执行审核');
        }
        action = 'set_group_add_request';
        params = { flag, sub_type: 'add', approve: true };
      } else return fail('CAPABILITY_UNSUPPORTED', '此 QQ 动作尚未接入执行器');
      // The OneBot service can be logged into another QQ without its URL changing.
      // Check its current identity before issuing any group mutation.
      let identity;
      try {
        identity = await this.qq(account, 'get_login_info');
      } catch {
        return fail('QQ_UNAVAILABLE', '暂时无法核对 QQ 登录身份，未执行操作', true);
      }
      if (!qqSucceeded(identity) || !/^\d+$/.test(String(identity.data.data?.user_id ?? '')))
        return fail('QQ_UNAVAILABLE', 'QQ 桥接尚未登录，未执行操作', true);
      if (!account.external_id || String(identity.data.data.user_id) !== account.external_id)
        return fail('QQ_IDENTITY_CHANGED', 'QQ 登录账号已变化，请恢复原账号或创建新连接');
      if (command.action !== 'message.send') {
        const role = await this.qqRole(account, target, account.external_id);
        if (role.admin !== true)
          return fail(
            role.admin === false ? 'QQ_PERMISSION_DENIED' : 'QQ_PERMISSION_UNKNOWN',
            role.reason,
            role.admin === null,
          );
      }
      if (qqVerification && reviewRef?.purpose !== 'qq-verification-notice') {
        const member = await this.qqMember(account, target, reviewRef!.user_id);
        if (!member) return fail('QQ_VERIFICATION_MEMBER_UNKNOWN', '无法实时确认成员身份，请人工核对');
        verificationProtected = member.role !== 'member' || reviewRef!.user_id === account.external_id;
        membershipProof = {
          join_time: typeof member.join_time === 'number' ? member.join_time : undefined,
          muted_until: typeof member.shut_up_timestamp === 'number' ? member.shut_up_timestamp : undefined,
        };
      }
      if (command.action !== 'message.send' || qqVerification || keyword) {
        // Role queries can take time. The same bridge URL can switch accounts
        // while they run; recheck the actor immediately before the mutation.
        let confirmed;
        try {
          confirmed = await this.qq(account, 'get_login_info');
        } catch {
          return fail('QQ_UNAVAILABLE', '暂时无法再次核对 QQ 登录身份，未执行操作', true);
        }
        if (!qqSucceeded(confirmed)) return fail('QQ_UNAVAILABLE', 'QQ 登录状态尚未确认，未执行操作', true);
        if (String(confirmed.data.data?.user_id) !== account.external_id)
          return fail('QQ_IDENTITY_CHANGED', '权限查询期间 QQ 登录账号已变化，未执行操作');
      }
      if (keyword) {
        if (!beforeMutation) return fail('KEYWORD_SCOPE', '无法核对关键词任务');
        const blocked = await beforeMutation();
        if (blocked) return fail(blocked.code, blocked.message, blocked.retryable ?? false);
      }
      if (command.action === 'membership.approve' || qqVerification) {
        if (qqVerification && !beforeMutation)
          return fail('QQ_VERIFICATION_SCOPE', '无法核对验证任务，未执行');
        const blocked = await beforeMutation?.(membershipProof);
        if (blocked) return fail(blocked.code, blocked.message, blocked.retryable ?? false);
        if (verificationProtected)
          return fail('QQ_VERIFICATION_PROTECTED', '群主、管理员及机器人自身不参与自动验证处分');
        if (
          !Number.isFinite(new Date(reviewRef!.expires_at).getTime()) ||
          new Date(reviewRef!.expires_at).getTime() <= Date.now()
        )
          return fail(
            qqVerification ? 'QQ_VERIFICATION_JOB_EXPIRED' : 'QQ_REQUEST_EXPIRED',
            qqVerification ? '验证任务已过期，请在后台核对' : '入群审核请求已过期，请在 QQ 客户端核对',
          );
      }
      const response = await this.qq(account, action, params);
      if (!qqSucceeded(response)) {
        if (
          response.status === 200 &&
          (response.data?.status === undefined || response.data.status === 'failed') &&
          [100, 1400, 1403, 1404].includes(response.data?.retcode)
        )
          return fail('QQ_REJECTED', 'QQ 桥接明确拒绝了此操作');
        throw new Error('QQ operation outcome is unknown');
      }
      const messageId = response.data.data?.message_id;
      if (
        command.action === 'message.send' &&
        !(
          (typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId !== 0) ||
          (typeof messageId === 'string' && /^-?[1-9]\d*$/.test(messageId))
        )
      )
        throw new Error('QQ send result has no confirmed message ID');
      return {
        ...base,
        status: 'succeeded',
        result: {
          ...(response.data.data?.message_id ? { message_id: String(response.data.data.message_id) } : {}),
        },
      };
    }
    throw new Error('Unsupported executor');
  }
}

export function telegramEvents(
  account: Row,
  update: any,
): { event: ConnectorEvent; name?: string; chat?: any; presentation?: Presentation }[] {
  const result: { event: ConnectorEvent; name?: string; chat?: any; presentation?: Presentation }[] = [];
  const message =
    update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  const base = (chatId: string, suffix: string, date?: number) => ({
    schema_version: '1' as const,
    event_id: `tg-${update.update_id}-${suffix}`,
    occurred_at: new Date((date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: chatId },
  });
  if (message && ['group', 'supergroup', 'channel'].includes(message.chat?.type)) {
    const chatId = String(message.chat.id);
    for (const user of message.new_chat_members ?? [])
      if (String(user.id) !== account.external_id)
        result.push({
          event: {
            ...base(chatId, `join-${user.id}`, message.date),
            type: 'member.joined',
            data: { user_id: String(user.id), membership_id: `tg-${update.update_id}-${user.id}` },
          },
          chat: message.chat,
        });
    if (message.left_chat_member)
      result.push({
        event: {
          ...base(chatId, 'leave', message.date),
          type: 'member.left',
          data: { user_id: String(message.left_chat_member.id), membership_id: 'unknown' },
        },
        chat: message.chat,
      });
    const text =
      message.text ??
      message.caption ??
      (message.photo ? '[图片]' : message.video ? '[视频]' : message.document ? '[文件]' : null);
    const photo = Array.isArray(message.photo)
      ? message.photo
          .filter((p: any) => typeof p.file_id === 'string' && Number(p.file_size ?? 0) <= 8 * 1024 * 1024)
          .at(-1)
      : undefined;
    const fileId =
      photo?.file_id ??
      (message.document?.mime_type?.startsWith('image/') ? message.document.file_id : undefined);
    const assetId = `tg-image-${message.message_id}`;
    if (text || fileId)
      result.push({
        event: {
          ...base(chatId, 'message', message.edit_date ?? message.date),
          type: update.edited_message || update.edited_channel_post ? 'message.edited' : 'message.created',
          data: {
            message_id: String(message.message_id),
            sender_id: String(message.from?.id ?? message.sender_chat?.id ?? 'unknown'),
            direction: String(message.from?.id) === account.external_id ? 'outgoing' : 'incoming',
            segments: fileId
              ? [
                  ...(message.caption ? [{ type: 'text' as const, text: String(message.caption) }] : []),
                  { type: 'image', asset_id: assetId, alt: 'Telegram 图片' },
                ]
              : [{ type: 'text', text }],
            ...(message.reply_to_message ? { reply_to: String(message.reply_to_message.message_id) } : {}),
            ...(message.message_thread_id ? { thread_id: String(message.message_thread_id) } : {}),
          },
        },
        name:
          [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
          message.sender_chat?.title ||
          message.chat.title ||
          '频道成员',
        presentation: fileId
          ? { images: [{ provider: 'telegram', asset_id: assetId, file_id: fileId }] }
          : undefined,
        chat: message.chat,
      });
  }
  const callback = update.callback_query;
  if (callback?.message?.chat)
    result.push({
      event: {
        ...base(String(callback.message.chat.id), 'callback'),
        type: 'interaction.created',
        data: {
          interaction_id: String(callback.id),
          user_id: String(callback.from.id),
          value: callback.data ?? '',
          expires_at: new Date(Date.now() + 8_000).toISOString(),
          acknowledged: true,
          message_id: String(callback.message.message_id),
        },
      },
      chat: callback.message.chat,
    });
  return result;
}

export function qqEvents(
  account: Row,
  payload: any,
): { event: ConnectorEvent; name?: string; presentation?: Presentation }[] {
  if (!payload.group_id) return [];
  const base = {
    schema_version: '1' as const,
    event_id: `qq-${sha(JSON.stringify(payload))}`,
    occurred_at: new Date(Number(payload.time ?? Date.now() / 1000) * 1000).toISOString(),
    source: { connector_id: account.id, account_id: account.id, conversation_id: String(payload.group_id) },
  };
  if (payload.post_type === 'message' && payload.message_type === 'group') {
    const images = qqImages(payload);
    let imageIndex = 0;
    const replyId = Array.isArray(payload.message)
      ? payload.message.find((item: any) => item.type === 'reply')?.data?.id
      : undefined;
    const hasMentions =
      Array.isArray(payload.message) &&
      payload.message.some(
        (part: any) => part.type === 'at' && /^[1-9]\d{4,19}$/.test(String(part.data?.qq)),
      );
    const content = Array.isArray(payload.message)
      ? payload.message
          .filter((item: any) => item.type !== 'reply')
          .map((item: any) => (item.type === 'text' ? (item.data?.text ?? '') : `[${item.type}]`))
          .join('')
      : String(payload.raw_message ?? payload.message ?? '');
    if (!content) return [];
    return [
      {
        event: {
          ...base,
          type: 'message.created',
          data: {
            message_id: String(payload.message_id),
            sender_id: String(payload.user_id),
            direction: String(payload.user_id) === account.external_id ? 'outgoing' : 'incoming',
            segments:
              Array.isArray(payload.message) && (images.length || hasMentions)
                ? payload.message
                    .filter((part: any) => part.type !== 'reply')
                    .slice(0, 100)
                    .map((part: any) =>
                      part.type === 'image'
                        ? { type: 'image' as const, asset_id: images[imageIndex++]!.asset_id, alt: 'QQ 图片' }
                        : part.type === 'at' && /^[1-9]\d{4,19}$/.test(String(part.data?.qq))
                          ? { type: 'mention' as const, user_id: String(part.data.qq) }
                          : {
                              type: 'text' as const,
                              text: (part.type === 'text'
                                ? String(part.data?.text || ' ')
                                : `[${part.type}]`
                              ).slice(0, 32000),
                            },
                    )
                : [{ type: 'text', text: content.slice(0, 32000) }],
            ...(replyId !== undefined ? { reply_to: String(replyId) } : {}),
          },
        },
        name: payload.sender?.card || payload.sender?.nickname,
        presentation: { images },
      },
    ];
  }
  if (payload.notice_type === 'group_increase')
    return [
      {
        event: {
          ...base,
          type: 'member.joined',
          data: { user_id: String(payload.user_id), membership_id: base.event_id },
        },
      },
    ];
  if (payload.notice_type === 'group_decrease')
    return [
      {
        event: {
          ...base,
          type: 'member.left',
          data: { user_id: String(payload.user_id), membership_id: 'unknown' },
        },
      },
    ];
  return [];
}
