import { resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  databaseUrl?: string;
  publicOrigin: string;
  setupToken?: string;
  encryptionKey?: string;
  secureCookie: boolean;
  seedDemo: boolean;
  allowPrivateConnectors: boolean;
  qqLocalPort?: number;
  qqWebuiPort?: number;
  qqWebuiToken?: string;
  binanceBrowserEnabled?: boolean;
  binanceBrowserExecutable?: string;
  /** Express `trust proxy`: which direct peers may report the client address in X-Forwarded-For. */
  trustProxy?: boolean | number | string;
  /**
   * Days of data to keep. 0 keeps that table forever: retention never deletes anything the
   * administrator has not explicitly opted into, and an old deployment keeps every row it had.
   */
  retention: { inbox: number; messages: number; audit: number; jobs: number };
}
export function parseTrustProxy(value = 'loopback'): boolean | number | string {
  const text = value.trim();
  if (['', 'false', '0'].includes(text)) return false;
  // Trusting every peer would let any client choose its own address and bypass per-client limits.
  if (text === 'true')
    throw new Error(
      'TRUST_PROXY=true trusts spoofed addresses; use loopback, a hop count or proxy addresses',
    );
  return /^\d+$/.test(text) ? Number(text) : text;
}
/** `0` disables deletion; anything else is a bounded number of days. */
function retentionDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 3650)
    throw new Error(`${name} must be a whole number of days from 0 to 3650 (0 keeps data forever)`);
  return value;
}
export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  const qqLocalPort = process.env.QQ_LOCAL_PORT === undefined ? undefined : Number(process.env.QQ_LOCAL_PORT);
  if (qqLocalPort !== undefined && (!Number.isInteger(qqLocalPort) || qqLocalPort < 1 || qqLocalPort > 65535))
    throw new Error('QQ_LOCAL_PORT must be 1..65535');
  const qqWebuiPort = process.env.QQ_WEBUI_PORT === undefined ? undefined : Number(process.env.QQ_WEBUI_PORT);
  if (qqWebuiPort !== undefined && (!Number.isInteger(qqWebuiPort) || qqWebuiPort < 1 || qqWebuiPort > 65535))
    throw new Error('QQ_WEBUI_PORT must be 1..65535');
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port,
    dataDir: resolve(process.env.DATA_DIR ?? '.local/data'),
    databaseUrl: process.env.DATABASE_URL,
    publicOrigin: process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`,
    setupToken: process.env.ADMIN_SETUP_TOKEN,
    encryptionKey: process.env.ENCRYPTION_KEY,
    secureCookie: process.env.COOKIE_SECURE === 'true',
    seedDemo: process.env.SEED_DEMO !== 'false',
    allowPrivateConnectors: process.env.ALLOW_PRIVATE_CONNECTORS === 'true',
    qqLocalPort,
    qqWebuiPort,
    qqWebuiToken: process.env.QQ_WEBUI_TOKEN,
    binanceBrowserEnabled: process.env.BINANCE_BROWSER_ENABLED === 'true',
    binanceBrowserExecutable: process.env.BINANCE_BROWSER_EXECUTABLE ?? '/usr/bin/google-chrome',
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    // Inbox events only back idempotency and diagnostics, so they expire by default. Messages and
    // audit rows are the chat archive and stay forever unless the administrator sets a window.
    retention: {
      inbox: retentionDays('RETENTION_INBOX_DAYS', 30),
      messages: retentionDays('RETENTION_MESSAGE_DAYS', 0),
      audit: retentionDays('RETENTION_AUDIT_DAYS', 0),
      jobs: retentionDays('RETENTION_JOBS_DAYS', 0),
    },
  };
}
