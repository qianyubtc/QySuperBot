import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { ApiError, SecretBox } from '../src/security.ts';
import { BinanceDirect } from '../src/binance-direct.ts';
import {
  binanceConnection,
  beginBinanceCheck,
  binanceFailureKind,
  recordBinanceFailure,
  recordBinanceSuccess,
} from '../src/binance-health.ts';
import { createHttpApp } from '../src/http.ts';

const credentials = {
  mode: 'direct' as const,
  web_token: 'private-health-credential',
  csrf_cookie: 'private-health-csrf',
};
const group = (id: string) => ({
  group: { id, name: 'fixture', systemMute: false, ownerBan: false },
  member: { role: 1, disabledReasonTypes: [], memberStatusInChannel: 0 },
  restriction: { groupTextRestricted: false },
});
const problem = (code: string, stage: string, http_status?: number, extra = {}) =>
  Object.assign(new Error('vendor ?token=' + credentials.web_token), {
    bridgeError: { code, stage, http_status, ...extra },
  });
async function fixture() {
  const s = await createServices(
    {
      ...loadConfig(),
      databaseUrl: undefined,
      dataDir: 'memory://',
      seedDemo: false,
      binanceBrowserEnabled: true,
    },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const created = await s.accounts.create(
    { kind: 'binance', name: 'health fixture', group_ids: ['10001', '10002'] },
    'test',
  );
  const calls: string[] = [];
  const fail: { operation?: string; error?: unknown; profileId?: string } = {};
  const factory = () => ({
    async request(message: { operation: string; params?: Record<string, unknown> }) {
      calls.push(message.operation);
      if (message.operation === fail.operation) throw fail.error;
      if (message.operation === 'profile') return { chatUserId: fail.profileId ?? '123' };
      if (message.operation === 'group') return group(String(message.params?.group_id));
      if (message.operation === 'history') return { messages: [] };
      if (message.operation === 'send_check')
        return { connection: 'open', token_format: 'opaque', token_expires_at: null };
      return { message_id: '999' };
    },
    async checkConnection() {
      return { connection: 'open' as const, token_format: 'opaque' as const, token_expires_at: null };
    },
    close() {},
  });
  const direct = new BinanceDirect(s.db, s.box, factory);
  s.binance.direct = direct;
  await s.binance.authentication(await s.accounts.get(created.id), credentials, 'test');
  await s.accounts.refresh(created.id, 'test');
  return {
    s,
    id: created.id,
    fail,
    calls,
    direct,
    factory,
    get: () => s.accounts.get(created.id),
    public: async () => (await s.accounts.list()).find((a) => a.id === created.id)!,
  };
}

test('only website authentication evidence requires relogin; network, CDN and IM token expiry remain distinct', () => {
  assert.equal(binanceFailureKind(problem('HTTP', 'profile', 401)), 'login_required');
  assert.equal(
    binanceFailureKind(problem('API', 'profile', 200, { api_code: '100001005' })),
    'login_required',
  );
  assert.equal(binanceFailureKind(new ApiError(409, 'BINANCE_TOKEN_EXPIRED', 'expired')), 'login_required');
  assert.equal(binanceFailureKind(problem('HTTP', 'upload', 401)), 'check_required');
  assert.equal(binanceFailureKind(problem('HTTP', 'profile', 403)), 'access_blocked');
  assert.equal(binanceFailureKind(problem('HTTP', 'profile', 429)), 'temporary_error');
  assert.equal(binanceFailureKind(problem('NETWORK', 'history')), 'temporary_error');
  assert.equal(
    binanceFailureKind(problem('PERMISSION', 'token', undefined, { detail: 'TOKEN_EXPIRED' })),
    'temporary_error',
  );
  assert.equal(binanceFailureKind(problem('PERMISSION', 'member')), 'permission_denied');
  assert.equal(
    binanceFailureKind(problem('PERMISSION', 'send', undefined, { detail: 'SEND_REJECTED' })),
    'check_required',
  );
  assert.equal(binanceFailureKind(problem('API', 'profile', 200, { api_code: '999999' })), 'check_required');
});

test('expired login persists through refresh failure, stops maintenance retries and disables chat; reauthorization preserves groups', async () => {
  const f = await fixture();
  const { s, id } = f;
  try {
    f.fail.operation = 'profile';
    f.fail.error = problem('HTTP', 'profile', 401);
    await assert.rejects(s.accounts.refresh(id, 'test'), /重新登录/);
    assert.equal((await f.get()).status, 'expired');
    const status = await f.public();
    assert(status.connection.needs_relogin);
    assert.equal(status.connection.state, 'login_required');
    const count = f.calls.length;
    await (s.worker as any).maintenance();
    assert.equal(f.calls.length, count);
    const room = (await s.db.query('SELECT id FROM conversations WHERE external_id=$1', ['10001']))[0]!;
    const chat = await s.chat.snapshot(room.id);
    assert.equal(chat.conversation.can_send, false);
    assert.equal(chat.conversation.account_id, id);
    assert(chat.conversation.connection?.needs_relogin);
    assert.match(chat.conversation.send_error!, /重新登录/);
    const serialized = JSON.stringify({
      status,
      chat,
      metadata: await s.db.query("SELECT value FROM metadata WHERE key LIKE 'binance-health:%'"),
    });
    assert(!serialized.includes(credentials.web_token));
    assert(!serialized.includes(credentials.csrf_cookie));
    assert(!serialized.includes('vendor ?token'));
    assert(!('health_session' in status));
    assert(!('health_metadata' in status));
    delete f.fail.operation;
    const old = await f.get();
    await s.binance.authentication(old, { ...credentials, web_token: 'fresh-private-credential' }, 'test');
    await s.accounts.refresh(id, 'test');
    await s.worker.pollBinance(await f.get());
    assert.notEqual((await f.get()).session_id, old.session_id);
    assert.deepEqual((await f.get()).settings.group_ids, ['10001', '10002']);
    const recovered = await f.public();
    assert.equal(recovered.connection.state, 'connected');
    assert(recovered.connection.verified_at);
    assert(recovered.connection.synced_at);
    assert(!recovered.connection.needs_relogin);
  } finally {
    await s.close();
  }
});

test('temporary history failure is visible until that group recovers; successful profile checks do not hide it', async () => {
  const f = await fixture();
  try {
    const account = await f.get();
    f.fail.operation = 'history';
    f.fail.error = problem('TIMEOUT', 'history');
    await assert.rejects(f.direct.request(account, 'history', { group_id: '10001' }));
    await f.direct.request(account, 'profile', {});
    assert.equal((await f.public()).connection.state, 'temporary_error');
    assert.equal((await f.get()).status, 'online');
    delete f.fail.operation;
    await f.direct.request(account, 'history', { group_id: '10002' });
    assert.equal((await f.public()).connection.issue_group_id, '10001');
    await f.direct.request(account, 'history', { group_id: '10001' });
    assert.equal((await f.public()).connection.state, 'connected');
  } finally {
    await f.s.close();
  }
});

test('an observed identity mismatch requires the original login and never replaces the bound account', async () => {
  const f = await fixture();
  try {
    f.fail.profileId = '999';
    await assert.rejects(f.s.accounts.refresh(f.id, 'test'), /原账号/);
    assert.equal((await f.get()).external_id, '123');
    assert.equal((await f.get()).status, 'expired');
    assert.equal((await f.public()).connection.state, 'identity_changed');
  } finally {
    await f.s.close();
  }
});

test('individual publication and media failures do not leave an otherwise healthy connection in error', async () => {
  const f = await fixture();
  try {
    for (const [operation, error] of [
      ['send_image', problem('NETWORK', 'upload', undefined, { effect: 'possible' })],
      ['send', problem('PERMISSION', 'send', undefined, { detail: 'SEND_REJECTED' })],
      ['image_url', problem('HTTP', 'image', 404)],
    ] as const) {
      f.fail.operation = operation;
      f.fail.error = error;
      await assert.rejects(f.direct.request(await f.get(), operation, { group_id: '10001' }));
      assert.equal((await f.public()).connection.state, 'connected');
    }
    f.fail.operation = 'send';
    f.fail.error = problem('NETWORK', 'profile');
    await assert.rejects(f.direct.request(await f.get(), 'send', { group_id: '10001' }));
    assert.equal((await f.public()).connection.state, 'temporary_error');
    delete f.fail.operation;
    const sends = f.calls.filter((c) => ['send', 'send_image'].includes(c)).length;
    const result = await f.s.accounts.checkBinance(f.id, 'test');
    assert.equal(result.failed_groups, 0);
    assert.equal(result.connection.state, 'connected');
    assert.equal(f.calls.filter((c) => ['send', 'send_image'].includes(c)).length, sends);
  } finally {
    await f.s.close();
  }
});

test('refreshing an already expired account cannot erase a later confirmed login failure', async () => {
  const f = await fixture();
  try {
    await recordBinanceFailure(
      f.s.db,
      await f.get(),
      'profile',
      undefined,
      beginBinanceCheck(),
      problem('HTTP', 'profile', 401),
    );
    const discover = f.s.adapters.discover.bind(f.s.adapters);
    f.s.adapters.discover = async (...args) => {
      const result = await discover(...args);
      await recordBinanceFailure(
        f.s.db,
        await f.get(),
        'history',
        '10001',
        beginBinanceCheck(),
        problem('HTTP', 'profile', 401),
      );
      return result;
    };
    await assert.rejects(
      f.s.accounts.refresh(f.id, 'test'),
      (error: any) => error.code === 'STALE_CONNECTION',
    );
    assert.equal((await f.get()).status, 'expired');
    assert((await f.public()).connection.needs_relogin);
    const calls = f.calls.length;
    await (f.s.worker as any).maintenance();
    assert.equal(f.calls.length, calls);
  } finally {
    await f.s.close();
  }
});

test('manual checks stop on authentication failure and report only groups actually checked', async () => {
  const f = await fixture();
  try {
    f.calls.length = 0;
    f.fail.operation = 'history';
    f.fail.error = problem('HTTP', 'profile', 401);
    const result = await f.s.accounts.checkBinance(f.id, 'test');
    assert.equal(result.checked_groups, 1);
    assert.equal(result.target_groups, 2);
    assert.equal(result.failed_groups, 1);
    assert(result.connection.needs_relogin);
    assert.equal(f.calls.filter((c) => c === 'history').length, 1);
  } finally {
    await f.s.close();
  }
});

test('manual checks do not report success after the selected groups change during a request', async () => {
  const f = await fixture();
  try {
    const old = await f.get(),
      client = f.direct.clients.get(f.id)!.client,
      request = client.request.bind(client);
    client.request = async (message) => {
      const result = await request(message);
      if (message.operation === 'history')
        await f.s.db.query(
          "UPDATE accounts SET settings=jsonb_set(settings,'{group_revision}','\"changed\"'::jsonb) WHERE id=$1",
          [f.id],
        );
      return result;
    };
    await assert.rejects(
      f.s.accounts.checkBinance(f.id, 'test'),
      (error: any) => error.code === 'STALE_CONNECTION',
    );
    await recordBinanceFailure(
      f.s.db,
      old,
      'history',
      '10001',
      beginBinanceCheck(),
      problem('HTTP', 'profile', 401),
    );
    assert.equal((await f.get()).status, 'online');
    assert(!(await f.public()).connection.needs_relogin);
  } finally {
    await f.s.close();
  }
});

test('old requests and deselected groups cannot expire or clear a newer login; stale successes cannot clear newer failures', async () => {
  const f = await fixture();
  try {
    const base = Date.now() + 1000;
    const old = await f.get();
    await f.s.binance.authentication(old, credentials, 'test');
    await f.s.accounts.refresh(f.id, 'test');
    await recordBinanceFailure(
      f.s.db,
      old,
      'profile',
      undefined,
      base + 200,
      problem('HTTP', 'profile', 401),
    );
    assert.equal((await f.get()).status, 'online');
    const current = await f.get();
    await recordBinanceFailure(f.s.db, current, 'history', '10001', base + 200, problem('NETWORK', 'history'));
    await recordBinanceSuccess(f.s.db, current, 'history', '10001', base + 100);
    assert.equal((await f.public()).connection.state, 'temporary_error');
    await f.s.db.query(
      "UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[]'::jsonb) WHERE id=$1",
      [f.id],
    );
    await recordBinanceFailure(
      f.s.db,
      current,
      'history',
      '10001',
      base + 300,
      problem('HTTP', 'profile', 401),
    );
    assert.equal((await f.get()).status, 'online');
    assert.equal((await f.public()).connection.state, 'awaiting_groups');
    await f.s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [f.id]);
    assert.equal((await f.public()).connection.state, 'paused');
  } finally {
    await f.s.close();
  }
});

test('a late old failure cannot replace a newer successful check or a newer verified login', async () => {
  const f = await fixture();
  try {
    const account = await f.get(),
      base = Date.now() + 1000;
    await recordBinanceSuccess(f.s.db, account, 'history', '10001', base + 200);
    await recordBinanceFailure(f.s.db, account, 'history', '10001', base + 100, problem('NETWORK', 'history'));
    assert.equal((await f.public()).connection.state, 'connected');
    await recordBinanceSuccess(f.s.db, account, 'profile', undefined, base + 400);
    await recordBinanceFailure(
      f.s.db,
      account,
      'history',
      '10002',
      base + 300,
      problem('HTTP', 'profile', 401),
    );
    assert.equal((await f.get()).status, 'online');
    assert.equal((await f.public()).connection.state, 'connected');
  } finally {
    await f.s.close();
  }
});

test('an older refresh failure cannot mark the account offline after a newer successful identity check', async () => {
  const f = await fixture();
  try {
    const client = f.direct.clients.get(f.id)!.client,
      original = client.request.bind(client);
    let rejectOld!: (error: unknown) => void, started!: () => void;
    const pending = new Promise((_, reject) => {
        rejectOld = reject;
      }),
      entered = new Promise<void>((resolve) => {
        started = resolve;
      });
    let first = true;
    client.request = async (message) => {
      if (message.operation === 'profile' && first) {
        first = false;
        started();
        return pending;
      }
      return original(message);
    };
    const old = f.s.accounts.refresh(f.id, 'test').then(
      () => null,
      (error) => error,
    );
    await entered;
    await f.direct.request(await f.get(), 'profile', {});
    rejectOld(problem('HTTP', 'profile', 401));
    assert.equal((await old).code, 'STALE_CONNECTION');
    assert.equal((await f.get()).status, 'online');
    assert.equal((await f.public()).connection.state, 'connected');
  } finally {
    await f.s.close();
  }
});

test('declared expired credentials show relogin before a worker runs; IM token metadata never substitutes for website expiry', () => {
  const account = {
    status: 'online',
    session_id: 'session',
    settings: {
      transport: 'direct',
      group_ids: ['10001'],
      direct_auth: { expires_at: '2000-01-01T00:00:00.000Z' },
    },
  };
  assert.equal(binanceConnection(account).state, 'login_required');
  account.status = 'paused';
  assert.equal(binanceConnection(account).state, 'paused');
  assert.equal(
    binanceConnection({
      status: 'online',
      session_id: 'session',
      settings: {
        transport: 'direct',
        group_ids: ['10001'],
        direct_auth: { configured_at: '2000-01-01T00:00:00.000Z' },
      },
    }).state,
    'check_required',
  );
});

test('health storage failures do not replace a confirmed message receipt', async () => {
  const f = await fixture();
  try {
    const direct = new BinanceDirect(
      {
        ...f.s.db,
        transaction: async () => {
          throw Error('health storage unavailable');
        },
      },
      f.s.box,
      f.factory,
    );
    try {
      assert.deepEqual(await direct.request(await f.get(), 'send', { group_id: '10001' }), {
        message_id: '999',
      });
    } finally {
      direct.close();
    }
  } finally {
    await f.s.close();
  }
});

test('manual connection check is authenticated, CSRF protected and never sends a message', async () => {
  const f = await fixture();
  const app = await createHttpApp(f.s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl(),
      path = `${base}/api/v1/accounts/${f.id}/binance-check`;
    assert.equal((await fetch(path, { method: 'POST' })).status, 401);
    const setup = await fetch(base + '/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'health-admin', password: 'health-admin-local-password' }),
    });
    const user = (await setup.json()) as any;
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(path, { method: 'POST', headers: { cookie } })).status, 403);
    const response = await fetch(path, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': user.csrf, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as any;
    assert.equal(result.failed_groups, 0);
    assert.equal(result.checked_groups, 2);
    assert.equal(result.connection.state, 'connected');
    assert(!f.calls.some((c) => ['send', 'send_image'].includes(c)));
  } finally {
    await app.close();
    await f.s.close();
  }
});
