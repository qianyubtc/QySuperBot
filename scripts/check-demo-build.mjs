import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../dist/demo/', import.meta.url);
const headers = await readFile(new URL('_headers', root), 'utf8');
assert(
  headers.includes("connect-src 'none'"),
  'Demo must disallow API, WS and SSE network connections',
);
assert(headers.includes("form-action 'none'"));
assert.equal(await readFile(new URL('_redirects', root), 'utf8'), '/* /index.html 200\n');
const files = await readdir(new URL('assets/', root));
const scripts = (
  await Promise.all(
    files
      .filter((n) => n.endsWith('.js'))
      .map((n) => readFile(new URL('assets/' + n, root), 'utf8')),
  )
).join('\n');
assert(
  !/new\s+(?:WebSocket|EventSource)\s*\(/.test(scripts),
  'A real transport leaked into the demo bundle',
);
assert(!scripts.includes('qsb_session'), 'Server authentication must not ship in the demo');
assert(
  !scripts.includes('credentials:"same-origin"'),
  'Production API client must not ship in the demo',
);
assert(scripts.includes('qysuperbot:demo:v1'), 'Browser demo adapter missing');
console.log(
  'Demo build verified: local data adapter, no real login/WS/SSE client, strict connection CSP, SPA routing.',
);
