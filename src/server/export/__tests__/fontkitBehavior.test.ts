import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { loadKitFont } from "../persianText";
import { embedExportFonts, pickFont } from "../persianText";
import { parsePdfText } from "../pdfInspect";

/**
 * Pins the RAW fontkit/pdf-lib behavior that the export pipeline compensates
 * for. These tests render WITHOUT the UBA stage (plain `drawText`) and assert
 * on real parsed PDFs — they document exactly why passing logical text
 * straight to pdf-lib produces broken Persian, and they fail if a fontkit
 * upgrade ever changes the underlying behavior the pipeline relies on.
 */
describe("raw fontkit script detection (no UBA)", () => {
  const kit = loadKitFont("regular");

  it("detects one script per string from the first strong character", () => {
    // A Persian-led mixed line is detected rtl: fontkit will reverse the
    // WHOLE glyph array, including the Latin tail.
    expect(kit.layout("تست ABC").direction).toBe("rtl");
    // A Latin-led line is detected ltr: nothing reverses AND the Arabic
    // shaper never runs (Persian comes out disconnected — see below).
    expect(kit.layout("ABC ۱۲۳").direction).toBe("ltr");
  });

  it("detects Persian digits as an RTL script (the digit-reversal trap)", () => {
    expect(kit.layout("۱۲۳").direction).toBe("rtl");
    expect(kit.layout("۱۷۱,۰۰۰").direction).toBe("rtl");
  });

  it("applies no mirror substitution (Vazirmatn has no rtlm feature)", () => {
    const parenGid = kit.glyphForCodePoint(0x28).id;
    const inRtl = kit.layout("(ت)").glyphs.find((glyph) => glyph.codePoints.includes(0x28));
    const inLtr = kit.layout("(a)").glyphs.find((glyph) => glyph.codePoints.includes(0x28));
    // Same gid in both directions, straight from the cmap: no contextual
    // substitution happened, so the pipeline must mirror brackets itself.
    expect(inRtl?.id).toBe(parenGid);
    expect(inLtr?.id).toBe(parenGid);
  });

  it("maps astral characters to .notdef (gid 0)", () => {
    expect(kit.layout("😀").glyphs.map((glyph) => glyph.id)).toEqual([0]);
  });
});

describe("raw pdf-lib rendering without the pipeline (the bug, pinned)", () => {
  it("reverses Persian digits end to end in a real PDF", async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedExportFonts(doc);
    const page = doc.addPage([600, 200]);
    const logical = "مبلغ کل: ۱۷۱,۰۰۰ تومان";
    page.drawText(logical, { x: 40, y: 100, size: 24, font: pickFont(fonts, "regular").pdf });
    const parsed = parsePdfText(await doc.save());
    const chars = (parsed.pages[0]?.glyphs ?? []).map((glyph) => glyph.chars).join("");
    // fontkit reversed the whole line (direction rtl): the digit run reads
    // backwards. THIS is the broken output the pipeline exists to fix.
    expect(chars).toBe("ناموت ۰۰۰,۱۷۱ :لک غلبم");
    expect(chars).toBe(logical.split("").reverse().join(""));
  });

  it("mirrors Latin tails of Persian-led lines in a real PDF", async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedExportFonts(doc);
    const page = doc.addPage([600, 200]);
    page.drawText("تست ABC", { x: 40, y: 100, size: 24, font: pickFont(fonts, "regular").pdf });
    const parsed = parsePdfText(await doc.save());
    const chars = (parsed.pages[0]?.glyphs ?? []).map((glyph) => glyph.chars).join("");
    // Correct UBA output would be "ABC تست"; raw rendering gives "CBA تست".
    expect(chars).toBe("CBA تست");
  });

  it("leaves Persian unshaped (isolated forms) in Latin-led lines", () => {
    const kit = loadKitFont("regular");
    // Whole-string script detection picks latn: the Arabic GSUB lookups never
    // run, so تست keeps its plain cmap (isolated) glyph ids …
    const raw = kit.layout("ABC تست").glyphs;
    expect(raw.map((glyph) => glyph.id)).toEqual([
      kit.glyphForCodePoint(0x41).id,
      kit.glyphForCodePoint(0x42).id,
      kit.glyphForCodePoint(0x43).id,
      kit.glyphForCodePoint(0x20).id,
      kit.glyphForCodePoint(0x62a).id,
      kit.glyphForCodePoint(0x633).id,
      kit.glyphForCodePoint(0x62a).id,
    ]);
    // … while the same letters shaped as their own run (as the pipeline's
    // per-run layout does) take joined initial/medial/final forms.
    const shaped = kit.layout("تست").glyphs.map((glyph) => glyph.id);
    expect(new Set(shaped).size).toBe(3);
    expect(shaped).not.toContain(kit.glyphForCodePoint(0x62a).id);
  });
});
