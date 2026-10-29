import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { createHttpApp } from '../src/http.ts';

async function fixture() {
  const state = {
    online: false,
    ready: false,
    uin: '12345',
    role: 'admin',
    unknownRole: false,
    qr: 'https://txz.qq.com/p?k=local-fixture-only',
    phase: 'waiting_qrcode',
    loginCount: 0,
    credential: '',
    invalidateCredentialOnce: false,
    config: {} as any,
    mutationResponse: null as any,
    hook: null as null | ((action: string, params: any) => Promise<void>),
  };
  const calls: { action: string; params: any }[] = [];
  const serve = (webui: boolean) =>
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const params = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const action = req.url!.replace(webui ? '/api/' : '/', '');
      calls.push({ action, params });
      await state.hook?.(action, params);
      res.setHeader('content-type', 'application/json');
      if (webui) {
        if (action === 'auth/login') {
          assert.equal(params.hash, createHash('sha256').update('fixture-webui-token.napcat').digest('hex'));
          state.credential = 'fixture-credential-' + ++state.loginCount;
          res.end(JSON.stringify({ code: 0, data: { Credential: state.credential } }));
          return;
        }
        if (state.invalidateCredentialOnce) {
          state.invalidateCredentialOnce = false;
          res.end(JSON.stringify({ code: -1, message: 'Unauthorized', data: null }));
          return;
        }
        if (req.headers.authorization !== `Bearer ${state.credential}`) {
          res.writeHead(401).end('{}');
          return;
        }
        let data: any;
        if (action === 'QQLogin/CheckLoginStatus')
          data = {
            isLogin: state.online,
            coreReady: state.ready,
            loginPhase: state.ready ? 'ready' : state.phase,
            qrcodeurl: state.qr,
            loginError: '',
          };
        else if (action === 'QQLogin/GetQQLoginInfo') data = { uin: state.uin, online: state.online };
        else if (action === 'QQLogin/RefreshQRcode') data = { qrcodeurl: state.qr };
        else if (action === 'QQLogin/GetQuickLoginList') data = [state.uin];
        else if (action === 'QQLogin/SetQuickLogin') data = null;
        else if (action === 'OB11Config/GetConfig') data = state.config;
        else if (action === 'OB11Config/SetConfig') {
          state.config = JSON.parse(params.config);
          data = null;
        } else {
          res.writeHead(404).end('{}');
          return;
        }
        res.end(JSON.stringify({ code: 0, data }));
        return;
      }
      const expected = state.config.network?.httpServers?.find((s: any) => s.name === 'superbot-api')?.token;
      if (req.headers.authorization !== `Bearer ${expected}`) {
        res.writeHead(401).end('{}');
        return;
      }
      let data: any;
      if (action === 'get_login_info') data = { user_id: Number(state.uin), nickname: 'Local QQ' };
      else if (action === 'get_group_list')
        data = [{ group_id: 67890, group_name: 'Local group', member_count: 3 }];
      else if (action === 'get_group_member_list')
        data = state.unknownRole ? [] : [{ user_id: Number(state.uin), group_id: 67890, role: state.role }];
      else if (action === 'get_group_member_info') {
        if (state.unknownRole) {
          res.end(JSON.stringify({ status: 'failed', retcode: 1400 }));
          return;
        }
        data = { user_id: Number(state.uin), group_id: 67890, role: state.role };
      } else if (action === 'set_group_add_request') {
        if (state.mutationResponse) {
          res.writeHead(state.mutationResponse.status).end(JSON.stringify(state.mutationResponse.data));
          return;
        }
        data = null;
      } else {
        res.writeHead(404).end('{}');
        return;
      }
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    });
  const onebot = serve(false),
    webui = serve(true);
  for (const server of [onebot, webui])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (onebot.address() as any).port;
  state.config = {
    network: {
      httpServers: [
        { name: 'superbot-api', enable: true, host: '127.0.0.1', port, token: 'fixture-api-token' },
      ],
      httpClients: [],
      websocketServers: [],
      websocketClients: [],
    },
    custom: 'preserve',
  };
  const s = await createServices(
    {
      ...loadConfig(),
      databaseUrl: undefined,
      dataDir: 'memory://',
      seedDemo: false,
      qqLocalPort: port,
      qqWebuiPort: (webui.address() as any).port,
      qqWebuiToken: 'fixture-webui-token',
    },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const connect = async () => {
    state.online = state.ready = true;
    const result = await s.qqLogin.connect({ name: 'Local QQ' }, 'test');
    const account = await s.accounts.get(result.account_id);
    const group = (
      await s.db.query('SELECT * FROM conversations WHERE executor_account_id=$1', [account.id])
    )[0]!;
    return { account, group };
  };
  const event = (flag = 'fixture-request-1', extra: any = {}) => ({
    time: Math.floor(Date.now() / 1000),
    self_id: 12345,
    post_type: 'request',
    request_type: 'group',
    sub_type: 'add',
    group_id: 67890,
    user_id: 99999,
    comment: 'Local membership request',
    flag,
    ...extra,
  });
  const jobs = () =>
    s.db.query("SELECT * FROM jobs WHERE action='membership.approve' ORDER BY created_at,id");
  return {
    s,
    state,
    calls,
    connect,
    event,
    jobs,
    close: async () => {
      await s.close();
      for (const server of [onebot, webui])
        await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('VPS QQ login caches private credentials, filters QR URLs and never exposes WebUI tokens', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.s.qqLogin.local()).available, true);
    const first = await f.s.qqLogin.status();
    assert.equal(first.qr_value, f.state.qr);
    await f.s.qqLogin.status();
    assert.equal(f.state.loginCount, 1);
    f.state.invalidateCredentialOnce = true;
    await f.s.qqLogin.status();
    assert.equal(f.state.loginCount, 2);
    const serialized = JSON.stringify(first);
    assert(!serialized.includes('fixture-webui-token'));
    assert(!serialized.includes('Credential'));
    f.state.qr = 'https://attacker.example/qr';
    assert.equal((await f.s.qqLogin.status()).qr_value, null);
    f.state.qr = 'https://txz.qq.com/p?k=accepted';
    f.state.phase = 'initializing';
    const accepted = await f.s.qqLogin.status();
    assert.equal(accepted.login_accepted, true);
    assert.equal(accepted.qr_value, null);
    await assert.rejects(f.s.qqLogin.call('/File/Delete'), (e: any) => e.code === 'QQ_LOGIN_ACTION');
    await assert.rejects(f.s.qqLogin.connect({}, 'test'), (e: any) => e.code === 'QQ_LOGIN_NOT_READY');
    assert.equal((await f.s.db.query('SELECT id FROM accounts')).length, 0);
  } finally {
    await f.close();
  }
});

test('Managed QQ first login provisions loopback API and signed reports; reconnect preserves identity, secrets and selection', async () => {
  const f = await fixture();
  try {
    const { account, group } = await f.connect();
    assert.equal(account.external_id, '12345');
    assert.equal(account.status, 'online');
    const client = f.state.config.network.httpClients.find((c: any) => c.name === 'superbot-events');
    assert(client.url.endsWith(`/connectors/qq/${account.id}/events`));
    assert.equal(client.token, f.s.box.open(account.incoming_secret_box));
    assert.equal(f.state.config.custom, 'preserve');
    assert.equal(f.state.config.network.httpServers[0].host, '127.0.0.1');
    await f.s.db.query('UPDATE accounts SET settings=$2::jsonb WHERE id=$1', [
      account.id,
      JSON.stringify({ group_ids: [group.external_id], group_revision: 'fixture-scope' }),
    ]);
    const again = await f.s.qqLogin.connect({ account_id: account.id }, 'test');
    assert.equal(again.account_id, account.id);
    const after = await f.s.accounts.get(account.id);
    assert.equal(after.secret_box, account.secret_box);
    assert.equal(after.incoming_secret_box, account.incoming_secret_box);
    assert.equal(after.settings.group_revision, 'fixture-scope');
    assert.equal((await f.s.db.query('SELECT id FROM accounts')).length, 1);
    await f.s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [account.id]);
    await assert.rejects(
      f.s.qqLogin.connect({ account_id: account.id }, 'test'),
      (e: any) => e.code === 'ACCOUNT_PAUSED',
    );
    await f.s.qqLogin.connect({ account_id: account.id, resume: true }, 'test');
    assert.equal((await f.s.accounts.get(account.id)).status, 'online');
  } finally {
    await f.close();
  }
});

test('Managed login protects bound QQ identities, unrelated ports and external bridges', async () => {
  const f = await fixture();
  try {
    const { account } = await f.connect();
    f.state.uin = '54321';
    assert.equal((await f.s.qqLogin.status(account.id)).identity_mismatch, true);
    await assert.rejects(
      f.s.qqLogin.connect({ account_id: account.id }, 'test'),
      (e: any) => e.code === 'QQ_IDENTITY_CHANGED',
    );
    assert.equal((await f.s.accounts.get(account.id)).external_id, '12345');
    const remote = await f.s.accounts.create(
      { kind: 'qq', name: 'External', endpoint: 'https://example.com' },
      'test',
    );
    await assert.rejects(f.s.qqLogin.status(remote.id), (e: any) => e.code === 'QQ_MANAGED_REQUIRED');
    f.state.config.network.httpServers[0].name = 'unrelated-server';
    await assert.rejects(f.s.qqLogin.connect({}, 'test'), (e: any) => e.code === 'QQ_LOCAL_PORT_IN_USE');
  } finally {
    await f.close();
  }
});

test('Managed login binds an existing unbound connection before configuring the bridge', async () => {
  const f = await fixture();
  try {
    const existing = await f.s.accounts.create(
      {
        kind: 'qq',
        name: 'Unbound local QQ',
        endpoint: `http://127.0.0.1:${f.s.config.qqLocalPort}`,
        token: 'fixture-api-token',
      },
      'test',
    );
    f.state.online = f.state.ready = true;
    let reads = 0;
    f.state.hook = async (action) => {
      if (action === 'OB11Config/GetConfig' && ++reads === 2) f.state.uin = '54321';
    };
    await assert.rejects(
      f.s.qqLogin.connect({ account_id: existing.id }, 'test'),
      (e: any) => e.code === 'QQ_IDENTITY_CHANGED',
    );
    const after = await f.s.accounts.get(existing.id);
    assert.equal(after.external_id, '12345');
    assert.notEqual(after.status, 'online');
    assert.equal((await f.s.db.query('SELECT account_id FROM bindings')).length, 0);
  } finally {
    await f.close();
  }
});

test('An older group refresh cannot overwrite a QQ identity bound while discovery is running', async () => {
  const f = await fixture();
  try {
    const existing = await f.s.accounts.create(
      {
        kind: 'qq',
        name: 'Concurrent local QQ',
        endpoint: `http://127.0.0.1:${f.s.config.qqLocalPort}`,
        token: 'fixture-api-token',
      },
      'test',
    );
    f.state.uin = '54321';
    f.state.hook = async (action) => {
      if (action === 'get_group_member_list')
        await f.s.db.query('UPDATE accounts SET external_id=$2 WHERE id=$1', [existing.id, '12345']);
    };
    await assert.rejects(
      f.s.accounts.refresh(existing.id, 'test'),
      (e: any) => e.code === 'QQ_IDENTITY_CHANGED',
    );
    assert.equal((await f.s.accounts.get(existing.id)).external_id, '12345');
    assert.equal((await f.s.db.query('SELECT account_id FROM bindings')).length, 0);
  } finally {
    await f.close();
  }
});

test('Managed login provisions private API credentials for an existing tokenless local connection', async () => {
  const f = await fixture();
  try {
    const existing = await f.s.accounts.create(
      {
        kind: 'qq',
        name: 'Tokenless local QQ',
        endpoint: `http://127.0.0.1:${f.s.config.qqLocalPort}`,
      },
      'test',
    );
    assert.equal((await f.s.accounts.get(existing.id)).secret_box, null);
    f.state.online = f.state.ready = true;
    f.state.config.network.httpServers[0].token = '';
    const connected = await f.s.qqLogin.connect({ account_id: existing.id }, 'test');
    assert.equal(connected.groups, 1);
    const after = await f.s.accounts.get(existing.id);
    assert.equal(after.external_id, '12345');
    const token = f.s.box.open(after.secret_box);
    assert(token.length >= 32);
    assert.equal(token, f.state.config.network.httpServers[0].token);
    await f.s.qqLogin.connect({ account_id: existing.id }, 'test');
    const again = await f.s.accounts.get(existing.id);
    assert.equal(again.secret_box, after.secret_box);
    assert.equal(again.incoming_secret_box, after.incoming_secret_box);
  } finally {
    await f.close();
  }
});

test('QQ auto review is off by default, excludes invitations and deduplicates observed and queued requests', async () => {
  const f = await fixture();
  try {
    const { account, group } = await f.connect();
    assert.equal((await f.s.qqRequests.overview(group.id)).auto_approve, false);
    const disabled = f.event();
    await f.s.qqRequests.receive(account, disabled);
    await f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test');
    await f.s.qqRequests.receive(account, disabled);
    assert.equal((await f.jobs()).length, 0);
    await f.s.qqRequests.receive(account, f.event('invite', { sub_type: 'invite' }));
    await f.s.qqRequests.receive(account, f.event('friend', { request_type: 'friend' }));
    assert.equal((await f.jobs()).length, 0);
    const active = f.event('active');
    await Promise.all([f.s.qqRequests.receive(account, active), f.s.qqRequests.receive(account, active)]);
    assert.equal((await f.jobs()).length, 1);
    await f.s.jobs.processOnce();
    assert.equal((await f.jobs())[0]!.status, 'succeeded');
    const effect = f.calls.filter((c) => c.action === 'set_group_add_request');
    assert.equal(effect.length, 1);
    assert.deepEqual(effect[0]!.params, { flag: 'active', sub_type: 'add', approve: true });
    const view = await f.s.qqRequests.overview(group.id);
    assert.equal(view.requests.length, 2);
    assert(!JSON.stringify(view).includes('flag_box'));
  } finally {
    await f.close();
  }
});

test('QQ auto review requires fresh owner/admin permissions and never substitutes cached roles', async () => {
  const f = await fixture();
  try {
    const { group, account } = await f.connect();
    f.state.unknownRole = true;
    await assert.rejects(
      f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test'),
      (e: any) => e.code === 'QQ_REVIEW_PERMISSION',
    );
    await f.s.accounts.refresh(account.id, 'test');
    assert.equal((await f.s.qqRequests.overview(group.id)).available, false);
    f.state.unknownRole = false;
    f.state.role = 'member';
    await f.s.accounts.refresh(account.id, 'test');
    await assert.rejects(
      f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test'),
      (e: any) => e.code === 'QQ_REVIEW_UNAVAILABLE',
    );
    assert.equal((await f.s.qqRequests.overview(group.id)).auto_approve, false);
    assert(!f.calls.some((c) => c.action === 'set_group_add_request'));
  } finally {
    await f.close();
  }
});

test('Changing NapCat configuration during connection never overwrites the newer configuration', async () => {
  const f = await fixture();
  try {
    f.state.online = f.state.ready = true;
    let reads = 0;
    f.state.hook = async (action) => {
      if (action === 'OB11Config/GetConfig' && ++reads === 2) f.state.config.custom = 'changed-outside';
    };
    await assert.rejects(f.s.qqLogin.connect({}, 'test'), (e: any) => e.code === 'QQ_CONFIG_CHANGED');
    assert.equal(f.state.config.custom, 'changed-outside');
    assert(!f.calls.some((c) => c.action === 'OB11Config/SetConfig'));
    assert((await f.s.db.query('SELECT * FROM accounts')).every((a) => a.status !== 'online'));
  } finally {
    await f.close();
  }
});

test('Closing then reopening QQ auto review does not resurrect queued or observed requests', async () => {
  const f = await fixture();
  try {
    const { account, group } = await f.connect();
    await f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test');
    const e = f.event('cancelled-request');
    await f.s.qqRequests.receive(account, e);
    await f.s.qqRequests.settings(group.id, { auto_approve: false }, 'test');
    await f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test');
    await f.s.qqRequests.receive(account, e);
    assert.equal((await f.jobs())[0]!.status, 'cancelled');
    assert.equal((await f.jobs()).length, 1);
    assert.equal(await f.s.jobs.processOnce(), false);
    assert(!f.calls.some((c) => c.action === 'set_group_add_request'));
  } finally {
    await f.close();
  }
});

test('Queued QQ requests stop for revoked authorization during live permission reads', async () => {
  for (const change of ['blacklist', 'settings', 'identity', 'pause', 'role', 'scope']) {
    const f = await fixture();
    try {
      const { group, account } = await f.connect();
      await f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test');
      await f.s.qqRequests.receive(account, f.event('queued-' + change));
      f.state.hook = async (action) => {
        if (action !== 'get_group_member_list') return;
        if (change === 'blacklist')
          await f.s.db.query(
            "INSERT INTO blacklists(id,conversation_id,user_id,reason) VALUES($1,$2,'99999','Fixture') ON CONFLICT DO NOTHING",
            [randomUUID(), group.id],
          );
        if (change === 'settings') {
          await f.s.qqRequests.settings(group.id, { auto_approve: false }, 'test');
          f.state.hook = null;
          await f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test');
        }
        if (change === 'identity') f.state.uin = '54321';
        if (change === 'pause')
          await f.s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [account.id]);
        if (change === 'role') f.state.role = 'member';
        if (change === 'scope') {
          const selected = await f.s.accounts.groups(account.id);
          await f.s.accounts.selectGroups(account.id, { group_ids: [], revision: selected.revision }, 'test');
        }
      };
      await f.s.jobs.processOnce();
      const job = (await f.jobs())[0]!;
      assert.equal(job.status, 'failed');
      assert(!f.calls.some((c) => c.action === 'set_group_add_request'));
    } finally {
      await f.close();
    }
  }
});

test('QQ review overview distinguishes final receipts and manual reconciliation without exposing request credentials', async () => {
  const f = await fixture();
  try {
    const { account, group } = await f.connect();
    await f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test');
    for (const [flag, response, expected] of [
      ['confirmed', { status: 200, data: { retcode: 0, status: 'ok', data: null } }, 'succeeded'],
      ['rejected', { status: 200, data: { retcode: 1403, status: 'failed' } }, 'failed'],
      ['ambiguous', { status: 200, data: { retcode: 0, status: 'failed' } }, 'unknown'],
      ['asynchronous', { status: 200, data: { retcode: 1, status: 'async' } }, 'unknown'],
    ] as const) {
      f.state.mutationResponse = response;
      const received = await f.s.qqRequests.receive(account, f.event(flag));
      const requestId = 'request_id' in received ? received.request_id : assert.fail('Request not recorded');
      let request = (await f.s.qqRequests.overview(group.id)).requests.find((r) => r.id === requestId)!;
      assert.equal(request.job_status, 'pending');
      await f.s.jobs.processOnce();
      request = (await f.s.qqRequests.overview(group.id)).requests.find((r) => r.id === requestId)!;
      assert.equal(request.job_status, expected);
      assert.equal('flag_box' in request, false);
      assert.equal('flag' in request, false);
      if (expected === 'unknown') {
        await assert.rejects(f.s.jobs.retry(request.job_id, 'test'));
        await f.s.jobs.reconcile(
          request.job_id,
          { outcome: 'succeeded', evidence: 'Fixture operator confirmed this specific member admission.' },
          'test',
        );
        assert.equal(
          (await f.s.qqRequests.overview(group.id)).requests.find((r) => r.id === request.id)!.job_status,
          'succeeded',
        );
      }
    }
    assert.equal(f.calls.filter((c) => c.action === 'set_group_add_request').length, 4);
  } finally {
    await f.close();
  }
});

test('QQ review handles disabled scope, expired requests, blacklists and unknown receipts without blind retries', async () => {
  const f = await fixture();
  try {
    const { group, account } = await f.connect();
    await f.s.qqRequests.settings(group.id, { auto_approve: true }, 'test');
    await f.s.qqRequests.receive(account, f.event('expired', { time: Math.floor(Date.now() / 1000) - 301 }));
    assert.equal((await f.jobs()).length, 0);
    await f.s.db.query(
      "INSERT INTO blacklists(id,conversation_id,user_id,reason) VALUES($1,$2,'99999','Fixture')",
      [randomUUID(), group.id],
    );
    await f.s.qqRequests.receive(account, f.event('blacklist'));
    assert.equal((await f.jobs()).length, 0);
    await f.s.db.query("UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[]') WHERE id=$1", [
      account.id,
    ]);
    await f.s.qqRequests.receive(account, f.event('disabled'));
    assert.equal((await f.jobs()).length, 0);
    await f.s.db.query(
      "UPDATE accounts SET settings=jsonb_set(settings,'{group_ids}','[\"67890\"]') WHERE id=$1",
      [account.id],
    );
    f.state.mutationResponse = { status: 500, data: { retcode: 0, status: 'ok', data: null } };
    const uncertain = f.event('unknown', { user_id: 88888 });
    await f.s.qqRequests.receive(account, uncertain);
    await f.s.jobs.processOnce();
    assert.equal((await f.jobs())[0]!.status, 'unknown');
    await f.s.qqRequests.receive(account, uncertain);
    assert.equal(await f.s.jobs.processOnce(), false);
    assert.equal(f.calls.filter((c) => c.action === 'set_group_add_request').length, 1);
    await assert.rejects(f.s.jobs.retry((await f.jobs())[0]!.id, 'test'));
    await f.s.qqRequests.receive(account, f.event('queued-expired', { user_id: 88888 }));
    await f.s.db.query(
      "UPDATE jobs SET review_ref=jsonb_set(review_ref,'{expires_at}',to_jsonb($2::text)) WHERE status='pending' AND conversation_id=$1",
      [group.id, new Date(Date.now() - 1000).toISOString()],
    );
    await f.s.jobs.processOnce();
    const expired = (await f.jobs()).find((job) => job.status === 'failed')!;
    assert.equal(expired.receipt.error.code, 'QQ_REQUEST_EXPIRED');
    assert.equal(f.calls.filter((c) => c.action === 'set_group_add_request').length, 1);
  } finally {
    await f.close();
  }
});

test('QQ login/review HTTP require admin and CSRF; only signed matching-account requests can create review records', async () => {
  const f = await fixture();
  const app = await createHttpApp(f.s);
  try {
    const { group, account } = await f.connect();
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'qq-review', password: 'qq-review-fixture-password' }),
    });
    const session = (await setup.json()) as any;
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const paths = [
      '/qq-local',
      '/qq-local/login',
      `/accounts/${account.id}/qq-login`,
      `/conversations/${group.id}/qq-requests`,
    ];
    const project = await f.s.features.createProject(
      { name: 'Fixture', conversation_ids: [group.id], scopes: ['messages.send', 'conversations.read'] },
      'test',
    );
    for (const path of paths) {
      assert.equal((await fetch(base + path)).status, 401);
      assert.equal(
        (await fetch(base + path, { headers: { authorization: `Bearer ${project.key}` } })).status,
        403,
      );
    }
    for (const [path, method, body] of [
      [`/accounts/${account.id}/qq-login/refresh`, 'POST', '{}'],
      ['/qq-local/login/connect', 'POST', '{}'],
      [`/conversations/${group.id}/qq-requests`, 'PUT', '{"auto_approve":true}'],
    ]) {
      assert.equal(
        (await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body }))
          .status,
        403,
      );
    }
    const payload = JSON.stringify(f.event('http-event'));
    const eventPath = base + `/connectors/qq/${account.id}/events`;
    assert.equal(
      (
        await fetch(eventPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        })
      ).status,
      401,
    );
    const signature =
      'sha1=' + createHmac('sha1', f.s.box.open(account.incoming_secret_box)).update(payload).digest('hex');
    assert.equal(
      (
        await fetch(eventPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signature': signature },
          body: payload,
        })
      ).status,
      200,
    );
    const view = await fetch(base + `/conversations/${group.id}/qq-requests`, { headers: { cookie } });
    assert.equal(view.status, 200);
    assert.equal(((await view.json()) as any).requests.length, 1);
    const allowed = await fetch(base + `/conversations/${group.id}/qq-requests`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf },
      body: '{"auto_approve":true}',
    });
    assert.equal(allowed.status, 200);
  } finally {
    await app.close();
    await f.close();
  }
});
