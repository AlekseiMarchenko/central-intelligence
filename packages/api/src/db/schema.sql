-- Central Intelligence Database Schema
-- Requires: PostgreSQL 15+ with pgvector extension

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- API keys for authentication
CREATE TABLE api_keys (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash   TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,           -- first 8 chars for display (ci_sk_...)
  name       TEXT NOT NULL DEFAULT 'default',
  org_id     TEXT,                    -- optional org grouping
  tier       TEXT NOT NULL DEFAULT 'free',  -- free | pro | team | enterprise
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX idx_api_keys_org_id ON api_keys (org_id);

-- Agent registry — tracks known agents under each API key
CREATE TABLE agents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,           -- caller-defined agent identifier
  name       TEXT,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, agent_id)
);

CREATE INDEX idx_agents_api_key ON agents (api_key_id);

-- Memories — the core table
CREATE TABLE memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id  UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,           -- which agent stored this
  user_id     TEXT,                    -- optional user-level grouping
  org_id      TEXT,                    -- optional org-level grouping
  scope       TEXT NOT NULL DEFAULT 'agent'
    CHECK (scope IN ('agent', 'user', 'org')),
  content     TEXT NOT NULL,
  tags        TEXT[] DEFAULT '{}',
  embedding   vector(1536),           -- OpenAI text-embedding-3-small dimension
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ             -- soft delete
);

-- Vector similarity search index
CREATE INDEX idx_memories_embedding ON memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Scoped lookups
CREATE INDEX idx_memories_agent ON memories (api_key_id, agent_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_memories_user ON memories (api_key_id, user_id, scope)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_memories_org ON memories (api_key_id, org_id, scope)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_memories_tags ON memories USING gin (tags)
  WHERE deleted_at IS NULL;

-- Usage tracking for billing
CREATE TABLE usage_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,           -- remember | recall | forget | share | context
  agent_id   TEXT NOT NULL,
  tokens     INTEGER DEFAULT 0,       -- embedding tokens consumed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_api_key_date ON usage_events (api_key_id, created_at);
