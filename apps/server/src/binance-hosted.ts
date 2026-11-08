import { readFileSync } from 'node:fs';
import type { ChatClient, ChatRequest } from '../../../packages/binance-chat/client.js';

/**
 * Runs the shared Binance chat client inside the server's own Chrome page, where the person who
 * operates the login window has signed in and passed Binance's human verification. Requests then
 * use that page's fetch, cookies and WebSocket exactly as the browser extension does, instead of a
 * separate server connection that never went through the verification.
 *
 * The page cannot call back into Node directly, so the channel is a small pump: the server starts a
 * request, then long-polls the page for events. A send's scope check and a member action's
 * pre-effect check are raised as questions, answered by the same server callbacks the direct
 * client uses, and any error they throw reaches the caller as the original error object.
 */

/** Operations that may change something on Binance once they have started. */
const effectful = new Set(['send', 'send_image', 'member_set_mute', 'member_remove']);
const stages: Record<string, string> = {
  send: 'send',
  send_image: 'image',
  member_set_mute: 'member',
  member_remove: 'member',
  socket: 'socket',
  profile: 'profile',
  group: 'group',
  history: 'history',
  groups: 'groups',
};
const jobTimeoutMs = 150_000;

let clientSource: string | undefined;
/** The shared client module as page script (its single export becomes a local function). */
function sharedClient() {
  if (!clientSource) {
    const source = readFileSync(new URL('../../../packages/binance-chat/client.js', import.meta.url), 'utf8');
    if (!source.includes('export function createBinanceChatClient'))
      throw new Error('Binance chat client source not found');
    clientSource = source.replace(
      'export function createBinanceChatClient',
      'function createBinanceChatClient',
    );
  }
  return clientSource;
}

// Plain page script (kept as text so no build step rewrites it). Installed once per isolated world.
const pageRuntime = `(createClient) => {
  if (globalThis.__qsbBinance) return 'ready';
  const outbox = [];
  const waiting = new Map();
  let wake = null;
  let asks = 0;
  const emit = (event) => {
    outbox.push(event);
    const resume = wake;
    wake = null;
    if (resume) resume();
  };
  const ask = (kind, job, group) =>
    new Promise((resolve, reject) => {
      const id = ++asks;
      waiting.set(id, { resolve, reject });
      emit({ type: 'ask', id, kind, job, group: group == null ? null : String(group) });
    });
  const failed = (job, error) =>
    emit({
      type: 'done',
      job,
      ok: false,
      error: error && error.bridgeError ? error.bridgeError : null,
      ask: error && error.qsbAsk ? error.qsbAsk : null,
      message: error && typeof error.message === 'string' ? error.message.slice(0, 200) : '',
    });
  const client = createClient({
    fetch: (...args) => fetch(...args),
    cookie(name) {
      const value = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(name + '='));
      try {
        return value ? decodeURIComponent(value.slice(name.length + 1)) : '';
      } catch {
        return '';
      }
    },
    managementEnabled: true,
    beforeSend: (group) => ask('send', null, group),
  });
  globalThis.__qsbBinance = {
    start(job, message, effect) {
      if (effect) message.before_effect = () => ask('effect', job, null);
      client.request(message).then(
        (data) => emit({ type: 'done', job, ok: true, data }),
        (error) => failed(job, error),
      );
      return true;
    },
    check(job, user) {
      client.checkConnection(user || undefined).then(
        (data) => emit({ type: 'done', job, ok: true, data }),
        (error) => failed(job, error),
      );
      return true;
    },
    next(wait) {
      if (outbox.length) return outbox.splice(0);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve(outbox.splice(0));
        }, wait);
        wake = () => {
          clearTimeout(timer);
          resolve(outbox.splice(0));
        };
      });
    },
    answer(id, ok, message) {
      const item = waiting.get(id);
      if (!item) return false;
      waiting.delete(id);
      if (ok) item.resolve();
      else {
        const error = new Error(message || '执行前检查未通过');
        error.qsbAsk = id;
        item.reject(error);
      }
      return true;
    },
    close() {
      client.close();
    },
  };
  return 'installed';
}`;

/**
 * The expression that installs the client in an isolated world of the Binance page. Tests pass a
 * stand-in factory expression; production always uses the shared client.
 */
export function hostedPageScript(factory?: string) {
  return `(${pageRuntime})(${factory ?? `(() => {\n${sharedClient()}\nreturn createBinanceChatClient;\n})()`})`;
}

type Evaluate = (expression: string) => Promise<any>;
type Job = {
  operation: string;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  effect?: () => Promise<void>;
  beforeSend?: (group: string) => Promise<void>;
};

function lost(operation: string, started: boolean) {
  const error = new Error('服务器浏览器的币安页面已断开');
  (error as any).bridgeError = {
    code: 'SOCKET',
    stage: stages[operation] ?? 'socket',
    // Once an effectful request reached the page it may have acted; never treat it as not sent.
    ...(effectful.has(operation) ? { effect: started ? 'possible' : 'none' } : {}),
  };
  return error;
}

export class HostedChannel {
  dead = false;
  private jobs = new Map<number, Job>();
  private askErrors = new Map<number, unknown>();
  private serial = 0;
  private pumping = false;
  private lastBeforeSend?: (group: string) => Promise<void>;
  constructor(
    private readonly evaluate: Evaluate,
    private readonly onClosed?: () => void,
  ) {}

  /** A ChatClient whose sends are fenced by `beforeSend`, like the direct client's. */
  client(beforeSend?: (group: string) => Promise<void>): ChatClient {
    return {
      request: (message: ChatRequest) => this.run('request', message, beforeSend),
      checkConnection: (user?: string) => this.run('check', user, beforeSend),
      close() {
        /* The page and its client outlive any one caller. */
      },
    };
  }

  private async run(kind: 'request' | 'check', payload: any, beforeSend?: (group: string) => Promise<void>) {
    const operation = kind === 'check' ? 'socket' : String(payload?.operation ?? '');
    if (this.dead) throw lost(operation, false);
    if (beforeSend) this.lastBeforeSend = beforeSend;
    const job = ++this.serial;
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(job, undefined, lost(operation, true)), jobTimeoutMs);
      timer.unref?.();
      this.jobs.set(job, {
        operation,
        resolve,
        reject,
        timer,
        beforeSend,
        effect: kind === 'request' ? payload.before_effect : undefined,
      });
    });
    try {
      if (kind === 'check')
        await this.evaluate(`globalThis.__qsbBinance.check(${job}, ${JSON.stringify(payload ?? '')})`);
      else {
        const { before_effect, ...message } = payload as ChatRequest;
        await this.evaluate(
          `globalThis.__qsbBinance.start(${job}, ${JSON.stringify(message)}, ${typeof before_effect === 'function'})`,
        );
      }
    } catch {
      // The page never received the request, so nothing can have happened on Binance.
      this.settle(job, undefined, lost(operation, false));
      this.close();
      return result;
    }
    void this.pump();
    return result;
  }

  private settle(job: number, value: unknown, error?: unknown) {
    const item = this.jobs.get(job);
    if (!item) return;
    this.jobs.delete(job);
    clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(value);
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.dead && this.jobs.size) {
        let events: any[];
        try {
          events = (await this.evaluate('globalThis.__qsbBinance.next(8000)')) ?? [];
        } catch {
          this.close();
          return;
        }
        for (const event of events) {
          if (event?.type === 'done')
            this.settle(event.job, event.data, event.ok ? undefined : this.failure(event));
          else if (event?.type === 'ask') void this.answer(event);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async answer(event: { id: number; kind: string; job: number | null; group: string | null }) {
    const owner = event.job === null ? undefined : this.jobs.get(event.job);
    // A send's scope check is not tied to one request inside the page; the latest caller's fence
    // is the current connection session's, which is the one that must still hold.
    const scope = owner?.beforeSend ?? this.lastBeforeSend;
    const check = event.kind === 'effect' ? owner?.effect : scope && (() => scope(event.group ?? ''));
    let ok = true,
      message = '';
    try {
      if (event.kind === 'effect' && !check) throw new Error('执行前检查不可用，未执行');
      await check?.();
    } catch (error) {
      ok = false;
      message = error instanceof Error ? error.message : '';
      this.askErrors.set(event.id, error);
    }
    try {
      await this.evaluate(
        `globalThis.__qsbBinance.answer(${event.id}, ${ok}, ${JSON.stringify(message.slice(0, 200))})`,
      );
    } catch {
      this.close();
    }
  }

  /** Rebuilds the page's failure; a server-side check that refused keeps its own error object. */
  private failure(event: { ask?: number | null; error?: unknown; message?: string }) {
    const original = event.ask ? this.askErrors.get(event.ask) : undefined;
    if (event.ask) this.askErrors.delete(event.ask);
    const error = original instanceof Error ? original : new Error(event.message || '币安网页请求失败');
    if (event.error && typeof event.error === 'object') (error as any).bridgeError = event.error;
    return error;
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    for (const [job, item] of this.jobs) this.settle(job, undefined, lost(item.operation, true));
    this.askErrors.clear();
    this.onClosed?.();
  }
}
