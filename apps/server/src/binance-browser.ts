import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { ApiError } from './security.ts';
import type { Config } from './config.ts';
import type { Database, Row } from './database.ts';
import type { AuthService } from './auth.ts';
import { audit } from './context.ts';
import { ChromePipe } from './chrome-pipe.ts';

const run = promisify(execFile);
const home = 'https://www.binance.com/zh-CN/square/chat';
const login = 'https://accounts.binance.com/zh-CN/login';
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
]);
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
};

export class BinanceBrowser {
  session?: Session;
  server?: WebSocketServer;
  closing = false;
  cleanup: Promise<void> = Promise.resolve();
  constructor(
    readonly config: Config,
    readonly db: Database,
    readonly auth: AuthService,
    readonly adopt: (
      account: Row,
      credentials: unknown,
      actor: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}
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
      expires_at: s?.accountId === id ? new Date(s.expires).toISOString() : null,
    };
  }
  async start(id: string, actor: string) {
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
      if (this.session === s) this.stop(id);
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
          login,
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
        )
          this.page(s, event.params.frame?.url);
        if (event.method === 'Page.screencastFrame' && event.sessionId === s.target) {
          void s.cdp
            ?.command('Page.screencastFrameAck', { sessionId: event.params.sessionId }, s.target)
            .catch(() => {});
          if (typeof event.params.data !== 'string' || event.params.data.length > 3 * 1024 * 1024) return;
          s.screenshot = event.params.data;
          for (const viewer of s.viewers)
            if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < 1024 * 1024)
              viewer.send(JSON.stringify({ type: 'frame', data: event.params.data }));
        }
      });
      const history = await s.cdp.command('Page.getNavigationHistory', {}, s.target);
      this.page(s, history.entries?.[history.currentIndex]?.url);
      await s.cdp.command(
        'Page.startScreencast',
        { format: 'jpeg', quality: 70, maxWidth: 1200, maxHeight: 800 },
        s.target,
      );
      if (this.session !== s) throw new ApiError(409, 'BINANCE_BROWSER_CLOSED', '登录窗口已关闭');
      s.ready = true;
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
  page(s: Session, value: unknown) {
    try {
      const url = new URL(String(value));
      // Never forward authentication codes or other query parameters in display metadata.
      s.page = ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : '正在打开币安页面';
      for (const viewer of s.viewers)
        if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: 'page', url: s.page }));
    } catch {}
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
      // URL-scoped CDP cookies are filtered immediately; no full cookie response reaches the client or logs.
      const data = await s.cdp!.command(
        'Network.getCookies',
        { urls: ['https://www.binance.com/bapi/c2c/v3/private/binance-chat/user/get-my-profile'] },
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
      const result = await this.adopt(
        account,
        { mode: 'direct', web_token, csrf_cookie, ...(device_id ? { device_id } : {}) },
        actor,
        s.abort.signal,
      );
      if (this.session === s) this.stop(id);
      return result;
    } finally {
      s.switching = false;
    }
  }
  async navigate(id: string, destination: 'login' | 'chat' = 'chat', windowId?: string) {
    const s = this.current(id, windowId);
    await s.cdp!.command('Page.navigate', { url: destination === 'login' ? login : home }, s.target);
    return { navigated: true };
  }
  stop(id?: string, windowId?: string) {
    const s = this.session;
    if (!s || (id && s.accountId !== id) || (windowId && s.id !== windowId)) return false;
    this.session = undefined;
    s.abort.abort();
    clearTimeout(s.expiry);
    s.screenshot = undefined;
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
        if (this.closing || request.headers.origin !== new URL(this.config.publicOrigin).origin)
          throw new Error();
        const principal = await this.auth.authenticate(request.headers);
        this.auth.requireAdmin(principal);
        await this.account(match[1]!);
        const s = this.current(match[1]!, match[2]!);
        if (s.viewers.size >= 2) throw new Error();
        wss.handleUpgrade(request, socket, head, (ws) => {
          s.viewers.add(ws);
          ws.on('error', () => {});
          if (s.screenshot) ws.send(JSON.stringify({ type: 'frame', data: s.screenshot }));
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
    this.stop();
    this.server?.close();
  }
  onModuleDestroy() {
    this.close();
  }
}
