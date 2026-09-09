import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import type { Font as KitFont } from "@pdf-lib/fontkit";
import { RTL_CASES } from "./rtlStrings";
import {
  drawPreparedLine,
  embedExportFonts,
  layoutTextBlock,
  pickFont,
  wrapParagraph,
  type ExportFont,
  type ExportFontSet,
} from "../persianText";
import {
  expectedVisualForTestLine,
  parsePdfText,
  type ParsedPage,
} from "../pdfInspect";

/**
 * THE regression suite for Export V1 RTL: every acceptance string is rendered
 * through the REAL pipeline (`layoutTextBlock` → pdf-lib `drawText` → saved
 * PDF bytes) and the assertions run against the PARSED PDF — glyph codes in
 * show operations, `/W` advances, `/ToUnicode` text — never against
 * intermediate shaping strings.
 *
 * Per string the suite proves, from the artifact:
 *   (a) glyph text reads exactly the hand-derived UBA visual string;
 *   (b) the glyph COUNT matches the shaped layout (joining/ligature forms);
 *   (c) glyphs advance strictly left to right with the shaped advances;
 *   (d) every glyph sits on the drawn baseline inside the content box.
 */

const SIZE = 24;
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 40;
const BASELINE = 400;

let fonts: ExportFontSet;
let regular: ExportFont;
let bold: ExportFont;
let kit: KitFont;
let pages: ParsedPage[];

function pageChars(page: ParsedPage): string {
  return page.glyphs.map((glyph) => glyph.chars).join("");
}

beforeAll(async () => {
  const doc = await PDFDocument.create();
  fonts = await embedExportFonts(doc);
  regular = pickFont(fonts, "regular");
  bold = pickFont(fonts, "bold");
  kit = fonts.kitRegular;

  for (const testCase of RTL_CASES) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const lines = layoutTextBlock(testCase.logical, {
      font: regular,
      size: SIZE,
      xLeft: MARGIN,
      xRight: PAGE_WIDTH - MARGIN,
    });
    expect(lines.length).toBe(1);
    const line = lines[0];
    if (!line) throw new Error(`no line for ${testCase.id}`);
    drawPreparedLine(page, line, regular, PAGE_WIDTH - MARGIN - line.width, BASELINE, rgb(0, 0, 0));
  }

  // Bold page: the same shaping decisions must hold for the bold weight.
  {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const lines = layoutTextBlock(RTL_CASES[0]?.logical ?? "", {
      font: bold,
      size: SIZE,
      xLeft: MARGIN,
      xRight: PAGE_WIDTH - MARGIN,
    });
    const line = lines[0];
    if (!line) throw new Error("no bold line");
    drawPreparedLine(page, line, bold, PAGE_WIDTH - MARGIN - line.width, BASELINE, rgb(0, 0, 0));
  }

  const parsed = parsePdfText(await doc.save());
  pages = parsed.pages;
  expect(pages.length).toBe(RTL_CASES.length + 1);
});

describe("glyph order in real PDFs (one page per acceptance string)", () => {
  RTL_CASES.forEach((testCase, index) => {
    const pageOf = (): ParsedPage => {
      const page = pages[index];
      if (!page) throw new Error(`missing page for ${testCase.id}`);
      return page;
    };

    it(`${testCase.id}: glyph text reads exactly the expected visual text`, () => {
      // Ligature-aware: `pdfJoinedText` (subtitle's lam-alef) where the
      // fused glyph's logical-order /ToUnicode differs from the UBA visual
      // string; the character-level `visual` everywhere else.
      expect(pageChars(pageOf())).toBe(testCase.pdfJoinedText ?? testCase.visual);
    });

    it(`${testCase.id}: per-glyph chars match the shaped layout exactly`, () => {
      // Glyph-level proof (stronger than the joined string): every glyph in
      // visual order carries exactly the code points the shaped layout
      // produced — order AND letter forms (ligatures fuse the same way).
      const expected = expectedVisualForTestLine(testCase.logical, kit);
      expect(pageOf().glyphs.map((glyph) => glyph.chars)).toEqual(
        expected.glyphs.map((glyph) => glyph.chars),
      );
    });

    it(`${testCase.id}: glyph count matches the shaped layout`, () => {
      const expected = expectedVisualForTestLine(testCase.logical, kit);
      expect(pageOf().glyphs.length).toBe(expected.glyphs.length);
    });

    it(`${testCase.id}: glyphs advance strictly left to right on the baseline`, () => {
      const glyphs = pageOf().glyphs;
      expect(glyphs.length).toBeGreaterThan(0);
      for (let i = 1; i < glyphs.length; i += 1) {
        const prev = glyphs[i - 1];
        const current = glyphs[i];
        if (!prev || !current) continue;
        expect(current.x).toBeGreaterThan(prev.x);
      }
      for (const glyph of glyphs) {
        expect(Math.abs(glyph.y - BASELINE)).toBeLessThan(0.01);
        expect(glyph.x).toBeGreaterThanOrEqual(MARGIN - 0.01);
        expect(glyph.x).toBeLessThanOrEqual(PAGE_WIDTH - MARGIN + 0.01);
        expect(glyph.size).toBe(SIZE);
      }
    });

    it(`${testCase.id}: pen steps match the shaped advances`, () => {
      const glyphs = pageOf().glyphs;
      const expected = expectedVisualForTestLine(testCase.logical, kit);
      const unitsPerEm = kit.unitsPerEm || 1000;
      expect(glyphs.length).toBe(expected.glyphs.length);
      for (let i = 0; i + 1 < glyphs.length; i += 1) {
        const current = glyphs[i];
        const next = glyphs[i + 1];
        const expectedGlyph = expected.glyphs[i];
        if (!current || !next || !expectedGlyph) continue;
        const want = (expectedGlyph.advanceWidth / unitsPerEm) * SIZE;
        expect(Math.abs(next.x - current.x - want)).toBeLessThan(0.75);
      }
    });

    it(`${testCase.id}: every glyph uses the embedded subset font`, () => {
      for (const glyph of pageOf().glyphs) {
        expect(glyph.baseFont).toContain("Vazirmatn");
        expect(glyph.chars.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("GPOS positioning gap (pdf-lib limitation, pinned)", () => {
  it("places glyphs by hmtx advances, ignoring GPOS adjustments", () => {
    // The seen of فاکتور رسمی kerns -160 units in layout (xAdvance 1455 vs
    // hmtx advanceWidth 1615 at upm 2048): the PDF pen step follows the hmtx
    // width (pdf-lib records it in /W and has no GPOS positioning), so the
    // rendered gap is ~1.9pt looser than the ideal layout. Order, joining,
    // and forms are unaffected; only inter-glyph spacing in kerned pairs.
    const glyphs = pages[1]?.glyphs ?? [];
    const seenAt = glyphs.findIndex((glyph) => glyph.chars === "س");
    expect(seenAt).toBeGreaterThanOrEqual(0);
    const seen = glyphs[seenAt];
    const next = glyphs[seenAt + 1];
    if (!seen || !next) throw new Error("seen step missing");
    const step = next.x - seen.x;
    expect(Math.abs(step - (1615 / 2048) * SIZE)).toBeLessThan(0.05);
    expect(Math.abs(step - (1455 / 2048) * SIZE)).toBeGreaterThan(1);
  });
});

describe("bold weight", () => {
  it("renders the same visual string through a different subset font", () => {
    const page = pages[RTL_CASES.length];
    if (!page) throw new Error("missing bold page");
    expect(pageChars(page)).toBe(RTL_CASES[0]?.visual ?? "");
    const regularBase = new Set((pages[0]?.glyphs ?? []).map((glyph) => glyph.baseFont));
    const boldBase = new Set(page.glyphs.map((glyph) => glyph.baseFont));
    expect(regularBase.size).toBe(1);
    expect(boldBase.size).toBe(1);
    expect([...regularBase][0]).not.toBe([...boldBase][0]);
  });
});

describe("lam-alef ligature (bonus, beyond the ten strings)", () => {
  it("fuses through ToUnicode multi-char entries with correct order", async () => {
    const doc = await PDFDocument.create();
    const localFonts = await embedExportFonts(doc);
    const localRegular = pickFont(localFonts, "regular");
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const lines = layoutTextBlock("سلام", {
      font: localRegular,
      size: SIZE,
      xLeft: MARGIN,
      xRight: PAGE_WIDTH - MARGIN,
    });
    const line = lines[0];
    if (!line) throw new Error("no salam line");
    drawPreparedLine(page, line, localRegular, PAGE_WIDTH - MARGIN - line.width, BASELINE, rgb(0, 0, 0));
    const parsed = parsePdfText(await doc.save());
    const glyphs = parsed.pages[0]?.glyphs ?? [];
    // Four characters shape to three glyphs (س + لا-ligature + م) …
    expect(glyphs.length).toBe(3);
    // … the ligature carries both code points through /ToUnicode …
    expect(glyphs.map((glyph) => glyph.chars)).toEqual(["م", "لا", "س"]);
    // … and the joined text still reads the exact visual string.
    expect(glyphs.map((glyph) => glyph.chars).join("")).toBe("ملاس");
  });
});

describe("wrapped paragraph (multi-line real PDF)", () => {
  it("keeps every wrapped line's glyphs on its own baseline, in order", async () => {
    const logical = "فروش کالا و خدمات برای مشتری گرامی با احترام تقدیم می‌شود";
    const doc = await PDFDocument.create();
    const localFonts = await embedExportFonts(doc);
    const localRegular = pickFont(localFonts, "regular");
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const lines = wrapParagraph(logical, { font: localRegular, size: 20, maxWidth: 260 });
    expect(lines.length).toBeGreaterThan(1);
    const black = rgb(0, 0, 0);
    let baseline = 700;
    for (const line of lines) {
      drawPreparedLine(page, line, localRegular, PAGE_WIDTH - MARGIN - line.width, baseline, black);
      baseline -= 30;
    }
    const parsed = parsePdfText(await doc.save());
    const glyphs = parsed.pages[0]?.glyphs ?? [];
    // Group parsed glyphs by baseline (rounded): one group per wrapped line.
    const groups = new Map<number, typeof glyphs>();
    for (const glyph of glyphs) {
      const key = Math.round(glyph.y);
      const group = groups.get(key) ?? [];
      group.push(glyph);
      groups.set(key, group);
    }
    expect(groups.size).toBe(lines.length);
    const sortedKeys = [...groups.keys()].sort((a, b) => b - a);
    lines.forEach((line, lineIndex) => {
      const group = groups.get(sortedKeys[lineIndex] ?? -1) ?? [];
      // Expected chars: the pipeline's own drawText through the same
      // fontkit.layout call pdf-lib makes — no oracle, just the artifact law.
      let want = "";
      for (const run of line.runs) {
        for (const shaped of localFonts.kitRegular.layout(run.drawText).glyphs) {
          want += String.fromCodePoint(...shaped.codePoints);
        }
      }
      expect(group.map((glyph) => glyph.chars).join("")).toBe(want);
      expect(group.length).toBeGreaterThan(0);
    });
  });
});
