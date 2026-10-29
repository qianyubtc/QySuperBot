import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { FormData } from 'undici';
import { createServices } from '../src/services.ts';
import { createHttpApp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox, ApiError } from '../src/security.ts';
import { groupSnapshot } from '../src/adapters.ts';
import { requestJson } from '../src/network.ts';
import { testPng } from './image-fixture.ts';

const services = () =>
  createServices(
    { ...loadConfig(), dataDir: 'memory://', databaseUrl: undefined, seedDemo: false },
    { worker: false, box: new SecretBox(randomBytes(32)) },
  );

test('uploaded images require administrator auth and CSRF, validate real bytes and remain private and reusable', async () => {
  const s = await services();
  const app = await createHttpApp(s);
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'image-admin', password: 'image-fixture-password' }),
    });
    const principal = (await setup.json()) as any;
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const png = testPng();
    const upload = (headers: Record<string, string>, body = png) =>
      fetch(base + '/uploads/images', {
        method: 'POST',
        headers: { 'content-type': 'image/png', ...headers },
        body: new Uint8Array(body),
      });
    assert.equal((await upload({})).status, 401);
    assert.equal((await upload({ cookie })).status, 403);
    const headers = { cookie, 'x-csrf-token': principal.csrf };
    const response = await upload(headers);
    assert.equal(response.status, 200);
    const image = (await response.json()) as any;
    assert.equal(image.width, 32);
    assert.equal(image.height, 24);
    assert.equal(image.byte_size, png.length);
    assert(!JSON.stringify(image).includes('base64'));
    assert.equal(((await (await upload(headers)).json()) as any).id, image.id);
    assert.equal((await s.db.query('SELECT id FROM uploaded_images')).length, 1);
    assert.equal((await fetch(base + '/uploads/images/' + image.id)).status, 401);
    const preview = await fetch(base + '/uploads/images/' + image.id, { headers: { cookie } });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.match(preview.headers.get('cache-control')!, /private.*no-store/);
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert(Buffer.from(await preview.arrayBuffer()).equals(png));
    assert.equal((await upload(headers, Buffer.from('<svg onload="alert(1)"></svg>'))).status, 400);
    assert.equal((await upload(headers, png.subarray(0, 25))).status, 400);
    assert.equal((await upload({ ...headers, 'content-type': 'image/jpeg' })).status, 400);
    const huge = Buffer.from(png);
    huge.writeUInt32BE(10001, 16);
    assert.equal((await upload(headers, huge)).status, 400);
    assert.equal((await upload(headers, Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await s.db.query('SELECT id FROM uploaded_images')).length, 1);
  } finally {
    await app.close();
    await s.close();
  }
});

test('one image or image-caption broadcast fans out to TG, QQ and Binance with stable receipts and local image history', async () => {
  const s = await services();
  try {
    const image = await s.uploads.create(testPng());
    const groups: string[] = [],
      calls: any[] = [];
    for (const kind of ['telegram', 'qq', 'binance'] as const) {
      const created = await s.accounts.create(
        {
          kind,
          name: kind,
          ...(kind === 'telegram'
            ? { token: 'fixture-token' }
            : kind === 'qq'
              ? { endpoint: 'https://example.com' }
              : { group_ids: ['10001'] }),
        },
        'test',
      );
      await s.db.query(
        "UPDATE accounts SET status='online',external_id='12345',session_id='fixture-session' WHERE id=$1",
        [created.id],
      );
      const account = await s.accounts.get(created.id);
      groups.push(await s.accounts.upsertGroup(account, groupSnapshot('10001', kind, 'group', 3, kind, true)));
      if (kind === 'binance') s.binance.peers.set(account.id, { extensionVersion: '0.1.8' } as any);
    }
    s.adapters.telegram = async (_account, action, params, upload) => {
      calls.push({ kind: 'telegram', action, params, upload });
      return { status: 200, data: { ok: true, result: { message_id: 501 } } };
    };
    s.adapters.qq = async (_account, action, params) => {
      if (action === 'get_login_info') return { status: 200, data: { retcode: 0, data: { user_id: 12345 } } };
      calls.push({ kind: 'qq', action, params });
      return { status: 200, data: { retcode: 0, data: { message_id: 502 } } };
    };
    s.binance.request = async (_account, operation, params) => {
      calls.push({ kind: 'binance', operation, params });
      return { message_id: '503' };
    };
    const body = {
      title: '图片群发',
      content: '图片说明',
      image_asset_id: image.id,
      conversation_ids: groups,
    };
    const [a, b] = await Promise.all([
      s.features.createAnnouncement(body, 'test', 'image-batch-request'),
      s.features.createAnnouncement(body, 'test', 'image-batch-request'),
    ]);
    assert.equal(a.id, b.id);
    while (await s.jobs.processOnce()) {
      /* local platform fixtures only */
    }
    assert.equal(calls.length, 3);
    const tg = calls.find((call) => call.kind === 'telegram');
    assert.equal(tg.action, 'sendPhoto');
    assert.equal(tg.params.caption, '图片说明');
    assert(tg.upload.body.equals(testPng()));
    const qq = calls.find((call) => call.kind === 'qq');
    assert.equal(qq.action, 'send_group_msg');
    assert.equal(qq.params.message[0].data.text, '图片说明');
    assert.equal(qq.params.message[1].data.file, `base64://${testPng().toString('base64')}`);
    const bn = calls.find((call) => call.kind === 'binance');
    assert.equal(bn.operation, 'send_image');
    assert.equal(bn.params.text, '图片说明');
    assert.equal(bn.params.image.data, testPng().toString('base64'));
    for (const id of groups) {
      const snapshot = await s.chat.snapshot(id);
      assert.equal(snapshot.messages.length, 1);
      assert.equal(snapshot.deliveries[0].status, 'succeeded');
      assert.equal(snapshot.messages[0].segments[0].text, '图片说明');
      const local = await s.chat.image(id, snapshot.messages[0].id);
      assert(local.body.equals(testPng()));
      assert(!JSON.stringify(snapshot).includes(testPng().toString('base64')));
    }
    const jobs = (await s.db.query('SELECT id FROM jobs')).length;
    await assert.rejects(
      s.features.createAnnouncement({ ...body, content: 'x'.repeat(1025) }, 'test'),
      (e: any) => e.code === 'CONTENT_TOO_LONG',
    );
    await assert.rejects(
      s.features.createAnnouncement({ ...body, image_asset_id: `upload-image-${'0'.repeat(64)}` }, 'test'),
      (e: any) => e.code === 'IMAGE_ASSET_NOT_FOUND',
    );
    const bnAccount = (await s.accounts.list()).find((a) => a.kind === 'binance')!;
    s.binance.peers.get(bnAccount.id)!.extensionVersion = '0.1.7';
    await assert.rejects(
      s.features.createAnnouncement(body, 'test'),
      (e: any) => e.code === 'BINANCE_EXTENSION_UPDATE',
    );
    assert.equal((await s.db.query('SELECT id FROM jobs')).length, jobs);
    s.binance.peers.get(bnAccount.id)!.extensionVersion = '0.1.8';
    const onlyImage = await s.features.createAnnouncement({ ...body, content: '' }, 'test');
    const pure = await s.db.query('SELECT params FROM jobs WHERE announcement_id=$1', [onlyImage.id]);
    assert(pure.every((job) => job.params.segments.length === 1 && job.params.segments[0].type === 'image'));
  } finally {
    await s.close();
  }
});

test('Binance photo outcomes distinguish no upload from possible publication and never retry an uncertain upload', async () => {
  const s = await services();
  try {
    const image = await s.uploads.create(testPng());
    const created = await s.accounts.create(
      { kind: 'binance', name: 'upload fixture', group_ids: ['10001'] },
      'test',
    );
    await s.db.query("UPDATE accounts SET status='online',external_id='12345' WHERE id=$1", [created.id]);
    const account = await s.accounts.get(created.id);
    const id = await s.accounts.upsertGroup(account, groupSnapshot('10001', 'image', 'group', 3, 'qq', true));
    s.binance.peers.set(account.id, { extensionVersion: '0.1.8' } as any);
    let effect = 'none',
      calls = 0;
    s.binance.request = async () => {
      calls++;
      throw Object.assign(new ApiError(502, 'BINANCE_BROWSER_REQUEST', 'fixture'), {
        bridgeError: { effect, code: 'NETWORK' },
      });
    };
    const announcement = await s.features.createAnnouncement(
      { title: 'image', image_asset_id: image.id, conversation_ids: [id] },
      'test',
    );
    await s.jobs.processOnce();
    let job = (await s.db.query('SELECT * FROM jobs WHERE announcement_id=$1', [announcement.id]))[0]!;
    assert.equal(job.status, 'failed');
    assert.equal(job.receipt.error.retryable, true);
    effect = 'possible';
    await s.jobs.retry(job.id, 'test');
    await s.jobs.processOnce();
    job = (await s.db.query('SELECT * FROM jobs WHERE id=$1', [job.id]))[0]!;
    assert.equal(job.status, 'unknown');
    assert.equal(calls, 2);
    await assert.rejects(s.jobs.retry(job.id, 'test'), (e: any) => e.code === 'RETRY_NOT_ALLOWED');
    assert.equal(await s.jobs.processOnce(), false);
    assert.equal(calls, 2);
  } finally {
    await s.close();
  }
});

test('pinned multipart transport preserves image bytes and generates its own content boundary', async () => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    assert.match(req.headers['content-type']!, /^multipart\/form-data; boundary=/);
    assert(body.includes(testPng()));
    assert(body.includes(Buffer.from('图片说明')));
    assert(body.includes(Buffer.from('filename="fixture.png"')));
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const form = new FormData();
    form.set('caption', '图片说明');
    form.set('photo', new Blob([new Uint8Array(testPng())], { type: 'image/png' }), 'fixture.png');
    const result = await requestJson(`http://127.0.0.1:${(server.address() as any).port}`, {
      method: 'POST',
      body: form,
      allowPrivate: true,
    });
    assert.equal(result.data.ok, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
