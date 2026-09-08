/**
 * Persian / Arabic text shaping for server-side PDF generation.
 *
 * `pdf-lib` maps code points to glyphs one-to-one and performs no complex
 * text layout: without help, Persian text would render disconnected and in
 * logical (not visual) order. This module converts a logical-order string
 * into the visual-order string `pdf-lib` must draw, using the well-known
 * presentation-forms technique:
 *
 *   1. Arabic letters are replaced by their contextual presentation forms
 *      (isolated / initial / medial / final) from Unicode blocks U+FB50–FBFF
 *      (Persian extensions: پ چ ژ ک گ ی) and U+FE70–FEFF, including the
 *      lam-alef ligatures (لا). Zero-width joiners control joining and are
 *      then dropped; combining marks stay attached to their base letter.
 *   2. The line is reordered for display: in a right-to-left paragraph the
 *      sequence of directional runs is reversed while Latin / number runs
 *      keep their internal order, so "فاکتور ۱۲۳" and "INV-101" both read
 *      correctly. Brackets are mirrored.
 *
 * This is a deliberately small, invoice-scoped subset of the Unicode bidi
 * algorithm — enough for business names, addresses, item titles, money and
 * identifiers — not a general text-layout engine. Pure and dependency-free.
 */

// ---------------------------------------------------------------------------
// Joining table: code point -> contextual presentation forms.
// ---------------------------------------------------------------------------

type JoiningType = "D" | "R" | "U";

interface JoiningEntry {
  type: JoiningType;
  /** [isolated, initial, medial, final] — null when the form cannot occur. */
  forms: [number | null, number | null, number | null, number | null];
}

const JOINING_TABLE = new Map<number, JoiningEntry>([
  [0x0621, { type: "U", forms: [0xfe80, null, null, null] }], // ء HAMZA
  [0x0622, { type: "R", forms: [0xfe81, null, null, 0xfe82] }], // آ
  [0x0623, { type: "R", forms: [0xfe83, null, null, 0xfe84] }], // أ
  [0x0624, { type: "R", forms: [0xfe85, null, null, 0xfe86] }], // ؤ
  [0x0625, { type: "R", forms: [0xfe87, null, null, 0xfe88] }], // إ
  [0x0626, { type: "D", forms: [0xfe89, 0xfe8b, 0xfe8c, 0xfe8a] }], // ئ
  [0x0627, { type: "R", forms: [0xfe8d, null, null, 0xfe8e] }], // ا
  [0x0628, { type: "D", forms: [0xfe8f, 0xfe91, 0xfe92, 0xfe90] }], // ب
  [0x0629, { type: "R", forms: [0xfe93, null, null, 0xfe94] }], // ة
  [0x062a, { type: "D", forms: [0xfe95, 0xfe97, 0xfe98, 0xfe96] }], // ت
  [0x062b, { type: "D", forms: [0xfe99, 0xfe9b, 0xfe9c, 0xfe9a] }], // ث
  [0x062c, { type: "D", forms: [0xfe9d, 0xfe9f, 0xfea0, 0xfe9e] }], // ج
  [0x062d, { type: "D", forms: [0xfea1, 0xfea3, 0xfea4, 0xfea2] }], // ح
  [0x062e, { type: "D", forms: [0xfea5, 0xfea7, 0xfea8, 0xfea6] }], // خ
  [0x062f, { type: "R", forms: [0xfea9, null, null, 0xfeaa] }], // د
  [0x0630, { type: "R", forms: [0xfeab, null, null, 0xfeac] }], // ذ
  [0x0631, { type: "R", forms: [0xfead, null, null, 0xfeae] }], // ر
  [0x0632, { type: "R", forms: [0xfeaf, null, null, 0xfeb0] }], // ز
  [0x0633, { type: "D", forms: [0xfeb1, 0xfeb3, 0xfeb4, 0xfeb2] }], // س
  [0x0634, { type: "D", forms: [0xfeb5, 0xfeb7, 0xfeb8, 0xfeb6] }], // ش
  [0x0635, { type: "D", forms: [0xfeb9, 0xfebb, 0xfebc, 0xfeba] }], // ص
  [0x0636, { type: "D", forms: [0xfebd, 0xfebf, 0xfec0, 0xfebe] }], // ض
  [0x0637, { type: "D", forms: [0xfec1, 0xfec3, 0xfec4, 0xfec2] }], // ط
  [0x0638, { type: "D", forms: [0xfec5, 0xfec7, 0xfec8, 0xfec6] }], // ظ
  [0x0639, { type: "D", forms: [0xfec9, 0xfecb, 0xfecc, 0xfeca] }], // ع
  [0x063a, { type: "D", forms: [0xfecd, 0xfecf, 0xfed0, 0xfece] }], // غ
  [0x0641, { type: "D", forms: [0xfed1, 0xfed3, 0xfed4, 0xfed2] }], // ف
  [0x0642, { type: "D", forms: [0xfed5, 0xfed7, 0xfed8, 0xfed6] }], // ق
  [0x0643, { type: "D", forms: [0xfed9, 0xfedb, 0xfedc, 0xfeda] }], // ك
  [0x0644, { type: "D", forms: [0xfedd, 0xfedf, 0xfee0, 0xfede] }], // ل
  [0x0645, { type: "D", forms: [0xfee1, 0xfee3, 0xfee4, 0xfee2] }], // م
  [0x0646, { type: "D", forms: [0xfee5, 0xfee7, 0xfee8, 0xfee6] }], // ن
  [0x0647, { type: "D", forms: [0xfee9, 0xfeeb, 0xfeec, 0xfeea] }], // ه
  [0x0648, { type: "R", forms: [0xfeed, null, null, 0xfeee] }], // و
  [0x0649, { type: "R", forms: [0xfeef, null, null, 0xfef0] }], // ى
  [0x064a, { type: "D", forms: [0xfef1, 0xfef3, 0xfef4, 0xfef2] }], // ي
  [0x0671, { type: "R", forms: [0xfb50, null, null, 0xfb51] }], // ٱ
  [0x067e, { type: "D", forms: [0xfb56, 0xfb58, 0xfb59, 0xfb57] }], // پ
  [0x0686, { type: "D", forms: [0xfb7a, 0xfb7c, 0xfb7d, 0xfb7b] }], // چ
  [0x0698, { type: "R", forms: [0xfb8a, null, null, 0xfb8b] }], // ژ
  [0x06a9, { type: "D", forms: [0xfb8e, 0xfb90, 0xfb91, 0xfb8f] }], // ک
  [0x06af, { type: "D", forms: [0xfb92, 0xfb94, 0xfb95, 0xfb93] }], // گ
  [0x06cc, { type: "D", forms: [0xfbfc, 0xfbfe, 0xfbff, 0xfbfd] }], // ی
]);

/** Lam + alef ligatures: alef code point -> [isolated, final] ligature. */
const LAM_ALEF_LIGATURES = new Map<number, [number, number]>([
  [0x0627, [0xfefb, 0xfefc]], // لا
  [0x0623, [0xfef7, 0xfef8]], // لأ
  [0x0625, [0xfef9, 0xfefa]], // لإ
  [0x0622, [0xfef5, 0xfef6]], // لآ
]);

const LAM = 0x0644;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;

// Neutral chars that mirror in RTL display (logical -> visual).
const MIRROR_MAP = new Map<number, number>([
  [0x0028, 0x0029], // ( -> )
  [0x0029, 0x0028], // ) -> (
  [0x005b, 0x005d], // [ -> ]
  [0x005d, 0x005b], // ] -> [
  [0x007b, 0x007d], // { -> }
  [0x007d, 0x007b], // } -> {
  [0x003c, 0x003e], // < -> >
  [0x003e, 0x003c], // > -> <
]);

// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------

type CharClass = "RTL" | "NUMBER" | "LATIN" | "NEUTRAL" | "MARK" | "FORMAT";

function isLatinLetter(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function isDigit(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // ASCII 0-9
    (cp >= 0x0660 && cp <= 0x0669) || // Arabic-Indic ٠-٩
    (cp >= 0x06f0 && cp <= 0x06f9) // Persian ۰-۹
  );
}

/** Combining marks: transparent to joining, rendered with their base char. */
function isCombiningMark(cp: number): boolean {
  return (
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06ed)
  );
}

function classify(cp: number): CharClass {
  if (cp === ZWNJ || cp === ZWJ) return "FORMAT";
  if (isCombiningMark(cp)) return "MARK";
  if (JOINING_TABLE.has(cp)) return "RTL";
  // Other Arabic-block letters without presentation forms (e.g. ګ, tah with
  // three dots) still flow right-to-left; they pass through unshaped.
  if (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfefe)
  ) {
    return isDigit(cp) ? "NUMBER" : "RTL";
  }
  if (isDigit(cp)) return "NUMBER";
  if (isLatinLetter(cp)) return "LATIN";
  return "NEUTRAL";
}

/** Separators allowed *inside* a number run when surrounded by digits. */
function isIntraNumberSeparator(cp: number): boolean {
  return (
    cp === 0x002e || // .
    cp === 0x002c || // ,
    cp === 0x066b || // ٫ Arabic decimal separator
    cp === 0x066c || // ٬ Arabic thousands separator
    cp === 0x2044 || // ⁄ fraction slash
    cp === 0x002f || // /
    cp === 0x003a // :
  );
}

/** Separators that glue Latin/digit tokens together (INV-101, mail.com). */
function isTokenGlue(cp: number): boolean {
  return (
    cp === 0x002d || // -
    cp === 0x005f || // _
    cp === 0x002e || // .
    cp === 0x002f || // /
    cp === 0x003a // :
  );
}

/** Returns true when the text contains at least one right-to-left letter. */
export function containsRtl(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (classify(cp) === "RTL") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Segmentation into directional runs
// ---------------------------------------------------------------------------

interface Run {
  kind: "RTL" | "LTR" | "NEUTRAL";
  /** Logical-order code points (marks still inline; FORMAT chars kept). */
  codePoints: number[];
}

function toCodePoints(text: string): number[] {
  const out: number[] = [];
  for (const char of text) out.push(char.codePointAt(0) ?? 0);
  return out;
}

/**
 * Splits logical text into directional runs and resolves neutrals:
 * a neutral run flanked by LTR content on both sides (mail@example.com,
 * card numbers with spaces) joins the LTR side; a neutral run flanked by
 * RTL joins the RTL side; anything else stays a standalone neutral run.
 */
function segmentRuns(codePoints: number[]): Run[] {
  // Pass 1: raw runs by class, with number-glue and token-glue handling.
  const raw: Run[] = [];
  let i = 0;
  const push = (kind: Run["kind"], cp: number) => {
    const last = raw[raw.length - 1];
    if (last && last.kind === kind) {
      last.codePoints.push(cp);
    } else {
      raw.push({ kind, codePoints: [cp] });
    }
  };

  while (i < codePoints.length) {
    const cp = codePoints[i] as number;
    const cls = classify(cp);

    if (cls === "RTL" || cls === "MARK" || cls === "FORMAT") {
      push("RTL", cp);
      i += 1;
      continue;
    }
    if (cls === "LATIN") {
      push("LTR", cp);
      i += 1;
      continue;
    }
    if (cls === "NUMBER") {
      push("LTR", cp);
      i += 1;
      continue;
    }
    // NEUTRAL: glue into a neighbouring LTR token when it sits between two
    // LTR-able characters (digits/latin around - _ . / :), otherwise its
    // own neutral run.
    const prev = i > 0 ? (codePoints[i - 1] as number) : null;
    const next = i + 1 < codePoints.length ? (codePoints[i + 1] as number) : null;
    const prevLtr =
      prev !== null && (classify(prev) === "LATIN" || classify(prev) === "NUMBER");
    const nextLtr =
      next !== null && (classify(next) === "LATIN" || classify(next) === "NUMBER");
    const prevDigit = prev !== null && classify(prev) === "NUMBER";
    const nextDigit = next !== null && classify(next) === "NUMBER";

    if (isIntraNumberSeparator(cp) && prevDigit && nextDigit) {
      push("LTR", cp);
    } else if (isTokenGlue(cp) && prevLtr && nextLtr) {
      // Hyphen/dot/slash between two LTR tokens (INV-101, mail.com): the
      // token must never be split by reordering.
      push("LTR", cp);
    } else if (
      // Spaces between two LTR tokens (card numbers, amounts) stay LTR so
      // the token is never split by reordering.
      (cp === 0x0020 || cp === 0x00a0) &&
      prevLtr &&
      nextLtr
    ) {
      push("LTR", cp);
    } else {
      push("NEUTRAL", cp);
    }
    i += 1;
  }

  // Pass 2: resolve standalone neutral runs by their neighbours.
  const resolved: Run[] = [];
  for (let r = 0; r < raw.length; r += 1) {
    const run = raw[r] as Run;
    if (run.kind !== "NEUTRAL") {
      resolved.push(run);
      continue;
    }
    const prevKind = r > 0 ? (raw[r - 1] as Run).kind : null;
    const nextKind = r + 1 < raw.length ? (raw[r + 1] as Run).kind : null;
    if (prevKind === "LTR" && nextKind === "LTR") {
      // Email/domain style: merge with the previous LTR run (the next LTR
      // run merges in turn when the loop reaches... it does not — so merge
      // forward explicitly here).
      const prev = resolved[resolved.length - 1] as Run;
      prev.codePoints.push(...run.codePoints);
      const following = raw[r + 1] as Run;
      prev.codePoints.push(...following.codePoints);
      r += 1; // consume the following run
    } else if (prevKind === "RTL" && nextKind === "RTL") {
      const prev = resolved[resolved.length - 1] as Run;
      prev.codePoints.push(...run.codePoints);
    } else if (prevKind === "RTL" && nextKind === null) {
      // Trailing neutral after RTL (e.g. "خدمات."): keep it with the RTL run
      // so it lands on the correct (left) side after reversal.
      const prev = resolved[resolved.length - 1] as Run;
      prev.codePoints.push(...run.codePoints);
    } else if (prevKind === null && nextKind === "RTL") {
      // Leading neutral before RTL: keep with the following RTL run.
      const following = raw[r + 1] as Run;
      following.codePoints.unshift(...run.codePoints);
    } else if (prevKind === "LTR" && nextKind === null) {
      const prev = resolved[resolved.length - 1] as Run;
      prev.codePoints.push(...run.codePoints);
    } else if (prevKind === null && nextKind === "LTR") {
      const following = raw[r + 1] as Run;
      following.codePoints.unshift(...run.codePoints);
    } else {
      resolved.push(run);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Arabic shaping of one RTL run (logical order in, visual clusters out)
// ---------------------------------------------------------------------------

interface Cluster {
  /** Shaped base code point (presentation form or pass-through). */
  base: number;
  /** Combining marks rendered with the base, in logical order. */
  marks: number[];
  /** True when the base is a lam-alef ligature (marks of both chars). */
  ligature: boolean;
}

/**
 * Shapes one RTL run: contextual forms are chosen from logical neighbours,
 * then lam-alef pairs are fused. FORMAT characters (ZWNJ/ZWJ) steer joining
 * and vanish; combining marks attach to their base cluster.
 */
function shapeRtlRun(codePoints: number[]): Cluster[] {
  interface Cell {
    cp: number;
    entry: JoiningEntry | null;
    /** Non-joining pass-through (neutral punctuation, tatweel, ...). */
    opaque: boolean;
    marks: number[];
    forceBreakBefore: boolean;
    forceJoinBefore: boolean;
  }

  // Build cells: marks attach to the previous cell; FORMAT chars set flags
  // on the boundary instead of becoming cells.
  const cells: Cell[] = [];
  let breakBeforeNext = false;
  let joinBeforeNext = false;
  for (const cp of codePoints) {
    if (cp === ZWNJ) {
      breakBeforeNext = true;
      joinBeforeNext = false;
      continue;
    }
    if (cp === ZWJ) {
      joinBeforeNext = true;
      breakBeforeNext = false;
      continue;
    }
    if (isCombiningMark(cp)) {
      const target = cells[cells.length - 1];
      if (target) target.marks.push(cp);
      // A leading mark with no base is dropped (nothing to attach to).
      continue;
    }
    const entry = JOINING_TABLE.get(cp) ?? null;
    cells.push({
      cp,
      entry,
      opaque: entry === null,
      marks: [],
      forceBreakBefore: breakBeforeNext,
      forceJoinBefore: joinBeforeNext,
    });
    breakBeforeNext = false;
    joinBeforeNext = false;
  }

  const joinsWithPrevious = (index: number): boolean => {
    if (index <= 0) return false;
    const current = cells[index] as Cell;
    const prev = cells[index - 1] as Cell;
    if (current.opaque || prev.opaque) return false;
    if (current.forceBreakBefore) return false;
    if (current.forceJoinBefore) return true;
    if (!current.entry || !prev.entry) return false;
    // Previous must join forward (dual) and current must join backward.
    return prev.entry.type === "D" && current.entry.type !== "U";
  };

  const joinsWithNext = (index: number): boolean =>
    index + 1 < cells.length && joinsWithPrevious(index + 1);

  // Choose contextual forms, fusing lam-alef pairs.
  const clusters: Cluster[] = [];
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i] as Cell;
    if (cell.opaque) {
      clusters.push({ base: cell.cp, marks: cell.marks, ligature: false });
      i += 1;
      continue;
    }
    // Lam-alef fusion: lam joined to a following alef variant.
    if (cell.cp === LAM && i + 1 < cells.length) {
      const next = cells[i + 1] as Cell;
      const ligature = LAM_ALEF_LIGATURES.get(next.cp);
      if (ligature && !next.opaque && joinsWithNext(i)) {
        const joinPrev = joinsWithPrevious(i);
        clusters.push({
          base: joinPrev ? ligature[1] : ligature[0],
          marks: [...cell.marks, ...next.marks],
          ligature: true,
        });
        i += 2;
        continue;
      }
    }
    const entry = cell.entry as JoiningEntry;
    const joinPrev = joinsWithPrevious(i);
    const joinNext = joinsWithNext(i);
    let form: number | null;
    if (joinPrev && joinNext) form = entry.forms[2] ?? entry.forms[0];
    else if (joinNext) form = entry.forms[1] ?? entry.forms[0];
    else if (joinPrev) form = entry.forms[3] ?? entry.forms[0];
    else form = entry.forms[0];
    clusters.push({ base: form ?? cell.cp, marks: cell.marks, ligature: false });
    i += 1;
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts one logical-order line into the visual-order string a
 * left-to-right renderer (`pdf-lib`) must draw.
 *
 * Pure left-to-right input (numbers, Latin identifiers such as invoice
 * numbers or IBANs) is returned unchanged. Anything containing Persian /
 * Arabic letters is shaped and bidi-reordered as described above.
 */
export function toVisualPersianText(input: string): string {
  if (input === "") return "";
  const codePoints = toCodePoints(input);
  const runs = segmentRuns(codePoints);
  const hasRtl = runs.some((run) => run.kind === "RTL");
  if (!hasRtl) return input;

  const ordered = [...runs].reverse();
  const out: number[] = [];
  for (const run of ordered) {
    if (run.kind === "RTL") {
      const clusters = shapeRtlRun(run.codePoints);
      for (let c = clusters.length - 1; c >= 0; c -= 1) {
        const cluster = clusters[c] as Cluster;
        // Opaque pass-through chars (brackets, punctuation) mirror; shaped
        // Arabic bases are never in the mirror map, so this is a no-op for
        // them. Combining marks are never mirrored.
        out.push(MIRROR_MAP.get(cluster.base) ?? cluster.base, ...cluster.marks);
      }
    } else if (run.kind === "LTR") {
      out.push(...run.codePoints);
    } else {
      for (const cp of run.codePoints) out.push(MIRROR_MAP.get(cp) ?? cp);
    }
  }
  return String.fromCodePoint(...out);
}
