import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  temporalDecay,
  reciprocalRankFusion,
} from "../src/services/memories.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns 0 when either vector is all zeros (denom=0 guard)", () => {
    const zero = [0, 0, 0];
    const v = [1, 2, 3];
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("handles high-dimensional vectors (1536-dim like OpenAI embeddings)", () => {
    const dim = 1536;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.sin(i + 0.1));
    const sim = cosineSimilarity(a, b);
    // Slightly shifted sine waves should be highly similar
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});

describe("temporalDecay", () => {
  it("returns ~1.0 for a memory created just now", () => {
    const now = new Date().toISOString();
    expect(temporalDecay(now)).toBeCloseTo(1.0, 1);
  });

  it("returns ~0.5 for a memory created 90 days ago (default half-life)", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(temporalDecay(ninetyDaysAgo)).toBeCloseTo(0.5, 1);
  });

  it("returns ~0.25 for a memory created 180 days ago", () => {
    const days180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    expect(temporalDecay(days180)).toBeCloseTo(0.25, 1);
  });

  it("returns ~0.06 for a memory created 365 days ago", () => {
    const days365 = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const decay = temporalDecay(days365);
    expect(decay).toBeGreaterThan(0.04);
    expect(decay).toBeLessThan(0.08);
  });

  it("respects custom half-life", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(temporalDecay(thirtyDaysAgo, 30)).toBeCloseTo(0.5, 1);
  });
});

describe("reciprocalRankFusion", () => {
  it("returns combined scores for a single ranked list", () => {
    const list = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ];
    const scores = reciprocalRankFusion([list]);
    // score = 1/(60+1) = 0.01639..., 1/(60+2) = 0.01613...
    expect(scores.get("a")).toBeGreaterThan(scores.get("b")!);
  });

  it("boosts items that appear in multiple lists", () => {
    const list1 = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ];
    const list2 = [
      { id: "b", rank: 1 },
      { id: "c", rank: 2 },
    ];
    const scores = reciprocalRankFusion([list1, list2]);
    // "b" appears in both lists, should have highest combined score
    expect(scores.get("b")).toBeGreaterThan(scores.get("a")!);
    expect(scores.get("b")).toBeGreaterThan(scores.get("c")!);
  });

  it("handles empty ranked lists gracefully", () => {
    const scores = reciprocalRankFusion([]);
    expect(scores.size).toBe(0);
  });

  it("handles lists with no overlap", () => {
    const list1 = [{ id: "a", rank: 1 }];
    const list2 = [{ id: "b", rank: 1 }];
    const scores = reciprocalRankFusion([list1, list2]);
    // Same rank in different lists → same individual score
    expect(scores.get("a")).toBeCloseTo(scores.get("b")!, 10);
  });

  it("uses custom k parameter", () => {
    const list = [{ id: "a", rank: 1 }];
    const k10 = reciprocalRankFusion([list], 10);
    const k100 = reciprocalRankFusion([list], 100);
    // Higher k = lower score (more damping)
    expect(k10.get("a")).toBeGreaterThan(k100.get("a")!);
  });
});
