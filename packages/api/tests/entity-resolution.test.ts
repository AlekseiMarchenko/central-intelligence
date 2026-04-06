import { describe, it, expect } from "vitest";
import {
  scoreCandidate,
  type EntityCandidate,
  type EntityWeights,
} from "../src/services/entity-resolution.js";

const DEFAULT_WEIGHTS: EntityWeights = { trigram: 0.5, cooccurrence: 0.3, temporal: 0.2 };

function makeCandidate(overrides: Partial<EntityCandidate> = {}): EntityCandidate {
  return {
    id: "entity-1",
    canonical: "alice",
    entity_type: "person",
    mention_count: 5,
    last_seen: new Date().toISOString(), // recent by default
    trigram_similarity: 0.8,
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("scores based on trigram when no co-occurrence or context", () => {
    const candidate = makeCandidate({ trigram_similarity: 0.9 });
    const score = scoreCandidate(candidate, [], new Map(), 0, new Date(), DEFAULT_WEIGHTS);

    // Trigram: 0.9 * 0.5 = 0.45
    // Co-occurrence: 0 (no context entities)
    // Temporal: ~0.2 (recent, decay ≈ 1.0)
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThan(0.7);
  });

  it("boosts score with co-occurrence", () => {
    const candidate = makeCandidate({ trigram_similarity: 0.4 });
    const cooccurrences = new Map([["entity-1", 10]]);

    const withoutCooccur = scoreCandidate(candidate, [], new Map(), 0, new Date(), DEFAULT_WEIGHTS);
    const withCooccur = scoreCandidate(
      candidate, ["other-entity"], cooccurrences, 10, new Date(), DEFAULT_WEIGHTS,
    );

    expect(withCooccur).toBeGreaterThan(withoutCooccur);
    // Co-occurrence adds: (10/10) * 0.3 = 0.3
    expect(withCooccur - withoutCooccur).toBeCloseTo(0.3, 1);
  });

  it("temporal breaks tie between equal trigram and co-occurrence", () => {
    const recent = makeCandidate({
      id: "recent",
      trigram_similarity: 0.6,
      last_seen: new Date().toISOString(),
    });
    const old = makeCandidate({
      id: "old",
      trigram_similarity: 0.6,
      last_seen: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year ago
    });

    const recentScore = scoreCandidate(recent, [], new Map(), 0, new Date(), DEFAULT_WEIGHTS);
    const oldScore = scoreCandidate(old, [], new Map(), 0, new Date(), DEFAULT_WEIGHTS);

    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("approaches 1.0 when all dimensions are perfect", () => {
    const candidate = makeCandidate({
      trigram_similarity: 1.0,
      last_seen: new Date().toISOString(),
    });
    const cooccurrences = new Map([["entity-1", 10]]);

    const score = scoreCandidate(
      candidate, ["context-entity"], cooccurrences, 10, new Date(), DEFAULT_WEIGHTS,
    );

    // Trigram: 1.0 * 0.5 = 0.5
    // Co-occurrence: (10/10) * 0.3 = 0.3
    // Temporal: ~1.0 * 0.2 = 0.2
    expect(score).toBeGreaterThan(0.95);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("returns only co-occurrence + temporal when trigram is zero", () => {
    const candidate = makeCandidate({ trigram_similarity: 0 });
    const cooccurrences = new Map([["entity-1", 5]]);

    const score = scoreCandidate(
      candidate, ["context-entity"], cooccurrences, 10, new Date(), DEFAULT_WEIGHTS,
    );

    // Trigram: 0
    // Co-occurrence: (5/10) * 0.3 = 0.15
    // Temporal: ~0.2
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.4);
  });

  it("returns 0 for co-occurrence when maxCooccurrence is 0", () => {
    const candidate = makeCandidate({ trigram_similarity: 0.5 });

    // maxCooccurrence = 0 should not cause division by zero
    const score = scoreCandidate(
      candidate, ["context-entity"], new Map(), 0, new Date(), DEFAULT_WEIGHTS,
    );

    // Only trigram + temporal contribute
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.5);
  });

  it("respects custom weights", () => {
    // Use imperfect trigram (0.6) so the weight distribution matters
    const candidate = makeCandidate({ trigram_similarity: 0.6 });
    const heavyTrigram: EntityWeights = { trigram: 0.9, cooccurrence: 0.05, temporal: 0.05 };
    const heavyTemporal: EntityWeights = { trigram: 0.05, cooccurrence: 0.05, temporal: 0.9 };

    const trigramHeavy = scoreCandidate(candidate, [], new Map(), 0, new Date(), heavyTrigram);
    const temporalHeavy = scoreCandidate(candidate, [], new Map(), 0, new Date(), heavyTemporal);

    // Heavy trigram: 0.6 * 0.9 = 0.54 + temporal: ~1.0 * 0.05 = 0.05 → ~0.59
    // Heavy temporal: 0.6 * 0.05 = 0.03 + temporal: ~1.0 * 0.9 = 0.9 → ~0.93
    // With imperfect trigram, temporal-heavy should win
    expect(temporalHeavy).toBeGreaterThan(trigramHeavy);
  });

  it("penalizes old entities via temporal decay", () => {
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const candidate = makeCandidate({
      trigram_similarity: 0.8,
      last_seen: sixMonthsAgo,
    });

    const score = scoreCandidate(candidate, [], new Map(), 0, new Date(), DEFAULT_WEIGHTS);

    // Trigram: 0.8 * 0.5 = 0.4
    // Temporal: ~0.5 * 0.2 = 0.1 (half-life = 180 days, age = 180 days)
    expect(score).toBeGreaterThan(0.45);
    expect(score).toBeLessThan(0.55);
  });
});
