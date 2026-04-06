import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../src/services/memories.js";

describe("4-way RRF fusion", () => {
  it("fuses 4 strategy result lists with correct scoring", () => {
    // Simulate 4 strategies returning overlapping results
    const vector = [
      { id: "fact-1", rank: 1 },
      { id: "fact-2", rank: 2 },
      { id: "fact-3", rank: 3 },
    ];
    const bm25 = [
      { id: "fact-2", rank: 1 },
      { id: "fact-4", rank: 2 },
      { id: "fact-1", rank: 3 },
    ];
    const graph = [
      { id: "fact-3", rank: 1 },
      { id: "fact-1", rank: 2 },
      { id: "fact-5", rank: 3 },
    ];
    const temporal = [
      { id: "fact-1", rank: 1 },
      { id: "fact-6", rank: 2 },
    ];

    const fused = reciprocalRankFusion([vector, bm25, graph, temporal]);

    // fact-1 appears in all 4 lists: should have highest score
    const scores = [...fused.entries()].sort((a, b) => b[1] - a[1]);
    expect(scores[0][0]).toBe("fact-1");

    // All 6 unique facts should be present
    expect(fused.size).toBe(6);
  });

  it("handles empty strategy lists gracefully", () => {
    const vector = [{ id: "fact-1", rank: 1 }];
    const bm25: { id: string; rank: number }[] = [];
    const graph: { id: string; rank: number }[] = [];
    const temporal: { id: string; rank: number }[] = [];

    const fused = reciprocalRankFusion(
      [vector, bm25, graph, temporal].filter((l) => l.length > 0)
    );

    expect(fused.size).toBe(1);
    expect(fused.has("fact-1")).toBe(true);
  });

  it("boosts items appearing in multiple strategies over single-strategy items", () => {
    const vector = [{ id: "multi", rank: 2 }, { id: "vector-only", rank: 1 }];
    const bm25 = [{ id: "multi", rank: 2 }, { id: "bm25-only", rank: 1 }];
    const graph = [{ id: "multi", rank: 1 }];

    const fused = reciprocalRankFusion([vector, bm25, graph]);

    const multiScore = fused.get("multi")!;
    const vectorOnlyScore = fused.get("vector-only")!;
    const bm25OnlyScore = fused.get("bm25-only")!;

    // "multi" appears in 3 lists, should beat single-list items
    expect(multiScore).toBeGreaterThan(vectorOnlyScore);
    expect(multiScore).toBeGreaterThan(bm25OnlyScore);
  });

  it("deduplicates correctly when same fact appears in all 4 strategies at rank 1", () => {
    const lists = [
      [{ id: "perfect", rank: 1 }],
      [{ id: "perfect", rank: 1 }],
      [{ id: "perfect", rank: 1 }],
      [{ id: "perfect", rank: 1 }],
    ];

    const fused = reciprocalRankFusion(lists);

    expect(fused.size).toBe(1);
    // Score = 4 * (1 / (60 + 1)) ≈ 0.0656
    const score = fused.get("perfect")!;
    expect(score).toBeCloseTo(4 / 61, 4);
  });
});
