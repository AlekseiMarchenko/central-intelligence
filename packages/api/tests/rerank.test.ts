import { describe, it, expect } from "vitest";
import { _passthroughRerank } from "../src/services/rerank.js";

describe("passthroughRerank", () => {
  it("returns documents in original order with linear score decay", () => {
    const docs = [
      { id: "a", content: "first" },
      { id: "b", content: "second" },
      { id: "c", content: "third" },
    ];

    const results = _passthroughRerank(docs, 3);

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe("a");
    expect(results[1].id).toBe("b");
    expect(results[2].id).toBe("c");
    // Scores should decrease linearly
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it("respects topN limit", () => {
    const docs = [
      { id: "a", content: "first" },
      { id: "b", content: "second" },
      { id: "c", content: "third" },
      { id: "d", content: "fourth" },
    ];

    const results = _passthroughRerank(docs, 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[1].id).toBe("b");
  });

  it("handles empty document list", () => {
    const results = _passthroughRerank([], 5);
    expect(results).toHaveLength(0);
  });

  it("handles single document", () => {
    const docs = [{ id: "a", content: "only one" }];
    const results = _passthroughRerank(docs, 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a");
    expect(results[0].score).toBe(1);
  });

  it("first score is always 1.0", () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({
      id: `doc-${i}`,
      content: `content ${i}`,
    }));

    const results = _passthroughRerank(docs, 10);
    expect(results[0].score).toBe(1);
    expect(results[9].score).toBeGreaterThan(0);
  });
});
