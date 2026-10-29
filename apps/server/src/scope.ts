import type { Row } from './database.ts';

// Aliases are fixed by our SQL callers, never supplied by an HTTP request.
export const groupEnabledSql = (account: string, group: string) =>
  `(${account}.kind NOT IN ('qq','telegram','binance') OR COALESCE((${account}.settings->'group_ids') @> jsonb_build_array(${group}.external_id),true))`;

export function groupEnabled(account: Row, externalId: string) {
  return (
    !['telegram', 'qq', 'binance'].includes(account.kind) ||
    !Array.isArray(account.settings.group_ids) ||
    account.settings.group_ids.includes(externalId)
  );
}
