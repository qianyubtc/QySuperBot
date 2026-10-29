import { spawn } from 'node:child_process';
const children = [
  spawn(
    process.execPath,
    [
      '--env-file-if-exists=.env',
      'node_modules/tsx/dist/cli.mjs',
      'watch',
      '--tsconfig',
      'apps/server/tsconfig.json',
      'apps/server/src/main.ts',
    ],
    { stdio: 'inherit' },
  ),
  spawn(
    process.execPath,
    ['--env-file-if-exists=.env', 'node_modules/vite/bin/vite.js', '--config', 'apps/admin/vite.config.ts'],
    {
      stdio: 'inherit',
    },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
