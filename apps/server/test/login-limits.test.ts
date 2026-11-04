import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServices, type Services } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig, parseTrustProxy } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { loginLimits } from '../src/auth.ts';

const password = 'limits-test-password';
type Server = { s: Services; app: Awaited<ReturnType<typeof createHttpApp>>; base: string };
const servers: Server[] = [];
async function start(trustProxy?: boolean | number | string): Promise<Server> {
  const s = await createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: false, trustProxy },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  const app = await createHttpApp(s);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/api/v1';
  const setup = await fetch(base + '/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'limits-admin', password }),
  });
  assert.equal(setup.status, 200);
  const server = { s, app, base };
  servers.push(server);
  return server;
}
let proxied: Server;
before(async () => {
  proxied = await start();
});
after(async () => {
  for (const { s, app } of servers) {
    await app.close();
    await s.close();
  }
});
const login = (server: Server, from: string, secret = 'wrong-password', username = 'limits-admin') =>
  fetch(server.base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
    body: JSON.stringify({ username, password: secret }),
  }).then((response) => response.status);

test('behind a same-host proxy each client address has its own budget', async () => {
  for (let i = 0; i < loginLimits.perUser; i++) assert.equal(await login(proxied, '203.0.113.1'), 401);
  assert.equal(await login(proxied, '203.0.113.1'), 429);
  assert.equal(await login(proxied, '203.0.113.1', password), 429, 'a limited address stays limited');
  assert.equal(await login(proxied, '203.0.113.2', password), 200, 'other clients can still sign in');
});

test('parallel wrong passwords cannot exceed the budget', async () => {
  const statuses = await Promise.all(
    Array.from({ length: loginLimits.perUser + 15 }, () => login(proxied, '203.0.113.3')),
  );
  assert.equal(statuses.filter((status) => status === 401).length, loginLimits.perUser);
  assert.equal(statuses.filter((status) => status === 429).length, 15);
});

test('trying many usernames from one address hits the address budget', async () => {
  for (let i = 0; i < loginLimits.perAddress; i++)
    assert.equal(await login(proxied, '203.0.113.4', 'wrong-password', `guess-${i}`), 401);
  assert.equal(await login(proxied, '203.0.113.4', 'wrong-password', 'guess-next'), 429);
  assert.equal(await login(proxied, '203.0.113.5', 'wrong-password', 'guess-next'), 401);
});

test('a successful sign-in resets the username budget and returns its address slot', async () => {
  for (let i = 0; i < loginLimits.perUser - 1; i++) assert.equal(await login(proxied, '203.0.113.6'), 401);
  assert.equal(await login(proxied, '203.0.113.6', password), 200);
  for (let i = 0; i < loginLimits.perUser; i++) assert.equal(await login(proxied, '203.0.113.6'), 401);
  assert.equal(await login(proxied, '203.0.113.6'), 429);
});

test('without a trusted proxy a client cannot pick its own address', async () => {
  const direct = await start(false);
  for (let i = 0; i < loginLimits.perUser; i++) assert.equal(await login(direct, `198.51.100.${i + 1}`), 401);
  assert.equal(await login(direct, '198.51.100.200'), 429, 'forwarded addresses must be ignored');
});

test('TRUST_PROXY accepts loopback, hop counts and addresses but never trusts every peer', () => {
  assert.equal(parseTrustProxy(), 'loopback');
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('loopback, uniquelocal'), 'loopback, uniquelocal');
  assert.throws(() => parseTrustProxy('true'), /spoofed/);
});
