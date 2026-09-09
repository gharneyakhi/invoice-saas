import { describe, expect, it } from "vitest";
import { RTL_CASES } from "./rtlStrings";
import {
  applyLineTrailingReset,
  findBreakOpportunities,
  resolveParagraph,
  reverseClusterString,
  sanitizeForBidi,
  splitClusters,
  splitParagraphs,
  visualRunsForLine,
  visualRunsForParagraph,
  visualStringForParagraph,
  visualUnitsForLine,
} from "../bidi";

describe("UBA acceptance strings (hand-derived literals)", () => {
  for (const testCase of RTL_CASES) {
    it(`${testCase.id}: levels resolve exactly`, () => {
      const resolved = resolveParagraph(testCase.logical, "rtl");
      expect(resolved.text).toBe(testCase.logical);
      expect(resolved.paraLevel).toBe(1);
      // Tripwire: every literal must cover every UTF-16 unit.
      expect(testCase.levels.length).toBe(testCase.logical.length);
      expect([...resolved.levels].join("")).toBe(testCase.levels);
    });

    it(`${testCase.id}: visual string matches exactly`, () => {
      const resolved = resolveParagraph(testCase.logical, "rtl");
      expect(visualStringForParagraph(resolved)).toBe(testCase.visual);
    });

    it(`${testCase.id}: visual runs reassemble the visual string`, () => {
      const resolved = resolveParagraph(testCase.logical, "rtl");
      const runs = visualRunsForParagraph(resolved);
      expect(runs.length).toBeGreaterThan(0);
      // Runs are in visual order carrying logical-order text: reversing the
      // RTL ones must reproduce the visual string exactly.
      const reassembled = runs
        .map((run) => (run.rtl ? reverseClusterString(run.logicalText) : run.logicalText))
        .join("");
      expect(reassembled).toBe(testCase.visual);
      // Every run's level must agree with the literal at its logical range.
      for (const run of runs) {
        for (let unit = run.logicalStart; unit <= run.logicalEnd; unit += 1) {
          expect(String(run.level)).toBe(testCase.levels[unit] ?? "?");
        }
      }
    });
  }
});

describe("L4 mirroring", () => {
  it("mirrors brackets at odd levels inside run text", () => {
    const resolved = resolveParagraph("(۱۰٪) ۲۰,۰۰۰ تومان", "rtl");
    const runs = visualRunsForParagraph(resolved);
    // Visual order: [ تومان][۲۰,۰۰۰][") " mirrored][۱۰٪]["(" mirrored].
    expect(runs.map((run) => run.logicalText)).toEqual([" تومان", "۲۰,۰۰۰", "( ", "۱۰٪", ")"]);
  });

  it("leaves brackets in LTR runs unmirrored", () => {
    const resolved = resolveParagraph("ABC (123)", "ltr");
    const runs = visualRunsForParagraph(resolved);
    expect(runs.map((run) => run.logicalText).join("")).toBe("ABC (123)");
  });
});

describe("sanitizeForBidi", () => {
  it("normalizes CRLF/CR to LF, TAB to space, drops other controls", () => {
    expect(sanitizeForBidi("a\r\nb\rc\tdef\u009Fg")).toBe("a\nb\nc defg");
  });

  it("preserves joining/zero-width controls the shaper needs", () => {
    expect(sanitizeForBidi("می‌خواهم‏ ‏‎abc")).toBe("می‌خواهم‏ ‏‎abc");
  });

  it("splits paragraphs on LF", () => {
    expect(splitParagraphs(sanitizeForBidi("a\r\nb\nc"))).toEqual(["a", "b", "c"]);
  });
});

describe("break opportunities", () => {
  it("offers droppable breaks after plain spaces only", () => {
    const resolved = resolveParagraph("a b  c", "ltr");
    const opportunities = findBreakOpportunities(resolved);
    expect(opportunities).toEqual([
      { afterUnit: 1, dropBreakChar: true },
      { afterUnit: 4, dropBreakChar: true },
    ]);
  });

  it("offers kept breaks after ZWSP", () => {
    const resolved = resolveParagraph("a​b", "ltr");
    expect(findBreakOpportunities(resolved)).toEqual([{ afterUnit: 1, dropBreakChar: false }]);
  });
});

describe("per-line L1 trailing reset", () => {
  it("resets trailing whitespace to the paragraph level", () => {
    const adjusted = applyLineTrailingReset(Uint8Array.from([2, 2, 2, 2]), "ABC ", 0, 3, 1);
    expect([...adjusted]).toEqual([2, 2, 2, 1]);
  });

  it("stops at the first non-trailing character", () => {
    const adjusted = applyLineTrailingReset(Uint8Array.from([2, 2, 2]), "AB ", 0, 2, 0);
    expect([...adjusted]).toEqual([2, 2, 0]);
  });

  it("places a wrapped line's trailing space in the paragraph run", () => {
    const resolved = resolveParagraph("تست ABC ", "rtl");
    const runs = visualRunsForLine(resolved, 0, 8);
    const last = runs[runs.length - 1];
    expect(last?.logicalText.endsWith(" ")).toBe(true);
    expect(last?.level).toBe(1);
  });
});

describe("surrogate-pair-atomic reordering", () => {
  it("never splits an astral pair across a flip edge", () => {
    const logical = "تست 😀 تست";
    const resolved = resolveParagraph(logical, "rtl");
    const units = visualUnitsForLine(resolved, 0, logical.length - 1);
    // Every code point's units stay contiguous and in order in visual output.
    const seen = new Set<number>();
    for (const unit of units) {
      expect(seen.has(unit)).toBe(false);
      seen.add(unit);
    }
    expect(units.length).toBe(logical.length);
    const pairHigh = logical.indexOf("😀");
    const highAt = units.indexOf(pairHigh);
    const lowAt = units.indexOf(pairHigh + 1);
    expect(highAt).toBeGreaterThanOrEqual(0);
    expect(lowAt).toBe(highAt + 1);
  });

  it("keeps astral characters intact in the visual string", () => {
    const logical = "تست 😀 ABC";
    const resolved = resolveParagraph(logical, "rtl");
    const visual = visualStringForParagraph(resolved);
    expect([...visual].length).toBe([...logical].length);
    expect(visual).toContain("😀");
  });
});

describe("shaping clusters", () => {
  it("attaches combining marks to their base cluster", () => {
    expect(splitClusters("a\u0301b")).toEqual(["a\u0301", "b"]);
  });

  it("keeps surrogate pairs whole", () => {
    expect(splitClusters("a😀b")).toEqual(["a", "😀", "b"]);
  });

  it("reverses at cluster granularity (involution)", () => {
    const text = "a\u0301b😀ج";
    const once = reverseClusterString(text);
    expect(once).toBe("ج😀ba\u0301");
    expect(reverseClusterString(once)).toBe(text);
  });
});
