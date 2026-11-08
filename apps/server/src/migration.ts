export const migration = `
CREATE TABLE IF NOT EXISTS metadata (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO metadata(key,value) VALUES ('setup','{}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS admins (
  id text PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, admin_id text NOT NULL REFERENCES admins(id), csrf text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_limits (key text PRIMARY KEY, failures integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY, platform text NOT NULL, name text NOT NULL, kind text NOT NULL,
  status text NOT NULL DEFAULT 'configuring', external_id text, endpoint text, secret_box text,
  incoming_key_id text UNIQUE, incoming_secret_box text, outgoing_key_id text, outgoing_secret_box text,
  session_id text, heartbeat_sequence bigint NOT NULL DEFAULT 0, session_expires_at timestamptz,
  last_seen_at timestamptz, last_error text, is_demo boolean NOT NULL DEFAULT false,
  cursor text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS binance_cursors (
  account_id text NOT NULL REFERENCES accounts(id), external_id text NOT NULL,
  cursor text NOT NULL, PRIMARY KEY(account_id,external_id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY, platform text NOT NULL, name text NOT NULL, kind text NOT NULL DEFAULT 'group',
  external_id text NOT NULL, executor_account_id text NOT NULL REFERENCES accounts(id),
  member_count integer, tags jsonb NOT NULL DEFAULT '[]',
  policy jsonb NOT NULL DEFAULT '{"mode":"observe","keywords":[],"blocked_domains":[],"action":"delete","verification_enabled":false,"verification_timeout":120}',
  policy_version text NOT NULL, is_demo boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS management_settings jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS bindings (
  account_id text NOT NULL REFERENCES accounts(id), external_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id), snapshot jsonb NOT NULL,
  permission_session_id text, permission_revision bigint NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,external_id)
);
CREATE TABLE IF NOT EXISTS inbox (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), event_id text NOT NULL,
  fingerprint text NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,event_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), account_id text NOT NULL REFERENCES accounts(id),
  external_id text NOT NULL, sender_id text NOT NULL, sender_name text NOT NULL,
  content text NOT NULL, segments jsonb NOT NULL, direction text NOT NULL,
  verdict text NOT NULL, reason text, content_version integer NOT NULL DEFAULT 1, fingerprint text NOT NULL,
  source_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted boolean NOT NULL DEFAULT false,
  UNIQUE(account_id,conversation_id,external_id)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_avatar text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS messages_conversation_time_id ON messages(conversation_id,created_at DESC,id DESC);
DROP INDEX IF EXISTS messages_conversation_time;
CREATE INDEX IF NOT EXISTS messages_sender ON messages(account_id,conversation_id,sender_id);
CREATE TABLE IF NOT EXISTS sender_profiles (
  account_id text NOT NULL REFERENCES accounts(id), conversation_id text NOT NULL REFERENCES conversations(id),
  sender_id text NOT NULL, sender_name text, sender_avatar text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,conversation_id,sender_id)
);
CREATE TABLE IF NOT EXISTS message_tombstones (
  account_id text NOT NULL REFERENCES accounts(id), conversation_id text NOT NULL REFERENCES conversations(id),
  external_id text NOT NULL, source_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,conversation_id,external_id)
);
CREATE TABLE IF NOT EXISTS blacklists (
  id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), user_id text NOT NULL,
  reason text NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS verifications (
  id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), user_id text NOT NULL,
  membership_id text NOT NULL, token_hash text NOT NULL, status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,user_id,membership_id)
);
CREATE TABLE IF NOT EXISTS uploaded_images (
  id text PRIMARY KEY,content_type text NOT NULL,byte_size integer NOT NULL,width integer NOT NULL,height integer NOT NULL,
  data text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS announcements (
  id text PRIMARY KEY, title text NOT NULL, content text NOT NULL, targets jsonb NOT NULL,
  scheduled_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS image_asset_id text REFERENCES uploaded_images(id);
CREATE TABLE IF NOT EXISTS message_templates (
  id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('broadcast','reply')), title text NOT NULL,
  content text NOT NULL, image_asset_id text REFERENCES uploaded_images(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_templates_kind ON message_templates(kind,updated_at DESC);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, intent_hash text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id), account_id text NOT NULL REFERENCES accounts(id),
  announcement_id text REFERENCES announcements(id), action text NOT NULL, params jsonb NOT NULL,
  owner_id text NOT NULL DEFAULT 'admin',
  status text NOT NULL DEFAULT 'pending', due_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  current_attempt integer NOT NULL DEFAULT 0, receipt jsonb, review_ref jsonb, trace jsonb,
  last_error text, locked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,due_at);
CREATE INDEX IF NOT EXISTS jobs_conversation_action_time ON jobs(conversation_id,action,created_at DESC,id DESC);
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS qq_context jsonb;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS challenge_job_id text REFERENCES jobs(id);
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS timeout_job_id text REFERENCES jobs(id);
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS failure_job_id text REFERENCES jobs(id);
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS retry_after timestamptz;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS challenge_sent_at timestamptz;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS detail_reason text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS verifications_qq_due ON verifications(expires_at) WHERE qq_context IS NOT NULL AND status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS jobs_moderation_message ON jobs(conversation_id,(review_ref->>'message_record_id')) WHERE review_ref->>'purpose'='moderation';
CREATE TABLE IF NOT EXISTS member_actions (
  id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES conversations(id),user_id text NOT NULL,
  action text NOT NULL,reason text NOT NULL,actor text NOT NULL,source text NOT NULL,
  job_id text REFERENCES jobs(id),warning_active boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_actions_target ON member_actions(conversation_id,user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS keyword_rules (
  id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES conversations(id),name text NOT NULL,
  enabled boolean NOT NULL,mode text NOT NULL,priority integer NOT NULL,match text NOT NULL,keywords jsonb NOT NULL,
  action text NOT NULL,response text NOT NULL,image_asset_id text REFERENCES uploaded_images(id),
  duration_seconds integer NOT NULL,cooldown_seconds integer NOT NULL,exempt_admins boolean NOT NULL,
  revision text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS keyword_rules_group ON keyword_rules(conversation_id,priority,created_at,id);
CREATE TABLE IF NOT EXISTS keyword_hits (
  id text PRIMARY KEY,rule_id text NOT NULL,conversation_id text NOT NULL REFERENCES conversations(id),
  message_id text NOT NULL UNIQUE REFERENCES messages(id),user_id text NOT NULL,rule_name text NOT NULL,
  action text NOT NULL,keyword text NOT NULL,status text NOT NULL,detail text NOT NULL,
  job_id text REFERENCES jobs(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS keyword_hits_cooldown ON keyword_hits(conversation_id,rule_id,created_at DESC);
CREATE INDEX IF NOT EXISTS keyword_hits_group_time ON keyword_hits(conversation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_keyword_message ON jobs(conversation_id,(review_ref->>'message_record_id')) WHERE review_ref->>'purpose' IN ('moderation','keyword');
CREATE TABLE IF NOT EXISTS qq_join_requests (
  id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),conversation_id text NOT NULL REFERENCES conversations(id),
  user_id text NOT NULL,flag_box text NOT NULL,fingerprint text NOT NULL,comment text NOT NULL,
  status text NOT NULL,reason text NOT NULL,job_id text REFERENCES jobs(id),source_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qq_join_requests_group ON qq_join_requests(conversation_id,created_at DESC);
CREATE TABLE IF NOT EXISTS attempts (
  id text PRIMARY KEY, job_id text NOT NULL REFERENCES jobs(id), number integer NOT NULL,
  command jsonb NOT NULL, status text NOT NULL, receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,number)
);
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY, name text NOT NULL, token_hash text UNIQUE NOT NULL, prefix text NOT NULL,
  conversation_ids jsonb NOT NULL, scopes jsonb NOT NULL, revoked_at timestamptz,
  last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nonces (key text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS routes (
  id text PRIMARY KEY, source_id text NOT NULL REFERENCES conversations(id), target_id text NOT NULL REFERENCES conversations(id),
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,target_id), CHECK(source_id<>target_id)
);
CREATE TABLE IF NOT EXISTS lotteries (
  id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), title text NOT NULL,
  winners_count integer NOT NULL, closes_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'open',
  entrants_snapshot jsonb, winners jsonb, drawn_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lottery_entries (
  lottery_id text NOT NULL REFERENCES lotteries(id), user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(lottery_id,user_id)
);
CREATE TABLE IF NOT EXISTS memberships (
  conversation_id text NOT NULL REFERENCES conversations(id), user_id text NOT NULL,
  membership_id text NOT NULL, status text NOT NULL, source_at timestamptz NOT NULL,
  PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS audit (
  id text PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO metadata(key,value) VALUES ('schema_version','1') ON CONFLICT DO NOTHING;
`;

/**
 * Changes that must run exactly once, in order, after the idempotent baseline above.
 * Append new entries; never edit or reorder applied ones.
 */
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 2,
    name: 'retention indexes and refresh audit cleanup',
    sql: `
CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS messages_blocked ON messages(conversation_id) WHERE verdict='blocked';
CREATE INDEX IF NOT EXISTS inbox_received ON inbox(received_at);
CREATE INDEX IF NOT EXISTS audit_created ON audit(created_at DESC);
-- Scheduled refreshes used to write an audit row every 30 seconds per account.
DELETE FROM audit WHERE action='account.refreshed' AND actor='定时刷新';
`,
  },
  {
    version: 3,
    name: 'bounded job cleanup',
    sql: `
-- Job cleanup reads terminal rows by age; unsettled jobs are never candidates.
CREATE INDEX IF NOT EXISTS jobs_terminal_created ON jobs(created_at)
  WHERE status IN ('succeeded','failed','cancelled','expired');
-- A job referenced by evidence or by a verification must be kept, so these guards need indexes.
CREATE INDEX IF NOT EXISTS keyword_hits_job ON keyword_hits(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS member_actions_job ON member_actions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS qq_join_requests_job ON qq_join_requests(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS verifications_challenge_job ON verifications(challenge_job_id) WHERE challenge_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS verifications_timeout_job ON verifications(timeout_job_id) WHERE timeout_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS verifications_failure_job ON verifications(failure_job_id) WHERE failure_job_id IS NOT NULL;
`,
  },
];

export interface MigrationConnection {
  exec(sql: string): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<{ version: number }[]>;
}
/** Applies the baseline, then each pending migration in its own transaction on one connection. */
export async function migrate(db: MigrationConnection, options: { lock?: boolean } = {}) {
  if (options.lock) await db.exec('SELECT pg_advisory_lock(7219031)');
  try {
    await db.exec(migration);
    await db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (await db.query('SELECT version FROM schema_migrations')).map((row) => Number(row.version)),
    );
    for (const step of migrations) {
      if (applied.has(step.version)) continue;
      await db.exec('BEGIN');
      try {
        await db.exec(step.sql);
        await db.query('INSERT INTO schema_migrations(version,name) VALUES($1,$2)', [
          step.version,
          step.name,
        ]);
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (options.lock) await db.exec('SELECT pg_advisory_unlock(7219031)');
  }
}
