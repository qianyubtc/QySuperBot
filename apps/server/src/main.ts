import { loadConfig } from './config.ts';
import { createServices } from './services.ts';
import { createHttpApp } from './http.ts';

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
async function close() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await services.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
