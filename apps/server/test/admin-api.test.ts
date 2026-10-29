import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../admin/src/api.ts';

test('a status request aborted while reading its body rejects instead of returning an empty account object', async () => {
  const original = globalThis.fetch,
    controller = new AbortController();
  globalThis.fetch = async (_input, options) => {
    assert.equal(options?.signal, controller.signal);
    const response = new Response('{}', { status: 200 });
    response.json = async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    };
    return response;
  };
  try {
    await assert.rejects(
      api('/accounts', { signal: controller.signal }),
      (error: any) => error.name === 'AbortError',
    );
  } finally {
    globalThis.fetch = original;
  }
});
