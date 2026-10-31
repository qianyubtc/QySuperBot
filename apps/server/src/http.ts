import 'reflect-metadata';
import { All, Catch, Controller, Get, Inject, Module, Param, Req, Res } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { ProtocolError, receiptSchema } from '../../../packages/contracts/src/index.ts';
import type { Services } from './services.ts';
import { ApiError, equal } from './security.ts';
import { audit } from './context.ts';
import { qqEvents } from './adapters.ts';
import { ChatService } from './chat.ts';
import { BinanceBridge } from './binance.ts';
import { BinanceBrowser, browserSocketPath } from './binance-browser.ts';
import { verificationRows } from './qq-verification.ts';

const SERVICE = Symbol('services');
@Catch()
class Errors implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError)
      return response.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: '请检查填写内容',
          fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    const known = error instanceof ApiError || error instanceof ProtocolError;
    const status = known ? error.status : error.statusCode === 413 ? 413 : (error.getStatus?.() ?? 500);
    if (status >= 500) console.error('API 请求失败', { type: error.name, code: error.code });
    response.status(status).json({
      error: {
        code: known ? error.code : 'REQUEST_FAILED',
        message: known ? error.message : status === 404 ? '接口不存在' : '请求未完成，请稍后重试',
      },
    });
  }
}

@Controller('api/v1')
class ApiController {
  services: Services;
  constructor(@Inject(SERVICE) services: Services) {
    this.services = services;
  }
  @Get('conversations/:id/stream')
  async stream(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const principal = await this.services.auth.authenticate(req.headers);
    this.services.auth.requireAdmin(principal);
    await this.services.chat.open(id, req, res);
  }
  @Get('uploads/images/:assetId')
  async uploadedImage(@Param('assetId') id: string, @Req() req: Request, @Res() res: Response) {
    const principal = await this.services.auth.authenticate(req.headers);
    this.services.auth.requireAdmin(principal);
    const image = await this.services.uploads.get(id);
    res
      .status(200)
      .set({
        'Content-Type': image.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      })
      .send(image.body);
  }
  @Get(['conversations/:id/messages/:messageId/image', 'conversations/:id/messages/:messageId/avatar'])
  async image(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const principal = await this.services.auth.authenticate(req.headers);
    this.services.auth.requireAdmin(principal);
    const image = req.path.endsWith('/avatar')
      ? await this.services.chat.avatar(id, messageId)
      : await this.services.chat.image(
          id,
          messageId,
          z.coerce
            .number()
            .int()
            .min(0)
            .max(99)
            .parse(req.query.index ?? 0),
        );
    res
      .status(200)
      .set({
        'Content-Type': image.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      })
      .send(image.body);
  }
  @All('{*path}')
  async route(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<any> {
    const s = this.services;
    const method = req.method;
    const path = req.path.slice('/api/v1'.length).replace(/\/$/, '') || '/';
    const body = req.body ?? {};
    const write = !['GET', 'HEAD'].includes(method);
    if (method === 'GET' && path === '/health') return { status: 'ok', storage: s.db.mode, version: '0.1.0' };
    if (method === 'GET' && path === '/auth/state') return s.auth.state();
    if (method === 'POST' && ['/auth/setup', '/auth/login'].includes(path)) {
      const session =
        path === '/auth/setup' ? await s.auth.setup(body) : await s.auth.login(body, req.ip ?? 'unknown');
      res.cookie('qsb_session', session.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: s.config.secureCookie,
        maxAge: 7 * 86400_000,
        path: '/',
      });
      res.setHeader('Cache-Control', 'no-store');
      return session.user;
    }
    // These endpoints receive raw bytes. Authentication always precedes parsing.
    if (
      method === 'POST' &&
      [
        '/connector-events',
        '/connector-receipts',
        '/connectors/handshake',
        '/connectors/heartbeat',
        '/connectors/permissions',
      ].includes(path)
    ) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, String(value));
      const { account, payload } = await s.accounts.authenticateHmac(
        headers,
        method,
        req.originalUrl,
        Buffer.isBuffer(body) ? body : Buffer.alloc(0),
        path.startsWith('/connector-') ? 'events' : 'control',
      );
      if (path === '/connector-events') return s.messages.ingest(account, payload);
      if (path === '/connector-receipts')
        return s.jobs.saveReceipt(account.id, receiptSchema.parse(payload), true);
      if (path === '/connectors/handshake') return s.accounts.handshake(account, payload);
      if (path === '/connectors/heartbeat') return s.accounts.heartbeat(account, payload);
      return s.accounts.permissions(account, payload);
    }
    const qqHook = path.match(/^\/connectors\/qq\/([^/]+)\/events$/);
    if (method === 'POST' && qqHook) {
      const account = await s.accounts.get(qqHook[1]!);
      if (account.kind !== 'qq' || account.status === 'paused' || !Buffer.isBuffer(body))
        throw new ApiError(401, 'UNAUTHORIZED', 'QQ 上报凭据不正确');
      const secret = s.box.open(account.incoming_secret_box);
      const signature = req.headers['x-signature'];
      // NapCat signs the exact request bytes. A supplied signature must validate,
      // rather than silently falling back to an unrelated Authorization header.
      const authorized =
        signature !== undefined
          ? typeof signature === 'string' &&
            /^sha1=[a-f0-9]{40}$/.test(signature) &&
            equal(signature, `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`)
          : equal(String(req.headers.authorization ?? ''), `Bearer ${secret}`);
      if (!authorized) throw new ApiError(401, 'UNAUTHORIZED', 'QQ 上报凭据不正确');
      let payload: any;
      try {
        payload = JSON.parse(body.toString('utf8'));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
      } catch {
        throw new ApiError(400, 'INVALID_JSON', '请求体格式不正确');
      }
      if (String(payload.self_id) !== account.external_id)
        throw new ApiError(403, 'ACCOUNT_SCOPE', 'QQ 上报账号不匹配，请先刷新连接');
      if (payload.post_type === 'request')
        return { accepted: true, ...(await s.qqRequests.receive(account, payload)) };
      for (const item of qqEvents(account, payload))
        await s.messages.ingest(account, item.event, item.name, false, item.presentation);
      return { accepted: true };
    }
    const principal = await s.auth.authenticate(req.headers, write);
    res.setHeader('Cache-Control', 'no-store');
    if (method === 'GET' && path === '/auth/me') {
      s.auth.requireAdmin(principal);
      return principal;
    }
    if (method === 'POST' && path === '/auth/logout') {
      s.auth.requireAdmin(principal);
      await s.auth.logout(String(req.headers.cookie ?? ''));
      res.clearCookie('qsb_session', { path: '/' });
      return { logged_out: true };
    }
    if (method === 'GET' && path === '/conversations') return s.features.groups(principal);
    if (method === 'POST' && path === '/messages')
      return s.features.send(principal, body, String(req.headers['idempotency-key'] ?? ''));
    const delivery = path.match(/^\/deliveries\/([^/]+)$/);
    if (method === 'GET' && delivery) return s.features.deliveries(delivery[1], principal);
    if (method === 'POST' && path === '/lotteries') {
      const value = z.object({ conversation_id: z.string() }).parse(body);
      s.auth.authorize(principal, 'lotteries.write', [value.conversation_id]);
      return s.features.createLottery(body, principal.name);
    }
    s.auth.requireAdmin(principal);
    const keywordRules = path.match(/^\/conversations\/([^/]+)\/keyword-rules(?:\/([^/]+))?$/);
    if (keywordRules) {
      const [, id, ruleId] = keywordRules;
      if (method === 'GET' && !ruleId) return s.keywords.overview(id!);
      if (method === 'POST' && ruleId === 'preview') return s.keywords.preview(id!, body);
      if (method === 'POST' && !ruleId) return s.keywords.save(id!, undefined, body, principal.name);
      if (method === 'PUT' && ruleId) return s.keywords.save(id!, ruleId, body, principal.name);
      if (method === 'DELETE' && ruleId) return s.keywords.remove(id!, ruleId, principal.name);
    }
    if (method === 'GET' && path === '/qq-local') return s.qqLogin.local();
    const qqLogin = path.match(
      /^\/(?:accounts\/([^/]+)\/qq-login|qq-local\/login)(?:\/(refresh|quick|connect))?$/,
    );
    if (qqLogin) {
      if (method === 'GET' && !qqLogin[2]) return s.qqLogin.status(qqLogin[1]);
      if (method === 'POST' && qqLogin[2] === 'refresh') return s.qqLogin.refresh(qqLogin[1], principal.name);
      if (method === 'POST' && qqLogin[2] === 'quick' && qqLogin[1])
        return s.qqLogin.quick(qqLogin[1], principal.name);
      if (method === 'POST' && qqLogin[2] === 'connect')
        return s.qqLogin.connect(
          { ...body, ...(qqLogin[1] ? { account_id: qqLogin[1] } : {}) },
          principal.name,
        );
    }
    const qqRequests = path.match(/^\/conversations\/([^/]+)\/qq-requests$/);
    if (qqRequests) {
      if (method === 'GET') return s.qqRequests.overview(qqRequests[1]!);
      if (method === 'PUT') return s.qqRequests.settings(qqRequests[1]!, body, principal.name);
    }
    const binanceMembers = path.match(/^\/conversations\/([^/]+)\/(binance-members|binance-member-actions)$/);
    if (binanceMembers) {
      if (method === 'GET' && binanceMembers[2] === 'binance-members')
        return s.binanceMembers.overview(binanceMembers[1]!, req.query.user_id);
      if (method === 'POST' && binanceMembers[2] === 'binance-member-actions')
        return s.binanceMembers.act(binanceMembers[1]!, body, String(req.headers['idempotency-key'] ?? ''), {
          id: principal.id,
          name: principal.name,
        });
    }
    const members = path.match(/^\/conversations\/([^/]+)\/(member-management|member-actions)$/);
    if (members) {
      if (method === 'GET' && members[2] === 'member-management')
        return s.members.overview(members[1]!, req.query.user_id);
      if (method === 'PUT' && members[2] === 'member-management')
        return s.members.settings(members[1]!, body, principal.name);
      if (method === 'POST' && members[2] === 'member-actions')
        return s.members.act(members[1]!, body, String(req.headers['idempotency-key'] ?? ''), {
          source: 'web',
          id: principal.id,
          name: principal.name,
        });
    }
    if (method === 'POST' && path === '/uploads/images') {
      const image = await s.uploads.create(body, req.headers['content-type']);
      await audit(s.db, principal.name, 'image.uploaded', image.id, { bytes: image.byte_size });
      return image;
    }
    if (method === 'GET' && path === '/overview') return s.features.overview();
    if (method === 'GET' && path === '/accounts') return s.accounts.list();
    if (method === 'POST' && path === '/accounts') return s.accounts.create(body, principal.name);
    const binanceCheck = path.match(/^\/accounts\/([^/]+)\/binance-check$/);
    if (method === 'POST' && binanceCheck) return s.accounts.checkBinance(binanceCheck[1]!, principal.name);
    const browser = path.match(/^\/accounts\/([^/]+)\/binance-browser(?:\/(connect|navigate))?$/);
    if (browser) {
      const id = browser[1]!;
      await s.binanceBrowser.account(id);
      if (method === 'GET' && !browser[2]) return s.binanceBrowser.status(id);
      if (method === 'POST' && !browser[2]) return s.binanceBrowser.start(id, principal.name);
      if (method === 'DELETE' && !browser[2]) {
        const { window_id } = z.strictObject({ window_id: z.string().uuid() }).parse(body);
        return { stopped: s.binanceBrowser.stop(id, window_id) };
      }
      if (method === 'POST' && browser[2] === 'connect') {
        const { window_id } = z.strictObject({ window_id: z.string().uuid() }).parse(body);
        return s.binanceBrowser.connect(id, principal.name, window_id);
      }
      if (method === 'POST' && browser[2] === 'navigate')
        return s.binanceBrowser.navigate(
          id,
          z
            .strictObject({
              destination: z.enum(['login', 'chat']).default('chat'),
              window_id: z.string().uuid(),
            })
            .parse(body).destination,
          body.window_id,
        );
    }
    const binanceAuth = path.match(/^\/accounts\/([^/]+)\/binance-auth$/);
    if (binanceAuth && method === 'PUT') {
      const account = await s.accounts.get(binanceAuth[1]!);
      const result = await s.binance.authentication(account, body, principal.name);
      if (result.mode === 'direct') {
        try {
          await s.accounts.refresh(account.id, principal.name);
        } catch {
          return { ...result, warning: '直连已保存，资料刷新暂未完成，请点击连接 / 刷新检查状态' };
        }
      }
      return result;
    }
    const selectedGroups = path.match(/^\/accounts\/([^/]+)\/groups(\/refresh)?$/);
    if (selectedGroups) {
      if (method === 'GET' && !selectedGroups[2]) return s.accounts.groups(selectedGroups[1]!);
      if (method === 'POST' && selectedGroups[2]) return s.accounts.groups(selectedGroups[1]!, true);
      if (method === 'PUT' && !selectedGroups[2])
        return s.accounts.selectGroups(selectedGroups[1]!, body, principal.name);
    }
    const binanceGroups = path.match(/^\/accounts\/([^/]+)\/binance-groups(\/refresh)?$/);
    if (binanceGroups) {
      if (method === 'GET' && !binanceGroups[2]) return s.accounts.binanceGroups(binanceGroups[1]!);
      if (method === 'POST' && binanceGroups[2]) return s.accounts.binanceGroups(binanceGroups[1]!, true);
      if (method === 'PUT' && !binanceGroups[2])
        return s.accounts.selectBinanceGroups(binanceGroups[1]!, body, principal.name);
    }
    const binanceDiagnostic = path.match(/^\/accounts\/([^/]+)\/(binance-diagnostics|binance-send-check)$/);
    if (binanceDiagnostic && method === (binanceDiagnostic[2] === 'binance-diagnostics' ? 'GET' : 'POST')) {
      const account = await s.accounts.get(binanceDiagnostic[1]!);
      if (binanceDiagnostic[2] === 'binance-send-check') return s.binance.checkSend(account, body);
      return s.binance.diagnose(account, z.string().parse(req.query.group_id));
    }
    const account = path.match(
      /^\/accounts\/([^/]+)\/(refresh|permissions-refresh|pause|telegram-group|binance-pairing)$/,
    );
    if (method === 'POST' && account) {
      if (account[2] === 'refresh') return s.accounts.refresh(account[1]!, principal.name, true);
      if (account[2] === 'permissions-refresh') return s.accounts.refresh(account[1]!, principal.name);
      if (account[2] === 'binance-pairing') return s.accounts.pairBinance(account[1]!, principal.name);
      if (account[2] === 'telegram-group')
        return s.accounts.addTelegramGroup(account[1]!, body, principal.name);
      await s.accounts.get(account[1]!);
      await s.db.query("UPDATE accounts SET status='paused' WHERE id=$1", [account[1]]);
      s.binance.disconnect(account[1]!);
      s.binanceBrowser.stop(account[1]!);
      await audit(s.db, principal.name, 'account.paused', account[1]!);
      return { paused: true };
    }
    const group = path.match(/^\/conversations\/([^/]+)(?:\/(policy|simulate|chat|history))?$/);
    if (group) {
      if (method === 'GET' && !group[2]) return s.features.group(group[1]!);
      if (method === 'GET' && group[2] === 'chat') return s.chat.snapshot(group[1]!);
      if (method === 'GET' && group[2] === 'history') return s.chat.history(group[1]!, req.query);
      if (method === 'PUT' && group[2] === 'policy')
        return s.features.policy(group[1]!, body, principal.name);
      if (method === 'POST' && group[2] === 'simulate') {
        const value = z
          .strictObject({
            user_id: z.string().regex(/^[\w-]{1,64}$/),
            text: z.string().min(1).max(8000).optional(),
            type: z.enum(['message', 'join']).default('message'),
          })
          .parse(body);
        if (value.type === 'message' && !value.text)
          throw new ApiError(400, 'TEXT_REQUIRED', '请填写模拟消息');
        const g = await s.features.group(group[1]!);
        if (!g.is_demo) throw new ApiError(403, 'DEMO_ONLY', '仅演示群支持模拟事件');
        const a = await s.accounts.get(g.executor_account_id);
        const id = randomUUID();
        return s.messages.ingest(
          a,
          {
            schema_version: '1',
            event_id: id,
            occurred_at: new Date().toISOString(),
            source: { connector_id: a.id, account_id: a.id, conversation_id: g.external_id },
            type: value.type === 'join' ? 'member.joined' : 'message.created',
            data:
              value.type === 'join'
                ? { user_id: value.user_id, membership_id: id }
                : {
                    message_id: id,
                    sender_id: value.user_id,
                    direction: 'incoming',
                    segments: [{ type: 'text', text: value.text }],
                  },
          },
          value.user_id,
        );
      }
    }
    if (method === 'GET' && path === '/announcements') return s.features.announcements();
    if (method === 'POST' && path === '/announcements')
      return s.features.createAnnouncement(
        body,
        principal.name,
        req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : undefined,
      );
    const cancel = path.match(/^\/announcements\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancel) return s.features.cancelAnnouncement(cancel[1]!, principal.name);
    if (method === 'GET' && path === '/deliveries') return s.features.deliveries();
    const retry = path.match(/^\/deliveries\/([^/]+)\/retry$/);
    if (method === 'POST' && retry) return s.jobs.retry(retry[1]!, principal.name);
    const reconcile = path.match(/^\/deliveries\/([^/]+)\/reconcile$/);
    if (method === 'POST' && reconcile) return s.jobs.reconcile(reconcile[1]!, body, principal.name);
    if (method === 'GET' && path === '/blacklists') return s.features.blacklists();
    if (method === 'POST' && path === '/blacklists') return s.features.blacklist(body, principal.name);
    const blacklist = path.match(/^\/blacklists\/([^/]+)$/);
    if (method === 'DELETE' && blacklist) return s.features.removeBlacklist(blacklist[1]!, principal.name);
    if (method === 'GET' && path === '/verifications') return verificationRows(s.db);
    const groupVerifications = path.match(/^\/conversations\/([^/]+)\/verifications$/);
    if (method === 'GET' && groupVerifications) {
      await s.features.group(groupVerifications[1]!);
      return verificationRows(s.db, groupVerifications[1]!);
    }
    const verification = path.match(/^\/verifications\/([^/]+)\/approve$/);
    if (method === 'POST' && verification)
      return s.features.approveVerification(verification[1]!, principal.name);
    const resendVerification = path.match(/^\/verifications\/([^/]+)\/resend$/);
    if (method === 'POST' && resendVerification)
      return s.qqVerification.resend(
        resendVerification[1]!,
        String(req.headers['idempotency-key'] ?? ''),
        principal.name,
      );
    if (method === 'GET' && path === '/projects') return s.features.projects();
    if (method === 'POST' && path === '/projects') return s.features.createProject(body, principal.name);
    const project = path.match(/^\/projects\/([^/]+)\/revoke$/);
    if (method === 'POST' && project) return s.features.revokeProject(project[1]!, principal.name);
    if (method === 'GET' && path === '/routes') return s.features.routes();
    if (method === 'POST' && path === '/routes') return s.features.saveRoute(body, principal.name);
    const route = path.match(/^\/routes\/([^/]+)$/);
    if (method === 'DELETE' && route) return s.features.deleteRoute(route[1]!, principal.name);
    if (method === 'GET' && path === '/lotteries') return s.features.lotteries();
    const draw = path.match(/^\/lotteries\/([^/]+)\/draw$/);
    if (method === 'POST' && draw) return s.features.drawLottery(draw[1]!, principal.name);
    if (method === 'GET' && path === '/audit')
      return s.db.query('SELECT * FROM audit ORDER BY created_at DESC LIMIT 200');
    throw new ApiError(404, 'NOT_FOUND', '接口不存在');
  }
}

@Module({})
class AppModule {}
export async function createHttpApp(services: Services) {
  const app = await NestFactory.create(
    {
      module: AppModule,
      controllers: [ApiController],
      providers: [
        { provide: SERVICE, useValue: services },
        { provide: ChatService, useValue: services.chat },
        { provide: BinanceBridge, useValue: services.binance },
        { provide: BinanceBrowser, useValue: services.binanceBrowser },
      ],
    },
    { bodyParser: false, logger: ['error', 'warn'] },
  );
  app.use((req: Request, res: Response, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    );
    next();
  });
  const raw = express.raw({ type: '*/*', limit: '256kb' });
  const upload = express.raw({ type: '*/*', limit: '8mb' });
  const parsed = express.json({ limit: '256kb' });
  app.use((req: Request, res: Response, next: express.NextFunction) =>
    (req.path === '/api/v1/uploads/images'
      ? upload
      : /^\/api\/v1\/(?:connector-events|connector-receipts|connectors\/)/.test(req.path)
        ? raw
        : parsed)(req, res, next),
  );
  app.useGlobalFilters(new Errors());
  const staticDir = resolve('dist/admin');
  if (existsSync(resolve(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false }));
    app.use((req: Request, res: Response, next: () => void) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/'))
        res.sendFile(resolve(staticDir, 'index.html'));
      else next();
    });
  }
  await app.init();
  services.binance.attach(app.getHttpServer());
  services.binanceBrowser.attach(app.getHttpServer());
  app.getHttpServer().on('upgrade', (req: Request, socket: import('node:net').Socket) => {
    if (req.url !== '/api/v1/connectors/binance/socket' && !browserSocketPath.test(req.url ?? ''))
      socket.destroy();
  });
  return app;
}
