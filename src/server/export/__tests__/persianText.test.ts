import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { resolveParagraph, sanitizeForBidi, visualRunsForParagraph } from "../bidi";
import {
  embedExportFonts,
  hexToRgb,
  layoutTextBlock,
  measureTextBlock,
  pickFont,
  prepareRun,
  probeFontkitDirection,
  stripUnshapableFormatChars,
  wrapParagraph,
  type ExportFont,
  type ExportFontSet,
} from "../persianText";

let fonts: ExportFontSet;
let regular: ExportFont;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  fonts = await embedExportFonts(doc);
  regular = pickFont(fonts, "regular");
});

describe("stripUnshapableFormatChars", () => {
  it("removes ALM, isolates, embeddings, and soft hyphen", () => {
    expect(stripUnshapableFormatChars("a\u061Cb\u2066c\u2069d\u202Ae\u202Cf\u202Eg\u00ADh")).toBe("abcdefgh");
  });

  it("keeps joining and zero-width controls the shaper needs", () => {
    // ZWNJ, ZWJ, LRM, RLM, ZWSP, BOM, NBSP, Arabic separators: all kept.
    const keep = "\u200C\u200D\u200E\u200F\u200B\uFEFF\u00A0\u066B\u066C";
    expect(stripUnshapableFormatChars(keep)).toBe(keep);
  });
});

describe("probeFontkitDirection", () => {
  it("observes rtl for Persian letters and Persian digits", () => {
    expect(probeFontkitDirection(fonts.kitRegular, "استودیو")).toBe("rtl");
    expect(probeFontkitDirection(fonts.kitRegular, "۱۲۳")).toBe("rtl");
    expect(probeFontkitDirection(fonts.kitRegular, "۱۷۱,۰۰۰")).toBe("rtl");
  });

  it("observes ltr for Latin, neutrals, and empty text", () => {
    expect(probeFontkitDirection(fonts.kitRegular, "ABC")).toBe("ltr");
    expect(probeFontkitDirection(fonts.kitRegular, ":")).toBe("ltr");
    expect(probeFontkitDirection(fonts.kitRegular, " ")).toBe("ltr");
    expect(probeFontkitDirection(fonts.kitRegular, "")).toBe("ltr");
  });

  it("pins the differing script detection of percent sign vs Arabic comma", () => {
    // U+066A ARABIC PERCENT SIGN carries Arabic script (rtl); U+060C ARABIC
    // COMMA is Common (ltr). The pipeline compensates per run, so either
    // behavior is safe — but a fontkit upgrade flipping one of these must
    // fail loudly here rather than silently reordering invoices.
    expect(probeFontkitDirection(fonts.kitRegular, "٪")).toBe("rtl");
    expect(probeFontkitDirection(fonts.kitRegular, "،")).toBe("ltr");
  });
});

describe("prepareRun counter-reversal decisions", () => {
  const decisionsFor = (logical: string): Array<{ text: string; rtl: boolean; counterReversed: boolean }> => {
    const runs = visualRunsForParagraph(resolveParagraph(sanitizeForBidi(logical), "rtl"));
    return runs.flatMap((run) => {
      const prepared = prepareRun(run, fonts.kitRegular);
      return prepared ? [{ text: run.logicalText, rtl: run.rtl, counterReversed: prepared.counterReversed }] : [];
    });
  };

  it("passes RTL-letter runs through untouched", () => {
    const decisions = decisionsFor("استودیو نمارو");
    expect(decisions).toEqual([{ text: "استودیو نمارو", rtl: true, counterReversed: false }]);
  });

  it("counter-reverses even-level Persian-digit runs (fontkit would reverse them)", () => {
    const decisions = decisionsFor("مبلغ کل: ۱۷۱,۰۰۰ تومان");
    const digits = decisions.find((entry) => entry.text === "۱۷۱,۰۰۰");
    expect(digits).toEqual({ text: "۱۷۱,۰۰۰", rtl: false, counterReversed: true });
    expect(decisions.filter((entry) => entry.text !== "۱۷۱,۰۰۰").every((entry) => !entry.counterReversed)).toBe(true);
  });

  it("passes even-level Latin runs through (fontkit agrees)", () => {
    const decisions = decisionsFor("تست ABC 123");
    const latin = decisions.find((entry) => entry.text === "ABC 123");
    expect(latin).toEqual({ text: "ABC 123", rtl: false, counterReversed: false });
  });

  it("reverses odd-level neutral runs fontkit would leave alone", () => {
    // `:` sits at an odd level but carries no RTL script: fontkit says ltr,
    // the UBA says the run reads right-to-left, so the pipeline reverses.
    const prepared = prepareRun(
      { level: 1, rtl: true, logicalText: ":", logicalStart: 0, logicalEnd: 0 },
      fonts.kitRegular,
    );
    expect(prepared?.counterReversed).toBe(true);
    expect(prepared?.drawText).toBe(":");
  });

  it("drops runs that strip to empty", () => {
    const prepared = prepareRun(
      { level: 1, rtl: true, logicalText: "\u061C", logicalStart: 0, logicalEnd: 0 },
      fonts.kitRegular,
    );
    expect(prepared).toBeNull();
  });
});

describe("wrapParagraph", () => {
  it("yields one empty line for empty or spaces-only paragraphs", () => {
    for (const text of ["", "   "]) {
      const lines = wrapParagraph(text, { font: regular, size: 12, maxWidth: 200 });
      expect(lines.length).toBe(1);
      expect(lines[0]?.runs).toEqual([]);
      expect(lines[0]?.width).toBe(0);
    }
  });

  it("keeps a fitting line whole and wraps narrow text word by word", () => {
    const wide = wrapParagraph("فروش کالا و خدمات", { font: regular, size: 12, maxWidth: 500 });
    expect(wide.length).toBe(1);
    const narrow = wrapParagraph("فروش کالا و خدمات", { font: regular, size: 12, maxWidth: 60 });
    expect(narrow.length).toBeGreaterThan(1);
    // Content preserved: the logical ranges cover every non-space unit.
    const source = "فروش کالا و خدمات";
    const covered = narrow
      .map((line) => source.slice(line.logicalStart, line.logicalEnd))
      .join(" ")
      .replace(/ +/g, " ");
    expect(covered).toBe(source);
  });

  it("hard-breaks an overlong word with guaranteed progress", () => {
    const word = "ت".repeat(40);
    const lines = wrapParagraph(word, { font: regular, size: 12, maxWidth: 30 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((line) => word.slice(line.logicalStart, line.logicalEnd)).join("")).toBe(word);
    for (const line of lines) expect(line.width).toBeGreaterThan(0);
  });

  it("rejects non-positive widths", () => {
    expect(() => wrapParagraph("تست", { font: regular, size: 12, maxWidth: 0 })).toThrow("maxWidth > 0");
  });
});

describe("layoutTextBlock", () => {
  it("keeps blank paragraphs as blank lines", () => {
    const lines = layoutTextBlock("الف\n\nب", { font: regular, size: 12, xLeft: 0, xRight: 400 });
    expect(lines.length).toBe(3);
    expect(lines[1]?.runs).toEqual([]);
  });

  it("measures blocks as line count times line height", () => {
    const lines = layoutTextBlock("الف\nب", { font: regular, size: 12, xLeft: 0, xRight: 400 });
    expect(measureTextBlock(lines, 18)).toBe(2 * 18);
  });
});

describe("hexToRgb", () => {
  it("converts lowercase #rrggbb", () => {
    expect(hexToRgb("#ff0000")).toEqual({ red: 1, green: 0, blue: 0, type: "RGB" });
  });

  it("rejects anything else", () => {
    for (const bad of ["#FF0000", "ff0000", "#fff", "#gggggg", ""]) {
      expect(() => hexToRgb(bad)).toThrow("invalid hex color");
    }
  });
});
