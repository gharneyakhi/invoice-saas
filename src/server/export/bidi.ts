/**
 * Unicode Bidirectional Algorithm (UBA) stage of the PDF export pipeline.
 *
 * Pipeline position: logical Unicode text (after input sanitization) →
 * THIS MODULE (levels, visual order, mirroring, run segmentation) →
 * `persianText.ts` (per-run shaping + drawing) → pdf-lib → PDF bytes.
 *
 * The UBA itself is NOT reimplemented here: levels, reordering and mirroring
 * come from `bidi-js` (a UAX#9-conformant implementation, MIT licensed). This
 * module owns the smaller, carefully-tested glue that a PDF renderer needs on
 * top of raw UBA output:
 *
 *   1. `sanitizeForBidi` — normalizes control characters BEFORE the UBA runs.
 *      TAB/CR/LF are paragraph/segment separators or NOTDEF in the font; they
 *      must never reach either the UBA or the shaper unhandled.
 *   2. `resolveParagraph` — UBA levels for one sanitized paragraph (no `\n`).
 *   3. `visualRunsForLine` — the paragraph (or a wrapped line range of it)
 *      segmented into maximal same-level runs in VISUAL (left-to-right) order,
 *      each carrying its logical-order text with UBA L4 mirroring applied.
 *      Shaping happens per run in `persianText.ts`, which is why runs — not a
 *      single visual string — are the unit of output.
 *   4. Surrogate-pair-atomic reordering: bidi-js computes flips over UTF-16
 *      code units, and a flip can cover exactly the two halves of an astral
 *      character (e.g. emoji). Naively reversing units would swap the halves
 *      and corrupt the character; flips are applied to code-point elements so
 *      pairs move as units with their halves intact.
 *   5. Per-line L1 handling: trailing whitespace of a wrapped line resolves to
 *      the paragraph level (UBA rule L1.4), so it joins the correct run.
 *      (Implemented here rather than relying on bidi-js's line slicing, whose
 *      trailing-reset indexes a sliced array with absolute indices and is a
 *      silent no-op for any line that does not start at 0.)
 *
 * Base direction: invoice lines default to RTL (`'rtl'`), matching the HTML
 * preview (`InvoicePreviewDocument`, `dir="rtl"`). Callers may pass `'ltr'`
 * explicitly; there is no "auto" mode because per-line auto-detection would
 * diverge from the preview for Latin-led mixed lines such as `ABC ۱۲۳ تست`.
 *
 * What this module deliberately does NOT do:
 *
 *   - No shaping, no joining, no presentation forms. Letter forms come from
 *     the font's GSUB table via fontkit (`persianText.ts`).
 *   - No rendering, no measurement, no font access. It is pure Unicode logic
 *     over strings and levels, and its tests assert hand-derived literals
 *     (see `bidi.test.ts`), not "whatever bidi-js says".
 */

import bidiFactory, {
  type Bidi,
  type BidiCharTypeName,
  type EmbeddingLevels,
} from "bidi-js";

const bidi: Bidi = bidiFactory();

export type BaseDirection = "rtl" | "ltr";

export const RTL_BASE_DIRECTION: BaseDirection = "rtl";

/** Paragraph level implied by an explicit base direction. */
export function paragraphLevelFor(baseDirection: BaseDirection): 0 | 1 {
  return baseDirection === "rtl" ? 1 : 0;
}

/** True for a high surrogate UTF-16 code unit. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** True for a low surrogate UTF-16 code unit. */
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Normalizes raw user/model text BEFORE the UBA sees it.
 *
 *   - `\r\n` and lone `\r` become `\n` (paragraph separators for step 2).
 *   - TAB becomes a plain space: TAB is bidi class S (it would split
 *     paragraphs inside the UBA) and NOTDEF in the PDF font.
 *   - Remaining C0 controls, DEL and C1 controls are dropped: several are
 *     paragraph/segment separators (B/S) or NOTDEF boxes in the font, and none
 *     carries invoice content.
 *
 * Everything else — including ZWNJ/ZWJ (joining controls the shaper needs),
 * LRM/RLM/ZWSP (zero-width, present in the font) and astral characters — is
 * preserved verbatim so the UBA resolves levels for the real text.
 */
export function sanitizeForBidi(input: string): string {
  if (input === "") return "";
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, " ");
  let out = "";
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      out += char; // LF: the paragraph separator, kept for splitParagraphs.
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // C0 / DEL / C1: dropped (see doc comment).
    } else {
      out += char;
    }
  }
  return out;
}

/** Splits sanitized text into paragraphs (LF-separated, LF consumed). */
export function splitParagraphs(sanitized: string): string[] {
  return sanitized.split("\n");
}

// ---------------------------------------------------------------------------
// UBA resolution
// ---------------------------------------------------------------------------

export interface ResolvedParagraph {
  /** Sanitized paragraph text (guaranteed to contain no `\n`). */
  text: string;
  baseDirection: BaseDirection;
  /** 0 for LTR, 1 for RTL. */
  paraLevel: 0 | 1;
  /**
   * Resolved embedding level per UTF-16 code unit (same indexing bidi-js
   * uses). Surrogate halves are unified to the pair's level (defensive: they
   * always agree in practice, but a split pair must never reach shaping).
   */
  levels: Uint8Array;
  /** Raw bidi-js result (paragraphs + levels), for reorder/mirror queries. */
  embedding: EmbeddingLevels;
}

/**
 * Runs the UBA over one sanitized paragraph.
 *
 * `text` must not contain `\n` (split first with `splitParagraphs`); a
 * defensive split takes the first segment if one slips through, so a stray LF
 * can never silently re-paragraph inside bidi-js.
 */
export function resolveParagraph(text: string, baseDirection: BaseDirection = RTL_BASE_DIRECTION): ResolvedParagraph {
  const paragraph = text.includes("\n") ? (text.split("\n")[0] ?? "") : text;
  const embedding = bidi.getEmbeddingLevels(paragraph, baseDirection);
  const paraLevel = paragraphLevelFor(baseDirection);
  const levels = Uint8Array.from(embedding.levels);
  unifySurrogatePairLevels(paragraph, levels);
  return { text: paragraph, baseDirection, paraLevel, levels, embedding };
}

/**
 * Forces both halves of every surrogate pair to the pair's level (the first
 * half's resolved level). bidi-js types both halves identically so they always
 * agree; this is a backstop so a future data change can never split a pair
 * across runs or flips.
 */
function unifySurrogatePairLevels(text: string, levels: Uint8Array): void {
  for (let i = 0; i + 1 < text.length; i++) {
    const high = text.charCodeAt(i) ?? 0;
    const low = text.charCodeAt(i + 1) ?? 0;
    if (isHighSurrogate(high) && isLowSurrogate(low)) {
      levels[i + 1] = levels[i] ?? 0;
      i++;
    }
  }
}

// ---------------------------------------------------------------------------
// Character typing (delegated to bidi-js's own data tables)
// ---------------------------------------------------------------------------

/** Bidi class name of the character at UTF-16 unit `index` (BMP-safe probe). */
function classNameAt(text: string, index: number): BidiCharTypeName {
  return bidi.getBidiCharTypeName(text[index] ?? "");
}

/**
 * True when a line may break AFTER the character at `index` AND the character
 * is a space that must be dropped from the output (standard collapsed break:
 * the break space belongs to neither line).
 *
 * Only bidi class WS qualifies: NBSP is class CS (it joins numbers and never
 * breaks), ZWSP is handled separately (break after, but kept — it is an
 * invisible format character, not a collapsible space).
 */
export function isBreakableAfterDroppable(text: string, index: number): boolean {
  return classNameAt(text, index) === "WS";
}

/** True for U+200B ZERO WIDTH SPACE (break opportunity, kept in output). */
export function isZeroWidthSpace(text: string, index: number): boolean {
  return (text.charCodeAt(index) ?? 0) === 0x200b;
}

/**
 * Line-break opportunities of a resolved paragraph, in ascending unit order.
 * Each entry is the unit index AFTER which a break may occur, plus whether the
 * break character itself is dropped (`WS`) or kept (`ZWSP`).
 */
export interface BreakOpportunity {
  /** Break after this UTF-16 unit index (inclusive). */
  afterUnit: number;
  /** Whether the break character is dropped from both lines. */
  dropBreakChar: boolean;
}

export function findBreakOpportunities(paragraph: ResolvedParagraph): BreakOpportunity[] {
  const out: BreakOpportunity[] = [];
  const { text } = paragraph;
  for (let i = 0; i < text.length; i++) {
    if (isBreakableAfterDroppable(text, i)) {
      out.push({ afterUnit: i, dropBreakChar: true });
    } else if (isZeroWidthSpace(text, i)) {
      out.push({ afterUnit: i, dropBreakChar: false });
    }
  }
  return out;
}

/** UBA rule L1.4 trailing set: reset to the paragraph level at a line end. */
function isTrailingResettable(name: BidiCharTypeName): boolean {
  switch (name) {
    case "WS":
    case "S":
    case "B":
    case "BN":
    case "RLE":
    case "LRE":
    case "RLO":
    case "LRO":
    case "PDF":
    case "LRI":
    case "RLI":
    case "FSI":
    case "PDI":
      return true;
    default:
      return false;
  }
}

/**
 * Copies `levels` with UBA rule L1.4 applied to the line range
 * `[lineStart, lineEnd]` (inclusive unit indices): trailing whitespace/format
 * characters resolve to the paragraph level so run segmentation places them in
 * the paragraph-direction run (at the line edge) rather than stranded inside a
 * middle run. Out-of-range ends are clamped; an empty range yields a copy of
 * the input levels.
 */
export function applyLineTrailingReset(
  levels: Uint8Array,
  text: string,
  lineStart: number,
  lineEnd: number,
  paraLevel: 0 | 1,
): Uint8Array {
  const adjusted = Uint8Array.from(levels);
  const start = Math.max(0, lineStart);
  const end = Math.min(levels.length - 1, lineEnd);
  for (let i = end; i >= start; i--) {
    if (!isTrailingResettable(classNameAt(text, i))) break;
    adjusted[i] = paraLevel;
  }
  return adjusted;
}

// ---------------------------------------------------------------------------
// Pair-atomic visual order
// ---------------------------------------------------------------------------

/**
 * UTF-16 unit indices of the line range `[lineStart, lineEnd]` (inclusive) in
 * VISUAL (left-to-right) order.
 *
 * Flips come from bidi-js (`getReorderSegments`, UBA rules L1+L2 over the
 * paragraph levels). They are applied to code-point elements rather than raw
 * units: a flip covering exactly one surrogate pair becomes a single-element
 * no-op instead of swapping the halves, and a flip edge can never split a
 * pair (ranges expand to pair boundaries first). For pure-BMP text this is
 * identical to the textbook unit reversal.
 */
export function visualUnitsForLine(
  paragraph: ResolvedParagraph,
  lineStart: number,
  lineEnd: number,
): number[] {
  const { text, embedding } = paragraph;
  const start = Math.max(0, lineStart);
  const end = Math.min(text.length - 1, lineEnd);
  if (end < start || text.length === 0) return [];

  // Code-point elements of the line: each is 1 unit, or 2 for a pair.
  interface Element {
    units: number[];
  }
  const elements: Element[] = [];
  for (let i = start; i <= end; i++) {
    const high = text.charCodeAt(i) ?? 0;
    const low = text.charCodeAt(i + 1) ?? 0;
    if (isHighSurrogate(high) && isLowSurrogate(low) && i + 1 <= end) {
      elements.push({ units: [i, i + 1] });
      i++;
    } else {
      elements.push({ units: [i] });
    }
  }

  const flips = bidi.getReorderSegments(text, embedding, start, end);
  for (const flip of flips) {
    const flipStart = flip[0] ?? 0;
    const flipEnd = flip[1] ?? 0;
    // Intersect with the line, then expand to element boundaries.
    let first = -1;
    let last = -1;
    for (let e = 0; e < elements.length; e++) {
      const units = elements[e]?.units ?? [];
      const overlaps = units.some((u) => u >= flipStart && u <= flipEnd);
      if (overlaps) {
        if (first === -1) first = e;
        last = e;
      }
    }
    if (first !== -1 && last !== -1 && last > first) {
      const slice = elements.slice(first, last + 1).reverse();
      elements.splice(first, last - first + 1, ...slice);
    }
  }

  const out: number[] = [];
  for (const element of elements) {
    for (const unit of element.units) out.push(unit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visual runs (the shaping unit)
// ---------------------------------------------------------------------------

export interface VisualRun {
  /**
   * Resolved embedding level of the run (line-L1-adjusted). Odd = RTL,
   * even = LTR.
   */
  level: number;
  /** True for odd (right-to-left) levels. */
  rtl: boolean;
  /**
   * The run's text in LOGICAL order with UBA L4 mirroring applied (chars at
   * odd levels replaced by their mirror image, e.g. `(` → `)`). This is the
   * exact string shaping consumes: an RTL run is passed to fontkit in logical
   * order (fontkit reverses + shapes it), an LTR run is passed through (or
   * counter-reversed when fontkit would wrongly reverse it — see
   * `persianText.ts`).
   */
  logicalText: string;
  /** Logical unit range of the run (inclusive, for debugging/tests). */
  logicalStart: number;
  logicalEnd: number;
}

/**
 * Segments the line range `[lineStart, lineEnd]` (inclusive) into maximal
 * same-level runs in VISUAL (left-to-right) order.
 *
 * Each visual same-level block corresponds to exactly one logical run; the
 * run's units are sorted back to logical order and L4 mirroring is applied to
 * odd-level mirrored characters via bidi-js's mirroring table.
 */
export function visualRunsForLine(
  paragraph: ResolvedParagraph,
  lineStart: number,
  lineEnd: number,
): VisualRun[] {
  const { text, levels, paraLevel } = paragraph;
  const start = Math.max(0, lineStart);
  const end = Math.min(text.length - 1, lineEnd);
  if (end < start || text.length === 0) return [];

  const adjusted = applyLineTrailingReset(levels, text, start, end, paraLevel);
  const visualUnits = visualUnitsForLine(paragraph, start, end);

  // Group consecutive visual units by (adjusted) level.
  const runs: VisualRun[] = [];
  let currentUnits: number[] = [];
  let currentLevel = -1;
  const flush = () => {
    if (currentUnits.length === 0 || currentLevel === -1) return;
    const sorted = [...currentUnits].sort((a, b2) => a - b2);
    const first = sorted[0] ?? start;
    const last = sorted[sorted.length - 1] ?? start;
    const rtl = currentLevel % 2 === 1;
    let logicalText = "";
    for (const unit of sorted) {
      const char = text[unit] ?? "";
      if (rtl) {
        logicalText += bidi.getMirroredCharacter(char) ?? char;
      } else {
        logicalText += char;
      }
    }
    runs.push({ level: currentLevel, rtl, logicalText, logicalStart: first, logicalEnd: last });
  };
  for (const unit of visualUnits) {
    const level = adjusted[unit] ?? paraLevel;
    if (currentUnits.length > 0 && level !== currentLevel) {
      flush();
      currentUnits = [];
    }
    currentLevel = level;
    currentUnits.push(unit);
  }
  flush();
  return runs;
}

/**
 * The line's fully reordered + mirrored visual string (glyph placement order,
 * left to right). Convenience for tests and oracles: production shaping uses
 * `visualRunsForLine` (runs shape independently), but the concatenation of run
 * visuals must always equal this string.
 */
export function visualStringForLine(
  paragraph: ResolvedParagraph,
  lineStart: number,
  lineEnd: number,
): string {
  const { text, levels } = paragraph;
  const start = Math.max(0, lineStart);
  const end = Math.min(text.length - 1, lineEnd);
  if (end < start || text.length === 0) return "";
  const visualUnits = visualUnitsForLine(paragraph, start, end);
  const mirrorMap = bidi.getMirroredCharactersMap(text, levels, start, end);
  let out = "";
  for (const unit of visualUnits) {
    out += mirrorMap.get(unit) ?? text[unit] ?? "";
  }
  return out;
}

/**
 * Whole-paragraph visual string (single-line convenience: the full paragraph
 * as one line, no wrapping). Used by tests and by single-line layout.
 */
export function visualStringForParagraph(paragraph: ResolvedParagraph): string {
  if (paragraph.text.length === 0) return "";
  return visualStringForLine(paragraph, 0, paragraph.text.length - 1);
}

/** Whole-paragraph visual runs (single-line convenience). */
export function visualRunsForParagraph(paragraph: ResolvedParagraph): VisualRun[] {
  if (paragraph.text.length === 0) return [];
  return visualRunsForLine(paragraph, 0, paragraph.text.length - 1);
}

// ---------------------------------------------------------------------------
// Shaping clusters
// ---------------------------------------------------------------------------

/**
 * Splits text into shaping clusters: surrogate pairs stay whole, and combining
 * marks (bidi class NSM) attach to the preceding cluster. Reversing at cluster
 * granularity (rather than per code point) keeps marks on their base letter,
 * which matters whenever the shaper fuses characters (ligatures) so that its
 * glyph reversal is not a pure character permutation anymore.
 */
export function splitClusters(text: string): string[] {
  const clusters: string[] = [];
  let index = 0;
  while (index < text.length) {
    const high = text.charCodeAt(index) ?? 0;
    const low = text.charCodeAt(index + 1) ?? 0;
    let cluster: string;
    if (isHighSurrogate(high) && isLowSurrogate(low)) {
      cluster = text.slice(index, index + 2);
      index += 2;
    } else {
      cluster = text[index] ?? "";
      index += 1;
    }
    // Attach following NSM marks to this cluster.
    while (index < text.length) {
      const nextHigh = text.charCodeAt(index) ?? 0;
      const nextLow = text.charCodeAt(index + 1) ?? 0;
      const next =
        isHighSurrogate(nextHigh) && isLowSurrogate(nextLow)
          ? text.slice(index, index + 2)
          : (text[index] ?? "");
      if (bidi.getBidiCharTypeName(next) !== "NSM") break;
      cluster += next;
      index += next.length;
    }
    clusters.push(cluster);
  }
  return clusters;
}

/** Cluster-granularity reversal (see `splitClusters`). An involution. */
export function reverseClusters(text: string): string[] {
  return splitClusters(text).reverse();
}

/** Cluster-granularity reversal joined back into a string. */
export function reverseClusterString(text: string): string {
  return reverseClusters(text).join("");
}
