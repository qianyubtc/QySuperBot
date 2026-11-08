import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { HostedChannel, hostedPageScript } from '../src/binance-hosted.ts';
import { ApiError } from '../src/security.ts';
import { binanceFailureKind } from '../src/binance-health.ts';

// A stand-in for the shared client that exercises the same hooks the real one calls.
const stubClient = `(env) => ({
  async request(message) {
    if (message.operation === 'history') return { messages: [{ msgId: '1' }] };
    if (message.operation === 'blocked') {
      const error = new Error('blocked');
      error.bridgeError = { code: 'API', stage: 'history', http_status: 403 };
      throw error;
    }
    if (message.operation === 'send') {
      await env.beforeSend(message.params.group_id);
      if (message.params.hang) return new Promise(() => {});
      return { message_id: '9' };
    }
    if (message.operation === 'member_remove') {
      if (typeof message.before_effect !== 'function') throw new Error('no pre-effect check');
      try {
        await env.beforeSend(message.params.group_id);
        await message.before_effect();
      } catch (error) {
        error.bridgeError = { ...(error.bridgeError ?? { code: 'FORMAT', stage: 'member' }), effect: 'none' };
        throw error;
      }
      return { state: 'removed' };
    }
    if (message.operation === 'hang') return new Promise(() => {});
    throw new Error('unexpected ' + message.operation);
  },
  async checkConnection() {
    return { connection: 'open', token_format: 'opaque', token_expires_at: null };
  },
  close() {},
})`;

function page(factory = stubClient) {
  const context = vm.createContext({ setTimeout, clearTimeout, document: { cookie: '' }, fetch });
  let broken = false;
  // Like Runtime.evaluate with awaitPromise + returnByValue: values cross as JSON.
  const evaluate = async (expression: string) => {
    if (broken) throw new Error('Cannot find context with specified id');
    const value = await vm.runInContext(expression, context);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  };
  return {
    evaluate,
    break() {
      broken = true;
    },
    async install() {
      assert.equal(await evaluate(hostedPageScript(factory)), 'installed');
      assert.equal(await evaluate(hostedPageScript(factory)), 'ready');
    },
  };
}

test('the shared client source installs as a page script', async () => {
  const p = page(undefined);
  assert.equal(await p.evaluate(hostedPageScript()), 'installed');
});

test('page requests resolve through the pump and failures keep their diagnostics', async () => {
  const p = page();
  await p.install();
  const client = new HostedChannel(p.evaluate).client();
  assert.deepEqual(await client.request({ operation: 'history', params: {} }), {
    messages: [{ msgId: '1' }],
  });
  assert.deepEqual(await client.checkConnection('1'), {
    connection: 'open',
    token_format: 'opaque',
    token_expires_at: null,
  });
  await assert.rejects(client.request({ operation: 'blocked', params: {} }), (error: any) => {
    assert.equal(error.bridgeError.http_status, 403);
    assert.equal(binanceFailureKind(error), 'access_blocked');
    return true;
  });
});

test('a send asks the server scope check, and a refusal reaches the caller as the original error', async () => {
  const p = page();
  await p.install();
  const groups: string[] = [];
  let allow = true;
  const refusal = new ApiError(409, 'BINANCE_CONNECTION_CHANGED', '连接或群范围已变化，本次未发送');
  const client = new HostedChannel(p.evaluate).client(async (group) => {
    groups.push(group);
    if (!allow) throw refusal;
  });
  assert.deepEqual(await client.request({ operation: 'send', params: { group_id: '10001' } }), {
    message_id: '9',
  });
  allow = false;
  await assert.rejects(client.request({ operation: 'send', params: { group_id: '10001' } }), (error) => {
    assert.equal(error, refusal);
    return true;
  });
  assert.deepEqual(groups, ['10001', '10001']);
});

test('member actions run the server pre-effect check, and a refusal is reported as not executed', async () => {
  const p = page();
  await p.install();
  const client = new HostedChannel(p.evaluate).client(async () => {});
  const checks: string[] = [];
  assert.deepEqual(
    await client.request({
      operation: 'member_remove',
      params: { group_id: '10001', user_id: '2' },
      before_effect: async () => {
        checks.push('passed');
      },
    }),
    { state: 'removed' },
  );
  const invalid = new ApiError(409, 'BINANCE_MANAGEMENT_SCOPE', '任务已过期');
  await assert.rejects(
    client.request({
      operation: 'member_remove',
      params: { group_id: '10001', user_id: '2' },
      before_effect: async () => {
        throw invalid;
      },
    }),
    (error: any) => {
      assert.equal(error, invalid);
      assert.equal((error as any).bridgeError.effect, 'none');
      return true;
    },
  );
  // Without a pre-effect check the shared client refuses member actions outright.
  await assert.rejects(
    client.request({ operation: 'member_remove', params: { group_id: '10001', user_id: '2' } }),
  );
  assert.deepEqual(checks, ['passed']);
});

test('losing the page marks started sends as possibly delivered and refuses new requests as not sent', async () => {
  const p = page();
  await p.install();
  let closed = 0;
  const channel = new HostedChannel(p.evaluate, () => closed++);
  const client = channel.client(async () => {});
  const reading = client.request({ operation: 'hang', params: {} });
  const sending = client.request({ operation: 'send', params: { group_id: '10001', hang: true } });
  await new Promise((r) => setTimeout(r, 50));
  p.break();
  // A read just failed; a send that reached the page may already be on Binance.
  await assert.rejects(
    reading,
    (error: any) => error.bridgeError.code === 'SOCKET' && !error.bridgeError.effect,
  );
  await assert.rejects(sending, (error: any) => error.bridgeError.effect === 'possible');
  assert.equal(channel.dead, true);
  assert.equal(closed, 1);
  await assert.rejects(
    client.request({ operation: 'send', params: { group_id: '10001' } }),
    (error: any) => error.bridgeError.effect === 'none',
  );
});
