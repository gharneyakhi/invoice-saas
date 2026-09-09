import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parsePdfText } from "../pdfInspect";

/**
 * Self-tests for the inspection tooling itself, against pdf-lib output whose
 * bytes were verified by hand: `drawRectangle` emits a `cm`-positioned
 * `m/l/h/f` path (NOT `re`), `drawLine` emits `m/l/S`, blocks wrap in `q/Q`.
 */
describe("parsePdfText", () => {
  it("recovers fills, strokes, and text with CTM-transformed positions", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawRectangle({ x: 10, y: 10, width: 50, height: 20, color: rgb(0.1, 0.2, 0.3) });
    page.drawLine({ start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, thickness: 0.75, color: rgb(0.5, 0.5, 0.5) });
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Hi", { x: 5, y: 150, size: 12, font: helvetica });
    const parsed = parsePdfText(await doc.save());

    expect(parsed.pages.length).toBe(1);
    const only = parsed.pages[0];
    if (!only) throw new Error("missing page");
    expect(only.width).toBe(200);
    expect(only.height).toBe(200);

    expect(only.fills.length).toBe(1);
    const fill = only.fills[0];
    if (!fill) throw new Error("missing fill");
    expect(fill.closed).toBe(true);
    expect(fill.r).toBeCloseTo(0.1, 4);
    expect(fill.g).toBeCloseTo(0.2, 4);
    expect(fill.b).toBeCloseTo(0.3, 4);
    expect(fill.points).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 30 },
      { x: 60, y: 30 },
      { x: 60, y: 10 },
    ]);

    expect(only.strokes.length).toBe(1);
    const stroke = only.strokes[0];
    if (!stroke) throw new Error("missing stroke");
    expect(stroke.width).toBe(0.75);
    expect(stroke.r).toBeCloseTo(0.5, 4);
    expect(stroke.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);

    expect(only.glyphs.map((glyph) => glyph.chars).join("")).toBe("Hi");
    expect(only.glyphs[0]?.x).toBe(5);
    expect(only.glyphs[0]?.y).toBe(150);
    expect(only.glyphs[0]?.size).toBe(12);
  });

  it("attributes glyphs to the correct page across pages", async () => {
    const doc = await PDFDocument.create();
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const first = doc.addPage([200, 200]);
    first.drawText("one", { x: 5, y: 150, size: 12, font: helvetica });
    const second = doc.addPage([200, 200]);
    second.drawText("two", { x: 5, y: 150, size: 12, font: helvetica });
    const parsed = parsePdfText(await doc.save());
    expect(parsed.pages.length).toBe(2);
    expect((parsed.pages[0]?.glyphs ?? []).map((glyph) => glyph.chars).join("")).toBe("one");
    expect((parsed.pages[1]?.glyphs ?? []).map((glyph) => glyph.chars).join("")).toBe("two");
  });

  it("returns no pages for bytes without page objects", () => {
    expect(parsePdfText(new Uint8Array([1, 2, 3])).pages).toEqual([]);
  });
});
