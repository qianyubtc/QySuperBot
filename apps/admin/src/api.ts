let csrf = '';
export const setCsrf = (value: string) => {
  csrf = value;
};
export async function uploadImage(file: File): Promise<Record<string, any>> {
  if (!file.size || file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MiB 的图片');
  const response = await fetch('/api/v1/uploads/images', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: file,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('superbot:unauthorized'));
    throw new RequestError(value.error?.message || '图片上传失败，请重试', response.status);
  }
  return value;
}
export class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function api<T = any>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const value = await response.json().catch(() => ({}));
  options.signal?.throwIfAborted();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('superbot:unauthorized'));
    const fields = value.error?.fields
      ?.map((field: any) => `${field.path}：${field.message}`)
      .join('；');
    throw new RequestError(
      fields || value.error?.message || `请求失败（${response.status}）`,
      response.status,
    );
  }
  return value;
}

// Browser demo replaces this entire module at build time.
export const mediaUrl = (path: string) => path;
export const openChatStream = (path: string): EventSource => new EventSource(path);

export async function exampleImage(): Promise<Record<string, any>> { throw new Error('示例海报仅在演示模式提供'); }
