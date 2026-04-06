import { describe, it, expect } from "vitest";
import {
  parseExtractionResult,
  ExtractionResultSchema,
} from "../src/services/fact-extraction.js";

describe("parseExtractionResult", () => {
  it("parses a valid full extraction result", () => {
    const raw = {
      facts: [
        {
          what: "Had lunch with Li Wei at Lanzhou Restaurant",
          when: { start: "2025-01-18", end: "2025-01-18" },
          where: "Lanzhou Restaurant",
          who: [{ name: "Li Wei", relation: "colleague" }],
          entities: ["Li Wei", "Lanzhou Restaurant"],
          fact_type: "experience",
          causal_relations: [],
        },
        {
          what: "Team discussed Q1 targets",
          entities: ["Q1 targets"],
          fact_type: "world",
        },
      ],
      preferences: ["prefers Chinese food", "likes team lunches"],
    };

    const result = parseExtractionResult(raw);
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].what).toBe("Had lunch with Li Wei at Lanzhou Restaurant");
    expect(result.facts[0].who).toHaveLength(1);
    expect(result.facts[0].who[0].name).toBe("Li Wei");
    expect(result.facts[0].fact_type).toBe("experience");
    expect(result.facts[1].entities).toEqual(["Q1 targets"]);
    expect(result.preferences).toEqual(["prefers Chinese food", "likes team lunches"]);
  });

  it("recovers when causal_relations is missing", () => {
    const raw = {
      facts: [
        { what: "Uses VS Code for development", entities: ["VS Code"] },
      ],
      preferences: [],
    };

    const result = parseExtractionResult(raw);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].causal_relations).toEqual([]);
  });

  it("drops invalid facts but keeps valid ones", () => {
    const raw = {
      facts: [
        { what: "Valid fact", entities: [] },
        { entities: [] }, // missing required 'what' field
        { what: "", entities: [] }, // empty 'what' field
        { what: "Another valid fact", entities: ["Entity"] },
      ],
      preferences: [],
    };

    const result = parseExtractionResult(raw);
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].what).toBe("Valid fact");
    expect(result.facts[1].what).toBe("Another valid fact");
  });

  it("returns empty arrays for null/undefined input", () => {
    expect(parseExtractionResult(null)).toEqual({ facts: [], preferences: [] });
    expect(parseExtractionResult(undefined)).toEqual({ facts: [], preferences: [] });
    expect(parseExtractionResult("string")).toEqual({ facts: [], preferences: [] });
    expect(parseExtractionResult(42)).toEqual({ facts: [], preferences: [] });
  });

  it("defaults fact_type to 'world' when omitted", () => {
    const raw = {
      facts: [{ what: "Some fact", entities: [] }],
      preferences: [],
    };

    const result = parseExtractionResult(raw);
    expect(result.facts[0].fact_type).toBe("world");
  });

  it("parses preferences and filters non-strings", () => {
    const raw = {
      facts: [],
      preferences: ["likes coffee", 42, null, "dislikes meetings", ""],
    };

    const result = parseExtractionResult(raw);
    expect(result.preferences).toEqual(["likes coffee", "dislikes meetings"]);
  });

  it("handles who[] with and without relation", () => {
    const raw = {
      facts: [
        {
          what: "Met with team",
          who: [
            { name: "Alice", relation: "manager" },
            { name: "Bob" },
          ],
          entities: [],
        },
      ],
      preferences: [],
    };

    const result = parseExtractionResult(raw);
    expect(result.facts[0].who).toHaveLength(2);
    expect(result.facts[0].who[0].relation).toBe("manager");
    expect(result.facts[0].who[1].relation).toBeUndefined();
  });

  it("handles when with null start/end", () => {
    const raw = {
      facts: [
        {
          what: "Something happened recently",
          when: { start: null, end: null },
          entities: [],
        },
      ],
      preferences: [],
    };

    const result = parseExtractionResult(raw);
    expect(result.facts[0].when?.start).toBeNull();
    expect(result.facts[0].when?.end).toBeNull();
  });

  it("defaults arrays when fields are missing entirely", () => {
    const raw = {
      facts: [{ what: "Minimal fact" }],
    };

    const result = parseExtractionResult(raw);
    expect(result.facts[0].entities).toEqual([]);
    expect(result.facts[0].who).toEqual([]);
    expect(result.facts[0].causal_relations).toEqual([]);
    expect(result.preferences).toEqual([]);
  });
});

describe("ExtractionResultSchema", () => {
  it("validates a complete result", () => {
    const result = ExtractionResultSchema.safeParse({
      facts: [
        {
          what: "Test fact",
          fact_type: "experience",
          entities: ["Test"],
        },
      ],
      preferences: ["likes testing"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid fact_type", () => {
    const result = ExtractionResultSchema.safeParse({
      facts: [{ what: "Test", fact_type: "invalid_type", entities: [] }],
      preferences: [],
    });
    expect(result.success).toBe(false);
  });

  it("provides defaults for empty input", () => {
    const result = ExtractionResultSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.facts).toEqual([]);
      expect(result.data.preferences).toEqual([]);
    }
  });
});
