-- Central Intelligence Database Schema
-- PostgreSQL 15+ (pgvector optional — cosine similarity computed in app layer)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- API keys for authentication
CREATE TABLE IF NOT EXISTS api_keys (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash   TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,           -- first 8 chars for display (ci_sk_...)
  name       TEXT NOT NULL DEFAULT 'default',
  org_id     TEXT,                    -- optional org grouping
  tier       TEXT NOT NULL DEFAULT 'free',  -- free | pro | team | enterprise
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys (org_id);

-- Agent registry — tracks known agents under each API key
CREATE TABLE IF NOT EXISTS agents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,           -- caller-defined agent identifier
  name       TEXT,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents (api_key_id);

-- Memories — the core table
CREATE TABLE IF NOT EXISTS memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id  UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,           -- which agent stored this
  user_id     TEXT,                    -- optional user-level grouping
  org_id      TEXT,                    -- optional org-level grouping
  scope       TEXT NOT NULL DEFAULT 'agent'
    CHECK (scope IN ('agent', 'user', 'org')),
  content     TEXT NOT NULL,
  tags        TEXT[] DEFAULT '{}',
  embedding   JSONB,                   -- stored as JSON array of floats
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ             -- soft delete
);

-- Scoped lookups
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories (api_key_id, agent_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories (api_key_id, user_id, scope)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_org ON memories (api_key_id, org_id, scope)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin (tags)
  WHERE deleted_at IS NULL;

-- Usage tracking for billing
CREATE TABLE IF NOT EXISTS usage_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,           -- remember | recall | forget | share | context
  agent_id   TEXT NOT NULL,
  tokens     INTEGER DEFAULT 0,       -- embedding tokens consumed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_api_key_date ON usage_events (api_key_id, created_at);

-- Payment credits — deposits from USDC on Base
CREATE TABLE IF NOT EXISTS payment_credits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id   UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  tx_hash      TEXT NOT NULL UNIQUE,           -- on-chain transaction hash
  from_address TEXT NOT NULL,                  -- sender wallet address
  amount       NUMERIC(18,6) NOT NULL,         -- USDC amount (6 decimals)
  network      TEXT NOT NULL DEFAULT 'base',   -- blockchain network
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_credits_api_key ON payment_credits (api_key_id);
CREATE INDEX IF NOT EXISTS idx_payment_credits_tx_hash ON payment_credits (tx_hash);

-- Payment debits — per-operation charges
CREATE TABLE IF NOT EXISTS payment_debits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id   UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,                  -- remember | recall | context | forget | share
  amount       NUMERIC(18,6) NOT NULL DEFAULT 0.001,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_debits_api_key ON payment_debits (api_key_id);
