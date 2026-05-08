import { sql } from "./connection.js";

/**
 * Subscriptions migration — LemonSqueezy-backed monthly subscriptions for Pro/Team tiers.
 *
 * Idempotent: safe to run on every boot. CREATE IF NOT EXISTS + DO blocks for
 * conditional alters mean re-running this on a populated DB is a no-op.
 *
 * Schema rationale:
 *   - 1:1 between api_keys and active subscriptions (one paid sub per key).
 *     A user can technically have history (cancelled subs followed by new ones)
 *     so we don't enforce UNIQUE on api_key_id alone — instead we partial-unique
 *     on (api_key_id) WHERE status = 'active' so only one active sub per key.
 *   - ls_subscription_id is the LS resource id (string, opaque). UNIQUE because
 *     LS owns the namespace and webhooks dedup by it.
 *   - We store the variant id so we can tell which tier the sub is for without
 *     joining back to LS. Variant → tier mapping is in code, not DB, because
 *     the mapping is config and may change (new variants, annual plans, etc).
 *   - current_period_end drives grace periods. On past_due, we keep entitlements
 *     until current_period_end + 7d, then expire.
 */
export async function migrateSubscriptions() {
  console.log("[migrate] Ensuring subscriptions schema...");

  // Main table
  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      api_key_id            UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      ls_subscription_id    TEXT NOT NULL UNIQUE,
      ls_customer_id        TEXT NOT NULL,
      ls_variant_id         TEXT NOT NULL,
      tier                  TEXT NOT NULL CHECK (tier IN ('pro', 'team')),
      status                TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled', 'expired', 'paused', 'on_trial', 'unpaid')),
      current_period_end    TIMESTAMPTZ,
      cancelled_at          TIMESTAMPTZ,
      ends_at               TIMESTAMPTZ,
      raw                   JSONB,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  console.log("[migrate] Ensured subscriptions table");

  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_api_key ON subscriptions(api_key_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_ls_id ON subscriptions(ls_subscription_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status) WHERE status = 'active'`;

  // Partial unique: only one active subscription per api_key
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_subscriptions_one_active_per_key'
      ) THEN
        CREATE UNIQUE INDEX idx_subscriptions_one_active_per_key
        ON subscriptions(api_key_id)
        WHERE status = 'active';
      END IF;
    END $$
  `;
  console.log("[migrate] Ensured subscription indexes (incl. one-active-per-key constraint)");

  // Webhook events log — for debugging missed/duplicate webhooks. Kept slim.
  await sql`
    CREATE TABLE IF NOT EXISTS lemonsqueezy_webhook_events (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_name            TEXT NOT NULL,
      event_id              TEXT,
      ls_subscription_id    TEXT,
      processed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      payload               JSONB NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ls_webhook_events_sub_id ON lemonsqueezy_webhook_events(ls_subscription_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ls_webhook_events_processed_at ON lemonsqueezy_webhook_events(processed_at DESC)`;
  console.log("[migrate] Ensured lemonsqueezy_webhook_events table");

  console.log("[migrate] subscriptions migration complete");
}
