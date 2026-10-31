export type KeywordRule = {
  id?: string;
  revision?: string;
  name: string;
  enabled: boolean;
  mode: string;
  priority: number;
  match: string;
  keywords: string[];
  action: string;
  response: string;
  image_asset_id: string | null;
  duration_seconds: number;
  cooldown_seconds: number;
  exempt_admins: boolean;
};

// List rows also contain database fields; only send editable fields back to the API.
export function keywordRulePayload(rule: KeywordRule) {
  return {
    name: rule.name,
    enabled: rule.enabled,
    mode: rule.mode,
    priority: rule.priority,
    match: rule.match,
    keywords: rule.keywords,
    action: rule.action,
    response: rule.response,
    image_asset_id: rule.image_asset_id,
    duration_seconds: rule.duration_seconds,
    cooldown_seconds: rule.cooldown_seconds,
    exempt_admins: rule.exempt_admins,
    ...(rule.id ? { expected_revision: rule.revision } : {}),
  };
}
