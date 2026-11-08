import { spawn } from 'node:child_process';

const commands = [
  [
    '--env-file-if-exists=.env',
    'node_modules/tsx/dist/cli.mjs',
    'watch',
    '--tsconfig',
    'apps/server/tsconfig.json',
    'apps/server/src/main.ts',
  ],
  ['--env-file-if-exists=.env', 'node_modules/vite/bin/vite.js', '--config', 'apps/admin/vite.config.ts'],
];
// Each child leads its own process group. tsx runs the actual server in a grandchild, so signalling
// only the wrapper would leave that server holding the port and the local database lock.
const children = commands.map((args) => spawn(process.execPath, args, { stdio: 'inherit', detached: true }));

/** Signals the whole group, falling back to the direct child when the group is already gone. */
function signal(child, name) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, name);
  } catch {
    try {
      child.kill(name);
    } catch {
      /* Already exited. */
    }
  }
}
function groupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The server lets itself go at 20s; this only covers a process that is wedged beyond that.
const killAfterMs = 25_000;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) signal(child, 'SIGTERM');
  const started = Date.now();
  const watch = setInterval(() => {
    const alive = children.filter((child) => groupAlive(child.pid));
    if (!alive.length) return void clearInterval(watch);
    if (Date.now() - started < killAfterMs) return;
    for (const child of alive) signal(child, 'SIGKILL');
    clearInterval(watch);
  }, 200);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('exit', () => {
  for (const child of children) if (child.exitCode === null) signal(child, 'SIGTERM');
});
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
