-- Payment credits — USDC deposits verified on-chain
CREATE TABLE IF NOT EXISTS payment_credits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id   UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  tx_hash      TEXT NOT NULL UNIQUE,          -- on-chain transaction hash
  from_address TEXT NOT NULL,                  -- sender wallet address
  amount       NUMERIC(18, 6) NOT NULL,        -- USD amount (USDC = 1:1 USD)
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
  amount       NUMERIC(18, 6) NOT NULL DEFAULT 0.001,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_debits_api_key ON payment_debits (api_key_id);
