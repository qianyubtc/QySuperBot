import { loadConfig } from './config.ts';
import { createServices } from './services.ts';
import { createHttpApp } from './http.ts';
import { log } from './log.ts';

// A stray rejection is logged instead of crashing the process; durable jobs recover on their own.
process.on('unhandledRejection', (error) => log.error('unhandled rejection', { error }));

const config = loadConfig();
const services = await createServices(config);
let app: Awaited<ReturnType<typeof createHttpApp>>;
try {
  app = await createHttpApp(services);
  await app.listen(config.port, config.host);
} catch (error) {
  await services.close();
  throw error;
}
console.log(
  `千羽 Superbot · http://${config.host}:${config.port} · ${services.db.mode === 'local' ? '本地持久化 PostgreSQL' : 'PostgreSQL'}`,
);
let stopping = false;
const shutdownTimeoutMs = 20_000;
async function close(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  // A slow platform call or a half-open socket must not keep the process — and the local database
  // lock — alive forever. The drain still runs; this only bounds how long it may take.
  const forced = setTimeout(() => {
    log.error('shutdown did not finish in time; exiting', { after_ms: shutdownTimeoutMs });
    process.exit(1);
  }, shutdownTimeoutMs);
  forced.unref();
  try {
    await app.close();
    await services.close();
  } catch (error) {
    log.error('shutdown failed', { error });
    process.exitCode = 1;
  } finally {
    clearTimeout(forced);
  }
}
// Duplicate signals are ignored: a supervisor such as tsx forwards the same SIGTERM to both the
// wrapper and this process, and that must not cut a drain short and strand the database lock.
const stop = (signal: string) => {
  if (!stopping) void close(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
