/**
 * PDF inspection tooling for the export pipeline.
 *
 * `parsePdfText` extracts the ACTUAL glyph stream from a generated PDF —
 * content-stream show operations, CTM-transformed positions, `/W` advances,
 * and `/ToUnicode` mappings — and `renderSvgPage` re-renders those glyphs
 * (at their PDF positions, with the real font outlines) as SVG for human
 * visual inspection.
 *
 * Why this exists: unit tests over intermediate shaping strings cannot prove
 * what a PDF viewer shows. These tools let the regression suite assert on the
 * real artifact (glyph codes in show operations) and let engineers look at a
 * faithful rendering without a PDF viewer.
 *
 * Scope: this is a purpose-built reader for pdf-lib's deterministic output,
 * NOT a general PDF parser. It understands exactly what our renderer emits:
 * Flate-encoded content streams, `/Type0` subset fonts with `/ToUnicode` and
 * `/W`, `BT/ET` text blocks with `Tf/Tm/Tj/TJ`, `cm`-positioned filled paths,
 * and `m/l/S` hairlines. Anything outside that is ignored or throws.
 *
 * Verified against real pdf-lib output (see the probe notes in
 * `glpyhOrder.test.ts`): `drawRectangle` emits `q/rg/cm/m/l/h/f/Q` (NOT the
 * `re` operator), `drawLine` emits `m/l/S`, every op block is wrapped in
 * `q/Q`, and font resource names carry a random numeric suffix.
 */

import { inflateSync } from "node:zlib";
import type { Font as KitFont } from "@pdf-lib/fontkit";
import { resolveParagraph, sanitizeForBidi, visualRunsForParagraph } from "./bidi";
import { RTL_BASE, prepareRun, type PreparedRun } from "./persianText";

// ---------------------------------------------------------------------------
// Parsed model.
// ---------------------------------------------------------------------------

/** One glyph emitted by a content-stream show operation. */
export interface ParsedGlyph {
  /** CID (subset code) as shown in the `Tj` string. */
  code: number;
  /** Unicode text for the code per `/ToUnicode` (ligatures yield 2+ chars). */
  chars: string;
  /** Baseline origin in PDF points (bottom-left origin), CTM-transformed. */
  x: number;
  y: number;
  /** Font size in points (`Tf`). */
  size: number;
  /** Resource font name (e.g. `F1`) and base font, for regular/bold checks. */
  fontRef: string;
  baseFont: string;
}

export interface ParsedPoint {
  x: number;
  y: number;
}

/** A filled path (`f`), points already transformed by the CTM. */
export interface ParsedFill {
  points: ParsedPoint[];
  closed: boolean;
  r: number;
  g: number;
  b: number;
}

/** A stroked path (`S`), points already transformed by the CTM. */
export interface ParsedStroke {
  points: ParsedPoint[];
  width: number;
  r: number;
  g: number;
  b: number;
}

export interface ParsedPage {
  index: number;
  width: number;
  height: number;
  glyphs: ParsedGlyph[];
  fills: ParsedFill[];
  strokes: ParsedStroke[];
}

export interface ParsedPdf {
  pages: ParsedPage[];
}

// ---------------------------------------------------------------------------
// Low-level object scan (Length-aware so binary streams cannot desync it).
// ---------------------------------------------------------------------------

interface RawObject {
  num: number;
  /** Dictionary source between `<<` and `>>` ("" when the object has none). */
  dict: string;
  /** Raw (still encoded) stream bytes, or null when there is no stream. */
  stream: Uint8Array | null;
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

interface ObjectHeader {
  num: number;
  bodyStart: number;
  end: number;
}

function collectObjects(pdf: Uint8Array): Map<number, RawObject> {
  const text = latin1(pdf);
  const objects = new Map<number, RawObject>();
  const headerPattern = /(\d+)\s+(\d+)\s+obj\b/g;
  const headers: ObjectHeader[] = [];
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(text)) !== null) {
    const num = Number.parseInt(match[1] ?? "0", 10);
    headers.push({ num, bodyStart: match.index + match[0].length, end: text.length });
  }
  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i];
    if (!current) continue;
    const next = headers[i + 1];
    const endMarker = text.indexOf("endobj", current.bodyStart);
    // `endobj` may theoretically appear inside Flate binary; the next header
    // caps the search, and stream slicing below uses /Length regardless.
    let end = endMarker >= 0 ? endMarker : text.length;
    if (next && next.bodyStart < end) end = next.bodyStart;
    current.end = end;
  }
  // Pass 1: dictionaries + integer objects (indirect /Length targets).
  const bodies = new Map<number, string>();
  const intValues = new Map<number, number>();
  for (const header of headers) {
    const body = text.slice(header.bodyStart, header.end);
    bodies.set(header.num, body);
    const asInt = /^\s*(\d+)\s*$/.exec(body);
    if (asInt?.[1]) intValues.set(header.num, Number.parseInt(asInt[1], 10));
  }
  // Pass 2: streams, sliced exactly by resolved /Length.
  for (const header of headers) {
    const body = bodies.get(header.num) ?? "";
    const dict = extractDict(body);
    let stream: Uint8Array | null = null;
    const streamMarker = body.indexOf("stream");
    if (streamMarker >= 0 && /stream\r?\n/.test(body.slice(streamMarker, streamMarker + 8))) {
      const dataStart = body.indexOf("\n", streamMarker) + 1;
      const absStart = header.bodyStart + dataStart;
      const length = resolveLength(dict, intValues);
      if (length !== null && absStart + length <= pdf.length) {
        stream = pdf.slice(absStart, absStart + length);
      } else {
        const endStream = body.lastIndexOf("endstream");
        if (endStream > dataStart) stream = pdf.slice(absStart, header.bodyStart + endStream);
      }
    }
    objects.set(header.num, { num: header.num, dict, stream });
  }
  unpackObjectStreams(objects);
  return objects;
}

/**
 * Merges objects packed in `/ObjStm` object streams into the map.
 *
 * pdf-lib saves with object streams by default: page dicts, font dicts, and
 * similar small objects live compressed inside `/ObjStm` streams rather than
 * as top-level bodies. Streams themselves (content, embedded fonts, CMaps)
 * always stay top-level, so only dictionaries need unpacking here.
 */
function unpackObjectStreams(objects: Map<number, RawObject>): void {
  for (const raw of objects.values()) {
    if (!/\/Type\s*\/ObjStm/.test(raw.dict)) continue;
    const count = /\/N\s+(\d+)/.exec(raw.dict)?.[1];
    const first = /\/First\s+(\d+)/.exec(raw.dict)?.[1];
    if (count === undefined || first === undefined) continue;
    const total = Number.parseInt(count, 10);
    const base = Number.parseInt(first, 10);
    const data = latin1(decodeStream(raw, objects));
    const numbers = data.slice(0, base).trim().split(/\s+/).map(Number);
    for (let k = 0; k < total; k += 1) {
      const num = numbers[k * 2];
      const offset = numbers[k * 2 + 1];
      const next = k + 1 < total ? numbers[k * 2 + 3] : data.length - base;
      if (num === undefined || offset === undefined || next === undefined) continue;
      const body = data.slice(base + offset, base + next);
      objects.set(num, { num, dict: extractDict(body), stream: null });
    }
  }
}

/** Balances nested `<< >>` pairs (Resources holds nested dicts). */
function extractDict(body: string): string {
  const dictStart = body.indexOf("<<");
  if (dictStart < 0) return "";
  let depth = 0;
  let cursor = dictStart;
  while (cursor < body.length) {
    if (body.startsWith("<<", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (body.startsWith(">>", cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) break;
    } else {
      cursor += 1;
    }
  }
  return body.slice(dictStart + 2, cursor - 2);
}

function resolveLength(dict: string, intValues: Map<number, number>): number | null {
  // NOTE: the indirect form must be tested first — `/Length 12 0 R` would
  // otherwise match the direct pattern and slice 12 bytes of binary.
  const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict);
  if (indirect?.[1]) return intValues.get(Number.parseInt(indirect[1], 10)) ?? null;
  const direct = /\/Length\s+(\d+)/.exec(dict);
  if (direct?.[1]) return Number.parseInt(direct[1], 10);
  return null;
}

function decodeStream(raw: RawObject, _objects: Map<number, RawObject>): Uint8Array {
  if (!raw.stream) return new Uint8Array();
  const filters: string[] = [];
  const filterMatch = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(raw.dict);
  if (filterMatch?.[1]) {
    const namePattern = /\/(\w+)/g;
    let name: RegExpExecArray | null;
    while ((name = namePattern.exec(filterMatch[1])) !== null) {
      if (name[1]) filters.push(name[1]);
    }
  }
  let data = raw.stream;
  for (const filter of filters) {
    if (filter === "FlateDecode") data = inflateSync(data);
    else throw new Error(`[pdf-inspect] unsupported stream filter: ${filter}`);
  }
  return data;
}

function refTarget(dict: string, key: string): number | null {
  const match = new RegExp(`${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function refTargets(dict: string, key: string): number[] {
  const match = new RegExp(`${key}\\s*\\[([^\\]]*)\\]`).exec(dict);
  if (!match?.[1]) {
    const single = refTarget(dict, key);
    return single === null ? [] : [single];
  }
  const targets: number[] = [];
  const pattern = /(\d+)\s+\d+\s+R/g;
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(match[1])) !== null) {
    if (found[1]) targets.push(Number.parseInt(found[1], 10));
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Font resources: /ToUnicode + /W.
// ---------------------------------------------------------------------------

interface InspectFont {
  baseFont: string;
  toUnicode: Map<number, string>;
  widths: Map<number, number>;
  defaultWidth: number;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Big-endian UTF-16 (possibly with surrogate pairs) → string. */
function utf16beToString(bytes: Uint8Array): string {
  const swapped = Buffer.alloc(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1] ?? 0;
    swapped[i + 1] = bytes[i] ?? 0;
  }
  return swapped.toString("utf16le");
}

function parseToUnicode(data: Uint8Array): Map<number, string> {
  const text = latin1(data);
  const mapping = new Map<number, string>();
  const takeBlocks = (begin: string, end: string): string[] => {
    const blocks: string[] = [];
    let cursor = 0;
    while (true) {
      const start = text.indexOf(begin, cursor);
      if (start < 0) break;
      const stop = text.indexOf(end, start);
      if (stop < 0) break;
      blocks.push(text.slice(start + begin.length, stop));
      cursor = stop + end.length;
    }
    return blocks;
  };
  for (const block of takeBlocks("beginbfchar", "endbfchar")) {
    const pattern = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g;
    let entry: RegExpExecArray | null;
    while ((entry = pattern.exec(block)) !== null) {
      const code = Number.parseInt((entry[1] ?? "").replace(/\s+/g, ""), 16);
      mapping.set(code, utf16beToString(hexToBytes(entry[2] ?? "")));
    }
  }
  for (const block of takeBlocks("beginbfrange", "endbfrange")) {
    // Array form first: `<lo> <hi> [<u1> <u2> ...]` (consumed spans removed
    // before the range form runs so entries cannot double-count).
    const arraySlices: Array<{ start: number; end: number }> = [];
    const arrayForm = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*\[([^\]]*)\]/g;
    let entry: RegExpExecArray | null;
    while ((entry = arrayForm.exec(block)) !== null) {
      const low = Number.parseInt((entry[1] ?? "").replace(/\s+/g, ""), 16);
      const itemPattern = /<([0-9A-Fa-f\s]+)>/g;
      let item: RegExpExecArray | null;
      let offset = 0;
      while ((item = itemPattern.exec(entry[3] ?? "")) !== null) {
        mapping.set(low + offset, utf16beToString(hexToBytes(item[1] ?? "")));
        offset += 1;
      }
      arraySlices.push({ start: entry.index, end: arrayForm.lastIndex });
    }
    let stripped = block;
    for (let i = arraySlices.length - 1; i >= 0; i -= 1) {
      const slice = arraySlices[i];
      if (slice) stripped = stripped.slice(0, slice.start) + stripped.slice(slice.end);
    }
    const rangeForm = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g;
    while ((entry = rangeForm.exec(stripped)) !== null) {
      const low = Number.parseInt((entry[1] ?? "").replace(/\s+/g, ""), 16);
      const high = Number.parseInt((entry[2] ?? "").replace(/\s+/g, ""), 16);
      const dst = hexToBytes(entry[3] ?? "");
      const base = dst.length >= 2 ? ((dst[dst.length - 2] ?? 0) << 8) + (dst[dst.length - 1] ?? 0) : 0;
      const prefix = dst.slice(0, Math.max(0, dst.length - 2));
      for (let code = low; code <= high; code += 1) {
        const value = base + (code - low);
        const full = new Uint8Array(prefix.length + 2);
        full.set(prefix, 0);
        full[prefix.length] = (value >> 8) & 0xff;
        full[prefix.length + 1] = value & 0xff;
        mapping.set(code, utf16beToString(full));
      }
    }
  }
  return mapping;
}

function parseWidthsArray(dict: string): { widths: Map<number, number>; defaultWidth: number } {
  const widths = new Map<number, number>();
  let defaultWidth = 1000;
  const dwMatch = /\/DW\s+(\d+)/.exec(dict);
  if (dwMatch?.[1]) defaultWidth = Number.parseInt(dwMatch[1], 10);
  const wMatch = /\/W\s*\[/.exec(dict);
  if (!wMatch || wMatch.index === undefined) return { widths, defaultWidth };
  let cursor = wMatch.index + wMatch[0].length - 1;
  let depth = 0;
  const start = cursor;
  while (cursor < dict.length) {
    const char = dict[cursor];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
    cursor += 1;
  }
  const body = dict.slice(start + 1, cursor);
  // Entries are `c [w ...]` runs or `cfirst clast w` triples.
  const tokenPattern = /(\[)|(\])|(-?\d+(?:\.\d+)?)/g;
  const tokens: Array<{ bracket: string } | { num: number }> = [];
  let token: RegExpExecArray | null;
  while ((token = tokenPattern.exec(body)) !== null) {
    if (token[1] !== undefined || token[2] !== undefined) tokens.push({ bracket: token[1] ?? token[2] ?? "" });
    else tokens.push({ num: Number.parseFloat(token[3] ?? "0") });
  }
  let i = 0;
  while (i < tokens.length) {
    const first = tokens[i];
    if (!first || !("num" in first)) {
      i += 1;
      continue;
    }
    const second = tokens[i + 1];
    if (second && "bracket" in second && second.bracket === "[") {
      let code = first.num;
      let j = i + 2;
      while (j < tokens.length) {
        const entry = tokens[j];
        if (!entry) break;
        if ("bracket" in entry) {
          j += 1;
          break;
        }
        widths.set(code, entry.num);
        code += 1;
        j += 1;
      }
      i = j;
    } else if (second && "num" in second) {
      const third = tokens[i + 2];
      if (third && "num" in third) {
        for (let code = first.num; code <= second.num; code += 1) widths.set(code, third.num);
        i += 3;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return { widths, defaultWidth };
}

function loadInspectFont(fontObj: RawObject, objects: Map<number, RawObject>): InspectFont {
  const baseMatch = /\/BaseFont\s*\/([^\s/[\]()<>]+)/.exec(fontObj.dict);
  const baseFont = baseMatch?.[1] ?? "?";
  let toUnicode = new Map<number, string>();
  const cmapNum = refTarget(fontObj.dict, "/ToUnicode");
  if (cmapNum !== null) {
    const cmapObj = objects.get(cmapNum);
    if (cmapObj) toUnicode = parseToUnicode(decodeStream(cmapObj, objects));
  }
  let widths = new Map<number, number>();
  let defaultWidth = 1000;
  const descendants = refTargets(fontObj.dict, "/DescendantFonts");
  const firstDescendant = descendants[0];
  if (firstDescendant !== undefined) {
    const descendant = objects.get(firstDescendant);
    if (descendant) {
      const parsed = parseWidthsArray(descendant.dict);
      widths = parsed.widths;
      defaultWidth = parsed.defaultWidth;
    }
  }
  return { baseFont, toUnicode, widths, defaultWidth };
}

// ---------------------------------------------------------------------------
// Content-stream walk.
// ---------------------------------------------------------------------------

type ContentToken =
  | { kind: "hex"; bytes: Uint8Array }
  | { kind: "literal"; bytes: Uint8Array }
  | { kind: "name"; value: string }
  | { kind: "number"; value: number }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "op"; value: string };

function tokenizeContent(data: Uint8Array): ContentToken[] {
  const text = latin1(data);
  const tokens: ContentToken[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (char === "" || char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\0") {
      i += 1;
      continue;
    }
    if (char === "%") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === "<" && text[i + 1] !== "<") {
      const end = text.indexOf(">", i);
      if (end < 0) break;
      tokens.push({ kind: "hex", bytes: hexToBytes(text.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (char === "(") {
      const out: number[] = [];
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        const current = text[j] ?? "";
        if (current === "\\") {
          const next = text[j + 1] ?? "";
          if (next === "n") out.push(10);
          else if (next === "r") out.push(13);
          else if (next === "t") out.push(9);
          else if (next === "b") out.push(8);
          else if (next === "f") out.push(12);
          else if (next === "(") out.push(40);
          else if (next === ")") out.push(41);
          else if (next === "\\") out.push(92);
          else if (next === "\n") {
            // Line continuation: nothing.
          } else if (next >= "0" && next <= "7") {
            const octal = text.slice(j + 1, j + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
            out.push(Number.parseInt(octal, 8));
            j += octal.length;
          } else if (next !== "") {
            out.push(next.charCodeAt(0));
          }
          j += 2;
        } else if (current === "(") {
          depth += 1;
          out.push(40);
          j += 1;
        } else if (current === ")") {
          depth -= 1;
          if (depth > 0) out.push(41);
          j += 1;
        } else {
          out.push(current.charCodeAt(0));
          j += 1;
        }
      }
      tokens.push({ kind: "literal", bytes: Uint8Array.from(out) });
      i = j;
      continue;
    }
    if (char === "/") {
      let j = i + 1;
      while (j < text.length && !/[ \t\n\r\f\0()<>[\]/%]/.test(text[j] ?? "")) j += 1;
      tokens.push({ kind: "name", value: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (char === "[") {
      tokens.push({ kind: "open" });
      i += 1;
      continue;
    }
    if (char === "]") {
      tokens.push({ kind: "close" });
      i += 1;
      continue;
    }
    const numberMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i));
    if (numberMatch) {
      tokens.push({ kind: "number", value: Number.parseFloat(numberMatch[0]) });
      i += numberMatch[0].length;
      continue;
    }
    let j = i;
    while (j < text.length && !/[ \t\n\r\f\0()<>[\]/%]/.test(text[j] ?? "")) j += 1;
    const word = text.slice(i, Math.max(j, i + 1));
    tokens.push(word === "<<" || word === ">>" ? { kind: "op", value: word } : { kind: "op", value: word });
    i = Math.max(j, i + 1);
  }
  return tokens;
}

interface Matrix6 {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY_MATRIX: Matrix6 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** PDF concat: result = m × base (m left-multiplied, row-vector convention). */
function applyMatrix(m: Matrix6, base: Matrix6): Matrix6 {
  return {
    a: m.a * base.a + m.b * base.c,
    b: m.a * base.b + m.b * base.d,
    c: m.c * base.a + m.d * base.c,
    d: m.c * base.b + m.d * base.d,
    e: m.e * base.a + m.f * base.c + base.e,
    f: m.e * base.b + m.f * base.d + base.f,
  };
}

function translation(dx: number, dy: number): Matrix6 {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
}

type Operand =
  | { t: "num"; v: number }
  | { t: "str"; bytes: Uint8Array }
  | { t: "name"; v: string }
  | { t: "array"; items: Array<{ str: Uint8Array } | { num: number }> };

interface GraphicsState {
  ctm: Matrix6;
  fill: [number, number, number];
  stroke: [number, number, number];
  lineWidth: number;
}

interface TextState {
  inText: boolean;
  font: string;
  size: number;
  tm: Matrix6;
  lm: Matrix6;
}

function freshGraphics(): GraphicsState {
  return { ctm: { ...IDENTITY_MATRIX }, fill: [0, 0, 0], stroke: [0, 0, 0], lineWidth: 1 };
}

function freshText(): TextState {
  return { inText: false, font: "", size: 0, tm: { ...IDENTITY_MATRIX }, lm: { ...IDENTITY_MATRIX } };
}

function transformPoint(m: Matrix6, x: number, y: number): ParsedPoint {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

function walkContent(
  data: Uint8Array,
  fonts: Map<string, InspectFont>,
  glyphs: ParsedGlyph[],
  fills: ParsedFill[],
  strokes: ParsedStroke[],
): void {
  const tokens = tokenizeContent(data);
  const stack: Operand[] = [];
  const graphicsStack: GraphicsState[] = [freshGraphics()];
  const graphics = (): GraphicsState => graphicsStack[graphicsStack.length - 1] ?? freshGraphics();
  const text = freshText();
  let path: ParsedPoint[] = [];
  let pathClosed = false;
  let array: { items: Array<{ str: Uint8Array } | { num: number }>; depth: number } | null = null;

  const takeNumbers = (count: number): number[] => {
    const values: number[] = [];
    for (let k = 0; k < count; k += 1) {
      const operand = stack.pop();
      values.unshift(operand && operand.t === "num" ? operand.v : 0);
    }
    return values;
  };
  const takeStrings = (count: number): Uint8Array[] => {
    const values: Uint8Array[] = [];
    for (let k = 0; k < count; k += 1) {
      const operand = stack.pop();
      values.unshift(operand && operand.t === "str" ? operand.bytes : new Uint8Array());
    }
    return values;
  };

  const showBytes = (bytes: Uint8Array): void => {
    const font = fonts.get(text.font);
    const device = applyMatrix(text.tm, graphics().ctm);
    let penX = device.e;
    const penY = device.f;
    if (font && font.toUnicode.size > 0) {
      // Identity-H subset font: codes are 2 bytes wide.
      for (let o = 0; o + 1 < bytes.length; o += 2) {
        const code = ((bytes[o] ?? 0) << 8) + (bytes[o + 1] ?? 0);
        const width = font.widths.get(code) ?? font.defaultWidth;
        glyphs.push({
          code,
          chars: font.toUnicode.get(code) ?? "",
          x: penX,
          y: penY,
          size: text.size,
          fontRef: text.font,
          baseFont: font.baseFont,
        });
        penX += (width / 1000) * text.size;
      }
    } else {
      // Simple font fallback (never emitted by our renderer): 1 byte/code.
      for (let o = 0; o < bytes.length; o += 1) {
        const code = bytes[o] ?? 0;
        glyphs.push({
          code,
          chars: String.fromCharCode(code),
          x: penX,
          y: penY,
          size: text.size,
          fontRef: text.font,
          baseFont: font?.baseFont ?? "?",
        });
        penX += 0.5 * text.size;
      }
    }
    // Advance the text matrix along its own baseline by the run width.
    const runWidth = penX - device.e;
    const baseline = Math.hypot(text.tm.a, text.tm.b) || 1;
    text.tm = applyMatrix(translation(runWidth / baseline, 0), text.tm);
  };

  for (const token of tokens) {
    if (token.kind === "number") {
      if (array) array.items.push({ num: token.value });
      else stack.push({ t: "num", v: token.value });
      continue;
    }
    if (token.kind === "hex" || token.kind === "literal") {
      if (array) array.items.push({ str: token.bytes });
      else stack.push({ t: "str", bytes: token.bytes });
      continue;
    }
    if (token.kind === "name") {
      if (!array) stack.push({ t: "name", v: token.value });
      continue;
    }
    if (token.kind === "open") {
      if (array) array.depth += 1;
      else array = { items: [], depth: 0 };
      continue;
    }
    if (token.kind === "close") {
      if (array && array.depth > 0) array.depth -= 1;
      else if (array) {
        stack.push({ t: "array", items: array.items });
        array = null;
      }
      continue;
    }
    const op = token.value;
    if (op === "q") {
      const current = graphics();
      graphicsStack.push({
        ctm: { ...current.ctm },
        fill: [...current.fill],
        stroke: [...current.stroke],
        lineWidth: current.lineWidth,
      });
    } else if (op === "Q") {
      if (graphicsStack.length > 1) graphicsStack.pop();
    } else if (op === "cm") {
      const nums = takeNumbers(6);
      const state = graphics();
      state.ctm = applyMatrix(
        {
          a: nums[0] ?? 1,
          b: nums[1] ?? 0,
          c: nums[2] ?? 0,
          d: nums[3] ?? 1,
          e: nums[4] ?? 0,
          f: nums[5] ?? 0,
        },
        state.ctm,
      );
    } else if (op === "rg" || op === "RG") {
      const nums = takeNumbers(3);
      const state = graphics();
      const color: [number, number, number] = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
      if (op === "rg") state.fill = color;
      else state.stroke = color;
    } else if (op === "g" || op === "G") {
      const nums = takeNumbers(1);
      const state = graphics();
      const gray = nums[0] ?? 0;
      if (op === "g") state.fill = [gray, gray, gray];
      else state.stroke = [gray, gray, gray];
    } else if (op === "w") {
      graphics().lineWidth = takeNumbers(1)[0] ?? 1;
    } else if (op === "m") {
      const nums = takeNumbers(2);
      const point = transformPoint(graphics().ctm, nums[0] ?? 0, nums[1] ?? 0);
      path = [point];
      pathClosed = false;
    } else if (op === "l") {
      const nums = takeNumbers(2);
      path.push(transformPoint(graphics().ctm, nums[0] ?? 0, nums[1] ?? 0));
    } else if (op === "h") {
      pathClosed = true;
    } else if (op === "re") {
      const nums = takeNumbers(4);
      const [x, y, w, h] = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0];
      const ctm = graphics().ctm;
      path = [
        transformPoint(ctm, x, y),
        transformPoint(ctm, x + w, y),
        transformPoint(ctm, x + w, y + h),
        transformPoint(ctm, x, y + h),
      ];
      pathClosed = true;
    } else if (op === "f" || op === "F" || op === "f*" || op === "B" || op === "B*") {
      const state = graphics();
      if (path.length > 0) {
        fills.push({ points: path, closed: pathClosed, r: state.fill[0], g: state.fill[1], b: state.fill[2] });
      }
      if ((op === "B" || op === "B*") && path.length > 0) {
        strokes.push({
          points: path,
          width: state.lineWidth,
          r: state.stroke[0],
          g: state.stroke[1],
          b: state.stroke[2],
        });
      }
      path = [];
      pathClosed = false;
    } else if (op === "S" || op === "s") {
      const state = graphics();
      if (path.length > 0) {
        strokes.push({
          points: path,
          width: state.lineWidth,
          r: state.stroke[0],
          g: state.stroke[1],
          b: state.stroke[2],
        });
      }
      path = [];
      pathClosed = false;
    } else if (op === "n") {
      path = [];
      pathClosed = false;
    } else if (op === "BT") {
      text.inText = true;
      text.tm = { ...IDENTITY_MATRIX };
      text.lm = { ...IDENTITY_MATRIX };
    } else if (op === "ET") {
      text.inText = false;
    } else if (op === "Tf") {
      const sizeOperand = stack.pop();
      const nameOperand = stack.pop();
      text.font = nameOperand && nameOperand.t === "name" ? nameOperand.v : "";
      text.size = sizeOperand && sizeOperand.t === "num" ? sizeOperand.v : 0;
    } else if (op === "Tm") {
      const nums = takeNumbers(6);
      text.tm = {
        a: nums[0] ?? 1,
        b: nums[1] ?? 0,
        c: nums[2] ?? 0,
        d: nums[3] ?? 1,
        e: nums[4] ?? 0,
        f: nums[5] ?? 0,
      };
      text.lm = { ...text.tm };
    } else if (op === "Td" || op === "TD") {
      const nums = takeNumbers(2);
      text.lm = applyMatrix(translation(nums[0] ?? 0, nums[1] ?? 0), text.lm);
      text.tm = { ...text.lm };
    } else if (op === "T*") {
      text.lm = applyMatrix(translation(0, -12), text.lm);
      text.tm = { ...text.lm };
    } else if (op === "Tj") {
      showBytes(takeStrings(1)[0] ?? new Uint8Array());
    } else if (op === "'") {
      text.lm = applyMatrix(translation(0, -12), text.lm);
      text.tm = { ...text.lm };
      showBytes(takeStrings(1)[0] ?? new Uint8Array());
    } else if (op === "\"") {
      takeNumbers(2);
      text.lm = applyMatrix(translation(0, -12), text.lm);
      text.tm = { ...text.lm };
      showBytes(takeStrings(1)[0] ?? new Uint8Array());
    } else if (op === "TJ") {
      const operand = stack.pop();
      if (operand && operand.t === "array") {
        for (const item of operand.items) {
          if ("str" in item) showBytes(item.str);
          else {
            // TJ kerning numbers shift the pen left (thousandths of em).
            const shift = (item.num / 1000) * text.size;
            const baseline = Math.hypot(text.tm.a, text.tm.b) || 1;
            text.tm = applyMatrix(translation(-shift / baseline, 0), text.tm);
          }
        }
      }
    } else {
      // Ignored: TL/Tc/Tw/Tz/Tr/Ts/TL, d/J/j/M/ri/i/gs, BX/EX, Do, sh, notes.
      stack.length = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Document assembly.
// ---------------------------------------------------------------------------

function parseMediaBox(pageDict: string, objects: Map<number, RawObject>): { width: number; height: number } {
  const direct = /\/MediaBox\s*\[\s*([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s*\]/.exec(pageDict);
  if (direct?.[3] && direct[4]) {
    return { width: Number.parseFloat(direct[3]), height: Number.parseFloat(direct[4]) };
  }
  const ref = refTarget(pageDict, "/MediaBox");
  if (ref !== null) {
    const target = objects.get(ref);
    if (target) return parseMediaBox(target.dict, objects);
  }
  return { width: 595, height: 842 };
}

function parseFontResources(pageDict: string, objects: Map<number, RawObject>): Map<string, InspectFont> {
  const fonts = new Map<string, InspectFont>();
  let resources = pageDict;
  if (!/\/Font\b/.test(resources)) {
    const resNum = refTarget(pageDict, "/Resources");
    if (resNum === null) return fonts;
    resources = objects.get(resNum)?.dict ?? "";
  }
  // Balance the /Font inner dict (a lazy `>>` match would stop at the first
  // nested close and drop entries when /Font is not the first key).
  const fontAt = resources.indexOf("/Font");
  if (fontAt < 0) return fonts;
  const openAt = resources.indexOf("<<", fontAt);
  if (openAt < 0) return fonts;
  const fontBlock = extractDict(resources.slice(Math.max(0, openAt - 2)));
  const pairPattern = /\/(\S+)\s+(\d+)\s+\d+\s+R/g;
  let pair: RegExpExecArray | null;
  while ((pair = pairPattern.exec(fontBlock)) !== null) {
    const name = pair[1];
    const num = pair[2];
    if (!name || !num) continue;
    const fontObj = objects.get(Number.parseInt(num, 10));
    if (fontObj) fonts.set(name, loadInspectFont(fontObj, objects));
  }
  return fonts;
}

/**
 * Parses a generated PDF into positioned glyphs, fills, and strokes.
 * Throws on malformed input (this is verification tooling: silence would be a
 * lie). Accepts `Uint8Array` or `Buffer`.
 */
export function parsePdfText(bytes: Uint8Array): ParsedPdf {
  const objects = collectObjects(bytes);
  const pageNums: number[] = [];
  for (const [num, raw] of objects) {
    // NOTE: `/Pages` (plural) must not match — `\b` excludes it.
    if (/\/Type\s*\/Page\b/.test(raw.dict)) pageNums.push(num);
  }
  pageNums.sort((a, b) => a - b);
  const pages: ParsedPage[] = [];
  pageNums.forEach((pageNum, index) => {
    const pageObj = objects.get(pageNum);
    if (!pageObj) return;
    const { width, height } = parseMediaBox(pageObj.dict, objects);
    const fonts = parseFontResources(pageObj.dict, objects);
    const glyphs: ParsedGlyph[] = [];
    const fills: ParsedFill[] = [];
    const strokes: ParsedStroke[] = [];
    for (const contentNum of refTargets(pageObj.dict, "/Contents")) {
      const content = objects.get(contentNum);
      if (content) walkContent(decodeStream(content, objects), fonts, glyphs, fills, strokes);
    }
    pages.push({ index, width, height, glyphs, fills, strokes });
  });
  return { pages };
}

// ---------------------------------------------------------------------------
// Expected glyph stream for a known logical line (test oracle input).
// ---------------------------------------------------------------------------

export interface ExpectedGlyph {
  chars: string;
  gid: number;
  codePoints: number[];
  /**
   * hmtx advance width in font units. The PDF pen steps follow THIS (pdf-lib
   * subsets record `advanceWidth` in `/W` and place glyphs by it), NOT the
   * GPOS-adjusted layout `xAdvance` — pdf-lib honors GSUB forms but ignores
   * GPOS positioning adjustments (pinned in `glyphOrder.test.ts`).
   */
  advanceWidth: number;
}

/**
 * Computes the glyph stream a correct renderer MUST emit for `logicalText`:
 * UBA runs → per-run fontkit layout (the same call pdf-lib makes) →
 * left-to-right glyphs with their font gids and carried code points. The
 * regression tests compare this against `parsePdfText` output: char sequence
 * equality proves ORDER, and (via `alignExpectedToParsed` below) gid equality
 * proves the exact letter FORMS.
 */
export function expectedVisualForTestLine(
  logicalText: string,
  kit: KitFont,
): { runs: PreparedRun[]; glyphs: ExpectedGlyph[]; visualText: string } {
  const paragraph = resolveParagraph(sanitizeForBidi(logicalText), RTL_BASE);
  const runs = visualRunsForParagraph(paragraph);
  const prepared: PreparedRun[] = [];
  const glyphs: ExpectedGlyph[] = [];
  let visualText = "";
  for (const run of runs) {
    const item = prepareRun(run, kit);
    if (!item) continue;
    prepared.push(item);
    visualText += run.logicalText;
    for (const glyph of kit.layout(item.drawText).glyphs) {
      glyphs.push({
        chars: String.fromCodePoint(...glyph.codePoints),
        gid: glyph.id,
        codePoints: [...glyph.codePoints],
        advanceWidth: glyph.advanceWidth,
      });
    }
  }
  return { runs: prepared, glyphs, visualText };
}

// ---------------------------------------------------------------------------
// SVG re-render.
// ---------------------------------------------------------------------------

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * High-precision formatting for SVG scale factors. Glyph scales are ~0.004
 * (size/upm); the 2-decimal coordinate formatter would round them to 0 and
 * silently erase small text from the re-render.
 */
function formatScale(value: number): string {
  return String(Math.round(value * 1000000) / 1000000);
}

/** 0–1 RGB channels → `#rrggbb` (for fills and glyph groups). */
export function rgbToHex(r: number, g: number, b: number): string {
  const channel = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export interface SvgGlyphInput {
  x: number;
  y: number;
  size: number;
  gid: number;
}

/** One font's glyphs on a page (regular and bold subset fonts differ). */
export interface SvgGlyphGroup {
  kit: KitFont;
  glyphs: SvgGlyphInput[];
  /** Fill for this group's paths (defaults to `opts.foreground`). */
  fill?: string;
}

/**
 * Re-renders a parsed page as SVG: fills/strokes as vector shapes plus one
 * `<path>` per glyph — real outlines from the fonts at the PDF's positions.
 * Glyphs must already be aligned 1:1 with the parsed page (see the verify
 * script); this function only draws.
 */
export function renderSvgPage(
  page: ParsedPage,
  groups: SvgGlyphGroup[],
  opts: { background?: string; foreground?: string } = {},
): string {
  const background = opts.background ?? "#ffffff";
  const foreground = opts.foreground ?? "#000000";
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${formatNumber(page.width)} ${formatNumber(page.height)}" width="${formatNumber(page.width)}" height="${formatNumber(page.height)}">`,
  );
  parts.push(`<rect x="0" y="0" width="${formatNumber(page.width)}" height="${formatNumber(page.height)}" fill="${xmlEscape(background)}"/>`);
  for (const fill of page.fills) {
    if (fill.points.length === 0) continue;
    const points = fill.points.map((p) => `${formatNumber(p.x)},${formatNumber(page.height - p.y)}`).join(" ");
    const tag = fill.points.length <= 2 || !fill.closed ? "polyline" : "polygon";
    parts.push(
      `<${tag} points="${points}" fill="${rgbToHex(fill.r, fill.g, fill.b)}" stroke="none"/>`,
    );
  }
  for (const stroke of page.strokes) {
    if (stroke.points.length === 0) continue;
    const points = stroke.points.map((p) => `${formatNumber(p.x)},${formatNumber(page.height - p.y)}`).join(" ");
    parts.push(
      `<polyline points="${points}" fill="none" stroke="${rgbToHex(stroke.r, stroke.g, stroke.b)}" stroke-width="${formatNumber(Math.max(0.25, stroke.width))}"/>`,
    );
  }
  for (const group of groups) {
    const upm = group.kit.unitsPerEm || 1000;
    const fill = group.fill ?? foreground;
    for (const glyph of group.glyphs) {
      const scale = glyph.size / upm;
      const outline = group.kit.getGlyph(glyph.gid).path.toSVG();
      parts.push(
        `<path transform="translate(${formatNumber(glyph.x)} ${formatNumber(page.height - glyph.y)}) scale(${formatScale(scale)} ${formatScale(-scale)})" d="${outline}" fill="${xmlEscape(fill)}"/>`,
      );
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}
