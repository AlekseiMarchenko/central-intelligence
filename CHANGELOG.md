# Changelog

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
