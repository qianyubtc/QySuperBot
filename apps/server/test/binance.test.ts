import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { WebSocket } from 'ws';
import { createServices, type Services } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { binanceEvent, binanceGroup, binanceHistory, binancePermissionDiagnostics } from '../src/binance.ts';
import type { ConnectorCommand } from '../../../packages/contracts/src/index.ts';
import { imageType, requestImage } from '../src/network.ts';

let s: Services, app: Awaited<ReturnType<typeof createHttpApp>>, url: string, account: any, config: any;
const origin = 'chrome-extension://' + 'a'.repeat(32);
const sockets = new Set<WebSocket>();
let appClosed = false;
const failureReply = Symbol('failureReply');
const groupInfo = (id = '10001') => ({
  group: { id, name: '币安测试群', currentMemberCount: 2603, permissionMap: { '1': false } },
  member: { role: 3, memberStatusInChannel: 0, permissionMap: { '1': false } },
});
const rawMessage = (id: string, text = '币安测试消息') => ({
  msgId: id,
  sessionId: '10001',
  sessionType: 'GROUP',
  msgType: 'U_TEXT',
  content: text,
  timestamp: Date.now() - 1000,
  sender: { chatUserId: '42', nickname: '测试成员' },
});
async function until(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition timed out');
}
async function bridge(
  secret = config.pairing_secret,
  handler: (op: string, params: any) => any = (op, params) =>
    op === 'profile'
      ? { chatUserId: '123' }
      : op === 'group'
        ? groupInfo(params.group_id)
        : op === 'history'
          ? { messages: [] }
          : { message_id: '999' },
  version: string | null = '0.1.4',
) {
  const ws = new WebSocket(url, { origin });
  sockets.add(ws);
  const ready = new Promise<boolean>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', () => resolve(false));
    ws.on('message', (data) => {
      const value = JSON.parse(data.toString());
      if (value.type === 'challenge')
        ws.send(
          JSON.stringify({
            type: 'auth',
            ...(version ? { version } : {}),
            account_id: account.id,
            proof: createHmac('sha256', secret)
              .update(`qsb-binance-v1:${value.nonce}:${account.id}`)
              .digest('hex'),
          }),
        );
      else if (value.type === 'ready') resolve(true);
      else if (value.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      else if (value.type === 'request')
        void Promise.resolve(handler(value.operation, value.params)).then((result) => {
          if (ws.readyState === WebSocket.OPEN && result !== undefined)
            ws.send(
              JSON.stringify(
                result && Object.hasOwn(result, failureReply)
                  ? {
                      type: 'result',
                      id: value.id,
                      ok: false,
                      ...(result[failureReply] ? { error: result[failureReply] } : {}),
                    }
                  : { type: 'result', id: value.id, ok: true, data: result },
              ),
            );
        });
    });
  });
  return { ws, ready: await ready };
}
before(async () => {
  s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: true },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  app = await createHttpApp(s);
  await app.listen(0, '127.0.0.1');
  url = (await app.getUrl()).replace(/^http/, 'ws') + '/api/v1/connectors/binance/socket';
  const created = await s.accounts.create(
    { kind: 'binance', name: '测试币安连接', group_ids: ['10001', '10001'] },
    'test',
  );
  config = created.binance_bridge;
  account = await s.accounts.get(created.id);
});
after(async () => {
  for (const ws of sockets) ws.terminate();
  if (!appClosed) await app.close();
  await s.close();
});

test('Binance creation scopes groups, encrypts the pairing key and keeps secrets out of account listings', async () => {
  assert.deepEqual(account.settings.group_ids, ['10001']);
  assert.equal(account.secret_box, null);
  assert.notEqual(account.incoming_secret_box, config.pairing_secret);
  assert.equal(s.box.open(account.incoming_secret_box), config.pairing_secret);
  const listed = (await s.accounts.list()).find((value) => value.id === account.id)!;
  assert.equal(listed.incoming_secret_box, undefined);
  assert.equal(JSON.stringify(listed).includes(config.pairing_secret), false);
  const empty = await s.accounts.create({ kind: 'binance', name: '待选择群的连接' }, 'test');
  assert.deepEqual((await s.accounts.get(empty.id)).settings.group_ids, []);
  await assert.rejects(
    s.accounts.create({ kind: 'binance', name: 'bad', group_ids: ['https://bad.test'] }, 'test'),
  );
});

test('Binance bridge rejects a website Origin and invalid pairing proof', async () => {
  const ws = new WebSocket(url, { origin: 'http://evil.test' });
  sockets.add(ws);
  await new Promise<void>((resolve) => {
    ws.on('error', () => resolve());
    ws.on('close', () => resolve());
  });
  const invalid = await bridge('incorrect-secret');
  assert.equal(invalid.ready, false);
  assert.equal(s.binance.peers.has(account.id), false);
});

test('a transient handshake database failure allows reconnecting instead of revoking valid pairing', async () => {
  const query = s.db.query;
  let failOnce = true;
  s.db.query = async (text, values) => {
    if (failOnce && text === 'SELECT * FROM accounts WHERE id=$1' && values?.[0] === account.id) {
      failOnce = false;
      throw new Error('temporary storage failure');
    }
    return query(text, values);
  };
  try {
    const ws = new WebSocket(url, { origin });
    sockets.add(ws);
    const closed = new Promise<number>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('close', resolve);
    });
    ws.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'challenge')
        ws.send(
          JSON.stringify({
            type: 'auth',
            account_id: account.id,
            proof: createHmac('sha256', config.pairing_secret)
              .update(`qsb-binance-v1:${value.nonce}:${account.id}`)
              .digest('hex'),
          }),
        );
    });
    assert.equal(await closed, 1011);
  } finally {
    s.db.query = query;
  }
  const recovered = await bridge(config.pairing_secret);
  assert.equal(recovered.ready, true);
  recovered.ws.terminate();
});

test('authenticated browser discovers only configured groups; history backfill cannot trigger verification, forwarding or penalties', async () => {
  let history = [rawMessage('90071992547409931', '广告测试')];
  await bridge(config.pairing_secret, (op, params) =>
    op === 'profile'
      ? { chatUserId: '123' }
      : op === 'group'
        ? groupInfo(params.group_id)
        : { messages: history },
  );
  await until(async () => (await s.accounts.get(account.id)).status === 'online');
  account = await s.accounts.get(account.id);
  const group = (await s.features.groups()).find((value) => value.platform === 'binance')!;
  assert.equal(group.external_id, '10001');
  assert.equal(group.member_count, 2603);
  const legacyPolicy = {
    mode: 'enforce',
    keywords: ['广告'],
    blocked_domains: [],
    action: 'delete',
    verification_enabled: true,
    verification_timeout: 120,
  };
  await assert.rejects(
    s.features.policy(group.id, legacyPolicy, 'test'),
    (error: any) => error.code === 'POLICY_ACTION_UNAVAILABLE',
  );
  // Exercise backfill safety for an existing rule saved before capability-aware settings.
  await s.db.query('UPDATE conversations SET policy=$2::jsonb WHERE id=$1', [
    group.id,
    JSON.stringify(legacyPolicy),
  ]);
  const target = (await s.features.groups()).find((value) => value.is_demo)!;
  await s.features.saveRoute({ source_id: group.id, target_id: target.id, enabled: true }, 'test');
  await s.worker.pollBinance(account);
  assert.equal((await s.db.query('SELECT * FROM messages WHERE account_id=$1', [account.id])).length, 1);
  assert.equal((await s.db.query('SELECT * FROM jobs WHERE conversation_id=$1', [group.id])).length, 0);
  assert.equal(
    (await s.db.query('SELECT * FROM verifications WHERE conversation_id=$1', [group.id])).length,
    0,
  );
  assert.equal(
    (await s.db.query('SELECT cursor FROM binance_cursors WHERE account_id=$1', [account.id]))[0]!.cursor,
    '90071992547409931',
  );
  history = [rawMessage('90071992547409932', '新消息')];
  await s.worker.pollBinance(account);
  assert.equal(
    (await s.db.query('SELECT * FROM verifications WHERE conversation_id=$1', [group.id])).length,
    1,
  );
  await s.worker.pollBinance(account);
  assert.equal((await s.db.query('SELECT * FROM messages WHERE account_id=$1', [account.id])).length, 2);
  await assert.rejects(s.binance.request(account, 'history', { group_id: '999' }), /授权范围/);
});

test('Binance decoding preserves large IDs, reply references, outgoing identity and scope; unsafe numeric IDs fail', () => {
  const raw = {
    ...rawMessage('90071992547409933'),
    refMsg: { msgId: '90071992547409931' },
    sender: { chatUserId: '123' },
  };
  const result = binanceEvent(account, raw)!;
  assert.equal(result.event.type, 'message.created');
  if (result.event.type === 'message.created') {
    assert.equal(result.event.data.reply_to, '90071992547409931');
    assert.equal(result.event.data.direction, 'outgoing');
  }
  assert.equal(binanceEvent(account, { ...raw, sessionId: '88' }), null);
  assert.equal(binanceEvent(account, { ...raw, sessionType: 'PRIVATE' }), null);
  assert.equal(binanceEvent(account, { ...raw, msgType: 'U_CARD', content: 'transfer' }), null);
  assert.equal(binanceEvent(account, { ...raw, deleted: true })?.event.type, 'message.deleted');
  assert.throws(() => binanceEvent(account, { ...raw, msgId: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => binanceEvent(account, { ...raw, sender: { chatUserId: Number.MAX_SAFE_INTEGER + 1 } }));
  assert.throws(() => binanceEvent(account, { ...raw, timestamp: Date.now() + 120_000 }));
  const unknown = binanceGroup('10001', { group: { id: '10001', name: 'unknown' }, member: {} });
  assert.equal(
    unknown.permissions.find((value) => value.capability === 'messages.send')!.permission,
    'unknown',
  );
  const muted = groupInfo();
  muted.member.permissionMap['1'] = true;
  assert.equal(binanceGroup('10001', muted).permissions[1]!.permission, 'denied');
  assert.throws(() => binanceGroup('8', groupInfo()), /其他群/);
});

test('browser failures preserve only safe diagnostic codes and accept legacy error frames', async () => {
  await bridge(config.pairing_secret, () => ({
    [failureReply]: {
      code: 'HTTP',
      stage: 'profile',
      http_status: 403,
      api_code: '100001005',
      message: 'private-response-body',
    },
  }));
  await until(async () => (await s.accounts.get(account.id)).last_error?.includes('HTTP 403'));
  const failure = (await s.accounts.get(account.id)).last_error;
  assert.match(failure, /聊天身份/);
  assert.match(failure, /100001005/);
  assert(!failure.includes('private-response-body'));
  await bridge(config.pairing_secret, () => ({
    [failureReply]: { code: 'FORMAT', stage: 'history', detail: 'MESSAGES_NULL', message: 'private-body' },
  }));
  await until(async () => (await s.accounts.get(account.id)).last_error?.includes('messages 字段为空值'));
  assert(!(await s.accounts.get(account.id)).last_error.includes('private-body'));
  for (const error of [null, { code: 'private-response-body', stage: 'profile' }]) {
    await bridge(config.pairing_secret, () => ({ [failureReply]: error }));
    await until(async () => (await s.accounts.get(account.id)).status === 'error');
    assert.equal((await s.accounts.get(account.id)).last_error, '币安网页请求未完成，请检查登录与桥接状态');
  }
});

test('Binance group restrictions accept official flag objects without treating inactive flags as a ban', () => {
  const input = {
    ...groupInfo(),
    group: {
      ...groupInfo().group,
      systemMute: { muted: false, expireAt: null },
      ownerBan: { banned: false, banType: null },
    },
    member: { ...groupInfo().member, role: 0 },
  };
  const permission = (value: unknown) => binanceGroup('10001', value).permissions[1]!.permission;
  assert.equal(permission(input), 'granted');
  assert.equal(permission({ ...input, group: { ...input.group, systemMute: { muted: true } } }), 'denied');
  assert.equal(permission({ ...input, group: { ...input.group, ownerBan: { banned: true } } }), 'denied');
  assert.equal(permission({ ...input, group: { ...input.group, systemMute: {} } }), 'unknown');
  assert.equal(permission({ ...input, group: { ...input.group, ownerBan: {} } }), 'unknown');
  assert.equal(permission({ ...input, member: { ...input.member, permissionMap: {} } }), 'unknown');
  assert.equal(permission({ ...input, member: { ...input.member, permissionMap: { '1': 0 } } }), 'unknown');
  const unknownMember = binanceGroup('10001', {
    ...input,
    member: { ...input.member, memberStatusInChannel: null },
  });
  assert.equal(unknownMember.permissions[0]!.permission, 'unknown');
  assert.equal(unknownMember.permissions[1]!.permission, 'unknown');
  assert.throws(
    () =>
      binanceGroup('10001', { ...input, group: { ...input.group, systemMute: { muted: 'private-value' } } }),
    (error: any) =>
      error.code === 'BINANCE_RESPONSE_FORMAT' &&
      error.message.includes('group.systemMute:object') &&
      !error.message.includes('private-value'),
  );
});

test('invalid history identifies the affected field without exporting message content or sender values', () => {
  assert.throws(
    () =>
      binanceHistory({
        messages: [
          { ...rawMessage('1', 'private-content'), sender: { chatUserId: 'private-sender\nprivate-data' } },
        ],
      }),
    (error: any) =>
      error.code === 'BINANCE_RESPONSE_FORMAT' &&
      error.message.includes('messages.sender.chatUserId:string') &&
      !error.message.includes('private-sender') &&
      !error.message.includes('private-content'),
  );
});

test('opaque Binance participant IDs survive history decoding and event validation without numeric conversion', () => {
  const sender = 'chat-user_abC+/=42';
  const raw = { ...rawMessage('90071992547409934'), sender: { chatUserId: sender } };
  const history = binanceHistory({ messages: [raw] });
  assert.equal(history.messages[0]!.sender!.chatUserId, sender);
  const item = binanceEvent(account, history.messages[0]);
  assert.equal(item?.event.type, 'message.created');
  if (item?.event.type === 'message.created') {
    assert.equal(item.event.data.sender_id, sender);
    assert.equal(item.event.data.direction, 'incoming');
  }
  for (const invalid of ['', 'two words', 'user\ncontrol', 'x'.repeat(257), '1'.repeat(257)])
    assert.throws(() => binanceHistory({ messages: [{ ...raw, sender: { chatUserId: invalid } }] }));
});

test('sending diagnostics remain group scoped, private and read only', async () => {
  const operations: string[] = [];
  await bridge(config.pairing_secret, (op, params) => {
    operations.push(op);
    if (op === 'profile') return { chatUserId: '123' };
    if (op === 'group') return { ...groupInfo(params.group_id), private_value: 'never-export' };
    return {
      connection: 'open',
      token_format: 'jwt',
      token_expires_at: '2030-01-01T00:00:00.000Z',
      token: 'never-export',
    };
  });
  await until(async () => (await s.accounts.get(account.id)).status === 'online');
  const diagnostic = await s.binance.diagnose(account, '10001');
  assert.equal(diagnostic.role, 3);
  assert.equal(diagnostic.permission.permission, 'granted');
  const result = await s.binance.checkSend(account, { group_id: '10001' });
  assert.equal(result.connection, 'open');
  assert(!JSON.stringify(result).includes('never-export'));
  assert(!JSON.stringify(diagnostic).includes('never-export'));
  assert.ok(!operations.includes('send'));
  await assert.rejects(s.binance.checkSend(account, { group_id: '999' }), /授权范围/);
  await assert.rejects(s.binance.checkSend(account, { group_id: '10001', text: 'must-not-send' }));
  const safe = binancePermissionDiagnostics({
    ...groupInfo(),
    member: { role: 3, disabledReasonTypes: ['private-token'] },
  });
  assert(!JSON.stringify(safe).includes('private-token'));
});

test('legacy extensions keep discovery working and receive an update prompt before unsupported send checks', async () => {
  const operations: string[] = [];
  await bridge(
    config.pairing_secret,
    (op) => {
      operations.push(op);
      return op === 'profile' ? { chatUserId: '123' } : groupInfo();
    },
    null,
  );
  await until(async () => (await s.accounts.get(account.id)).status === 'online');
  assert.equal((await s.binance.diagnose(account, '10001')).extension_version, null);
  await assert.rejects(s.binance.checkSend(account, { group_id: '10001' }), /v0.1.4/);
  assert(!operations.includes('send_check'));
  assert.equal(s.binance.peers.has(account.id), true);
});

test('invalid discovery responses report a known field and its type without leaking values', async () => {
  await bridge(config.pairing_secret, (operation) =>
    operation === 'profile'
      ? { chatUserId: '123' }
      : { ...groupInfo(), member: { ...groupInfo().member, role: 'private-response-value' } },
  );
  await until(async () => (await s.accounts.get(account.id)).last_error?.includes('member.role:string'));
  await assert.rejects(s.accounts.refresh(account.id, 'test'), (error: any) => {
    assert.equal(error.code, 'BINANCE_RESPONSE_FORMAT');
    assert.match(error.message, /member.role:string/);
    assert(!error.message.includes('private-response-value'));
    return true;
  });
});

test('Binance send forwards the quote once and requires a confirmed message ID; disconnect never fabricates success', async () => {
  const calls: any[] = [];
  const active = await bridge(config.pairing_secret, (op, params) => {
    if (op === 'profile') return { chatUserId: '123' };
    if (op === 'group') return groupInfo(params.group_id);
    calls.push(params);
    return params.text === 'disconnect' ? undefined : { message_id: '90071992547409934' };
  });
  await until(async () => (await s.accounts.get(account.id)).status === 'online');
  account = await s.accounts.get(account.id);
  const command: ConnectorCommand = {
    schema_version: '1',
    command_id: randomUUID(),
    idempotency_key: randomUUID(),
    attempt_id: randomUUID(),
    attempt_number: 1,
    logical_conversation_id: 'test',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    target: { connector_id: account.id, account_id: account.id, conversation_id: '10001' },
    action: 'message.send',
    params: { segments: [{ type: 'text', text: '测试回复' }], reply_to: '90071992547409931' },
  };
  const result = await s.adapters.execute(account, command);
  assert.equal(result.status, 'succeeded');
  assert.equal(calls[0].reply_to, command.params.reply_to);
  assert.equal(calls[0].local_id, command.attempt_id);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].not_after <= Date.now() + 17_000);
  const inFlight = s.adapters.execute(account, {
    ...command,
    params: { segments: [{ type: 'text', text: 'disconnect' }] },
  });
  const rejection = assert.rejects(inFlight, /断开/);
  await until(async () => calls.length === 2);
  active.ws.terminate();
  await rejection;
});

test('joined room discovery paginates normal and archived groups; selections change live, preserve history and cancel pending work', async () => {
  const pages: any[] = [];
  await bridge(
    config.pairing_secret,
    (op, params) => {
      if (op === 'profile') return { chatUserId: '123' };
      if (op === 'group') return groupInfo(params.group_id);
      if (op === 'groups') {
        pages.push(params);
        if (params.archived)
          return {
            groups: [{ id: '3000', name: '归档群', member_count: null }],
            has_more: false,
            next_timestamp: null,
          };
        return params.timestamp
          ? {
              groups: [{ id: '2000', name: '第二个群', member_count: 3 }],
              has_more: false,
              next_timestamp: null,
            }
          : {
              groups: [{ id: '10001', name: '币安测试群', member_count: 2603 }],
              has_more: true,
              next_timestamp: 100,
            };
      }
      return { messages: [] };
    },
    '0.1.6',
  );
  await until(async () => (await s.accounts.get(account.id)).status === 'online');
  const catalog = await s.accounts.binanceGroups(account.id, true);
  assert.deepEqual(
    catalog.groups.map((group) => group.id),
    ['10001', '2000', '3000'],
  );
  assert.equal(pages.length, 3);
  await assert.rejects(
    s.accounts.selectBinanceGroups(account.id, { group_ids: ['999'], revision: catalog.revision }, 'test'),
    /已加入/,
  );
  const added = await s.accounts.selectBinanceGroups(
    account.id,
    { group_ids: ['10001', '2000'], revision: catalog.revision },
    'test',
  );
  assert.deepEqual(added.group_ids, ['10001', '2000']);
  await assert.rejects(
    s.accounts.selectBinanceGroups(account.id, { group_ids: [], revision: catalog.revision }, 'test'),
    /已被更新/,
  );
  const stale = await s.accounts.get(account.id);
  const group = (await s.features.groups()).find((item) => item.external_id === '2000')!;
  const event = binanceEvent(stale, { ...rawMessage('7001'), sessionId: '2000' })!;
  await s.messages.ingest(stale, event.event, event.name, true);
  const pending = await s.jobs.enqueue({
    key: 'selection-test-pending',
    conversationId: group.id,
    action: 'message.send',
    params: { segments: [{ type: 'text', text: '不会发送的测试任务' }] },
  });
  const removed = await s.accounts.selectBinanceGroups(
    account.id,
    { group_ids: ['10001'], revision: added.revision },
    'test',
  );
  const chat = await s.chat.snapshot(group.id);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.conversation.can_send, false);
  assert.match(chat.conversation.send_error!, /取消同步/);
  assert.equal(
    (await s.db.query('SELECT status FROM jobs WHERE id=$1', [pending.id]))[0]!.status,
    'cancelled',
  );
  await assert.rejects(s.binance.request(stale, 'history', { group_id: '2000' }), /授权范围/);
  const late = binanceEvent(stale, { ...rawMessage('7002'), sessionId: '2000' })!;
  assert.equal((await s.messages.ingest(stale, late.event)).ignored, true);
  assert.equal((await s.chat.snapshot(group.id)).messages.length, 1);
  await s.db.query(
    'INSERT INTO binance_cursors(account_id,external_id,cursor) VALUES($1,$2,$3) ON CONFLICT(account_id,external_id) DO UPDATE SET cursor=EXCLUDED.cursor',
    [account.id, '2000', '7002'],
  );
  const restored = await s.accounts.selectBinanceGroups(
    account.id,
    { group_ids: ['10001', '2000'], revision: removed.revision },
    'test',
  );
  assert.equal(
    (
      await s.db.query('SELECT cursor FROM binance_cursors WHERE account_id=$1 AND external_id=$2', [
        account.id,
        '2000',
      ])
    ).length,
    0,
  );
  await s.accounts.selectBinanceGroups(account.id, { group_ids: [], revision: restored.revision }, 'test');
  assert.equal((await s.accounts.get(account.id)).status, 'online');
  const empty = await s.accounts.binanceGroups(account.id);
  await s.accounts.selectBinanceGroups(account.id, { group_ids: ['10001'], revision: empty.revision }, 'test');
  account = await s.accounts.get(account.id);
});

test('image previews require admin access, bind group and message IDs, reject deleted content and stream only image bytes', async () => {
  const urls: any[] = [];
  await bridge(
    config.pairing_secret,
    (op, params) => {
      if (op === 'profile') return { chatUserId: '123' };
      if (op === 'group') return groupInfo(params.group_id);
      if (op === 'image_url') {
        urls.push(params);
        return { url: 'https://cdn.example.com/image.png?signed=opaque' };
      }
      return { messages: [] };
    },
    '0.1.6',
  );
  await until(async () => (await s.accounts.get(account.id)).status === 'online');
  account = await s.accounts.get(account.id);
  const item = binanceEvent(account, { ...rawMessage('8001'), msgType: 'U_IMAGE' })!;
  assert.equal(item.event.type, 'message.created');
  assert.deepEqual((item.event.data as any).segments, [
    { type: 'text', text: '币安测试消息' },
    { type: 'image', asset_id: 'bn-image-8001', alt: '币安群图片' },
  ]);
  await s.messages.ingest(account, item.event, item.name, true);
  const group = (await s.features.groups()).find((row) => row.external_id === '10001')!;
  const message = (await s.chat.snapshot(group.id)).messages.find((row: any) => row.external_id === '8001');
  assert.equal(message.segments.find((part: any) => part.type === 'image')?.asset_id, 'bn-image-8001');
  const base = (await app.getUrl()) + '/api/v1';
  const path = `/conversations/${group.id}/messages/${message.id}/image`;
  assert.equal((await fetch(base + path)).status, 401);
  const admin = await s.auth.setup({ username: 'image-admin', password: 'image-admin-password' });
  const headers = { cookie: `qsb_session=${admin.token}` };
  const originalLoader = s.chat.loadImage;
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  s.chat.loadImage = async (url) => {
    assert.equal(url, 'https://cdn.example.com/image.png?signed=opaque');
    return { body: bytes, contentType: 'image/png' };
  };
  try {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].message_id, '8001');
    const other = (await s.features.groups()).find((row) => row.external_id === '2000')!;
    assert.equal(
      (await fetch(`${base}/conversations/${other.id}/messages/${message.id}/image`, { headers })).status,
      404,
    );
    await s.db.query('UPDATE messages SET deleted=true WHERE id=$1', [message.id]);
    assert.equal((await fetch(base + path, { headers })).status, 404);
    assert.equal(urls.length, 1);
  } finally {
    s.chat.loadImage = originalLoader;
  }
  for (const bad of [
    'http://127.0.0.1/pic',
    'https://127.0.0.1/pic',
    'https://[::1]/pic',
    'https://user:password@example.com/pic',
  ])
    await assert.rejects(requestImage(bad));
  assert.equal(imageType(Buffer.from('<svg onload="alert(1)"/>')), null);
  assert.equal(imageType(bytes), 'image/png');
  assert.equal(imageType(Buffer.from('GIF89atest')), 'image/gif');
});

test('pairing rotation revokes old connections and keys; a different Binance identity cannot take over the existing account', async () => {
  const old = config.pairing_secret;
  config = await s.accounts.pairBinance(account.id, 'test');
  assert.equal((await bridge(old)).ready, false);
  await bridge(config.pairing_secret, () => ({ chatUserId: '456' }));
  await until(async () => (await s.accounts.get(account.id)).status === 'error');
  assert.equal((await s.accounts.get(account.id)).external_id, '123');
  assert.match((await s.accounts.get(account.id)).last_error, /登录账号已变化/);
  await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [account.id]);
  s.binance.disconnect(account.id);
  assert.equal((await bridge(config.pairing_secret)).ready, false);
  await assert.rejects(s.accounts.pairBinance(account.id, 'test'), /恢复/);
});

test('browser companion restricts operations to configured groups and never forwards session cookies', async () => {
  const script = await readFile('extensions/binance-browser/content.js', 'utf8');
  let listener: any;
  const paths: any[] = [];
  const context = vm.createContext({
    location: { origin: 'https://www.binance.com', pathname: '/zh-CN/chatroom' },
    document: { cookie: 'cr00=test-session; csrftoken=test-csrf; account_cookie=never-export' },
    chrome: {
      runtime: {
        id: 'test',
        onMessage: {
          addListener(value: any) {
            listener = value;
          },
        },
      },
    },
    window: { addEventListener() {} },
    AbortSignal,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (path: string, options: any) => {
      paths.push({ path, options });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ success: true, data: { chatUserId: '123', privateField: 'never-export' } }),
      };
    },
  });
  vm.runInContext(script, context);
  const call = (operation: string, params: any, groups = ['10001']) =>
    new Promise<any>((resolve) =>
      listener(
        { type: 'qsb-binance-request', operation, params, group_ids: groups },
        { id: 'test' },
        resolve,
      ),
    );
  const profile = await call('profile', {});
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), { ok: true, data: { chatUserId: '123' } });
  assert.equal(paths[0].options.headers.csrftoken, createHash('md5').update('test-session').digest('hex'));
  assert.equal(paths[0].options.headers.c2ctype, 'c2c_web');
  assert.equal(JSON.stringify(profile).includes('cookie'), false);
  assert.equal((await call('history', { group_id: '999' })).ok, false);
  assert.equal((await call('withdraw', { group_id: '10001' })).ok, false);
  assert.equal(paths.length, 1);
});

test('browser companion sends exact quote IDs, ignores unrelated confirmations and never sends an expired request', async () => {
  let listener: any, pagehide: (() => void) | undefined;
  const wire: any[] = [];
  let socket: any;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(url: string) {
      assert.equal(new URL(url).hostname, 'stream.binance.com');
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(value: string) {
      const frame = JSON.parse(value);
      if (frame.msgType === 'HEART_BEAT') {
        queueMicrotask(() => this.onmessage?.({ data: value }));
        return;
      }
      wire.push(frame);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const context = vm.createContext({
    location: { origin: 'https://www.binance.com', pathname: '/zh-CN/chatroom' },
    document: { cookie: 'csrftoken=test' },
    chrome: {
      runtime: {
        id: 'test',
        onMessage: {
          addListener(value: any) {
            listener = value;
          },
        },
      },
    },
    window: {
      addEventListener(name: string, callback: () => void) {
        if (name === 'pagehide') pagehide = callback;
      },
    },
    WebSocket: FakeSocket,
    AbortSignal,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (path: string) => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          data: path.endsWith('dynamic-domain')
            ? { 'c2c-im': 'wss://stream.binance.com' }
            : path.endsWith('/token')
              ? { uid: '123', token: 'chat-only-test' }
              : path.endsWith('get-my-profile')
                ? { chatUserId: '123' }
                : path.endsWith('get-channel-info')
                  ? groupInfo().group
                  : path.endsWith('chat-restriction')
                    ? { groupTextRestricted: null }
                    : groupInfo().member,
        }),
    }),
  });
  vm.runInContext(await readFile('extensions/binance-browser/content.js', 'utf8'), context);
  const call = (params: any) =>
    new Promise<any>((resolve) =>
      listener(
        { type: 'qsb-binance-request', operation: 'send', params, group_ids: ['10001'] },
        { id: 'test' },
        resolve,
      ),
    );
  const params = {
    group_id: '10001',
    text: '测试引用',
    reply_to: '90071992547409931',
    local_id: randomUUID(),
    not_after: Date.now() + 17_000,
    expected_user_id: '123',
  };
  try {
    assert.equal((await call({ ...params, not_after: Date.now() - 1 })).ok, false);
    assert.equal(wire.length, 0);
    assert.equal((await call({ ...params, expected_user_id: '456' })).ok, false);
    assert.equal(wire.length, 0);
    let settled = false;
    const sent = call(params).then((result) => {
      settled = true;
      return result;
    });
    await until(async () => wire.length === 1);
    assert.deepEqual(wire[0].refMsgIds, ['90071992547409931']);
    assert.equal(wire[0].localId, params.local_id);
    socket.onmessage({ data: JSON.stringify({ ...wire[0], msgId: '90071992547409932', sessionId: '999' }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    socket.onmessage({ data: JSON.stringify({ ...wire[0], msgId: '90071992547409932' }) });
    assert.deepEqual(JSON.parse(JSON.stringify(await sent)), {
      ok: true,
      data: { message_id: '90071992547409932' },
    });
    assert.equal(wire.length, 1);
  } finally {
    pagehide?.();
  }
});

test('application shutdown closes an active Binance bridge', async () => {
  await s.db.query("UPDATE accounts SET status='configuring' WHERE id=$1", [account.id]);
  const connected = await bridge();
  assert.equal(connected.ready, true);
  await until(async () => (await s.accounts.get(account.id)).status === 'online');
  const closed = new Promise<void>((resolve) => connected.ws.once('close', () => resolve()));
  await app.close();
  appClosed = true;
  await closed;
  assert.equal(connected.ws.readyState, WebSocket.CLOSED);
});
