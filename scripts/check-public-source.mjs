import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const failures = [];
for (const file of files) {
  if (
    /(^|\/)(?:\.local|node_modules|dist|backups|\.wrangler)\//.test(file) ||
    /(?:\.pem|\.key|\.p12|\.pfx|\.sqlite3?|\.db|\.log)$/.test(file) ||
    (/(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example')
  )
    failures.push(file + ': excluded local/runtime file');
  const text = await readFile(file, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text))
    failures.push(file + ': private key material');
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16})\b/.test(text))
    failures.push(file + ': access credential');
  if (/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/.test(text)) failures.push(file + ': bot credential');
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Public source check passed: ${files.length} tracked files, no runtime data or common credential formats.`,
  );
