import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

const [input, destination = '.env.production', ...extra] = process.argv.slice(2);
const domain = input ? input.trim().replace(/\.$/, '').toLowerCase() : '';
if (
  extra.length ||
  !domain.includes('.') ||
  domain.length > 253 ||
  isIP(domain) ||
  !/[a-z]/.test(domain.split('.').at(-1)) ||
  !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
) {
  console.error('用法：node scripts/init-production.mjs 后台域名 [配置文件路径]，域名不含协议或路径');
  process.exit(1);
}
const secret = () => randomBytes(32).toString('hex');
const content = [
  'NODE_ENV=production',
  'HOST=127.0.0.1',
  'PORT=3000',
  `PUBLIC_ORIGIN=https://${domain}`,
  'DATA_DIR=/var/lib/qianyusuperbot',
  `DATABASE_URL=postgresql://qianyusuperbot:${secret()}@127.0.0.1:5432/qianyusuperbot`,
  `ADMIN_SETUP_TOKEN=${secret()}`,
  `ENCRYPTION_KEY=${secret()}`,
  'COOKIE_SECURE=true',
  'SEED_DEMO=false',
  'ALLOW_PRIVATE_CONNECTORS=false',
  '',
].join('\n');
try {
  writeFileSync(resolve(destination), content, { flag: 'wx', mode: 0o600 });
  console.log(`已创建 ${resolve(destination)}；密钥保存在文件中，未输出到终端。`);
} catch (error) {
  if (error.code === 'EEXIST') console.error('配置已存在，未覆盖或重置密钥。更新部署请沿用现有配置。');
  else console.error(`无法写入配置：${error.code ?? error.message}`);
  process.exit(1);
}
