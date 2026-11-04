import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';

const services = () =>
  createServices(
    { ...loadConfig(), databaseUrl: undefined, dataDir: 'memory://', seedDemo: true, setupToken: undefined },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );

test('a failing precondition check is a retryable failure, not an unknown outcome', async () => {
  const s = await services();
  try {
    const group = (await s.features.groups())[0]!;
    const job = await s.jobs.enqueue({
      key: randomUUID(),
      conversationId: group.id,
      action: 'message.send',
      params: { segments: [{ type: 'text', text: '你好' }] },
    });
    (s.jobs as any).preconditions = async () => {
      throw new Error('database hiccup');
    };
    assert.equal(await s.jobs.processOnce(), true);
    const row = (await s.db.query('SELECT * FROM jobs WHERE id=$1', [job.id]))[0]!;
    assert.equal(row.status, 'failed');
    assert.equal(row.receipt.error.code, 'PRECONDITION_CHECK_FAILED');
    assert.equal(row.receipt.error.retryable, true);
  } finally {
    await s.close();
  }
});

test('without a setup token only a direct local request can create the first administrator', async () => {
  const s = await services();
  const app = await createHttpApp(s);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/api/v1';
  const setup = (headers: Record<string, string> = {}) =>
    fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'guard-admin', password: 'guard-test-password' }),
    });
  try {
    const proxied = await setup({ 'x-forwarded-for': '203.0.113.9' });
    assert.equal(
      proxied.status,
      403,
      'a request forwarded by the local reverse proxy came from the internet',
    );
    assert.equal(((await proxied.json()) as any).error.code, 'SETUP_NOT_CONFIGURED');
    assert.equal((await setup()).status, 200, 'a request made on the server itself is still allowed');
  } finally {
    await app.close();
    await s.close();
  }
});
