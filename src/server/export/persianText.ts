/**
 * Persian shaping + drawing stage of the PDF export pipeline.
 *
 * Pipeline position: `bidi.ts` (visual runs in logical order + levels) →
 * THIS MODULE (per-run shaping decisions + measurement + drawing) → pdf-lib.
 *
 * THE CORE PROBLEM THIS SOLVES
 * -----------------------------
 * pdf-lib renders custom-font text by calling `fontkit.layout(text)` once per
 * `drawText` and emitting the resulting glyph ids (`CustomFontEmbedder`
 * encodes `font.layout(text).glyphs`). fontkit shapes with the font's real
 * GSUB/GPOS tables (Persian joining works), but its "bidi" is NOT the Unicode
 * Bidirectional Algorithm: it detects ONE script for the WHOLE string (first
 * non-Common/Inherited/Unknown character) and, when that script is an RTL one,
 * reverses the ENTIRE glyph array (see `OTLayoutEngine.position`: "Reverse the
 * glyphs and positions if the script is right-to-left"). Consequences, all
 * proven by `fontkitBehavior.test.ts` on real PDFs:
 *
 *   - Pure Persian-letter lines (`استودیو نمارو`) render correctly raw.
 *   - Any line with Persian digits renders them BACKWARDS (`۱۷۱,۰۰۰` →
 *     `۰۰۰,۱۷۱`): digits are script=Arabic, so the whole line reverses.
 *   - Latin/digits inside an RTL-detected line reverse (`ABC` → `CBA`).
 *   - A line starting with Latin is detected `latn`/`ltr`: nothing reverses
 *     AND the Arabic shaper never runs, so Persian letters come out
 *     disconnected (isolated forms).
 *   - Brackets are never mirrored (Vazirmatn has no `rtlm` GSUB feature).
 *
 * THE CORRECTED PIPELINE (per line)
 * ----------------------------------
 *  1. UBA (`bidi.ts`): logical text → levels → maximal same-level runs in
 *     visual (left-to-right) order, each run carrying its logical-order text
 *     with L4 mirroring applied.
 *  2. Per run, decide what string pdf-lib must receive (`prepareRun`):
 *       - Strip format characters the font cannot render (U+061C ALM and the
 *         isolate/embedding controls are NOTDEF in Vazirmatn; U+00AD soft
 *         hyphen would render visibly). Stripped characters are zero-width and
 *         invisible, so runs keep their UBA-computed geometry.
 *       - Probe the REAL fontkit behavior for that exact string
 *         (`kitFont.layout(stripped).direction`, the same call pdf-lib makes
 *         internally) and compare with the UBA truth (odd level = must
 *         reverse). If they DISAGREE, pass the cluster-reversed string:
 *         for even-level (LTR) runs this *cancels* fontkit's wrong reversal;
 *         for odd-level pure-neutral runs (fontkit sees no RTL script) it
 *         *performs* the reversal fontkit would skip. RTL-letter runs pass
 *         through untouched: fontkit's reversal + GSUB shaping is exactly
 *         right for them.
 *     No presentation-form code points are used anywhere: joining comes from
 *     the font's GSUB (`isol`/`init`/`medi`/`fina`, lam-alef `rlig`) applied
 *     by fontkit to logical-order run text.
 *  3. Measure each prepared run with the embedded pdf-lib font
 *     (`widthOfTextAtSize`) and draw runs left to right at advancing x. Line
 *     width is the sum of run widths; RTL lines right-align by starting at
 *     `rightEdge - width`.
 *
 * Multi-line text wraps on the LOGICAL paragraph first (word breaks at spaces,
 * UBA levels computed once for the whole paragraph), then each wrapped line is
 * reordered independently with per-line L1 trailing handling (`bidi.ts`).
 *
 * Fonts: Vazirmatn Regular/Bold, vendored under `./fonts` (OFL, see
 * `./fonts/README.md`), embedded subset. Font files resolve via `process.cwd()`
 * with a `PDF_FONT_DIR` override for exotic deployments.
 */

import fs from "node:fs";
import path from "node:path";
import { PDFDocument, PDFFont, PDFPage, RGB, rgb } from "pdf-lib";
import fontkit, { type Font as KitFont } from "@pdf-lib/fontkit";
import {
  RTL_BASE_DIRECTION,
  findBreakOpportunities,
  resolveParagraph,
  reverseClusterString,
  sanitizeForBidi,
  splitClusters,
  splitParagraphs,
  visualRunsForLine,
  type BaseDirection,
  type ResolvedParagraph,
  type VisualRun,
} from "./bidi";

// ---------------------------------------------------------------------------
// Font loading + embedding
// ---------------------------------------------------------------------------

export type ExportFontWeight = "regular" | "bold";

const FONT_FILE_NAME: Record<ExportFontWeight, string> = {
  regular: "Vazirmatn-Regular.ttf",
  bold: "Vazirmatn-Bold.ttf",
};

/** Directories searched (in order) for the vendored TTF files. */
function fontSearchDirs(): string[] {
  const override = process.env.PDF_FONT_DIR;
  const dirs: string[] = [];
  if (override && override.trim() !== "") dirs.push(override);
  dirs.push(path.join(process.cwd(), "src", "server", "export", "fonts"));
  return dirs;
}

/** Raw bytes of a vendored font, or a descriptive throw listing tried paths. */
export function loadFontBytes(weight: ExportFontWeight): Buffer {
  const fileName = FONT_FILE_NAME[weight];
  const tried: string[] = [];
  for (const dir of fontSearchDirs()) {
    const candidate = path.join(dir, fileName);
    tried.push(candidate);
    try {
      const bytes = fs.readFileSync(candidate);
      if (bytes.length > 0) return bytes;
    } catch {
      // Try the next directory.
    }
  }
  throw new Error(
    `[pdf-export] missing font file "${fileName}" (weight "${weight}"). ` +
      `Tried: ${tried.join(", ")}. ` +
      `The file is vendored at src/server/export/fonts/ — see that directory's README.md.`,
  );
}

/** A fontkit font handle over the vendored bytes (for shaping probes). */
export function loadKitFont(weight: ExportFontWeight): KitFont {
  return fontkit.create(loadFontBytes(weight));
}

export interface ExportFontSet {
  regular: PDFFont;
  bold: PDFFont;
  kitRegular: KitFont;
  kitBold: KitFont;
}

/**
 * Registers fontkit on a fresh document and embeds both weights (subset).
 * The returned pdf-lib fonts render; the kit fonts answer shaping probes.
 */
export async function embedExportFonts(doc: PDFDocument): Promise<ExportFontSet> {
  doc.registerFontkit(fontkit);
  const regularBytes = loadFontBytes("regular");
  const boldBytes = loadFontBytes("bold");
  const [regular, bold] = await Promise.all([
    doc.embedFont(regularBytes, { subset: true }),
    doc.embedFont(boldBytes, { subset: true }),
  ]);
  return {
    regular,
    bold,
    kitRegular: fontkit.create(regularBytes),
    kitBold: fontkit.create(boldBytes),
  };
}

/** pdf-lib font + kit probe handle for one weight, resolved from a set. */
export interface ExportFont {
  pdf: PDFFont;
  kit: KitFont;
}

export function pickFont(fonts: ExportFontSet, weight: ExportFontWeight): ExportFont {
  return weight === "bold" ? { pdf: fonts.bold, kit: fonts.kitBold } : { pdf: fonts.regular, kit: fonts.kitRegular };
}

// ---------------------------------------------------------------------------
// Run preparation (the shaping decision)
// ---------------------------------------------------------------------------

/**
 * Format characters stripped from run text before shaping.
 *
 *   - U+061C ARABIC LETTER MARK, U+2066–U+2069 isolates, U+202A–U+202E
 *     embeddings/overrides: the UBA has already consumed their effect into the
 *     levels, and they are NOTDEF (.notdef box) in Vazirmatn.
 *   - U+00AD SOFT HYPHEN: Vazirmatn renders it visibly (it has an advance
 *     width), but mid-line it must be invisible; this pipeline breaks lines
 *     only at spaces/ZWSP/hard breaks, so SHY carries no break meaning here.
 *
 * NOT stripped (zero-width AND present in Vazirmatn): ZWNJ/ZWJ (joining
 * controls the shaper needs), LRM/RLM, ZWSP, BOM. Stripped characters are all
 * zero-width/invisible, so removal cannot change run geometry.
 */
const STRIPPED_FORMAT_CHAR_PATTERN = /[\u00AD\u061C\u202A-\u202E\u2066-\u2069]/g;
const STRIPPED_FORMAT_CHAR_CODES = new Set([0x61c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xad]);

/** Removes `STRIPPED_FORMAT_CHAR_*` from run text (see doc comment). */
export function stripUnshapableFormatChars(text: string): string {
  STRIPPED_FORMAT_CHAR_PATTERN.lastIndex = 0;
  const fast = text.replace(STRIPPED_FORMAT_CHAR_PATTERN, "");
  // The regex above is a fast path; verify by code point so no listed char
  // survives through an encoding slip (the pattern contains invisible chars).
  let verified = "";
  for (const char of fast) {
    const code = char.codePointAt(0) ?? 0;
    if (!STRIPPED_FORMAT_CHAR_CODES.has(code)) verified += char;
  }
  return verified;
}

/**
 * Observes fontkit's shaping direction for the EXACT string pdf-lib will
 * receive — the same `font.layout(text)` call `CustomFontEmbedder` makes
 * internally, including its first-strong-script detection and RTL-table
 * lookup. Returns `"rtl"` when fontkit will reverse the glyphs, `"ltr"` when
 * it will not. This is a runtime observation, not a reimplementation of
 * fontkit's script tables, so it stays correct across fontkit versions.
 */
export function probeFontkitDirection(kit: KitFont, text: string): "rtl" | "ltr" {
  if (text === "") return "ltr";
  const direction = kit.layout(text).direction;
  if (direction !== "rtl" && direction !== "ltr") {
    throw new Error(`[pdf-export] unexpected fontkit layout direction: ${String(direction)}`);
  }
  return direction;
}

export interface PreparedRun {
  /** Resolved embedding level (line-L1-adjusted). Odd = RTL, even = LTR. */
  level: number;
  /** True for odd (right-to-left) levels. */
  rtl: boolean;
  /**
   * Exact string to hand to pdf-lib (`drawText` / `widthOfTextAtSize`):
   * logical run text, L4-mirrored, stripped, and cluster-reversed when
   * fontkit's reversal decision disagrees with the UBA (see module docs).
   */
  drawText: string;
  /** True when the run text was cluster-reversed for fontkit. */
  counterReversed: boolean;
}

/**
 * Decides what string pdf-lib must receive for one UBA run.
 *
 * Rule: reverse (at cluster granularity) if and only if fontkit's reversal
 * decision for the stripped run text disagrees with the UBA level parity.
 * RTL-letter runs pass through (fontkit reverses + GSUB-shapes correctly);
 * even-level runs starting with Arabic-script characters (Persian digits,
 * ٪, ،) are counter-reversed to cancel fontkit's wrong reversal; odd-level
 * pure-neutral runs (no RTL script for fontkit to detect) are reversed to
 * perform the reversal fontkit would skip.
 */
export function prepareRun(run: VisualRun, kit: KitFont): PreparedRun | null {
  const stripped = stripUnshapableFormatChars(run.logicalText);
  if (stripped === "") return null;
  const fontkitDirection = probeFontkitDirection(kit, stripped);
  const fontkitReverses = fontkitDirection === "rtl";
  const mustReverse = run.rtl !== fontkitReverses;
  return {
    level: run.level,
    rtl: run.rtl,
    drawText: mustReverse ? reverseClusterString(stripped) : stripped,
    counterReversed: mustReverse,
  };
}

// ---------------------------------------------------------------------------
// Line layout + drawing
// ---------------------------------------------------------------------------

export interface PreparedLine {
  runs: PreparedRun[];
  /** Total advance width at the layout size (sum of run widths). */
  width: number;
  size: number;
}

/** Prepares + measures one visual line (runs already in visual order). */
export function layoutVisualLine(runs: VisualRun[], font: ExportFont, size: number): PreparedLine {
  const prepared: PreparedRun[] = [];
  let width = 0;
  for (const run of runs) {
    const item = prepareRun(run, font.kit);
    if (!item) continue;
    width += font.pdf.widthOfTextAtSize(item.drawText, size);
    prepared.push(item);
  }
  return { runs: prepared, width, size };
}

/** One run handed to pdf-lib, recorded for verification re-rendering. */
export interface DrawnRun {
  page: PDFPage;
  /** Run's left edge in PDF points (bottom-left origin). */
  x: number;
  /** Text baseline in PDF points (bottom-left origin). */
  baselineY: number;
  size: number;
  kit: KitFont;
  drawText: string;
  /** Fill color of the run (so the SVG re-render matches the PDF exactly). */
  color: RGB;
}

/**
 * Optional sink for every run `drawPreparedLine` emits. The production
 * renderer never passes one (zero overhead, zero behavior change); the
 * verification script (`scripts/pdf-rtl-verify.ts`) uses it to re-render
 * faithful SVGs: each recorded run is re-laid-out with the same fontkit call
 * pdf-lib makes, cross-checked glyph-by-glyph against the parsed PDF, and
 * drawn with real outlines at the recorded positions.
 */
export interface DrawRecorder {
  record(run: DrawnRun): void;
}

/**
 * Draws a prepared line. `xLeft` is the line's left edge (the caller aligns:
 * RTL lines pass `rightEdge - line.width`); `baselineY` is the text baseline.
 */
export function drawPreparedLine(
  page: PDFPage,
  line: PreparedLine,
  font: ExportFont,
  xLeft: number,
  baselineY: number,
  color: RGB,
  recorder?: DrawRecorder,
): void {
  let x = xLeft;
  for (const run of line.runs) {
    page.drawText(run.drawText, { x, y: baselineY, size: line.size, font: font.pdf, color });
    recorder?.record({ page, x, baselineY, size: line.size, kit: font.kit, drawText: run.drawText, color });
    x += font.pdf.widthOfTextAtSize(run.drawText, line.size);
  }
}

// ---------------------------------------------------------------------------
// Paragraph wrapping (logical) + drawing
// ---------------------------------------------------------------------------

export interface WrapOptions {
  font: ExportFont;
  size: number;
  maxWidth: number;
  baseDirection?: BaseDirection;
}

export interface WrappedLine extends PreparedLine {
  /** Logical unit range of the source paragraph (end exclusive). */
  logicalStart: number;
  logicalEnd: number;
}

interface WrapWord {
  /** First unit of the word's measurable content. */
  start: number;
  /** Exclusive end of measurable content (dropped break space excluded). */
  contentEnd: number;
}

/**
 * Wraps one sanitized paragraph (no `\n`) to the given width.
 *
 * Levels come from ONE UBA run over the whole paragraph; wrapping only chooses
 * break points (break spaces are dropped, ZWSP kept, runs of spaces collapse
 * like HTML). Each wrapped line is then reordered independently with per-line
 * L1 handling. A word longer than `maxWidth` hard-breaks at cluster
 * boundaries. An empty (or spaces-only) paragraph yields one empty line
 * (blank-line height).
 */
export function wrapParagraph(paragraphText: string, options: WrapOptions): WrappedLine[] {
  const { font, size, maxWidth } = options;
  const baseDirection = options.baseDirection ?? RTL_BASE_DIRECTION;
  if (!(maxWidth > 0)) {
    throw new Error(`[pdf-export] wrapParagraph requires maxWidth > 0 (got ${String(maxWidth)})`);
  }
  const paragraph: ResolvedParagraph = resolveParagraph(paragraphText, baseDirection);
  const text = paragraph.text;
  if (text === "") {
    return [{ runs: [], width: 0, size, logicalStart: 0, logicalEnd: 0 }];
  }

  const dropAfter = new Set<number>();
  for (const opportunity of findBreakOpportunities(paragraph)) {
    if (opportunity.dropBreakChar) dropAfter.add(opportunity.afterUnit);
  }
  const isDroppedBreak = (index: number): boolean => dropAfter.has(index);

  // Words: spans between dropped break chars; empty-content spans (space runs)
  // vanish, which is exactly HTML-like collapsing.
  const words: WrapWord[] = [];
  let wordStart: number | null = null;
  const flushWord = (contentEnd: number) => {
    if (wordStart !== null && contentEnd > wordStart) {
      words.push({ start: wordStart, contentEnd });
    }
    wordStart = null;
  };
  for (let i = 0; i < text.length; i++) {
    if (isDroppedBreak(i)) {
      flushWord(i);
    } else if (wordStart === null) {
      wordStart = i;
    }
  }
  flushWord(text.length);
  if (words.length === 0) {
    return [{ runs: [], width: 0, size, logicalStart: 0, logicalEnd: text.length }];
  }

  const measureRange = (start: number, end: number): number => {
    if (end <= start) return 0;
    const runs = visualRunsForLine(paragraph, start, end - 1);
    return layoutVisualLine(runs, font, size).width;
  };

  // Greedy lines: extend each line word by word while it fits. Interior
  // spaces stay inside the measured range; the break space itself is excluded
  // by construction (words end before it).
  const lineRanges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < words.length) {
    const first = words[cursor] as WrapWord;
    const lineStart = first.start;
    if (measureRange(lineStart, first.contentEnd) > maxWidth) {
      // Single word longer than the line: hard-break it at clusters.
      lineRanges.push(...hardBreakWord(paragraph, lineStart, first.contentEnd, font, size, maxWidth));
      cursor++;
      continue;
    }
    let last = cursor;
    while (last + 1 < words.length) {
      const candidate = words[last + 1] as WrapWord;
      if (measureRange(lineStart, candidate.contentEnd) > maxWidth) break;
      last++;
    }
    const lastWord = words[last] as WrapWord;
    lineRanges.push({ start: lineStart, end: lastWord.contentEnd });
    cursor = last + 1;
  }

  return lineRanges.map(({ start, end }) => {
    if (end <= start) return { runs: [], width: 0, size, logicalStart: start, logicalEnd: end };
    const runs = visualRunsForLine(paragraph, start, end - 1);
    const laid = layoutVisualLine(runs, font, size);
    return { ...laid, logicalStart: start, logicalEnd: end };
  });
}

/**
 * Hard-breaks an overlong word (no break opportunity fits) at cluster
 * boundaries so every piece fits `maxWidth`. Surrogate-pair/NSM-safe via
 * `splitClusters`; always makes progress (at least one cluster per piece).
 */
function hardBreakWord(
  paragraph: ResolvedParagraph,
  wordStart: number,
  wordEnd: number,
  font: ExportFont,
  size: number,
  maxWidth: number,
): Array<{ start: number; end: number }> {
  const pieces: Array<{ start: number; end: number }> = [];
  const clusters = splitClusters(paragraph.text.slice(wordStart, wordEnd));
  const boundaries: number[] = [wordStart];
  let offset = wordStart;
  for (const cluster of clusters) {
    offset += cluster.length;
    boundaries.push(Math.min(offset, wordEnd));
  }
  const measureRange = (start: number, end: number): number => {
    if (end <= start) return 0;
    return layoutVisualLine(visualRunsForLine(paragraph, start, end - 1), font, size).width;
  };
  let pieceStart = wordStart;
  while (pieceStart < wordEnd) {
    // Furthest boundary that fits (binary search over boundaries).
    let lo = 0;
    let hi = boundaries.length - 1;
    let best = pieceStart;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = boundaries[mid] ?? pieceStart;
      if (candidate <= pieceStart) {
        lo = mid + 1;
        continue;
      }
      if (measureRange(pieceStart, candidate) <= maxWidth) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best <= pieceStart) {
      // Even one cluster overflows (pathological size/width): emit it anyway
      // to guarantee progress rather than looping forever.
      const next = boundaries.find((b) => b > pieceStart) ?? wordEnd;
      best = Math.min(next, wordEnd);
    }
    pieces.push({ start: pieceStart, end: best });
    pieceStart = best;
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Block drawing
// ---------------------------------------------------------------------------

export type ParagraphAlign = "right" | "left" | "center";

export interface DrawParagraphOptions {
  font: ExportFont;
  size: number;
  color: RGB;
  recorder?: DrawRecorder;
  /** Text-box edges (content coordinates). */
  xLeft: number;
  xRight: number;
  /** Baseline of the FIRST line. */
  firstBaselineY: number;
  /** Distance between baselines. */
  lineHeight: number;
  align?: ParagraphAlign;
  baseDirection?: BaseDirection;
}

export interface DrawParagraphResult {
  /** Baseline of the LAST line drawn (== firstBaselineY for one line). */
  lastBaselineY: number;
  lineCount: number;
}

/**
 * Draws raw text (may contain `\n` paragraphs) as a wrapped block. Returns the
 * last baseline so callers can flow the next block. Blank paragraphs consume
 * one line height (visible blank line).
 */
export function drawParagraph(page: PDFPage, rawText: string, options: DrawParagraphOptions): DrawParagraphResult {
  const lines = layoutTextBlock(rawText, options);
  let baselineY = options.firstBaselineY;
  const align = options.align ?? "right";
  for (const line of lines) {
    const xLeft =
      align === "right"
        ? options.xRight - line.width
        : align === "center"
          ? options.xLeft + (options.xRight - options.xLeft - line.width) / 2
          : options.xLeft;
    drawPreparedLine(page, line, options.font, xLeft, baselineY, options.color, options.recorder);
    baselineY -= options.lineHeight;
  }
  return { lastBaselineY: baselineY + options.lineHeight, lineCount: lines.length };
}

export interface LayoutTextBlockOptions {
  font: ExportFont;
  size: number;
  xLeft: number;
  xRight: number;
  baseDirection?: BaseDirection;
}

/** Lays out (without drawing) the wrapped lines of raw multi-paragraph text. */
export function layoutTextBlock(rawText: string, options: LayoutTextBlockOptions): WrappedLine[] {
  const sanitized = sanitizeForBidi(rawText);
  const maxWidth = Math.max(1, options.xRight - options.xLeft);
  const out: WrappedLine[] = [];
  for (const paragraphText of splitParagraphs(sanitized)) {
    const wrapped = wrapParagraph(paragraphText, {
      font: options.font,
      size: options.size,
      maxWidth,
      baseDirection: options.baseDirection ?? RTL_BASE_DIRECTION,
    });
    out.push(...wrapped);
  }
  return out;
}

/** Measures a laid-out block's height for `lineHeight` (no drawing). */
export function measureTextBlock(lines: WrappedLine[], lineHeight: number): number {
  return lines.length * lineHeight;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `#rrggbb` (lowercase, validated) → pdf-lib RGB. Throws on invalid input. */
export function hexToRgb(hex: string): RGB {
  if (!/^#[0-9a-f]{6}$/.test(hex)) {
    throw new Error(`[pdf-export] invalid hex color (want lowercase #rrggbb): ${JSON.stringify(hex)}`);
  }
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(red, green, blue);
}

/** Re-exported for callers that only need "which base direction". */
export { RTL_BASE_DIRECTION as RTL_BASE };
