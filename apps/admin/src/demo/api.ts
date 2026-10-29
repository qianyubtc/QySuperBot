import { DemoStore, DemoError, DEMO_KEY, poster, now } from './store';
export { DemoError as RequestError } from './store';
let storage: Storage | undefined;
try {
  storage = window.localStorage;
} catch {
  /* Read-only previews still render; writes return a useful error. */
}
export const demo = new DemoStore(
  storage ?? {
    getItem: () => null,
    removeItem: () => {},
    setItem: () => {
      throw new Error('Storage unavailable');
    },
  },
);
export const setCsrf = (_value: string) => {};
export async function api<T = any>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const result = demo.request(path, options);
  options.signal?.throwIfAborted();
  return structuredClone(result) as T;
}
export function mediaUrl(path: string): string {
  const url = new URL(path, 'https://demo.invalid');
  const upload = url.pathname.match(/\/uploads\/images\/([^/]+)/);
  if (upload) return demo.state.images[decodeURIComponent(upload[1]!)]?.url ?? poster;
  const message = url.pathname.match(/\/messages\/([^/]+)\/image/);
  if (message) {
    const m = demo.state.messages.find((v: Record<string, any>) => v.id === decodeURIComponent(message[1]!));
    return (
      demo.state.images[m?.segments?.find((s: Record<string, any>) => s.type === 'image')?.asset_id]?.url ??
      poster
    );
  }
  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#e4eedc"/><circle cx="32" cy="25" r="11" fill="#73956c"/><path d="M10 60a22 22 0 0 1 44 0" fill="#73956c"/></svg>',
    )
  );
}
export async function uploadImage(file: File): Promise<Record<string, any>> {
  if (!file.size || file.size > 1024 * 1024 || !['image/jpeg', 'image/png'].includes(file.type))
    throw new DemoError('演示模式请选择不超过 1 MiB 的 JPG / PNG；文件只保存在当前浏览器。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10',
    jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!(file.type === 'image/png' ? png : jpg)) throw new DemoError('图片文件内容不是有效的 JPG / PNG');
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new DemoError('读取本地图片失败'));
    r.readAsDataURL(file);
  });
  const picture = new Image();
  picture.src = url;
  try {
    await picture.decode();
    if (!picture.naturalWidth || !picture.naturalHeight) throw new Error('Empty image');
  } catch {
    throw new DemoError('无法解码此图片，文件可能损坏。请选择完整的 JPG / PNG。');
  }
  const id =
    'upload-image-' +
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  const row = {
    id,
    url,
    byte_size: file.size,
    content_type: png ? 'image/png' : 'image/jpeg',
    created_at: now(),
  };
  demo.update((s) => {
    s.images[id] = row;
    return row;
  });
  return row;
}
export function openChatStream(path: string): EventSource {
  const id = decodeURIComponent(path.match(/\/conversations\/([^/]+)\/stream/)?.[1] ?? '');
  const events = new EventTarget();
  let closed = false;
  const stream = {
    readyState: 0,
    onopen: null as null | (() => void),
    onerror: null as null | (() => void),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    close() {
      closed = true;
      stream.readyState = 2;
      demo.listeners.delete(emit);
    },
  };
  function emit() {
    if (!closed)
      events.dispatchEvent(new MessageEvent('chat.snapshot', { data: JSON.stringify(demo.snapshot(id)) }));
  }
  demo.listeners.add(emit);
  queueMicrotask(() => {
    if (!closed) {
      stream.readyState = 1;
      stream.onopen?.();
      emit();
    }
  });
  return stream as unknown as EventSource;
}
window.addEventListener('storage', (event) => {
  if (event.key === DEMO_KEY) {
    try {
      demo.state = new DemoStore(storage).state;
      demo.listeners.forEach((fn) => fn());
    } catch {
      /* Keep current valid snapshot. */
    }
  }
});

demo.listeners.add(() => window.dispatchEvent(new Event('superbot:demo-changed')));

export async function exampleImage(): Promise<Record<string, any>> {
  const row = {
    id: 'upload-image-' + '0'.repeat(64),
    url: poster,
    byte_size: 0,
    content_type: 'image/svg+xml',
    created_at: now(),
  };
  demo.update((s) => {
    s.images[row.id] = row;
  });
  return row;
}
