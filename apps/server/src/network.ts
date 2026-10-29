import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch, type BodyInit } from 'undici';
import { ApiError } from './security.ts';

export async function requestRemote(
  urlText: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    timeoutMs?: number;
    allowPrivate?: boolean;
    signal?: AbortSignal;
  } = {},
  limit = 2 * 1024 * 1024,
): Promise<{ status: number; body: Buffer }> {
  const url = new URL(urlText);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new ApiError(400, 'INVALID_ENDPOINT', '连接地址格式不正确');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length) throw new ApiError(400, 'ENDPOINT_UNRESOLVED', '无法解析连接地址');
  for (const item of addresses) {
    const range = ipaddr.process(item.address).range();
    const local = ['private', 'loopback', 'uniqueLocal', 'carrierGradeNat'].includes(range);
    if (
      (range !== 'unicast' && !(local && options.allowPrivate)) ||
      (url.protocol === 'http:' && !options.allowPrivate)
    ) {
      throw new ApiError(
        400,
        'ENDPOINT_NOT_ALLOWED',
        '此连接地址不在允许范围内；本地桥接需由服务器启用 ALLOW_PRIVATE_CONNECTORS',
      );
    }
  }
  const address = addresses.find((item) => item.family === 4) ?? addresses[0]!;
  // Pin the validated IP so a second DNS lookup cannot redirect the request into a private network.
  const agent = new Agent({
    connect: {
      lookup: (_host: any, opts: any, callback: any) => {
        if (opts.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    },
  });
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      dispatcher: agent,
      redirect: 'manual',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 12_000)])
        : AbortSignal.timeout(options.timeoutMs ?? 12_000),
    });
    if (response.status >= 300 && response.status < 400)
      throw new ApiError(502, 'ENDPOINT_REDIRECT', '连接器重定向被拒绝，请配置最终地址');
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > limit) throw new ApiError(502, 'RESPONSE_TOO_LARGE', '连接器响应过大');
        chunks.push(chunk);
      }
    return { status: response.status, body: Buffer.concat(chunks) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'CONNECTOR_UNREACHABLE', '连接器请求失败或超时');
  } finally {
    await agent.close();
  }
}
export async function requestJson(url: string, options: Parameters<typeof requestRemote>[1] = {}) {
  const response = await requestRemote(url, options);
  let data: any;
  try {
    data = response.body.length ? JSON.parse(response.body.toString('utf8')) : {};
  } catch {
    throw new ApiError(502, 'INVALID_RESPONSE', '连接器没有返回有效 JSON');
  }
  return { status: response.status, data };
}
export function imageType(body: Buffer): string | null {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  if (
    body.subarray(4, 8).toString('ascii') === 'ftyp' &&
    ['avif', 'avis'].includes(body.subarray(8, 12).toString('ascii'))
  )
    return 'image/avif';
  return null;
}
export async function requestImage(url: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  // Public IP pinning, HTTPS, no redirects, no login cookies, and bounded bytes apply to signed media URLs too.
  const response = await requestRemote(
    url,
    {
      headers: { accept: 'image/avif,image/webp,image/*' },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
    8 * 1024 * 1024,
  );
  const contentType = imageType(response.body);
  if (response.status !== 200 || !contentType)
    throw new ApiError(502, 'IMAGE_UNAVAILABLE', '图片已失效或格式暂不支持，请稍后重试');
  return { body: response.body, contentType };
}
