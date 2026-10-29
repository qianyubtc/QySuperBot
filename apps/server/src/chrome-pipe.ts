import type { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { ApiError } from './security.ts';

// Chromium's native pipe uses null-terminated JSON on fd 3/4; no debugging TCP port exists.
export class ChromePipe extends EventEmitter {
  serial = 0;
  buffer = Buffer.alloc(0);
  pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  closed = false;
  constructor(
    readonly input: Writable,
    readonly output: Readable,
  ) {
    super();
    input.on('error', () => this.close());
    output.on('error', () => this.close());
    output.on('end', () => this.close());
    output.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 8 * 1024 * 1024) {
        this.close();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf(0)) >= 0) {
        const frame = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        try {
          const value = JSON.parse(frame.toString());
          if (value.id) {
            const item = this.pending.get(value.id);
            if (!item) continue;
            this.pending.delete(value.id);
            clearTimeout(item.timer);
            if (value.error)
              item.reject(new ApiError(502, 'BINANCE_BROWSER_COMMAND', '浏览器操作未完成，请稍后重试'));
            else item.resolve(value.result);
          } else if (typeof value.method === 'string') this.emit('event', value);
        } catch {
          this.close();
          return;
        }
      }
    });
  }
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.closed || this.pending.size >= 64)
      return Promise.reject(new ApiError(409, 'BINANCE_BROWSER_CLOSED', '登录窗口已断开，请重新打开'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError(504, 'BINANCE_BROWSER_TIMEOUT', '登录窗口响应超时，请重试'));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.input.write(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
          (error) => {
            if (error) this.close();
          },
        );
      } catch {
        this.close();
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new ApiError(409, 'BINANCE_BROWSER_CLOSED', '登录窗口已断开'));
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.input.destroy();
    this.output.destroy();
    this.emit('closed');
  }
}
