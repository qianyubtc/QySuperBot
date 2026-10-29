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
  };
}
