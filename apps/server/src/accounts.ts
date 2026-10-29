import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  acceptHeartbeat,
  conversationSchema,
  handshakeSchema,
  heartbeatSchema,
  permissionSnapshotSchema,
  verifyRequest,
} from '../../../packages/contracts/src/index.ts';
import type { ReplayStore } from '../../../packages/contracts/src/index.ts';
import type { Row, Sql } from './database.ts';
import type { Context } from './context.ts';
import { audit, epoch, json } from './context.ts';
import { accountInput, defaultPolicy } from './inputs.ts';
import { ApiError, equal, sha, token } from './security.ts';
import { groupSnapshot } from './adapters.ts';
import { binanceGroupId } from './binance.ts';
import type { GroupSnapshot } from './adapters.ts';
import { idSchema } from '../../../packages/contracts/src/index.ts';
import { binanceConnection, hasBinanceLoginIssue } from './binance-health.ts';

export class AccountsService {
  ctx: Context;
  constructor(ctx: Context) {
    this.ctx = ctx;
  }
  async list(): Promise<Row[]> {
    const accounts = await this.ctx.db
      .query(`SELECT a.id,a.platform,a.kind,a.name,a.status,a.external_id,a.endpoint,a.settings,a.last_seen_at,a.last_error,a.is_demo,a.created_at,
      a.session_id AS health_session,(SELECT value FROM metadata WHERE key='binance-health:'||a.id) AS health_metadata,
      (SELECT count(*)::int FROM bindings b WHERE b.account_id=a.id) AS group_count FROM accounts a ORDER BY a.created_at`);
    return accounts.map(({ health_session, health_metadata, ...account }) => ({
      ...account,
      ...(account.kind === 'binance'
        ? {
            connection: binanceConnection(
              { ...account, session_id: health_session },
              health_metadata,
              this.ctx.config.binanceBrowserEnabled,
            ),
          }
        : {}),
    }));
  }
  async get(id: string, sql: Sql = this.ctx.db): Promise<Row> {
    const value = (await sql.query('SELECT * FROM accounts WHERE id=$1', [id]))[0];
    if (!value) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '连接账号不存在');
    return value;
  }
  async create(input: unknown, actor: string, sql: Sql = this.ctx.db) {
    const value = accountInput.parse(input);
    const id = randomUUID();
    const incoming = token();
    const outgoing = token();
    const incomingKey = `evt_${id}`;
    const outgoingKey = `cmd_${id}`;
    await sql.query(
      `INSERT INTO accounts(id,platform,kind,name,endpoint,secret_box,incoming_key_id,incoming_secret_box,outgoing_key_id,outgoing_secret_box,settings)
      VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        id,
        value.kind,
        value.name,
        value.endpoint ?? null,
        value.token ? this.ctx.box.seal(value.token) : null,
        incomingKey,
        this.ctx.box.seal(incoming),
        outgoingKey,
        this.ctx.box.seal(outgoing),
        json(
          value.kind === 'binance'
            ? { group_ids: [...new Set(value.group_ids ?? [])], group_revision: '0' }
            : {},
        ),
      ],
    );
    await audit(sql, actor, 'account.created', id, { kind: value.kind, name: value.name });
    return {
      id,
      ...(value.kind === 'binance'
        ? {
            binance_bridge: {
              server_url:
                this.ctx.config.publicOrigin.replace(/^http/, 'ws') + '/api/v1/connectors/binance/socket',
              account_id: id,
              pairing_secret: incoming,
            },
          }
        : {}),
      credentials: {
        connector_id: id,
        account_id: id,
        event_key_id: incomingKey,
        event_secret: incoming,
        command_key_id: outgoingKey,
        command_secret: outgoing,
        events_url: `${this.ctx.config.publicOrigin}/api/v1/connector-events`,
        handshake_url: `${this.ctx.config.publicOrigin}/api/v1/connectors/handshake`,
        ...(value.kind === 'qq'
          ? {
              qq_events_url: `${this.ctx.config.publicOrigin}/api/v1/connectors/qq/${id}/events`,
              qq_webhook_token: incoming,
            }
          : {}),
      },
    };
  }
  async upsertGroup(account: Row, group: GroupSnapshot, sql: Sql = this.ctx.db): Promise<string> {
    const namespace = ['telegram', 'qq', 'binance'].includes(account.kind) ? account.kind : account.id;
    const id = sha(json([namespace, group.external_id])).slice(0, 32);
    const snapshot = conversationSchema.parse({
      connector_id: account.id,
      account_id: account.id,
      conversation_id: group.external_id,
      name: group.name,
      kind: ['group', 'community', 'channel', 'direct'].includes(group.kind) ? group.kind : 'other',
      member_count: group.member_count,
      observed_at: group.observed_at ?? new Date().toISOString(),
      capabilities: group.capabilities,
      permissions: group.permissions,
    });
    if (epoch(snapshot.observed_at) > Date.now() + 60_000)
      throw new ApiError(400, 'FUTURE_SNAPSHOT', '群权限快照时间超出允许范围');
    await sql.query(
      `INSERT INTO conversations(id,platform,name,kind,external_id,executor_account_id,member_count,policy,policy_version,is_demo)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,member_count=EXCLUDED.member_count,observed_at=now()`,
      [
        id,
        account.platform,
        group.name,
        group.kind,
        group.external_id,
        account.id,
        group.member_count,
        json(defaultPolicy),
        randomUUID(),
        account.is_demo,
      ],
    );
    await sql.query(
      `INSERT INTO bindings(account_id,external_id,conversation_id,snapshot) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(account_id,external_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,observed_at=now()
      WHERE (bindings.snapshot->>'observed_at')::timestamptz < (EXCLUDED.snapshot->>'observed_at')::timestamptz`,
      [account.id, group.external_id, id, json(snapshot)],
    );
    return id;
  }
  async refresh(id: string, actor: string, resume = false) {
    if (resume)
      await this.ctx.db.query("UPDATE accounts SET status='configuring' WHERE id=$1 AND status='paused'", [
        id,
      ]);
    const account = await this.get(id);
    if (account.status === 'paused')
      throw new ApiError(409, 'ACCOUNT_PAUSED', '账号已暂停，请由管理员重新连接');
    if (account.kind === 'demo')
      return {
        groups: (await this.ctx.db.query('SELECT conversation_id FROM bindings WHERE account_id=$1', [id]))
          .length,
      };
    try {
      const known = await this.ctx.db.query('SELECT external_id FROM bindings WHERE account_id=$1', [id]);
      const result = await this.ctx.adapters.discover(
        account,
        known.map((item) => item.external_id),
      );
      await this.ctx.db.transaction(async (tx) => {
        const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [id]))[0]!;
        if (
          current.status === 'paused' ||
          (account.kind === 'binance' && current.status === 'expired' && account.status !== 'expired') ||
          (['binance', 'qq', 'telegram'].includes(account.kind) &&
            (current.settings.group_revision ?? '0') !== (account.settings.group_revision ?? '0')) ||
          (['custom', 'binance'].includes(account.kind) && current.session_id !== account.session_id)
        )
          throw new ApiError(409, 'STALE_CONNECTION', '账号状态或连接会话已变化，请重新连接');
        if (current.kind === 'binance' && current.settings.transport === 'direct') {
          const health = (
            await tx.query('SELECT value FROM metadata WHERE key=$1', [`binance-health:${id}`])
          )[0]?.value;
          if (hasBinanceLoginIssue(current, health))
            throw new ApiError(409, 'STALE_CONNECTION', '币安登录失效状态尚未解除，请重新登录');
        }
        if (current.kind === 'qq' && current.external_id && current.external_id !== result.externalId)
          throw new ApiError(409, 'QQ_IDENTITY_CHANGED', 'QQ 账号已绑定其他身份，未覆盖账号或群权限');
        if (account.kind === 'telegram') {
          const lock = `telegram-bot:${result.externalId}`;
          await tx.query('INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', [
            lock,
            '{}',
          ]);
          await tx.query('SELECT key FROM metadata WHERE key=$1 FOR UPDATE', [lock]);
          const duplicate = (
            await tx.query(
              "SELECT id FROM accounts WHERE kind='telegram' AND external_id=$1 AND id<>$2 AND status<>'paused' LIMIT 1",
              [result.externalId, id],
            )
          )[0];
          if (duplicate)
            throw new ApiError(
              409,
              'TELEGRAM_DUPLICATE_BOT',
              '此机器人已存在另一个未暂停的连接，请使用原连接或先暂停它',
            );
        }
        for (const group of result.groups) await this.upsertGroup(account, group, tx);
        if (account.kind === 'qq')
          await tx.query('UPDATE accounts SET settings=$2::jsonb WHERE id=$1', [
            id,
            json({
              ...current.settings,
              discovered_group_ids: result.groups.map((group) => group.external_id),
            }),
          ]);
        await tx.query(
          "UPDATE accounts SET external_id=$2,status='online',last_seen_at=now(),last_error=NULL WHERE id=$1",
          [id, result.externalId],
        );
        await audit(tx, actor, 'account.refreshed', id, { groups: result.groups.length });
      });
      return { groups: result.groups.length };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'STALE_CONNECTION') throw error;
      if ((error as { staleConnection?: boolean })?.staleConnection)
        throw new ApiError(409, 'STALE_CONNECTION', '连接状态已更新，请以后台最新检查结果为准');
      const message = error instanceof ApiError ? error.message : '连接器响应格式或账号身份不正确';
      await this.ctx.db.query(
        "UPDATE accounts SET status=CASE WHEN kind='binance' AND status='expired' THEN status ELSE 'error' END,last_error=CASE WHEN kind='binance' AND status='expired' THEN last_error ELSE $2 END WHERE id=$1 AND status<>'paused' AND ($3::text IS NULL OR session_id=$3)",
        [id, message, ['custom', 'binance'].includes(account.kind) ? account.session_id : null],
      );
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'CONNECTOR_RESPONSE', message);
    }
  }
  async addTelegramGroup(id: string, input: unknown, actor: string) {
    const value = z.strictObject({ external_id: z.string().regex(/^-?\d+$/) }).parse(input);
    const account = await this.get(id);
    if (account.kind !== 'telegram') throw new ApiError(400, 'UNSUPPORTED', '此入口仅用于添加 Telegram 群');
    const group = await this.ctx.adapters.telegramGroup(account, value.external_id);
    const groupId = await this.upsertGroup(account, group);
    await audit(this.ctx.db, actor, 'conversation.connected', groupId);
    return { id: groupId };
  }
  async checkBinance(id: string, actor: string) {
    const account = await this.get(id);
    if (account.kind !== 'binance') throw new ApiError(400, 'UNSUPPORTED', '此入口仅用于币安聊天');
    await this.refresh(id, actor);
    const current = await this.get(id);
    const ensureCurrent = async () => {
      const latest = await this.get(id);
      if (
        latest.status === 'paused' ||
        latest.session_id !== current.session_id ||
        (latest.settings.group_revision ?? '0') !== (current.settings.group_revision ?? '0')
      )
        throw new ApiError(409, 'STALE_CONNECTION', '检查期间连接或同步群已变化，请重新检查');
      return latest;
    };
    let failed = 0,
      checked = 0;
    for (const group_id of current.settings.group_ids) {
      await ensureCurrent();
      checked++;
      try {
        await this.ctx.adapters.binance!.request(current, 'history', { group_id });
        await ensureCurrent();
        await this.ctx.adapters.binance!.checkSend(current, { group_id });
      } catch (error) {
        await ensureCurrent();
        if ((error as { staleConnection?: boolean })?.staleConnection)
          throw new ApiError(409, 'STALE_CONNECTION', '连接状态已更新，请以最新结果为准');
        failed++;
        if ((await this.get(id)).status === 'expired') break;
      }
    }
    await ensureCurrent();
    const latest = (await this.list()).find((a) => a.id === id)!;
    return {
      checked_groups: checked,
      target_groups: current.settings.group_ids.length,
      failed_groups: failed,
      connection: latest.connection,
    };
  }
  async binanceGroups(id: string, refresh = false) {
    let account = await this.get(id);
    if (account.kind !== 'binance') throw new ApiError(400, 'UNSUPPORTED', '此入口仅用于币安聊天');
    const key = `binance-groups:${id}`;
    if (refresh) {
      const session = account.session_id;
      const groups = await this.ctx.adapters.binance!.joinedGroups(account);
      await this.ctx.db.transaction(async (tx) => {
        const current = await this.get(id, tx);
        if (current.session_id !== session || current.status === 'paused')
          throw new ApiError(409, 'STALE_CONNECTION', '浏览器连接已变化，请重新读取群列表');
        await tx.query(
          'INSERT INTO metadata(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
          [key, json({ groups, session_id: session, observed_at: new Date().toISOString() })],
        );
      });
      account = await this.get(id);
    }
    const cached = (await this.ctx.db.query('SELECT value FROM metadata WHERE key=$1', [key]))[0]?.value;
    const known = new Map<string, Row>((cached?.groups ?? []).map((group: Row) => [group.id, group]));
    for (const groupId of account.settings.group_ids ?? [])
      if (!known.has(groupId)) {
        const old = (
          await this.ctx.db.query(
            'SELECT c.name,c.member_count FROM bindings b JOIN conversations c ON c.id=b.conversation_id WHERE b.account_id=$1 AND b.external_id=$2',
            [id, groupId],
          )
        )[0];
        known.set(groupId, {
          id: groupId,
          name: old?.name ?? `群 ${groupId}`,
          member_count: old?.member_count ?? null,
          unavailable: true,
        });
      }
    return {
      groups: [...known.values()],
      group_ids: account.settings.group_ids ?? [],
      revision: account.settings.group_revision ?? '0',
      discovered_at: cached?.observed_at ?? null,
    };
  }
  async groups(id: string, refresh = false) {
    let account = await this.get(id);
    if (!['qq', 'telegram'].includes(account.kind))
      throw new ApiError(400, 'UNSUPPORTED', '此入口用于 QQ 或 Telegram 群选择');
    if (refresh) {
      await this.refresh(id, '群列表刷新');
      account = await this.get(id);
    }
    const bindings = await this.ctx.db.query(
      'SELECT b.external_id,b.snapshot,b.observed_at,c.name,c.member_count FROM bindings b JOIN conversations c ON c.id=b.conversation_id WHERE b.account_id=$1 ORDER BY c.name,b.external_id',
      [id],
    );
    return {
      groups: bindings.map((binding) => ({
        id: binding.external_id,
        name: binding.name,
        member_count: binding.member_count,
        unavailable:
          (account.kind === 'qq' &&
            Array.isArray(account.settings.discovered_group_ids) &&
            !account.settings.discovered_group_ids.includes(binding.external_id)) ||
          binding.snapshot.permissions.find((p: Row) => p.capability === 'messages.read')?.permission ===
            'denied',
      })),
      group_ids: account.settings.group_ids ?? bindings.map((binding) => binding.external_id),
      revision: account.settings.group_revision ?? '0',
      discovered_at:
        bindings
          .map((binding) => new Date(binding.observed_at).toISOString())
          .sort()
          .at(-1) ?? null,
    };
  }
  async selectGroups(id: string, input: unknown, actor: string) {
    const value = z
      .strictObject({ group_ids: z.array(idSchema).max(500), revision: z.string().min(1).max(64) })
      .parse(input);
    const selected = [...new Set(value.group_ids)];
    await this.ctx.db.transaction(async (tx) => {
      const account = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '连接账号不存在');
      if (!['qq', 'telegram'].includes(account.kind))
        throw new ApiError(400, 'UNSUPPORTED', '此入口用于 QQ 或 Telegram 群选择');
      if ((account.settings.group_revision ?? '0') !== value.revision)
        throw new ApiError(409, 'SELECTION_CHANGED', '同步范围已变化，请重新读取群列表');
      const bindings = await tx.query('SELECT external_id,snapshot FROM bindings WHERE account_id=$1', [id]);
      const previous = account.settings.group_ids ?? bindings.map((b) => b.external_id);
      for (const groupId of selected.filter((groupId) => !previous.includes(groupId))) {
        const binding = bindings.find((b) => b.external_id === groupId);
        if (
          !binding ||
          (account.kind === 'qq' &&
            Array.isArray(account.settings.discovered_group_ids) &&
            !account.settings.discovered_group_ids.includes(groupId)) ||
          binding.snapshot.permissions.find((p: Row) => p.capability === 'messages.read')?.permission ===
            'denied'
        )
          throw new ApiError(403, 'GROUP_SCOPE', '只能选择当前账号已发现并可访问的群');
      }
      if (selected.some((groupId) => !bindings.some((b) => b.external_id === groupId)))
        throw new ApiError(403, 'GROUP_SCOPE', '只能选择已发现的群');
      await tx.query('UPDATE accounts SET settings=$2::jsonb WHERE id=$1', [
        id,
        json({ ...account.settings, group_ids: selected, group_revision: randomUUID() }),
      ]);
      await tx.query(
        "UPDATE jobs SET status='cancelled',last_error='此群已取消同步',updated_at=now() WHERE account_id=$1 AND status='pending' AND conversation_id IN (SELECT conversation_id FROM bindings WHERE account_id=$1 AND NOT(external_id=ANY($2::text[])))",
        [id, selected],
      );
      await audit(tx, actor, 'account.groups_selected', id, { selected });
    });
    return this.groups(id);
  }
  async selectBinanceGroups(id: string, input: unknown, actor: string) {
    const value = z
      .strictObject({ group_ids: z.array(binanceGroupId).max(20), revision: z.string().min(1).max(64) })
      .parse(input);
    const selected = [...new Set(value.group_ids)];
    await this.ctx.db.transaction(async (tx) => {
      const account = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '连接账号不存在');
      if (account.kind !== 'binance') throw new ApiError(400, 'UNSUPPORTED', '此入口仅用于币安聊天');
      if ((account.settings.group_revision ?? '0') !== value.revision)
        throw new ApiError(409, 'SELECTION_CHANGED', '同步范围已被更新，请重新打开群选择后再保存');
      const previous: string[] = account.settings.group_ids ?? [];
      const additions = selected.filter((groupId) => !previous.includes(groupId));
      if (additions.length) {
        const cached = (
          await tx.query('SELECT value FROM metadata WHERE key=$1', [`binance-groups:${id}`])
        )[0]?.value;
        if (
          !cached ||
          cached.session_id !== account.session_id ||
          epoch(cached.observed_at) < Date.now() - 15 * 60_000
        )
          throw new ApiError(409, 'GROUP_LIST_STALE', '请先刷新已加入的聊天室列表');
        if (additions.some((groupId) => !cached.groups.some((group: Row) => group.id === groupId)))
          throw new ApiError(403, 'BINANCE_GROUP_SCOPE', '只能选择当前账号已加入的聊天室');
      }
      await tx.query('UPDATE accounts SET settings=$2::jsonb WHERE id=$1', [
        id,
        json({ ...account.settings, group_ids: selected, group_revision: randomUUID() }),
      ]);
      for (const groupId of additions) {
        await tx.query('DELETE FROM binance_cursors WHERE account_id=$1 AND external_id=$2', [id, groupId]);
        const cached = (
          await tx.query('SELECT value FROM metadata WHERE key=$1', [`binance-groups:${id}`])
        )[0]!.value;
        const group = cached.groups.find((item: Row) => item.id === groupId);
        await this.upsertGroup(
          account,
          {
            external_id: groupId,
            name: group.name,
            kind: 'group',
            member_count: group.member_count,
            capabilities: [
              { capability: 'messages.read', state: 'supported' },
              { capability: 'messages.send', state: 'supported' },
            ],
            permissions: [
              { capability: 'messages.read', permission: 'granted' },
              { capability: 'messages.send', permission: 'unknown', reason: '正在核对群发送权限' },
            ],
          },
          tx,
        );
      }
      await tx.query(
        "UPDATE jobs SET status='cancelled',last_error='此群已取消同步',updated_at=now() WHERE account_id=$1 AND status='pending' AND conversation_id IN (SELECT conversation_id FROM bindings WHERE account_id=$1 AND NOT(external_id=ANY($2::text[])))",
        [id, selected],
      );
      await audit(tx, actor, 'account.binance.groups_selected', id, { selected });
    });
    this.ctx.adapters.binance!.updateScope(id, selected);
    let warning: string | null = null;
    try {
      await this.refresh(id, actor);
    } catch (error) {
      warning = error instanceof ApiError ? error.message : '同步范围已保存，权限信息将在恢复连接后刷新';
    }
    return { ...(await this.binanceGroups(id)), warning };
  }
  async pairBinance(id: string, actor: string) {
    const secret = token();
    const account = await this.get(id);
    if (account.kind !== 'binance') throw new ApiError(400, 'UNSUPPORTED', '此连接不是币安聊天');
    if (account.settings.transport === 'direct')
      throw new ApiError(409, 'BINANCE_MODE', '请先切回浏览器桥接，再重新配对');
    if (account.status === 'paused') throw new ApiError(409, 'ACCOUNT_PAUSED', '请先恢复此账号连接');
    const updated = await this.ctx.db.query(
      "UPDATE accounts SET incoming_secret_box=$2,status='awaiting_auth',session_id=NULL,last_error=NULL WHERE id=$1 AND status<>'paused' AND COALESCE(settings->>'transport','bridge')<>'direct' RETURNING id",
      [id, this.ctx.box.seal(secret)],
    );
    if (!updated.length) throw new ApiError(409, 'ACCOUNT_PAUSED', '账号已暂停');
    this.ctx.adapters.binance?.disconnect(id);
    await audit(this.ctx.db, actor, 'account.binance.pairing_rotated', id);
    return {
      server_url: this.ctx.config.publicOrigin.replace(/^http/, 'ws') + '/api/v1/connectors/binance/socket',
      account_id: id,
      pairing_secret: secret,
    };
  }
  async authenticateHmac(
    headers: Headers,
    method: string,
    path: string,
    body: Buffer,
    purpose: 'events' | 'control',
  ) {
    const key = headers.get('x-superbot-key-id');
    const account = key
      ? (await this.ctx.db.query('SELECT * FROM accounts WHERE incoming_key_id=$1', [key]))[0]
      : undefined;
    if (!account || account.status === 'paused') throw new ApiError(401, 'UNKNOWN_KEY', '连接凭据无效');
    const replayStore: ReplayStore = {
      consume: async (identity, expiresAt) => {
        await this.ctx.db.query('DELETE FROM nonces WHERE expires_at<now()');
        const inserted = await this.ctx.db.query(
          'INSERT INTO nonces(key,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING key',
          [identity, new Date(expiresAt * 1000).toISOString()],
        );
        return inserted.length === 1;
      },
    };
    await verifyRequest({
      headers,
      method,
      path,
      body,
      purpose,
      keyId: account.incoming_key_id,
      secret: this.ctx.box.open(account.incoming_secret_box),
      scope: account.id,
      replayStore,
    });
    let payload: any;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new ApiError(400, 'INVALID_JSON', '请求体不是有效 JSON');
    }
    return { account, payload };
  }
  async handshake(account: Row, input: unknown) {
    const value = handshakeSchema.parse(input);
    if (value.connector_id !== account.id || value.account_id !== account.id || account.kind !== 'custom')
      throw new ApiError(403, 'ACCOUNT_SCOPE', '握手账号不在此凭据范围内');
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const changed = await this.ctx.db.query(
      "UPDATE accounts SET session_id=$2,session_expires_at=$3,heartbeat_sequence=0,status='online',last_seen_at=now(),last_error=NULL WHERE id=$1 AND status<>'paused' RETURNING id",
      [account.id, sessionId, expiresAt],
    );
    if (!changed.length) throw new ApiError(409, 'ACCOUNT_PAUSED', '账号已暂停');
    return {
      schema_version: '1',
      connector_id: account.id,
      account_id: account.id,
      session_id: sessionId,
      lease_expires_at: expiresAt,
    };
  }
  async heartbeat(account: Row, input: unknown) {
    const value = heartbeatSchema.parse(input);
    const rows = await this.ctx.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [account.id]))[0]!;
      if (
        current.status === 'paused' ||
        !acceptHeartbeat(
          {
            connector_id: account.id,
            account_id: account.id,
            session_id: current.session_id,
            sequence: Number(current.heartbeat_sequence),
          },
          value,
        )
      )
        throw new ApiError(409, 'STALE_HEARTBEAT', '会话或心跳序号已经失效');
      return tx.query(
        'UPDATE accounts SET heartbeat_sequence=$2,status=$3,last_seen_at=now(),session_expires_at=$4 WHERE id=$1 RETURNING id',
        [account.id, value.sequence, value.state, new Date(Date.now() + 90_000).toISOString()],
      );
    });
    return { accepted: rows.length === 1 };
  }
  async permissions(account: Row, input: unknown) {
    const value = permissionSnapshotSchema.parse(input);
    await this.ctx.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [account.id]))[0]!;
      if (
        value.connector_id !== account.id ||
        value.account_id !== account.id ||
        value.session_id !== current.session_id ||
        current.status === 'paused'
      )
        throw new ApiError(403, 'ACCOUNT_SCOPE', '权限快照不属于当前连接会话');
      if (epoch(value.observed_at) > Date.now() + 60_000)
        throw new ApiError(400, 'FUTURE_SNAPSHOT', '权限快照时间超出允许范围');
      const binding = (
        await tx.query('SELECT * FROM bindings WHERE account_id=$1 AND external_id=$2 FOR UPDATE', [
          account.id,
          value.conversation_id,
        ])
      )[0];
      if (!binding) throw new ApiError(404, 'BINDING_NOT_FOUND', '请先同步此群信息');
      const previous = binding.snapshot;
      if (
        binding.permission_session_id === value.session_id &&
        Number(binding.permission_revision) >= value.revision
      )
        throw new ApiError(409, 'STALE_PERMISSIONS', '权限快照版本已过期');
      await tx.query(
        'UPDATE bindings SET snapshot=$3::jsonb,permission_session_id=$4,permission_revision=$5,observed_at=now() WHERE account_id=$1 AND external_id=$2',
        [
          account.id,
          value.conversation_id,
          json({ ...previous, permissions: value.permissions, observed_at: value.observed_at }),
          value.session_id,
          value.revision,
        ],
      );
    });
    return { accepted: true };
  }
  async seedDemo() {
    if (!this.ctx.config.seedDemo) return;
    await this.ctx.db.transaction(async (tx) => {
      if ((await tx.query("SELECT key FROM metadata WHERE key='demo_seeded'")).length) return;
      const id = 'local-demo';
      await tx.query(
        "INSERT INTO accounts(id,platform,name,kind,status,is_demo,last_seen_at) VALUES($1,'custom','本地演示连接器','demo','online',true,now()) ON CONFLICT DO NOTHING",
        [id],
      );
      const account = await this.get(id, tx);
      const first = await this.upsertGroup(
        account,
        groupSnapshot('demo-community', '研发交流群', 'group', null, 'demo', true),
        tx,
      );
      await this.upsertGroup(
        account,
        groupSnapshot('demo-updates', '产品更新频道', 'channel', null, 'demo', true),
        tx,
      );
      const contents = [
        '欢迎来到超级机器人的开发空间。',
        '所有消息和发送记录都会保存，可以在群详情里查看。',
        '可以先试试规则观察模式，再开启自动处理。',
        '第一版正在接入群管理、消息发布与项目 API。',
      ];
      for (let i = 0; i < contents.length; i++)
        await tx.query(
          `INSERT INTO messages(id,conversation_id,account_id,external_id,sender_id,sender_name,content,segments,direction,verdict,fingerprint,source_at,created_at)
        VALUES($1,$2,$3,$4,'demo-member','示例成员',$5,$6::jsonb,'incoming','allowed',$7,$8,$8)`,
          [
            randomUUID(),
            first,
            id,
            `seed-${i}`,
            contents[i],
            json([{ type: 'text', text: contents[i] }]),
            sha(contents[i]!),
            new Date(Date.now() - (contents.length - i) * 20 * 60_000).toISOString(),
          ],
        );
      await tx.query("INSERT INTO metadata(key,value) VALUES('demo_seeded','true')");
    });
  }
}
