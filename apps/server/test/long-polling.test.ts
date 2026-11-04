import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createServices } from '../src/services.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/security.ts';
import { requestJson } from '../src/network.ts';

test('repeated connector calls reuse pooled keep-alive connections', async () => {
  let connections = 0;
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  server.on('connection', () => connections++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    for (let i = 0; i < 6; i++) {
      const response = await requestJson(`http://127.0.0.1:${port}/call`, { allowPrivate: true });
      assert.equal(response.data.ok, true);
    }
    // A call issued the instant the previous one ends may open a second pooled socket; without
    // pooling every call would need its own connection.
    assert.ok(connections <= 2, `${connections} connections for 6 calls`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a started worker long-polls each Telegram bot in its own loop and stops it cleanly', async () => {
  const s = await createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );
  try {
    const polls: { timeout: number; offset: number; signal?: AbortSignal }[] = [];
    s.adapters.telegram = async (_account, action, params: any = {}, _image, options = {}) => {
      if (action === 'getMe')
        return { status: 200, data: { ok: true, result: { id: 789, first_name: 'Loop Bot' } } };
      if (action === 'getWebhookInfo') return { status: 200, data: { ok: true, result: { url: '' } } };
      if (action === 'getUpdates') {
        polls.push({ timeout: params.timeout, offset: params.offset, signal: options.signal });
        if (polls.length === 1) return { status: 200, data: { ok: true, result: [{ update_id: 41 }] } };
        // Hold the long poll open, as Telegram does, until the loop is stopped.
        await new Promise((_, reject) =>
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      }
      return { status: 200, data: { ok: true, result: true } };
    };
    const created = await s.accounts.create(
      { kind: 'telegram', name: 'Loop bot', token: 'loop-token' },
      'test',
    );
    await s.accounts.refresh(created.id, 'test');
    assert.equal((await s.accounts.get(created.id)).status, 'online');

    s.worker.longPolling = true;
    await (s.worker as any).syncTelegramLoops();
    for (let i = 0; i < 100 && polls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(polls.length, 2);
    assert.deepEqual(
      polls.map((poll) => [poll.timeout, poll.offset]),
      [
        [25, 0],
        [25, 42],
      ],
    );
    assert.equal(s.worker.telegramLoops.size, 1);
    // The short poll leaves Telegram to the loop instead of competing with it.
    await (s.worker as any).poll();
    assert.equal(polls.length, 2);

    await s.worker.drain();
    assert.equal(polls[1]!.signal?.aborted, true);
    assert.equal(s.worker.telegramLoops.size, 0);
    // Stopping the loop is not a connection failure.
    const account = await s.accounts.get(created.id);
    assert.equal(account.status, 'online');
    assert.equal(account.last_error, null);
  } finally {
    await s.close();
  }
});
