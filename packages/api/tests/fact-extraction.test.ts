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

  // --- Coercion tests (the 80% fallback fix) ---

  it("coerces who from string to array", () => {
    const raw = {
      facts: [{ what: "Met Alice", who: "Alice" }],
      preferences: [],
    };
    const result = parseExtractionResult(raw);
    expect(result.facts[0].who).toEqual([{ name: "Alice" }]);
  });

  it("coerces who from object to array", () => {
    const raw = {
      facts: [{ what: "Met Bob", who: { name: "Bob", relation: "colleague" } }],
      preferences: [],
    };
    const result = parseExtractionResult(raw);
    expect(result.facts[0].who).toEqual([{ name: "Bob", relation: "colleague" }]);
  });

  it("coerces who from mixed array", () => {
    const raw = {
      facts: [{ what: "Team meeting", who: ["Alice", { name: "Bob" }, 42] }],
      preferences: [],
    };
    const result = parseExtractionResult(raw);
    expect(result.facts[0].who).toHaveLength(2);
    expect(result.facts[0].who[0].name).toBe("Alice");
    expect(result.facts[0].who[1].name).toBe("Bob");
  });

  it("coerces entities from single string to array", () => {
    const raw = {
      facts: [{ what: "Used VS Code", entities: "VS Code" }],
      preferences: [],
    };
    const result = parseExtractionResult(raw);
    expect(result.facts[0].entities).toEqual(["VS Code"]);
  });

  it("coerces when from string to object", () => {
    const raw = {
      facts: [{ what: "Event on date", when: "2025-01-18" }],
      preferences: [],
    };
    const result = parseExtractionResult(raw);
    expect(result.facts[0].when).toEqual({ start: "2025-01-18", end: null });
  });

  it("coerces preferences from single string", () => {
    const raw = {
      facts: [],
      preferences: "likes coffee",
    };
    const result = parseExtractionResult(raw);
    expect(result.preferences).toEqual(["likes coffee"]);
  });

  it("keeps facts with only 'what' field (everything else optional)", () => {
    const raw = {
      facts: [
        { what: "Fact with broken fields", who: 42, entities: true, when: false },
      ],
      preferences: [],
    };
    const result = parseExtractionResult(raw);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].what).toBe("Fact with broken fields");
    expect(result.facts[0].who).toEqual([]);
    expect(result.facts[0].entities).toEqual([]);
  });

  it("coerces invalid fact_type to default 'world'", () => {
    const raw = {
      facts: [{ what: "Test", fact_type: "invalid_type" }],
      preferences: [],
    };
    const result = parseExtractionResult(raw);
    expect(result.facts[0].fact_type).toBe("world");
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

  it("accepts any fact_type (coercion handles invalid values)", () => {
    const result = ExtractionResultSchema.safeParse({
      facts: [{ what: "Test", fact_type: "invalid_type", entities: [] }],
      preferences: [],
    });
    // Schema is lenient now — coercion in parseExtractionResult defaults invalid to "world"
    expect(result.success).toBe(true);
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
