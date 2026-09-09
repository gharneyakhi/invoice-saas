/**
 * Persian / Arabic bidirectional text pipeline for server-side PDF generation.
 *
 * `pdf-lib` delegates custom-font text layout to `fontkit`, whose `layout()`
 * has NO run-based bidi: it detects ONE script per `drawText` call (the first
 * non-Common/Inherited character) and, when that script is right-to-left
 * (Arabic, Hebrew, ...), FULLY REVERSES the glyph run after OpenType shaping
 * (see `OTLayoutEngine.position` in `@pdf-lib/fontkit`: `if
 * (glyphRun.direction === 'rtl') { glyphRun.glyphs.reverse(); ... }`).
 * Consequences, all verified against the bundled fontkit:
 *
 *   - pure Latin/digit strings pass through untouched;
 *   - pure Arabic-script strings come back in correct visual order AND with
 *     real GSUB shaping (contextual forms, lam-alef ligatures, ZWNJ breaks,
 *     mark positioning) — the font's own shaper does this correctly;
 *   - MIXED strings (Persian + Latin/digits) come back SCRAMBLED: Latin and
 *     digit runs are reversed along with everything else.
 *
 * So a single pre-reordered "visual string" can NEVER be drawn correctly —
 * this module therefore converts each logical line into an ordered list of
 * single-direction FRAGMENTS. The PDF renderer draws every fragment with its
 * own `drawText` call, in order, advancing x by the measured fragment width.
 * Each fragment carries the EXACT string fontkit must receive:
 *
 *   - `rtl`:   logical-order text (Arabic letters + neutrals, NO Latin and NO
 *              digits). fontkit reverses it into visual order and GSUB-shapes
 *              it. Brackets are pre-mirrored here because fontkit reverses
 *              but never mirrors.
 *   - `ltr`:   visual-order text with no Arabic-script characters (Latin,
 *              ASCII digits, punctuation). fontkit renders it as-is.
 *   - `ltr-rev`: visual-order text made ONLY of Arabic-script non-letters
 *              (Persian/Arabic-Indic digits, ٪ ، ...) — which WOULD trigger
 *              fontkit's RTL detection — passed PRE-REVERSED so fontkit's own
 *              reversal restores the intended order. Widths are unaffected
 *              (reversal preserves advances).
 *
 * The run segmentation below is an invoice-scoped subset of the Unicode bidi
 * algorithm: weak-type resolution (percent/decimal/thousands separators join
 * their number), N0-style bracket pairing (`(snapshot)` stays an LTR unit;
 * `(۱۰٪)` sits on the RTL side so `۲۰,۰۰۰ (۱۰٪)` shows `(۱۰٪) ۲۰,۰۰۰`),
 * neutral resolution by flanking runs, and mirroring. Pure and
 * dependency-free; fontkit itself is only touched by the renderer.
 */

const ZWNJ = 0x200c;
const ZWJ = 0x200d;

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
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06ed)
  );
}

/**
 * Arabic-script LETTERS (as opposed to digits/punctuation): core Arabic
 * (incl. hamza forms and tatweel U+0640), Persian extensions (پ چ ژ ک گ ی),
 * Arabic Supplement / Extended-A/B, and the presentation-forms blocks
 * (accepted pass-through on input).
 */
function isArabicLetter(cp: number): boolean {
  return (
    (cp >= 0x0621 && cp <= 0x064a) ||
    (cp >= 0x066e && cp <= 0x06d3) ||
    (cp >= 0x06fa && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x0870 && cp <= 0x089f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfefe)
  );
}

/**
 * Arabic-block PUNCTUATION: neutral for ordering purposes (NOT strong RTL —
 * classifying these as RTL is what used to split number runs apart and
 * scramble every percent/discount cell). Weak-type resolution below re-glues
 * the numeric ones (٪ ٫ ٬ ،) to adjacent digits.
 */
const ARABIC_PUNCTUATION = new Set<number>([
  0x060c, // ، ARABIC COMMA
  0x060d, // ؍ ARABIC DATE SEPARATOR
  0x060e, // ؎ ARABIC POETIC VERSE SIGN
  0x060f, // ؽ ARABIC SIGN MISRA
  0x061b, // ؛ ARABIC SEMICOLON
  0x061f, // ؟ ARABIC QUESTION MARK
  0x066a, // ٪ ARABIC PERCENT SIGN
  0x066b, // ٫ ARABIC DECIMAL SEPARATOR
  0x066c, // ٬ ARABIC THOUSANDS SEPARATOR
  0x066d, // ٭ ARABIC FIVE POINTED STAR
  0x06d4, // ۔ ARABIC FULL STOP
]);

const FORMAT_CHARS = new Set<number>([
  ZWNJ, // ZERO WIDTH NON-JOINER (joining break — the shaper needs it)
  ZWJ, // ZERO WIDTH JOINER
  0x061c, // ARABIC LETTER MARK
]);

function classify(cp: number): CharClass {
  if (FORMAT_CHARS.has(cp)) return "FORMAT";
  if (isCombiningMark(cp)) return "MARK";
  if (isDigit(cp)) return "NUMBER";
  if (ARABIC_PUNCTUATION.has(cp)) return "NEUTRAL";
  if (isLatinLetter(cp)) return "LATIN";
  if (isArabicLetter(cp)) return "RTL";
  return "NEUTRAL";
}

/**
 * True when the code point's Unicode script is one fontkit treats as
 * right-to-left (in practice: Script=Arabic). fontkit scans for the first
 * non-Common/Inherited/Unknown char and reverses the whole run when it is
 * Arabic-script — this predicate replicates that trigger so fragments can
 * compensate exactly.
 */
function firesFontkitRtl(cp: number): boolean {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x0870 && cp <= 0x089f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

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

function mirrorChar(cp: number): number {
  return MIRROR_MAP.get(cp) ?? cp;
}

/** Returns true when the text contains at least one Arabic-script letter. */
export function containsRtl(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (classify(cp) === "RTL") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Weak-type resolution (UBA W4/W5 flavour, invoice subset)
// ---------------------------------------------------------------------------

/** European-terminator style: joins a preceding number (`۹٪`, `10%`). */
const ET_CHARS = new Set<number>([
  0x0025, // % PERCENT SIGN
  0x066a, // ٪ ARABIC PERCENT SIGN
  0x2030, // ‰ PER MILLE SIGN
]);

/** Arabic separators that join a number only when BETWEEN two digits. */
const CS_ARABIC = new Set<number>([
  0x060c, // ،
  0x066b, // ٫
  0x066c, // ٬
]);

/**
 * Single left-to-right pass: an ET char whose resolved left neighbour is a
 * number becomes a number (backward chaining, so `۱۰٪٪` stays one run);
 * an Arabic CS char flanked by numbers on both sides becomes a number.
 * Everything else keeps its raw class.
 */
function resolveWeakTypes(codePoints: number[], raw: CharClass[]): CharClass[] {
  const out = [...raw];
  for (let i = 0; i < codePoints.length; i += 1) {
    const cp = codePoints[i] as number;
    if (ET_CHARS.has(cp) && i > 0 && out[i - 1] === "NUMBER") {
      out[i] = "NUMBER";
    } else if (
      CS_ARABIC.has(cp) &&
      i > 0 &&
      i + 1 < codePoints.length &&
      out[i - 1] === "NUMBER" &&
      raw[i + 1] === "NUMBER"
    ) {
      out[i] = "NUMBER";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bracket pairing (UBA N0 flavour, non-nested)
// ---------------------------------------------------------------------------

const BRACKET_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0x0028, 0x0029], // ( )
  [0x005b, 0x005d], // [ ]
  [0x007b, 0x007d], // { }
  [0x003c, 0x003e], // < >
];

/**
 * Matches opening brackets with their next same-type closing bracket
 * (first-match, no nesting in invoice scope) and classifies each pair by its
 * enclosed content, UBA-N0 style:
 *
 *   - enclosed Latin (no RTL): an LTR pair (`(snapshot)`, `[INV-1]`) — the
 *     whole span is one LTR run, drawn as-is;
 *   - enclosed numbers/neutrals only (or empty): embedding-side brackets
 *     (`(۱۰٪)`, `(۱۲۳)`) — in an RTL paragraph these sit on the RTL side, so
 *     they are emitted as RTL-kind runs (reversing block order while the
 *     number inside stays intact: `۲۰,۰۰۰ (۱۰٪)` shows `(۱۰٪) ۲۰,۰۰۰`);
 *   - enclosed RTL: plain neutral brackets that merge into / mirror with the
 *     surrounding RTL side (`(تومان)`).
 */
interface BracketPairs {
  /** openIndex -> closeIndex for LTR pairs (drawn as one LTR run). */
  ltrPairs: Map<number, number>;
  /** Indices of embedding-side (RTL-kind) brackets. */
  rtlSideBrackets: Set<number>;
}

function findBracketPairs(codePoints: number[], classes: CharClass[]): BracketPairs {
  const closeFor = new Map<number, number>(BRACKET_PAIRS.map(([o, c]) => [o, c]));
  const ltrPairs = new Map<number, number>();
  const rtlSideBrackets = new Set<number>();
  for (let i = 0; i < codePoints.length; i += 1) {
    const close = closeFor.get(codePoints[i] as number);
    if (close === undefined) continue;
    for (let j = i + 1; j < codePoints.length; j += 1) {
      if (codePoints[j] !== close) continue;
      let hasRtl = false;
      let hasLatin = false;
      for (let k = i + 1; k < j; k += 1) {
        if (classes[k] === "RTL") hasRtl = true;
        if (classes[k] === "LATIN") hasLatin = true;
      }
      if (!hasRtl && hasLatin) {
        ltrPairs.set(i, j);
      } else if (!hasRtl) {
        rtlSideBrackets.add(i);
        rtlSideBrackets.add(j);
      }
      break; // first-match only (no nesting in invoice scope)
    }
  }
  return { ltrPairs, rtlSideBrackets };
}

// ---------------------------------------------------------------------------
// Segmentation into directional runs
// ---------------------------------------------------------------------------

interface Run {
  kind: "RTL" | "LTR" | "NEUTRAL";
  /** Logical-order code points. */
  codePoints: number[];
}

function toCodePoints(text: string): number[] {
  const out: number[] = [];
  for (const char of text) out.push(char.codePointAt(0) ?? 0);
  return out;
}

/** Chunked `String.fromCodePoint` (spread would overflow the stack on huge input). */
function fromCodePoints(codePoints: number[]): string {
  let out = "";
  for (let i = 0; i < codePoints.length; i += 4096) {
    out += String.fromCodePoint(...codePoints.slice(i, i + 4096));
  }
  return out;
}

/** ASCII separators allowed *inside* a number run when surrounded by digits. */
function isIntraNumberSeparator(cp: number): boolean {
  return (
    cp === 0x002e || // .
    cp === 0x002c || // ,
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

/**
 * Splits logical text into directional runs and resolves neutrals:
 * a neutral run flanked by LTR content on both sides (mail@example.com,
 * card numbers with spaces, `a)b`) joins the LTR side unmirrored (N1);
 * a neutral run flanked by RTL joins the RTL side; boundary neutrals join
 * their neighbour EXCEPT mirrorable brackets, which stay standalone so they
 * are mirrored. Anything else stays a standalone neutral run.
 */
function segmentRuns(codePoints: number[], classes: CharClass[]): Run[] {
  const { ltrPairs, rtlSideBrackets } = findBracketPairs(codePoints, classes);

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
    const pairEnd = ltrPairs.get(i);
    if (pairEnd !== undefined) {
      for (let k = i; k <= pairEnd; k += 1) push("LTR", codePoints[k] as number);
      i = pairEnd + 1;
      continue;
    }
    if (rtlSideBrackets.has(i)) {
      // Embedding-side bracket (N0: pair encloses numbers/neutrals only):
      // an RTL-kind run so block order reverses around it.
      push("RTL", codePoints[i] as number);
      i += 1;
      continue;
    }

    const cp = codePoints[i] as number;
    const cls = classes[i] as CharClass;

    if (cls === "RTL") {
      push("RTL", cp);
      i += 1;
      continue;
    }
    if (cls === "MARK" || cls === "FORMAT") {
      // Marks/format chars ride with a preceding RTL run (ZWNJ inside
      // `می‌شود`); anywhere else they are neutral (a ZWNJ between Latin
      // letters must not flip the whole line to RTL).
      const last = raw[raw.length - 1];
      push(last && last.kind === "RTL" ? "RTL" : "NEUTRAL", cp);
      i += 1;
      continue;
    }
    if (cls === "LATIN" || cls === "NUMBER") {
      push("LTR", cp);
      i += 1;
      continue;
    }
    // NEUTRAL: glue into a neighbouring LTR token when it sits between two
    // LTR-able characters, otherwise its own neutral run.
    const prev = i > 0 ? (classes[i - 1] as CharClass) : null;
    const next = i + 1 < codePoints.length ? (classes[i + 1] as CharClass) : null;
    const prevLtr = prev === "LATIN" || prev === "NUMBER";
    const nextLtr = next === "LATIN" || next === "NUMBER";
    const prevDigit = prev === "NUMBER";
    const nextDigit = next === "NUMBER";

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
      // Email/domain style: merge with the neighbouring LTR runs (the next
      // LTR run merges in turn when the loop reaches... it does not — so
      // merge forward explicitly here). Unmirrored per N1.
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
      // Trailing neutral after LTR joins it — EXCEPT mirrorable brackets,
      // which are RTL-side (mirrored) per N2 and stay standalone.
      const prev = resolved[resolved.length - 1] as Run;
      const rest = run.codePoints.filter((cp) => !MIRROR_MAP.has(cp));
      const mirrors = run.codePoints.filter((cp) => MIRROR_MAP.has(cp));
      if (rest.length > 0) prev.codePoints.push(...rest);
      if (mirrors.length > 0) resolved.push({ kind: "NEUTRAL", codePoints: mirrors });
    } else if (prevKind === null && nextKind === "LTR") {
      // Leading neutral before LTR joins it — EXCEPT mirrorable brackets.
      const following = raw[r + 1] as Run;
      const rest = run.codePoints.filter((cp) => !MIRROR_MAP.has(cp));
      const mirrors = run.codePoints.filter((cp) => MIRROR_MAP.has(cp));
      if (rest.length > 0) following.codePoints.unshift(...rest);
      if (mirrors.length > 0) resolved.push({ kind: "NEUTRAL", codePoints: mirrors });
    } else {
      resolved.push(run);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Fragments (the drawable contract)
// ---------------------------------------------------------------------------

/**
 * One drawable piece of a logical line, in VISUAL (left-to-right) order.
 *
 *   - `rtl`:     logical-order text for fontkit to reverse + GSUB-shape.
 *                Contains Arabic-script letters; never Latin or digits.
 *   - `ltr`:     text fontkit renders as-is (no Arabic-script chars inside).
 *   - `ltr-rev`: text that WOULD trigger fontkit's RTL reversal (Persian /
 *                Arabic-Indic digits, ٪ ، ...), passed PRE-REVERSED so the
 *                render restores the intended order. Never contains Latin.
 *
 * Invariants (all covered by tests): no fragment mixes Arabic-script letters
 * with Latin/digits; every `rtl`/`ltr-rev` fragment triggers fontkit's RTL
 * path; every `ltr` fragment triggers its LTR path.
 */
export interface PdfTextFragment {
  text: string;
  direction: "rtl" | "ltr" | "ltr-rev";
}

/**
 * Splits LTR-run text into maximal fontkit-homogeneous sub-runs: spans
 * containing Arabic-script chars (which trigger fontkit's RTL reversal) are
 * emitted pre-reversed; everything else is emitted as-is.
 */
function splitLtrFragment(codePoints: number[]): PdfTextFragment[] {
  const out: PdfTextFragment[] = [];
  let i = 0;
  while (i < codePoints.length) {
    const firing = firesFontkitRtl(codePoints[i] as number);
    let j = i + 1;
    while (j < codePoints.length && firesFontkitRtl(codePoints[j] as number) === firing) {
      j += 1;
    }
    const slice = codePoints.slice(i, j);
    if (firing) {
      out.push({ direction: "ltr-rev", text: fromCodePoints([...slice].reverse()) });
    } else {
      out.push({ direction: "ltr", text: fromCodePoints(slice) });
    }
    i = j;
  }
  return out.filter((fragment) => fragment.text !== "");
}

/** Fast path: pure printable ASCII can never contain RTL (single LTR draw). */
function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Converts one logical-order line into the visual-order fragments the PDF
 * renderer must draw (one `drawText` call per fragment, left to right).
 *
 * Pure-LTR input yields LTR fragments in input order; anything containing
 * Arabic-script letters is bidi-reordered as described above. RTL fragments
 * keep logical text (fontkit shapes); LTR fragments keep visual text.
 */
export function shapePersianLine(input: string): PdfTextFragment[] {
  if (input === "") return [];
  if (isPrintableAscii(input)) return [{ text: input, direction: "ltr" }];

  const codePoints = toCodePoints(input);
  const classes = resolveWeakTypes(codePoints, codePoints.map(classify));
  const runs = segmentRuns(codePoints, classes);
  const hasRtl = runs.some((run) => run.kind === "RTL");
  if (!hasRtl) {
    // No reordering — but the line may still contain Arabic-script digits /
    // punctuation (۱۲۳, ٪) that trigger fontkit's RTL path, so split it.
    return splitLtrFragment(codePoints);
  }

  interface Work {
    kind: "RTL" | "LTR";
    codePoints: number[];
  }

  const ordered = [...runs].reverse();
  const visual: Work[] = [];
  // A standalone neutral run has embedding (RTL-paragraph) direction, so in
  // visual order its internal order is reversed and mirrored (N2): logical
  // `موبایل: 0912` shows the `: ` as ` :` between the runs.
  const toVisualNeutral = (cps: number[]): number[] =>
    [...cps].reverse().map(mirrorChar);
  let pendingLeading: number[] | null = null;

  for (const run of ordered) {
    if (run.kind === "NEUTRAL") {
      const visualNeutral = toVisualNeutral(run.codePoints);
      const prev = visual[visual.length - 1];
      if (!prev) {
        pendingLeading = [...(pendingLeading ?? []), ...visualNeutral];
        continue;
      }
      if (prev.kind === "LTR") {
        prev.codePoints.push(...visualNeutral);
      } else {
        // RTL fragments are drawn logical (fontkit reverses): prepend the
        // neutral part in the order that reversal restores.
        prev.codePoints.unshift(...[...visualNeutral].reverse());
      }
      continue;
    }
    if (run.kind === "RTL") {
      // Own chars mirrored exactly once (unpaired brackets merged into the
      // run); attached neutral parts were already mirrored at attach time.
      const frag: Work = { kind: "RTL", codePoints: run.codePoints.map(mirrorChar) };
      if (pendingLeading) {
        frag.codePoints.push(...[...pendingLeading].reverse());
        pendingLeading = null;
      }
      visual.push(frag);
      continue;
    }
    const frag: Work = { kind: "LTR", codePoints: [...run.codePoints] };
    if (pendingLeading) {
      frag.codePoints.unshift(...pendingLeading);
      pendingLeading = null;
    }
    visual.push(frag);
  }
  if (pendingLeading) {
    // Defensive: a line of only neutral runs with hasRtl true is impossible
    // (neutral runs never set hasRtl), but never drop text.
    visual.push({ kind: "LTR", codePoints: pendingLeading });
  }

  const fragments: PdfTextFragment[] = [];
  for (const frag of visual) {
    if (frag.kind === "RTL") {
      if (frag.codePoints.length === 0) continue;
      if (frag.codePoints.some((cp) => firesFontkitRtl(cp))) {
        fragments.push({ direction: "rtl", text: fromCodePoints(frag.codePoints) });
      } else {
        // RTL-kind run with no Arabic-script char (an embedding-side bracket
        // pair's punctuation, e.g. ` )` in `۲۰,۰۰۰ (۱۰٪)`): fontkit would
        // NOT reverse it, so emit it in visual order directly as LTR.
        fragments.push({
          direction: "ltr",
          text: fromCodePoints([...frag.codePoints].reverse()),
        });
      }
    } else {
      fragments.push(...splitLtrFragment(frag.codePoints));
    }
  }
  return fragments;
}
