import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binanceSite,
  binanceSiteOf,
  binanceSites,
  isSiteUrl,
  pageRefusalKind,
  siteHostMatches,
} from '../src/binance-site.ts';
import { loadConfig } from '../src/config.ts';
import { createDirectClient } from '../src/binance-direct.ts';

test('each site owns one page origin and never accepts a look-alike host', () => {
  assert.equal(binanceSiteOf('https://www.binance.com/zh-CN/square/chat')?.id, 'official');
  assert.equal(binanceSiteOf('https://accounts.binance.com/zh-CN/login')?.id, 'official');
  assert.equal(binanceSiteOf('https://www.qorscuxtbd.com/zh-CN/square')?.id, 'backup');
  assert.equal(binanceSiteOf('https://notbinance.com/'), undefined);
  assert.equal(binanceSiteOf('https://binance.com.evil.example/'), undefined);
  assert.equal(binanceSiteOf('http://www.binance.com/'), undefined, 'plain HTTP is not a session site');
  assert.equal(binanceSiteOf('https://www.binance.com:8443/'), undefined, 'a non-443 port is refused');
  assert.equal(binanceSiteOf('https://user:pass@www.binance.com/'), undefined);

  assert.equal(isSiteUrl(binanceSites.official, 'https://www.binance.com/zh-CN/square'), true);
  assert.equal(isSiteUrl(binanceSites.official, 'https://www.qorscuxtbd.com/zh-CN/square'), false);
  assert.equal(isSiteUrl(binanceSites.backup, 'https://www.qorscuxtbd.com/zh-CN/square'), true);
  assert(siteHostMatches(binanceSites.official, 'accounts.binance.com'));
  assert(!siteHostMatches(binanceSites.official, 'qorscuxtbd.com'));
  assert.throws(() => binanceSite('mirror'), /Unknown Binance site/);
});

test('a blocked page is told apart from a verification challenge', () => {
  assert.equal(pageRefusalKind('Access Denied'), 'denied');
  assert.equal(pageRefusalKind('ERROR: The request could not be satisfied'), 'denied');
  assert.equal(pageRefusalKind('403 Forbidden'), 'denied');
  assert.equal(pageRefusalKind('安全验证'), 'challenge');
  assert.equal(pageRefusalKind('Just a moment...'), 'challenge');
  assert.equal(pageRefusalKind('币安广场 · 聊天'), null);
  assert.equal(pageRefusalKind('', '请完成人机验证'), 'challenge');
});

test('only a known site can be configured', () => {
  const saved = process.env.BINANCE_WEB_SITE;
  try {
    process.env.BINANCE_WEB_SITE = 'mirror';
    assert.throws(() => loadConfig(), /BINANCE_WEB_SITE/);
    process.env.BINANCE_WEB_SITE = 'backup';
    assert.equal(loadConfig().binanceWebSite, 'backup');
    delete process.env.BINANCE_WEB_SITE;
    assert.equal(loadConfig().binanceWebSite, 'official');
  } finally {
    if (saved === undefined) delete process.env.BINANCE_WEB_SITE;
    else process.env.BINANCE_WEB_SITE = saved;
  }
});

test('direct credentials and headers follow the configured site', async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = createDirectClient(
    { mode: 'direct', web_token: 'token-value', csrf_cookie: 'csrf-cookie' },
    undefined,
    {
      request: async (url, options) => {
        requests.push({ url, headers: (options?.headers ?? {}) as Record<string, string> });
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ success: true, data: { chatUserId: '123' } })),
        };
      },
    },
    binanceSites.backup,
  );
  await client.request({ operation: 'profile' });
  assert.equal(new URL(requests[0]!.url).origin, 'https://www.qorscuxtbd.com');
  assert.equal(requests[0]!.headers.origin, 'https://www.qorscuxtbd.com');
  assert.equal(requests[0]!.headers.referer, binanceSites.backup.chat);
});
