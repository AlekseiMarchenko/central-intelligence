#!/bin/bash
set -euo pipefail

# Add Postgres binaries to PATH
export PATH="/usr/lib/postgresql/17/bin:$PATH"

# Usage: benchmark-entrypoint.sh [--detach] <benchmark> [users] [top-k] [concurrency] [store-delay-ms]
#   benchmark:   lifebench | longmemeval
#   users:       comma-separated user IDs or "all" (lifebench only, default: all)
#   top-k:       memories to retrieve per question (default: 20)
#   concurrency: parallel API calls (default: 10)
#   store-delay: ms between stores (default: 0 for lifebench, 3000 for longmemeval)

LOG_FILE="/data/benchmark.log"
DATA_DIR="/data/benchmark-data"
RESULTS_DIR="/data/results"
DETACH=false

# Parse args — pull out --detach flag from any position
POSITIONAL=()
for arg in "$@"; do
  if [ "$arg" = "--detach" ]; then
    DETACH=true
  else
    POSITIONAL+=("$arg")
  fi
done

BENCHMARK="${POSITIONAL[0]:-lifebench}"
USERS="${POSITIONAL[1]:-all}"
TOP_K="${POSITIONAL[2]:-20}"
CONCURRENCY="${POSITIONAL[3]:-10}"
STORE_DELAY="${POSITIONAL[4]:-}"

# If --detach, re-exec in background
if [ "$DETACH" = true ]; then
  echo "Detaching benchmark to background. Follow with: tail -f $LOG_FILE"
  nohup /app/benchmark-entrypoint.sh "$BENCHMARK" "$USERS" "$TOP_K" "$CONCURRENCY" "$STORE_DELAY" \
    > "$LOG_FILE" 2>&1 &
  BGPID=$!
  echo "PID: $BGPID"
  echo "$BGPID" > /data/benchmark.pid

  sleep 3
  if kill -0 $BGPID 2>/dev/null; then
    echo "Benchmark running in background. SSH can safely disconnect."
    exit 0
  else
    echo "Benchmark failed to start. Check $LOG_FILE"
    tail -20 "$LOG_FILE"
    exit 1
  fi
fi

echo "============================================"
echo "  CI Benchmark VM"
echo "============================================"
echo "  Benchmark:   $BENCHMARK"
echo "  Users:       $USERS"
echo "  Top-K:       $TOP_K"
echo "  Concurrency: $CONCURRENCY"
echo "============================================"

# ─── Validate ───
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "FATAL: OPENAI_API_KEY is not set"
  exit 1
fi

# ─── Helper: start/stop API ───
start_api() {
  local extraction_concurrency="${1:-0}"
  local skip_obs="${2:-}"
  cd /app/ci
  DATABASE_URL="postgres://ci_bench:ci_bench@localhost:5432/ci_bench" \
    OPENAI_API_KEY="$OPENAI_API_KEY" \
    PORT=3141 \
    NODE_ENV=production \
    MAX_EXTRACTION_CONCURRENCY="$extraction_concurrency" \
    SKIP_OBSERVATIONS="$skip_obs" \
    node dist/index.js >> /data/api.log 2>&1 &
  CI_PID=$!
  echo "$CI_PID" > /data/api.pid

  for i in $(seq 1 60); do
    if curl -sf http://localhost:3141/health > /dev/null 2>&1; then
      echo "  CI API healthy (attempt $i, extraction_concurrency=$extraction_concurrency)"
      return 0
    fi
    if [ "$i" -eq 60 ]; then
      echo "  FATAL: CI API failed to start after 60s"
      tail -20 /data/api.log
      return 1
    fi
    sleep 1
  done
}

stop_api() {
  if [ -f /data/api.pid ]; then
    kill "$(cat /data/api.pid)" 2>/dev/null || true
    rm -f /data/api.pid
    sleep 2
  fi
}

# ─── 1. Initialize & start Postgres ───
echo ""
echo "--- [1/9] Starting Postgres ---"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "  Initializing Postgres cluster..."
  mkdir -p "$PGDATA"
  chown -R postgres:postgres /data
  su postgres -c "initdb -D $PGDATA --auth-local=trust --auth-host=trust --no-locale -E UTF8"

  cat >> "$PGDATA/postgresql.conf" <<PGCONF
shared_buffers = 256MB
work_mem = 16MB
maintenance_work_mem = 256MB
effective_cache_size = 1GB
max_connections = 50
listen_addresses = 'localhost'
log_min_messages = warning
PGCONF
fi

su postgres -c "pg_ctl -D $PGDATA -l /data/pg.log start -w -t 30"
echo "  Postgres started."

# ─── 2. Create database + extensions ───
echo ""
echo "--- [2/9] Setting up database ---"

su postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname = 'ci_bench'\" | grep -q 1" \
  || su postgres -c "psql -c \"CREATE USER ci_bench WITH PASSWORD 'ci_bench' SUPERUSER\""

su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = 'ci_bench'\" | grep -q 1" \
  || su postgres -c "createdb -O ci_bench ci_bench"

su postgres -c "psql -d ci_bench -c 'CREATE EXTENSION IF NOT EXISTS vector'"
su postgres -c "psql -d ci_bench -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto'"
echo "  Database ready."

# ─── 3. Apply schema + migration columns ───
echo ""
echo "--- [3/9] Applying schema ---"
su postgres -c "psql -d ci_bench -f /app/ci/src/db/schema.sql" > /dev/null 2>&1

su postgres -c "psql -d ci_bench" > /dev/null 2>&1 <<'MIGRATE'
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_vec vector(1536);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_date_from TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_date_to TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS entities JSONB;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS preferences JSONB;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS extraction_status TEXT DEFAULT 'pending';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS extraction_retries INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memories_embedding_vec ON memories USING hnsw (embedding_vec vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_memories_event_date ON memories (event_date_from) WHERE event_date_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_entities ON memories USING gin (entities) WHERE entities IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_preferences ON memories USING gin (preferences) WHERE preferences IS NOT NULL;

-- Entity resolution indexes (critical for enrichment speed)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_entities_trgm ON entities USING gin (canonical gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_api_agent ON entities (api_key_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_entity_facts_fact ON entity_facts (fact_id);
CREATE INDEX IF NOT EXISTS idx_fact_units_memory ON fact_units (memory_id);
CREATE INDEX IF NOT EXISTS idx_fact_units_api_agent ON fact_units (api_key_id, agent_id, fact_type);
CREATE INDEX IF NOT EXISTS idx_fact_units_tsv ON fact_units USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_fact_links_from ON fact_links (from_fact_id, link_type);
CREATE INDEX IF NOT EXISTS idx_fact_links_to ON fact_links (to_fact_id, link_type);
MIGRATE
echo "  Schema + migrations applied."

# ─── 4. Create API key ───
echo ""
echo "--- [4/9] Creating API key ---"

RAW=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')
BENCH_KEY="ci_sk_${RAW}"
KEY_HASH=$(echo -n "$BENCH_KEY" | sha256sum | awk '{print $1}')
KEY_PREFIX="${BENCH_KEY:0:14}"

su postgres -c "psql -d ci_bench -c \"INSERT INTO api_keys (key_hash, key_prefix, name, org_id, tier) VALUES ('$KEY_HASH', '$KEY_PREFIX', 'benchmark', 'benchmark', 'enterprise') ON CONFLICT (key_hash) DO NOTHING\""

API_KEY_ID=$(su postgres -c "psql -d ci_bench -tAc \"SELECT id FROM api_keys WHERE key_hash = '$KEY_HASH'\"")
su postgres -c "psql -d ci_bench -c \"INSERT INTO payment_credits (api_key_id, tx_hash, from_address, amount, network) VALUES ('$API_KEY_ID', 'benchmark-prefund-$(date +%s)', 'benchmark', 200.000000, 'benchmark') ON CONFLICT (tx_hash) DO NOTHING\""
echo "$BENCH_KEY" > /data/bench_key
echo "  API Key: $BENCH_KEY"
echo "  Pre-funded: \$200"

mkdir -p "$RESULTS_DIR" "$DATA_DIR"
START_TIME=$(date +%s)

# ═══════════════════════════════════════════════════
#  PHASE A: INGEST (enrichment disabled)
# ═══════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════"
echo "  PHASE A: Ingestion (enrichment disabled)"
echo "═══════════════════════════════════════════════════"

start_api 0

cd /app/lifebench

if [ "$BENCHMARK" = "lifebench" ]; then
  DELAY="${STORE_DELAY:-0}"
  node dist/cli.js run \
    --provider ci \
    --api-key "$BENCH_KEY" \
    --api-url http://localhost:3141 \
    --phase ingest \
    --users "$USERS" \
    --top-k "$TOP_K" \
    --concurrency "$CONCURRENCY" \
    --store-delay "$DELAY" \
    --data-dir "$DATA_DIR" \
    --output "$RESULTS_DIR" \
    --verbose

elif [ "$BENCHMARK" = "longmemeval" ]; then
  DELAY="${STORE_DELAY:-3000}"
  node dist/cli.js longmemeval \
    --provider ci \
    --api-key "$BENCH_KEY" \
    --api-url http://localhost:3141 \
    --top-k "$TOP_K" \
    --store-delay "$DELAY" \
    --data-dir "$DATA_DIR" \
    --output "$RESULTS_DIR" \
    --verbose

  SKIP_ENRICHMENT_AND_EVAL=true
else
  echo "FATAL: Unknown benchmark '$BENCHMARK'. Use 'lifebench' or 'longmemeval'."
  exit 1
fi

INGEST_TIME=$(date +%s)
echo ""
echo "  Ingestion complete in $(( (INGEST_TIME - START_TIME) / 60 ))m $(( (INGEST_TIME - START_TIME) % 60 ))s"

stop_api

if [ "${SKIP_ENRICHMENT_AND_EVAL:-}" = "true" ]; then
  PRED_FILE="$RESULTS_DIR/ci/longmemeval-predictions.jsonl"
  GOLD_FILE="$DATA_DIR/longmemeval-repo/data/longmemeval_s_cleaned.json"
  if [ -f "$PRED_FILE" ] && [ -f "$GOLD_FILE" ]; then
    echo ""
    echo "--- Running LongMemEval official evaluation ---"
    cd "$DATA_DIR/longmemeval-repo/src/evaluation"
    /opt/lme-venv/bin/python3 evaluate_qa.py gpt-4o "$PRED_FILE" "$GOLD_FILE" \
      | tee "$RESULTS_DIR/ci/longmemeval-evaluation.txt"
  fi
else

# ═══════════════════════════════════════════════════
#  PHASE B: ENRICHMENT (deferred, via /memories/extract)
# ═══════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════"
echo "  PHASE B: Enrichment (deferred)"
echo "═══════════════════════════════════════════════════"

# Clean up stale extraction data before re-enriching
echo "  Cleaning up fallback facts and stale extraction data..."
su postgres -c "psql -d ci_bench -c \"DELETE FROM fact_links\"" > /dev/null 2>&1
su postgres -c "psql -d ci_bench -c \"DELETE FROM entity_facts\"" > /dev/null 2>&1
su postgres -c "psql -d ci_bench -c \"DELETE FROM entity_cooccurrences\"" > /dev/null 2>&1
su postgres -c "psql -d ci_bench -c \"DELETE FROM fact_units\"" > /dev/null 2>&1
su postgres -c "psql -d ci_bench -c \"DELETE FROM entities\"" > /dev/null 2>&1
su postgres -c "psql -d ci_bench -c \"UPDATE memories SET extraction_status = 'pending', extraction_retries = 0, entities = NULL, preferences = NULL, enriched_at = NULL\"" > /dev/null 2>&1

TOTAL_PENDING=$(su postgres -c "psql -d ci_bench -tAc \"SELECT COUNT(*) FROM memories WHERE extraction_status = 'pending'\"" | tr -d ' ')
echo "  Cleaned. Memories to enrich: $TOTAL_PENDING"

start_api 3 1  # concurrency=3, skip_observations=1

# Trigger batch extraction via the dedicated endpoint
EXTRACT_RESPONSE=$(curl -sf -X POST http://localhost:3141/memories/extract \
  -H "Authorization: Bearer $BENCH_KEY" \
  -H "Content-Type: application/json")
echo "  Extract response: $EXTRACT_RESPONSE"

# Wait for extraction to complete
echo "  Waiting for extraction to complete..."
while true; do
  PENDING=$(su postgres -c "psql -d ci_bench -tAc \"SELECT COUNT(*) FROM memories WHERE extraction_status = 'pending'\"" | tr -d ' ')
  PROCESSING=$(su postgres -c "psql -d ci_bench -tAc \"SELECT COUNT(*) FROM memories WHERE extraction_status = 'processing'\"" | tr -d ' ')
  COMPLETE=$(su postgres -c "psql -d ci_bench -tAc \"SELECT COUNT(*) FROM memories WHERE extraction_status = 'complete'\"" | tr -d ' ')
  echo "  Enrichment: $COMPLETE complete, $PROCESSING processing, $PENDING pending"
  if [ "$PENDING" = "0" ] && [ "$PROCESSING" = "0" ]; then
    break
  fi
  sleep 30
done

ENRICH_TIME=$(date +%s)
echo ""
echo "  Enrichment complete in $(( (ENRICH_TIME - INGEST_TIME) / 60 ))m $(( (ENRICH_TIME - INGEST_TIME) % 60 ))s"

stop_api

# ═══════════════════════════════════════════════════
#  PHASE C: EVALUATE
# ═══════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════"
echo "  PHASE C: Evaluation"
echo "═══════════════════════════════════════════════════"

start_api 0

cd /app/lifebench
node dist/cli.js run \
  --provider ci \
  --api-key "$BENCH_KEY" \
  --api-url http://localhost:3141 \
  --phase evaluate \
  --users "$USERS" \
  --top-k "$TOP_K" \
  --data-dir "$DATA_DIR" \
  --output "$RESULTS_DIR" \
  --verbose

stop_api

fi  # end of lifebench-specific phases

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "============================================"
echo "  Benchmark complete!"
echo "  Duration: ${DURATION}s ($((DURATION / 60))m $((DURATION % 60))s)"
echo "  Results:  $RESULTS_DIR/ci/"
echo "============================================"
echo ""
ls -la "$RESULTS_DIR/ci/" 2>/dev/null || echo "  (no results found)"

if [ -f "$RESULTS_DIR/ci/report.md" ]; then
  echo ""
  echo "--- Report ---"
  cat "$RESULTS_DIR/ci/report.md"
fi

su postgres -c "pg_ctl -D $PGDATA stop -m fast" 2>/dev/null || true
echo ""
echo "=== Done ==="
