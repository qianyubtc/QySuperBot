import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { ApiError } from './security.ts';
import type { Config } from './config.ts';
import type { Database, Row } from './database.ts';
import type { AuthService } from './auth.ts';
import { audit } from './context.ts';
import { ChromePipe } from './chrome-pipe.ts';
import { log } from './log.ts';
import { HostedChannel, hostedPageScript } from './binance-hosted.ts';
import { binanceSite, pageRefusalKind } from './binance-site.ts';
import type { ChatClient } from '../../../packages/binance-chat/client.js';

const run = promisify(execFile);

// Binance's CDN answers 403 until its human verification is passed, which Square shows.

const coordinate = z.number().finite().min(0).max(1200);
export const browserSocketPath =
  /^\/api\/v1\/accounts\/([a-f0-9-]{36})\/binance-browser\/socket\?window_id=([a-f0-9-]{36})$/;
export const browserInput = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('pointer'),
    action: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']),
    x: coordinate,
    y: z.number().finite().min(0).max(800),
    button: z.enum(['none', 'left', 'right', 'middle']).default('none'),
    buttons: z.number().int().min(0).max(7).default(0),
    deltaX: z.number().finite().min(-5000).max(5000).optional(),
    deltaY: z.number().finite().min(-5000).max(5000).optional(),
  }),
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(4096) }),
  z.strictObject({
    type: z.literal('key'),
    action: z.enum(['keyDown', 'keyUp']),
    key: z.string().max(30),
    code: z.string().max(30),
    keyCode: z.number().int().min(0).max(255),
    modifiers: z.number().int().min(0).max(15),
  }),
  z.strictObject({ type: z.literal('ping') }),
  // Sent by the page after it has drawn a frame; see BinanceBrowser.deliver.
  z.strictObject({ type: z.literal('frame_ack') }),
]);
/** How a viewer is keeping up with the screencast. */
type ViewerFlow = { acks: boolean; inflight: boolean; sentAt: number; sent: number };
/** At most ~12 frames a second: enough for typing and QR codes, light on a small VPS. */
const frameIntervalMs = 80;
/** A viewer that stops acknowledging (hidden tab, lost message) gets frames again after this. */
const staleFrameMs = 3000;
type Session = {
  id: string;
  accountId: string;
  abort: AbortController;
  browser?: ChildProcess;
  display?: ChildProcess;
  cdp?: ChromePipe;
  target?: string;
  viewers: Set<WebSocket>;
  expires: number;
  expiry?: ReturnType<typeof setTimeout>;
  ready: boolean;
  switching: boolean;
  screenshot?: string;
  page?: string;
  /** Sequence number of `screenshot`. */
  frame?: number;
  /** Chrome's screencast frame waiting for our acknowledgement (Chrome sends no more until then). */
  pendingAck?: number;
  ackTimer?: ReturnType<typeof setTimeout>;
  lastAck?: number;
  flow?: Map<WebSocket, ViewerFlow>;
  /**
   * Kept after "连接此账号": this browser, where a person signed in and passed Binance's human
   * verification, now carries the account's chat traffic, so it stays open with no time limit.
   */
  keep?: boolean;
  channel?: HostedChannel;
  channelPending?: Promise<HostedChannel>;
  /** Whether Chrome is streaming the screen (only while someone watches a kept browser). */
  casting?: boolean;
  watcher?: ReturnType<typeof setInterval>;
};
const screencast = { format: 'jpeg', quality: 60, maxWidth: 1200, maxHeight: 800 };

export class BinanceBrowser {
  session?: Session;
  server?: WebSocketServer;
  closing = false;
  cleanup: Promise<void> = Promise.resolve();
  readonly publicOrigin: string;
  hosting?: Promise<unknown>;
  hostFailedAt = 0;
  /** The verified site this deployment uses; both the login page and the chat belong to it. */
  get site() {
    return binanceSite(this.config.binanceWebSite);
  }
  get destinations() {
    const site = this.site;
    return { login: site.login, chat: site.chat, square: site.square } as const;
  }
  /**
   * True only for the site's chat origin. The login host serves the sign-in pages of the same site
   * but not the chat API, so a window sitting there must never be treated as the chat session.
   */
  onChatOrigin(url: unknown) {
    try {
      return new URL(String(url)).origin === `https://${this.site.host}`;
    } catch {
      return false;
    }
  }
  constructor(
    readonly config: Config,
    readonly db: Database,
    readonly auth: AuthService,
    readonly adopt: (
      account: Row,
      credentials: unknown,
      actor: string,
      signal: AbortSignal,
      options?: { hosted?: boolean },
    ) => Promise<unknown>,
  ) {
    try {
      this.publicOrigin = new URL(config.publicOrigin).origin;
    } catch {
      this.publicOrigin = '';
    }
  }
  /**
   * `PUBLIC_ORIGIN` is the address connectors call, which is not always the address the console is
   * opened from (dev proxy, reverse proxy, alternate host). A browser cannot forge `Host`, so a
   * matching Origin/Host pair is still same-origin and still rejects cross-site WebSocket upgrades.
   */
  originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return false;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (this.publicOrigin && parsed.origin === this.publicOrigin) return true;
    const host = request.headers.host;
    return !!host && parsed.host.toLowerCase() === host.toLowerCase();
  }
  async account(id: string) {
    const row = (await this.db.query('SELECT * FROM accounts WHERE id=$1', [z.string().uuid().parse(id)]))[0];
    if (!row || row.kind !== 'binance') throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '币安连接不存在');
    if (row.status === 'paused') throw new ApiError(409, 'ACCOUNT_PAUSED', '请先恢复此账号');
    return row;
  }
  status(id: string) {
    const s = this.session;
    return {
      available: !!this.config.binanceBrowserEnabled,
      running: s?.accountId === id && s.ready,
      starting: s?.accountId === id && !s.ready,
      window_id: s?.accountId === id ? s.id : null,
      kept: s?.accountId === id && !!s.keep,
      expires_at: s?.accountId === id && !s.keep ? new Date(s.expires).toISOString() : null,
    };
  }
  async start(id: string, actor: string, options: { keep?: boolean; url?: string } = {}) {
    if (!this.config.binanceBrowserEnabled || this.closing)
      throw new ApiError(409, 'BINANCE_BROWSER_UNAVAILABLE', '此服务器尚未启用币安登录窗口');
    await this.account(id);
    await this.cleanup;
    if (this.closing) throw new ApiError(409, 'BINANCE_BROWSER_UNAVAILABLE', '服务器正在关闭');
    if (this.session) {
      if (this.session.accountId !== id)
        throw new ApiError(409, 'BINANCE_BROWSER_BUSY', '另一个币安账号正在登录，请先结束该窗口');
      if (!this.session.ready)
        throw new ApiError(409, 'BINANCE_BROWSER_BUSY', '此登录窗口正在启动，请稍候再打开');
      return this.status(id);
    }
    const s: Session = {
      id: randomUUID(),
      accountId: id,
      abort: new AbortController(),
      viewers: new Set(),
      expires: Date.now() + 15 * 60_000,
      ready: false,
      switching: false,
    };
    this.session = s;
    const stop = () => {
      if (this.session === s) this.stop(id, undefined, true);
    };
    s.expiry = setTimeout(stop, 15 * 60_000);
    s.expiry.unref();
    try {
      const folder = join(this.config.dataDir, 'binance-browser', id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
      const authority = join(folder, 'Xauthority');
      let display: number | undefined;
      for (let candidate = 91; candidate < 101; candidate++) {
        try {
          await access(`/tmp/.X${candidate}-lock`);
        } catch {
          display = candidate;
          break;
        }
      }
      if (display === undefined) throw new ApiError(409, 'BINANCE_BROWSER_BUSY', '服务器显示资源暂不可用');
      await run('/usr/bin/xauth', [
        '-f',
        authority,
        'add',
        `:${display}`,
        '.',
        randomBytes(16).toString('hex'),
      ]);
      await chmod(authority, 0o600);
      if (this.session !== s) throw new ApiError(409, 'BINANCE_BROWSER_CLOSED', '登录窗口已关闭');
      s.display = spawn(
        '/usr/bin/Xvfb',
        [`:${display}`, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-auth', authority],
        { stdio: 'ignore' },
      );
      s.display.on('error', stop);
      s.display.on('exit', stop);
      // Xvfb creates this socket only when its display is ready. Never reuse QQ's display.
      for (let attempt = 0; ; attempt++) {
        if (this.session !== s || attempt > 40)
          throw new ApiError(502, 'BINANCE_BROWSER_START', '服务器显示环境启动失败');
        try {
          await access(`/tmp/.X11-unix/X${display}`);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const child = (s.browser = spawn(
        this.config.binanceBrowserExecutable ?? '/usr/bin/google-chrome',
        [
          '--remote-debugging-pipe',
          `--user-data-dir=${join(folder, 'profile')}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-dev-shm-usage',
          '--window-size=1280,900',
          '--force-device-scale-factor=1',
          options.url ?? this.site.login,
        ],
        {
          detached: true,
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            HOME: folder,
            LANG: 'C.UTF-8',
            XDG_CONFIG_HOME: join(folder, 'config'),
            XDG_CACHE_HOME: join(folder, 'cache'),
            DISPLAY: `:${display}`,
            XAUTHORITY: authority,
          },
          stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        },
      ));
      child.on('error', stop);
      child.on('exit', stop);
      s.cdp = new ChromePipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
      s.cdp.once('closed', stop);
      await s.cdp.command('Browser.getVersion');
      const targets = await s.cdp.command('Target.getTargets');
      const page = targets.targetInfos?.find((target: any) => target.type === 'page');
      if (!page) throw new ApiError(502, 'BINANCE_BROWSER_START', '币安登录页面尚未创建，请重试');
      await this.attachPage(s, page.targetId);
      s.cdp.on('event', (event) => {
        if (
          event.method === 'Page.frameNavigated' &&
          event.sessionId === s.target &&
          !event.params.frame?.parentId
        ) {
          this.page(s, event.params.frame?.url);
          // A new document drops the page client; the next request installs it again.
          s.channel?.close();
          s.channel = undefined;
        }
        if (event.method === 'Page.screencastFrame' && event.sessionId === s.target) {
          if (typeof event.params.data === 'string' && event.params.data.length <= 3 * 1024 * 1024)
            this.frame(s, event.params.sessionId, event.params.data);
          else
            void s.cdp
              ?.command('Page.screencastFrameAck', { sessionId: event.params.sessionId }, s.target)
              .catch(() => {});
        }
      });
      const history = await s.cdp.command('Page.getNavigationHistory', {}, s.target);
      this.page(s, history.entries?.[history.currentIndex]?.url);
      await s.cdp.command('Page.startScreencast', screencast, s.target);
      s.casting = true;
      if (this.session !== s) throw new ApiError(409, 'BINANCE_BROWSER_CLOSED', '登录窗口已关闭');
      s.ready = true;
      if (options.keep) this.keep(s);
      await audit(this.db, actor, 'account.binance.browser_opened', id);
      this.current(id, s.id);
      return this.status(id);
    } catch (error) {
      stop();
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'BINANCE_BROWSER_START', '服务器浏览器启动失败，请检查 Chrome 和显示环境');
    }
  }
  async attachPage(s: Session, targetId: string) {
    const attached = await s.cdp!.command('Target.attachToTarget', { targetId, flatten: true });
    s.target = attached.sessionId;
    await s.cdp!.command('Page.enable', {}, s.target);
    await s.cdp!.command(
      'Emulation.setDeviceMetricsOverride',
      { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false },
      s.target,
    );
  }
  /**
   * A new screencast frame. Frames used to be pushed while up to 1 MiB was still queued for a
   * viewer, and Chrome was acknowledged at once, so on a slow link every click waited behind
   * seconds of stale frames. Now a viewer that acknowledges frames has at most one in flight and
   * gets the newest one as soon as it has drawn the last, and Chrome is capped at ~12 frames a
   * second instead of painting and encoding as fast as it can.
   */
  frame(s: Session, castSession: number, data: string) {
    s.screenshot = data;
    s.frame = (s.frame ?? 0) + 1;
    for (const viewer of s.viewers) this.deliver(s, viewer);
    s.pendingAck = castSession;
    this.pace(s);
  }
  private flowOf(s: Session, ws: WebSocket) {
    s.flow ??= new Map();
    let flow = s.flow.get(ws);
    if (!flow) s.flow.set(ws, (flow = { acks: false, inflight: false, sentAt: 0, sent: 0 }));
    return flow;
  }
  private canTake(s: Session, ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const flow = this.flowOf(s, ws);
    // Pages from before frame acknowledgements fall back to the socket buffer.
    return flow.acks
      ? !flow.inflight || Date.now() - flow.sentAt > staleFrameMs
      : ws.bufferedAmount < 256 * 1024;
  }
  deliver(s: Session, ws: WebSocket) {
    const flow = this.flowOf(s, ws);
    if (!s.screenshot || flow.sent === s.frame || !this.canTake(s, ws)) return;
    flow.inflight = true;
    flow.sent = s.frame ?? 0;
    flow.sentAt = Date.now();
    ws.send(JSON.stringify({ type: 'frame', data: s.screenshot }));
  }
  frameAck(s: Session, ws: WebSocket) {
    const flow = this.flowOf(s, ws);
    flow.acks = true;
    flow.inflight = false;
    this.deliver(s, ws);
  }
  /** Lets Chrome paint the next frame, at most ~12 times a second. */
  private pace(s: Session) {
    if (s.pendingAck === undefined || s.ackTimer) return;
    s.ackTimer = setTimeout(
      () => {
        s.ackTimer = undefined;
        const id = s.pendingAck;
        if (id === undefined || this.session !== s) return;
        s.pendingAck = undefined;
        s.lastAck = Date.now();
        void s.cdp?.command('Page.screencastFrameAck', { sessionId: id }, s.target).catch(() => {});
      },
      Math.max(0, (s.lastAck ?? 0) + frameIntervalMs - Date.now()),
    );
  }
  /** Streams the screen while someone watches; an unwatched kept browser does not paint frames. */
  private cast(s: Session) {
    // An ordinary login window streams for its whole (short) life.
    if (!s.keep) return;
    const wanted = s.viewers.size > 0;
    if (wanted === !!s.casting || !s.cdp || !s.target || this.session !== s) return;
    s.casting = wanted;
    void s.cdp
      .command(wanted ? 'Page.startScreencast' : 'Page.stopScreencast', wanted ? screencast : {}, s.target)
      .catch(() => {});
  }
  /** Turns the login window into the account's long-lived chat browser. */
  private keep(s: Session) {
    if (s.keep) return;
    s.keep = true;
    clearTimeout(s.expiry);
    s.expiry = undefined;
    s.expires = Number.POSITIVE_INFINITY;
    this.cast(s);
    // A paused, removed or re-configured account no longer needs this browser.
    s.watcher = setInterval(() => {
      void this.db
        .query('SELECT kind,status,settings FROM accounts WHERE id=$1', [s.accountId])
        .then(([row]) => {
          if (
            !row ||
            row.kind !== 'binance' ||
            row.status === 'paused' ||
            row.settings?.transport !== 'direct' ||
            row.settings?.direct_auth?.hosted !== true
          )
            this.stop(s.accountId, undefined, true);
        })
        .catch(() => {});
    }, 60_000);
    s.watcher.unref();
  }
  /**
   * The chat client of a kept browser. When the browser is not running (after a restart, say) it is
   * started again in the background; the request in hand fails and the next poll retries.
   */
  hostedClient(id: string, beforeSend?: (group: string) => Promise<void>): ChatClient {
    const channel = () => this.channel(id);
    return {
      request: async (message) => (await channel()).client(beforeSend).request(message),
      checkConnection: async (user) => (await channel()).client(beforeSend).checkConnection(user),
      close() {
        /* The browser outlives any one client. */
      },
    };
  }
  private async channel(id: string) {
    const s = this.session;
    if (!s || s.accountId !== id || !s.ready || !s.cdp || !s.target) {
      if (s?.accountId === id && !s.ready)
        throw new ApiError(503, 'BINANCE_BROWSER_STARTING', '服务器浏览器正在启动，稍后自动同步');
      this.host(id);
      throw new ApiError(503, 'BINANCE_BROWSER_STARTING', '服务器浏览器未运行，正在重新启动；稍后自动同步');
    }
    if (s.channel && !s.channel.dead) return s.channel;
    s.channelPending ??= this.openChannel(s).finally(() => {
      s.channelPending = undefined;
    });
    return s.channelPending;
  }
  private async openChannel(s: Session) {
    const cdp = s.cdp!;
    const frame = async () => (await cdp.command('Page.getFrameTree', {}, s.target)).frameTree?.frame;
    let main = await frame();
    if (!this.onChatOrigin(main?.url)) {
      // Never navigate away from what a person is doing in the window, such as a verification.
      if (s.viewers.size)
        throw new ApiError(409, 'BINANCE_BROWSER_IN_USE', '请先在登录窗口中打开币安聊天页，再继续');
      await cdp.command('Page.navigate', { url: this.site.chat }, s.target);
      for (let attempt = 0; attempt < 40 && !this.onChatOrigin(main?.url); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        main = await frame();
      }
      if (!this.onChatOrigin(main?.url))
        throw new ApiError(504, 'BINANCE_BROWSER_TIMEOUT', '币安聊天页打开超时');
    }
    // An isolated world, like an extension content script: same cookies and origin as the page,
    // but invisible to the page's own scripts.
    const world = await cdp.command(
      'Page.createIsolatedWorld',
      { frameId: main.id, worldName: 'qsb-binance' },
      s.target,
    );
    const evaluate = async (expression: string) => {
      const result = await cdp.command(
        'Runtime.evaluate',
        { expression, contextId: world.executionContextId, awaitPromise: true, returnByValue: true },
        s.target,
      );
      if (result.exceptionDetails) throw new Error('page script failed');
      return result.result?.value;
    };
    await evaluate(hostedPageScript(undefined, this.site.domains));
    const channel = new HostedChannel(evaluate, () => {
      if (s.channel === channel) s.channel = undefined;
    });
    if (this.session !== s) {
      channel.close();
      throw new ApiError(409, 'BINANCE_BROWSER_CLOSED', '服务器浏览器已关闭');
    }
    s.channel = channel;
    return channel;
  }
  /** Starts the account's chat browser again without a viewer, retrying at most once a minute. */
  host(id: string) {
    if (!this.config.binanceBrowserEnabled || this.closing || this.hosting) return;
    if (Date.now() - this.hostFailedAt < 60_000) return;
    this.hosting = this.start(id, '系统', { keep: true, url: this.site.chat })
      .catch((error) => {
        this.hostFailedAt = Date.now();
        log.warn('binance chat browser restart failed', { account: id, error });
      })
      .finally(() => {
        this.hosting = undefined;
      });
  }
  page(s: Session, value: unknown) {
    try {
      const url = new URL(String(value));
      // Never forward authentication codes or other query parameters in display metadata.
      s.page = ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : '正在打开币安页面';
      for (const viewer of s.viewers)
        if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'page', url: s.page }));
    } catch {}
  }
  /**
   * Reads what the window is actually showing. A 403 from a CDN and a human-verification wall both
   * look like "no cookies" to the next step, and the operator needs to know which one it is.
   */
  private async pageRefusal(s: Session) {
    try {
      const result = await s.cdp!.command(
        'Runtime.evaluate',
        {
          expression:
            "({title: document.title, text: (document.body && document.body.innerText || '').slice(0, 600)})",
          returnByValue: true,
        },
        s.target,
      );
      const value = result.result?.value;
      if (!value || typeof value.title !== 'string') return null;
      return pageRefusalKind(value.title, typeof value.text === 'string' ? value.text : '');
    } catch {
      return null;
    }
  }
  private refusalMessage(kind: 'challenge' | 'denied') {
    if (kind === 'challenge')
      return new ApiError(
        409,
        'BINANCE_VERIFICATION_REQUIRED',
        '币安要求先完成安全验证，请在窗口中完成验证后再点击连接此账号',
      );
    const site = this.site;
    const other = site.id === 'official' ? 'backup' : 'official';
    return new ApiError(
      409,
      'BINANCE_ACCESS_BLOCKED',
      `币安拒绝了这个网络访问${site.id === 'official' ? '官网' : '备用站'}（403 或访问受限）。可先更换服务器出口网络；若确认是站点被拦，改用已核实的${other === 'backup' ? '备用站' : '官网'}（BINANCE_WEB_SITE=${other}）后重启`,
    );
  }
  current(id: string, windowId?: string) {
    const s = this.session;
    if (
      !s ||
      s.accountId !== id ||
      (windowId && s.id !== windowId) ||
      !s.ready ||
      !s.cdp ||
      !s.target ||
      s.expires <= Date.now()
    )
      throw new ApiError(409, 'BINANCE_BROWSER_CLOSED', '登录窗口已关闭或超时，请重新打开');
    return s;
  }
  async connect(id: string, actor: string, windowId?: string) {
    const s = this.current(id, windowId),
      account = await this.account(id);
    if (s.switching) throw new ApiError(409, 'BINANCE_BUSY', '正在验证并连接，请稍候');
    s.switching = true;
    try {
      const refusal = await this.pageRefusal(s);
      if (refusal) throw this.refusalMessage(refusal);
      // URL-scoped CDP cookies are filtered immediately; no full cookie response reaches the client or logs.
      const data = await s.cdp!.command(
        'Network.getCookies',
        { urls: [`https://${this.site.host}/bapi/c2c/v3/private/binance-chat/user/get-my-profile`] },
        s.target,
      );
      const pick = (name: string) =>
        data.cookies
          ?.filter((item: any) => item.name === name)
          .sort((a: any, b: any) => b.path.length - a.path.length)[0]?.value;
      const web_token = pick('p20t'),
        csrf_cookie = pick('cr00'),
        device_id = pick('BNC_FV_KEY');
      if (!web_token || !csrf_cookie)
        throw new ApiError(409, 'BINANCE_LOGIN_REQUIRED', '请先在窗口完成币安登录，再点击连接此账号');
      if (this.session !== s) throw new ApiError(409, 'BINANCE_BROWSER_CLOSED', '登录窗口已关闭');
      // Validation and all later traffic run inside this page, which carries the verification.
      const result = await this.adopt(
        account,
        { mode: 'direct', web_token, csrf_cookie, ...(device_id ? { device_id } : {}) },
        actor,
        s.abort.signal,
        { hosted: true },
      );
      if (this.session === s) this.keep(s);
      return result;
    } finally {
      s.switching = false;
    }
  }
  async navigate(id: string, destination: 'login' | 'chat' | 'square' = 'chat', windowId?: string) {
    const s = this.current(id, windowId);
    await s.cdp!.command('Page.navigate', { url: this.destinations[destination] }, s.target);
    return { navigated: true };
  }
  /** Closes the browser. A kept browser carries the chat, so closing its window leaves it running. */
  stop(id?: string, windowId?: string, force = false) {
    const s = this.session;
    if (!s || (id && s.accountId !== id) || (windowId && s.id !== windowId)) return false;
    if (s.keep && !force) return false;
    this.session = undefined;
    s.abort.abort();
    clearTimeout(s.expiry);
    clearInterval(s.watcher);
    s.channel?.close();
    s.screenshot = undefined;
    clearTimeout(s.ackTimer);
    s.ackTimer = undefined;
    for (const viewer of s.viewers) viewer.close(1000, 'Login window closed');
    s.cdp?.close();
    s.browser?.kill('SIGTERM');
    s.display?.kill('SIGTERM');
    const child = s.browser;
    if (child?.pid && child.exitCode === null) {
      this.cleanup = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {}
          resolve();
        }, 2500);
        timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }
  attach(server: Server) {
    const wss = (this.server = new WebSocketServer({ noServer: true, maxPayload: 16384 }));
    server.on('upgrade', (request, socket, head) => {
      const match = request.url?.match(browserSocketPath);
      if (!match) return;
      void (async () => {
        if (this.closing || !this.originAllowed(request)) {
          log.warn('binance browser websocket rejected', {
            reason: this.closing ? 'closing' : 'origin',
            origin: String(request.headers.origin ?? ''),
            host: String(request.headers.host ?? ''),
          });
          throw new Error();
        }
        const principal = await this.auth.authenticate(request.headers);
        this.auth.requireAdmin(principal);
        await this.account(match[1]!);
        const s = this.current(match[1]!, match[2]!);
        if (s.viewers.size >= 2) throw new Error();
        wss.handleUpgrade(request, socket, head, (ws) => {
          s.viewers.add(ws);
          ws.on('error', () => {});
          this.deliver(s, ws);
          this.cast(s);
          if (s.page) ws.send(JSON.stringify({ type: 'page', url: s.page }));
          let count = 0,
            since = Date.now();
          const check = setInterval(() => {
            void this.auth
              .authenticate(request.headers)
              .then((p) => {
                this.auth.requireAdmin(p);
                return this.account(s.accountId);
              })
              .catch(() => ws.close(1008, 'Session expired'));
          }, 15000);
          check.unref();
          ws.once('close', () => {
            clearInterval(check);
            s.viewers.delete(ws);
            s.flow?.delete(ws);
            this.cast(s);
          });
          ws.on('message', (raw) => {
            void (async () => {
              if (this.session !== s || !s.ready || s.expires <= Date.now()) throw new Error();
              if (Date.now() - since > 1000) {
                since = Date.now();
                count = 0;
              }
              if (++count > 100) throw new Error();
              const input = browserInput.parse(JSON.parse(raw.toString()));
              if (input.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
              }
              if (input.type === 'frame_ack') {
                this.frameAck(s, ws);
                return;
              }
              if (input.type === 'text')
                await s.cdp!.command('Input.insertText', { text: input.text }, s.target);
              if (input.type === 'key')
                await s.cdp!.command(
                  'Input.dispatchKeyEvent',
                  {
                    type: input.action,
                    key: input.key,
                    code: input.code,
                    windowsVirtualKeyCode: input.keyCode,
                    nativeVirtualKeyCode: input.keyCode,
                    modifiers: input.modifiers,
                  },
                  s.target,
                );
              if (input.type === 'pointer')
                await s.cdp!.command(
                  'Input.dispatchMouseEvent',
                  {
                    type: input.action,
                    x: input.x,
                    y: input.y,
                    button: input.button,
                    buttons: input.buttons,
                    clickCount: input.action === 'mousePressed' || input.action === 'mouseReleased' ? 1 : 0,
                    ...(input.action === 'mouseWheel'
                      ? { deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 }
                      : {}),
                  },
                  s.target,
                );
            })().catch(() => ws.close(1008, 'Invalid browser input'));
          });
        });
      })().catch(() => socket.destroy());
    });
  }
  close() {
    this.closing = true;
    this.stop(undefined, undefined, true);
    this.server?.close();
  }
  onModuleDestroy() {
    this.close();
  }
}
