import { randomUUID } from 'node:crypto';
import type { Database, Row } from './database.ts';
import type { Config } from './config.ts';
import { ApiError, checkPassword, equal, hashPassword, sha, token } from './security.ts';
import { credentialsInput, setupInput } from './inputs.ts';

export type Principal =
  | { kind: 'admin'; id: string; name: string; csrf: string }
  | { kind: 'project'; id: string; name: string; conversation_ids: string[]; scopes: string[] };
export class AuthService {
  db: Database;
  config: Config;
  constructor(db: Database, config: Config) {
    this.db = db;
    this.config = config;
  }
  async state() {
    const exists = (await this.db.query('SELECT id FROM admins LIMIT 1')).length > 0;
    return { setup_required: !exists, setup_token_required: !!this.config.setupToken };
  }
  async setup(input: unknown) {
    const value = setupInput.parse(input);
    if (this.config.setupToken && !equal(value.setup_token ?? '', this.config.setupToken))
      throw new ApiError(403, 'SETUP_TOKEN_REQUIRED', '初始化凭据不正确');
    if (!['127.0.0.1', 'localhost', '::1'].includes(this.config.host) && !this.config.setupToken) {
      throw new ApiError(403, 'SETUP_NOT_CONFIGURED', '请先在服务器配置 ADMIN_SETUP_TOKEN，再创建管理员');
    }
    const id = randomUUID();
    const password = await hashPassword(value.password);
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT key FROM metadata WHERE key='setup' FOR UPDATE");
      if ((await tx.query('SELECT id FROM admins LIMIT 1')).length)
        throw new ApiError(409, 'ALREADY_CONFIGURED', '管理员已经创建，请直接登录');
      await tx.query('INSERT INTO admins(id,username,password_hash) VALUES($1,$2,$3)', [
        id,
        value.username,
        password,
      ]);
    });
    return this.newSession(id, value.username);
  }
  async login(input: unknown, address: string) {
    const value = credentialsInput.parse(input);
    const key = sha(address + ':' + value.username);
    const limit = (
      await this.db.query('SELECT * FROM login_limits WHERE key=$1 AND expires_at>now()', [key])
    )[0];
    if (limit && limit.failures >= 10)
      throw new ApiError(429, 'LOGIN_RATE_LIMIT', '尝试次数过多，请稍后再试');
    const user = (await this.db.query('SELECT * FROM admins WHERE username=$1', [value.username]))[0];
    const valid = await checkPassword(
      value.password,
      user?.password_hash ?? `unused-timing-salt:${'0'.repeat(128)}`,
    );
    if (!valid || !user) {
      await this.db.query(
        `INSERT INTO login_limits(key,failures,expires_at) VALUES($1,1,now()+interval '15 minutes')
        ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN login_limits.expires_at<now() THEN 1 ELSE login_limits.failures+1 END,
        expires_at=CASE WHEN login_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE login_limits.expires_at END`,
        [key],
      );
      throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确');
    }
    await this.db.query('DELETE FROM login_limits WHERE key=$1', [key]);
    return this.newSession(user.id, user.username);
  }
  private async newSession(id: string, username: string) {
    const raw = token();
    const csrf = token();
    await this.db.query(
      "INSERT INTO sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
      [sha(raw), id, csrf],
    );
    return { token: raw, user: { id, username, csrf } };
  }
  async authenticate(
    headers: Record<string, string | string[] | undefined>,
    write = false,
  ): Promise<Principal> {
    const authorization = String(headers.authorization ?? '');
    if (authorization.startsWith('Bearer ')) {
      const project = (
        await this.db.query('SELECT * FROM projects WHERE token_hash=$1 AND revoked_at IS NULL', [
          sha(authorization.slice(7)),
        ])
      )[0];
      if (!project) throw new ApiError(401, 'UNAUTHORIZED', 'API Key 无效或已撤销');
      await this.db.query('UPDATE projects SET last_used_at=now() WHERE id=$1', [project.id]);
      return {
        kind: 'project',
        id: project.id,
        name: project.name,
        conversation_ids: project.conversation_ids,
        scopes: project.scopes,
      };
    }
    const raw = String(headers.cookie ?? '')
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith('qsb_session='))
      ?.slice(12);
    const session = raw
      ? (
          await this.db.query(
            `SELECT s.*,a.username FROM sessions s JOIN admins a ON a.id=s.admin_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`,
            [sha(raw)],
          )
        )[0]
      : undefined;
    if (!session) throw new ApiError(401, 'UNAUTHORIZED', '请先登录管理台');
    if (write && !equal(String(headers['x-csrf-token'] ?? ''), session.csrf))
      throw new ApiError(403, 'CSRF_FAILED', '会话校验失效，请刷新后重试');
    return { kind: 'admin', id: session.admin_id, name: session.username, csrf: session.csrf };
  }
  requireAdmin(principal: Principal) {
    if (principal.kind !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', '此操作需要管理员权限');
  }
  authorize(principal: Principal, scope: string, conversationIds: string[]) {
    if (principal.kind === 'admin') return;
    if (
      !principal.scopes.includes(scope) ||
      conversationIds.some((id) => !principal.conversation_ids.includes(id))
    )
      throw new ApiError(403, 'SCOPE_FORBIDDEN', '此项目没有目标群或操作权限');
  }
  async logout(cookie: string) {
    const raw = cookie
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith('qsb_session='))
      ?.slice(12);
    if (raw) await this.db.query('DELETE FROM sessions WHERE token_hash=$1', [sha(raw)]);
  }
}
