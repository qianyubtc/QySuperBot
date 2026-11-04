/**
 * Minimal structured logger: one JSON line per event on stderr (journald keeps it), with
 * credentials stripped from messages and stacks. Quiet under `node --test` unless SUPERBOT_LOG=1.
 */
const patterns: [RegExp, string][] = [
  [/bot\d{3,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>'],
  [/(Bearer\s+)[^\s"',]+/gi, '$1<redacted>'],
  [/(qsb_session=)[^;\s"']+/g, '$1<redacted>'],
  [/(qsb_)[A-Za-z0-9_-]{20,}/g, '$1<redacted>'],
  [/((?:token|secret|password|cookie|authorization|csrf)["']?\s*[:=]\s*["']?)[^"',;&\s}]+/gi, '$1<redacted>'],
];
export const redact = (text: string) =>
  patterns.reduce((value, [pattern, to]) => value.replace(pattern, to), text);

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; status?: unknown; cause?: unknown };
    return {
      name: error.name,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.status !== undefined ? { status: error.status } : {}),
      message: redact(error.message),
      stack: redact(
        String(error.stack ?? '')
          .split('\n')
          .slice(1, 6)
          .join('\n')
          .trim(),
      ),
      ...(error.cause ? { cause: serialize(error.cause) } : {}),
    };
  }
  if (typeof value === 'string') return redact(value);
  return value;
}

const quiet = () => !!process.env.NODE_TEST_CONTEXT && process.env.SUPERBOT_LOG !== '1';
function write(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) {
  if (quiet()) return;
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, message };
  for (const [key, value] of Object.entries(fields)) entry[key] = serialize(value);
  try {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    /* Logging must never break the caller. */
  }
}
export const log = {
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
