/**
 * Visual verification for Export V1 PDF RTL.
 *
 * Renders REAL pdf-lib PDFs (the ten acceptance strings, a bold page, the
 * lam-alef bonus, and full invoices from fabricated models), then re-renders
 * every page as SVG with REAL font outlines at the PDF's own positions, and
 * converts the SVGs to PNGs. Every SVG glyph is cross-checked against the
 * parsed PDF (glyph text 1:1, pen positions within tolerance) before it is
 * drawn, so what you see is what the PDF contains — any mismatch aborts with
 * a loud error instead of producing a misleading picture.
 *
 * Output: `pdf-verify-output/` (gitignored): `*.pdf`, `*.svg`, `*.png`.
 *
 * Run:
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=y npx vite-node --config scripts/vite.verify.config.ts scripts/pdf-rtl-verify.ts
 * (The dummy OAuth env lets the real auth-options module load; no session or
 * database is touched — prisma resolves to a throwing stub.)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Font as KitFont } from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import { RTL_CASES } from "../src/server/export/__tests__/rtlStrings";
import { finalizedModel, lineItem } from "../src/server/export/__tests__/fixtures";
import {
  drawPreparedLine,
  embedExportFonts,
  layoutTextBlock,
  loadKitFont,
  pickFont,
  type DrawnRun,
} from "../src/server/export/persianText";
import {
  expectedVisualForTestLine,
  parsePdfText,
  renderSvgPage,
  rgbToHex,
  type ParsedPage,
  type SvgGlyphInput,
} from "../src/server/export/pdfInspect";
import { renderInvoicePdf } from "../src/server/export/pdfService";

const OUT_DIR = path.join(process.cwd(), "pdf-verify-output");
const SIZE = 24;
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const BASELINE = 400;
const POSITION_TOLERANCE_PT = 0.75;

let failures = 0;

function fail(message: string): void {
  failures += 1;
  console.error(`  FAIL ${message}`);
}

function toPng(svgPath: string, pngPath: string): boolean {
  try {
    execFileSync("convert", ["-density", "150", svgPath, pngPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Aligns parsed glyphs with the shaped layout; throws on any mismatch. */
function svgInputsForTestPage(page: ParsedPage, logical: string, kit: KitFont, label: string): SvgGlyphInput[] {
  const expected = expectedVisualForTestLine(logical, kit);
  if (expected.glyphs.length !== page.glyphs.length) {
    fail(`${label}: glyph count parsed=${page.glyphs.length} expected=${expected.glyphs.length}`);
    throw new Error("aborted");
  }
  let maxDx = 0;
  const inputs = page.glyphs.map((glyph, index): SvgGlyphInput => {
    const want = expected.glyphs[index];
    if (!want || glyph.chars !== want.chars) {
      fail(`${label}: glyph ${index} chars parsed=${JSON.stringify(glyph.chars)} expected=${JSON.stringify(want?.chars)}`);
      throw new Error("aborted");
    }
    return { x: glyph.x, y: glyph.y, size: glyph.size, gid: want.gid };
  });
  const upm = kit.unitsPerEm || 1000;
  for (let i = 0; i + 1 < page.glyphs.length; i += 1) {
    const current = page.glyphs[i];
    const next = page.glyphs[i + 1];
    const want = expected.glyphs[i];
    if (!current || !next || !want) continue;
    maxDx = Math.max(maxDx, Math.abs(next.x - current.x - (want.advanceWidth / upm) * SIZE));
  }
  const joined = page.glyphs.map((glyph) => glyph.chars).join("");
  console.log(`  ok ${label}: ${inputs.length} glyphs, max pen-step deviation ${maxDx.toFixed(3)}pt`);
  console.log(`     parsed visual text: ${joined}`);
  if (maxDx > POSITION_TOLERANCE_PT) fail(`${label}: pen-step deviation ${maxDx.toFixed(3)}pt`);
  return inputs;
}

async function renderStringPages(): Promise<void> {
  console.log("acceptance strings → rtl-strings.pdf + per-page SVG/PNG");
  const doc = await PDFDocument.create();
  const fonts = await embedExportFonts(doc);
  const regular = pickFont(fonts, "regular");
  const bold = pickFont(fonts, "bold");
  const black = rgb(0, 0, 0);
  const linePages: Array<{ logical: string; name: string; weight: "regular" | "bold" }> = [
    ...RTL_CASES.map((testCase) => ({ logical: testCase.logical, name: testCase.id, weight: "regular" as const })),
    { logical: RTL_CASES[0]?.logical ?? "", name: "studio-bold", weight: "bold" as const },
    { logical: "سلام", name: "salam-ligature", weight: "regular" as const },
  ];
  for (const entry of linePages) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const font = entry.weight === "bold" ? bold : regular;
    const lines = layoutTextBlock(entry.logical, { font, size: SIZE, xLeft: MARGIN, xRight: PAGE_W - MARGIN });
    const line = lines[0];
    if (!line || lines.length !== 1) throw new Error(`unexpected layout for ${entry.name}`);
    drawPreparedLine(page, line, font, PAGE_W - MARGIN - line.width, BASELINE, black);
  }
  const bytes = await doc.save();
  writeFileSync(path.join(OUT_DIR, "rtl-strings.pdf"), bytes);
  const parsed = parsePdfText(bytes);
  const kit = loadKitFont("regular");
  const kitBold = loadKitFont("bold");
  linePages.forEach((entry, index) => {
    const page = parsed.pages[index];
    if (!page) throw new Error(`missing parsed page ${index}`);
    const inputs = svgInputsForTestPage(page, entry.logical, entry.weight === "bold" ? kitBold : kit, entry.name);
    const groupKit = entry.weight === "bold" ? kitBold : kit;
    const svg = renderSvgPage(page, [{ kit: groupKit, glyphs: inputs }]);
    const svgPath = path.join(OUT_DIR, `rtl-${entry.name}.svg`);
    writeFileSync(svgPath, svg);
    if (!toPng(svgPath, path.join(OUT_DIR, `rtl-${entry.name}.png`))) {
      console.log("  (convert unavailable — SVG only)");
    }
  });
}

async function renderInvoice(name: string, itemCount: number): Promise<void> {
  console.log(`${name} (${itemCount} items) → ${name}.pdf + per-page SVG/PNG`);
  const items = Array.from({ length: itemCount }, (_, index) =>
    lineItem({ id: `item-${index}`, title: `قلم شماره ${index + 1}` }),
  );
  const model = itemCount === 1 ? finalizedModel() : finalizedModel({ items });
  const recorded: DrawnRun[] = [];
  const bytes = await renderInvoicePdf(model, { recorder: { record: (run) => recorded.push(run) } });
  writeFileSync(path.join(OUT_DIR, `${name}.pdf`), bytes);
  const parsed = parsePdfText(bytes);

  // Group recorded runs by page identity (first-seen order == page order;
  // page numbers are drawn last but resolve to their own page object).
  const seenPages: unknown[] = [];
  const pageIndexOf = (page: unknown): number => {
    let index = seenPages.indexOf(page);
    if (index < 0) {
      index = seenPages.length;
      seenPages.push(page);
    }
    return index;
  };
  const perPage: Array<{ glyphs: Array<SvgGlyphInput & { kit: KitFont; fill: string }>; chars: string[] }> =
    parsed.pages.map(() => ({ glyphs: [], chars: [] }));
  for (const run of recorded) {
    const index = pageIndexOf(run.page);
    const slot = perPage[index];
    if (!slot) throw new Error(`recorded run on unknown page index ${index}`);
    const upm = run.kit.unitsPerEm || 1000;
    let penX = run.x;
    const fill = rgbToHex(run.color.red, run.color.green, run.color.blue);
    for (const glyph of run.kit.layout(run.drawText).glyphs) {
      const chars = String.fromCodePoint(...glyph.codePoints);
      slot.glyphs.push({ x: penX, y: run.baselineY, size: run.size, gid: glyph.id, kit: run.kit, fill });
      slot.chars.push(chars);
      penX += (glyph.advanceWidth / upm) * run.size;
    }
  }

  parsed.pages.forEach((page, index) => {
    const slot = perPage[index];
    if (!slot) throw new Error(`missing recorded slot for page ${index}`);
    const label = `${name} p${index + 1}`;
    if (slot.chars.length !== page.glyphs.length) {
      fail(`${label}: recorded=${slot.chars.length} parsed=${page.glyphs.length}`);
      throw new Error("aborted");
    }
    let maxDx = 0;
    let maxDy = 0;
    const inputs = page.glyphs.map((glyph, glyphIndex) => {
      const wantChars = slot.chars[glyphIndex];
      const wantGlyph = slot.glyphs[glyphIndex];
      if (glyph.chars !== wantChars || !wantGlyph) {
        fail(`${label}: glyph ${glyphIndex} parsed=${JSON.stringify(glyph.chars)} recorded=${JSON.stringify(wantChars)}`);
        throw new Error("aborted");
      }
      maxDx = Math.max(maxDx, Math.abs(glyph.x - wantGlyph.x));
      maxDy = Math.max(maxDy, Math.abs(glyph.y - wantGlyph.y));
      return { x: glyph.x, y: glyph.y, size: glyph.size, gid: wantGlyph.gid, kit: wantGlyph.kit, fill: wantGlyph.fill };
    });
    console.log(`  ok ${label}: ${inputs.length} glyphs, max |dx| ${maxDx.toFixed(3)}pt max |dy| ${maxDy.toFixed(3)}pt`);
    if (maxDx > POSITION_TOLERANCE_PT || maxDy > 0.01) fail(`${label}: position deviation`);
    const groups = new Map<KitFont, Map<string, SvgGlyphInput[]>>();
    for (const glyph of inputs) {
      let byFill = groups.get(glyph.kit);
      if (!byFill) {
        byFill = new Map();
        groups.set(glyph.kit, byFill);
      }
      const group = byFill.get(glyph.fill) ?? [];
      group.push(glyph);
      byFill.set(glyph.fill, group);
    }
    const svg = renderSvgPage(
      page,
      [...groups.entries()].flatMap(([kit, byFill]) =>
        [...byFill.entries()].map(([fill, glyphs]) => ({ kit, glyphs, fill })),
      ),
    );
    const svgPath = path.join(OUT_DIR, `${name}-p${index + 1}.svg`);
    writeFileSync(svgPath, svg);
    if (!toPng(svgPath, path.join(OUT_DIR, `${name}-p${index + 1}.png`))) {
      console.log("  (convert unavailable — SVG only)");
    }
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await renderStringPages();
  await renderInvoice("invoice", 1);
  await renderInvoice("invoice-long", 60);
  if (failures > 0) {
    console.error(`\n${failures} VERIFICATION FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nall pages verified: parsed PDF glyphs match the shaped layouts 1:1");
}

await main();
