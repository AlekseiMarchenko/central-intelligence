# Changelog

## [1.2.0] - 2026-04-09 — Benchmark Infrastructure + pgvector Fix

Benchmark runs no longer touch production. A dedicated Fly VM runs LifeBench with its own ephemeral Postgres, so benchmarks can ingest 15K memories without affecting the live API. pgvector now survives Fly Postgres restarts. Infra costs dropped 58%.

### Fixed

- **pgvector survives restarts.** Custom Docker image (`db/Dockerfile`) bakes `postgresql-17-pgvector` into the Fly Postgres base image. The `.so` binary no longer disappears on machine restart.
- **Parallel migration deadlocks.** Benchmark entrypoint pre-applies all ALTER TABLE columns before starting the API, working around the `Promise.all()` deadlock in `index.ts` migrations.

### Added

- **Benchmark VM.** Self-contained Fly machine (`ci-benchmark`) with ephemeral Postgres, the CI API, and the LifeBench harness in one container. Runs detached via `nohup`, SSH-safe with stall monitoring.
- **Custom Postgres image.** `db/Dockerfile` extends `flyio/postgres-flex:17.2` with pgvector 0.8.2 baked in. Deployed as `registry.fly.io/central-intelligence-db:pgvector`.

### Infrastructure

- Fly costs: **$52/mo → $22/mo** (58% reduction). API 2GB→1GB, DB 2GB→1GB, Landing 2×1GB→1×256MB.
- Production DB cleaned: **3.6GB → 582MB** (87% reduction). Removed old benchmark data, preserved 134 real user memories.
- Benchmark VM: `shared-cpu-2x:2048MB` with 3GB volume, runs LifeBench in ~3 hours.

### New Files

- `db/Dockerfile` — Custom Postgres image with pgvector
- `benchmark/Dockerfile` — Benchmark VM image
- `benchmark/benchmark-entrypoint.sh` — Orchestration script
- `benchmark/fly.toml` — Fly config for ci-benchmark app

## [1.1.0] - 2026-04-08 — Retrieval Reliability

All four retrieval strategies now work correctly. Temporal search, BM25 on short facts, and vector indexing were broken since v1.0.0. Recall also runs a dual-path architecture: both the new fact-based 4-way search and the proven memory-based 2-way search run in parallel, with results merged using a query type classifier. Nondeclarative questions improved +12.8 points while maintaining overall benchmark parity.

### Fixed

- **Temporal search actually works now.** Postgres doesn't support `ABS()` on intervals. Changed to `ABS(EXTRACT(EPOCH FROM ...))`. Temporal strategy went from 0 results to 50 per recall.
- **BM25 matches short facts.** Switched from AND-joined `plainto_tsquery` to OR-joined `to_tsquery`. Short fact_units (20-30 words) now match when any significant query term appears, not all of them. BM25 went from 0 results to 100 per recall.
- **Vector search uses HNSW index.** Queries without a `fact_type` filter couldn't use the partial HNSW indexes. Added a global (non-partial) HNSW index. Search dropped from 30-73 seconds to <50ms.
- **Temporal month extraction broadened.** Now matches month names mid-sentence ("working in January?"), day-month without year ("January 25th"), and cultural dates (Spring Festival).

### Added

- **Dual-path recall.** Both fact-based (4-way) and memory-based (2-way) search run in parallel. Results are merged using query type weights, so each question type gets the best retrieval path.
- **Query type classifier.** Categorizes each recall query as factual (favors full-text memories), temporal (favors fact graph), or pattern (favors knowledge graph) using keyword patterns. No LLM call needed.
- **Topic tagging in fact extraction.** Each extracted fact now gets 2-5 topic labels ("restaurant dining", "career advice") appended to its search vector, improving BM25 discoverability.
- **Enriched search vectors.** Fact_unit tsvectors now include entity names, topic labels, and who-names alongside the fact text itself.

### Infrastructure

- Fly Postgres: global HNSW index on fact_units, `maintenance_work_mem` increased to 512MB.
- Fly machine: upgraded from 256MB to 1GB RAM to handle concurrent fact extraction.

## [1.0.0] - 2026-04-06 — 4-Way Retrieval

Recall is now 4x smarter. Every memory is decomposed into structured facts at store time, with entities extracted, resolved, and linked into a knowledge graph. Recall runs four search strategies in parallel (vector, BM25, graph traversal, temporal), fuses them with RRF, and reranks with a local cross-encoder model. Zero per-recall API cost.

### Added

- **Fact decomposition.** Each stored memory is broken into atomic facts with entities, temporal info, and causal relations via GPT-4o-mini. Facts are individually searchable with their own embeddings and tsvectors.
- **Entity resolution.** Extracted entities are matched against existing ones using trigram similarity, co-occurrence scoring, and temporal proximity. "Alice" and "my coworker Alice" merge automatically.
- **Knowledge graph.** Entities, facts, and co-occurrences form a queryable graph via junction tables. Graph traversal finds related facts through shared entities and causal links.
- **4-way parallel retrieval.** Recall runs vector search, BM25, graph traversal (dual-seed: embedding + entity name), and temporal search simultaneously. Results are fused via Reciprocal Rank Fusion.
- **Local ONNX cross-encoder reranker.** ms-marco-MiniLM-L-6-v2 runs locally via @xenova/transformers. Zero per-request cost. Falls back to Cohere API, then passthrough.
- **Observation consolidation.** When an entity accumulates 5+ facts, a higher-level observation is auto-synthesized. These "pre-computed answers" match directly on recall.
- **Fallback fact_units.** Every store() creates a searchable fact_unit synchronously, so memories are findable from millisecond one, even before extraction completes.
- **Per-strategy observability.** Each retrieval strategy logs hit counts and latency on every recall.
- **36 new tests** covering fact extraction validation, entity scoring, 4-way RRF fusion, reranker fallback, and observation contracts. 68 total.

### Changed

- Store pipeline: replaced simple entity+preference enrichment with full fact decomposition (3x retry, exponential backoff, concurrency-limited queue).
- Recall pipeline: routes to fact-based 4-way retrieval when fact_units exist, falls back to legacy 2-way (vector + BM25) on memories table.
- Reranker: 3-tier fallback chain (ONNX local, Cohere API, passthrough) replaces Cohere-only.
- Dockerfile: pre-downloads ONNX model during build for fast cold starts.
- Store cost: ~$0.0003/memory (up from ~$0.00007). Recall cost: $0 (down from ~$0.00002).

## [0.5.0] - 2026-04-03 — Cross-Tool Memory

CI Local now reads config files from 5 AI coding platforms and merges them into the search pipeline. Memories stored via Claude Code are discoverable when using Cursor, and vice versa. This is the cross-tool memory layer: your AI memory works everywhere, not just in one tool.

### Added

- **Cross-tool file source reading.** CI Local discovers and parses CLAUDE.md, .cursor/rules, .windsurf/rules, codex.md, and .github/copilot-instructions.md. Parsed sections are embedded and merged into the hybrid search pipeline alongside database memories.
- **File source cache.** New `file_source_cache` SQLite table stores content hashes, embeddings, and first-seen timestamps. Only re-embeds sections when content changes. First recall after adding a config file takes ~2-4s (embedding), subsequent calls are instant.
- **Smart recall signals.** Recall and context responses now include `source` (db or platform name), `freshness_score` (0-1 exponential decay), and `duplicate_group` (Jaccard word overlap > 0.8). Agents can use these to prioritize fresh, unique memories.
- **Duplicate detection.** Near-duplicate memories across sources are grouped. If the same fact exists in CLAUDE.md and the database, both are returned but flagged as duplicates so agents can deduplicate.
- **CLAUDE.md with skill routing rules** added to the project.

### Changed

- `MemoryWithScore` type extended with optional `source`, `source_path`, `freshness_score`, and `duplicate_group` fields. Backward compatible.
- Hybrid search now merges file-sourced candidates into all three strategies (vector, FTS5, fuzzy) via RRF fusion.

### CI Local (v1.1.0)

- File source reading + caching
- Smart recall signals in MCP responses
- Duplicate detection across DB + file sources

## [0.4.0] - 2026-03-31 — Quality Sprint

Retrieval actually works now. BM25 full-text search was broken since launch (tsvectors stored as empty strings). Trigram search ran against encrypted ciphertext, producing noise. Context compression silently forwarded decrypted memories to OpenAI. All three are fixed: BM25 generates tsvectors from plaintext before encrypting, trigram search is removed (vector + BM25 is sufficient), and context compression is removed (clients handle summarization). Benchmark score went from 92/100 (vector-only, two strategies broken) to 100/100 (vector + BM25 hybrid).

### Fixed

- BM25 full-text search now works — `content_tsv` is populated from plaintext before encryption, not set to empty string
- Removed trigram search — it ran `similarity()` against AES-256-GCM ciphertext, producing meaningless scores
- Removed `compressContext` — it sent decrypted memory content to OpenAI GPT-4o-mini, contradicting the encryption-at-rest guarantee
- Batch-fetched BM25-only results with `WHERE id = ANY(...)` instead of N+1 individual queries
- Replaced bare `catch {}` blocks in BM25 search with specific error handling — catches column-not-found (pre-migration), re-throws and logs everything else
- `forget()` now logs usage events for billing and analytics (was the only operation that didn't)
- Migration uses `CREATE INDEX CONCURRENTLY` for the GIN index to avoid table locks on production
- Lazy tsvector backfill during `recall()` — old memories get their tsvectors populated when decrypted, since the bulk migration can't decrypt (no access to raw API keys)

### Added

- Vitest test suite — 32 tests covering pure functions (cosine similarity, temporal decay, RRF), encryption roundtrips and edge cases, and rate limiting middleware
- GIN index on `content_tsv` for BM25 search performance
- ASCII diagram of the retrieval pipeline in `memories.ts`

### Changed

- Hybrid retrieval is now vector + BM25 (was vector + BM25 + trigram)
- `store()` returns the `result` variable (with plaintext content) instead of `memory` for clarity
