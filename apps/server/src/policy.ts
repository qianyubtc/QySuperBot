import type { Policy } from './inputs.ts';
export function evaluateText(policy: Policy, text: string): string | null {
  const normalized = text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase();
  for (const keyword of policy.keywords)
    if (normalized.includes(keyword.normalize('NFKC').toLowerCase())) return `关键词：${keyword}`;
  const domains = [
    ...normalized.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[\/:?#\s]|$)/g),
  ].map((match) => match[1]!);
  for (const blocked of policy.blocked_domains) {
    const host = blocked
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]!;
    if (domains.some((domain) => domain === host || domain.endsWith('.' + host))) return `域名：${blocked}`;
  }
  return null;
}
