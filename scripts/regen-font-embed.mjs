#!/usr/bin/env node
/**
 * Regenerates `src/server/export/fonts/vazirmatnFont.ts` from the committed
 * `Vazirmatn.ttf`.
 *
 *   node scripts/regen-font-embed.mjs
 *
 * The generated module holds the base64 payload as an ARRAY of chunks joined
 * once at module load. Do NOT "simplify" it back into a chain of `+`
 * concatenations: a ~2,700-deep left-nested BinaryExpression overflows the
 * recursive AST walkers of both ESLint and the Next.js production minifier
 * (`RangeError: Maximum call stack size exceeded`), while a flat array literal
 * is iterated rather than recursed. The exported string is byte-for-byte
 * identical either way, so PDF/image rendering is unaffected.
 *
 * The script aborts (restoring nothing, writing nothing) unless the emitted
 * payload decodes back to exactly the bytes of `Vazirmatn.ttf`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TTF = path.join(ROOT, "src/server/export/fonts/Vazirmatn.ttf");
const OUT = path.join(ROOT, "src/server/export/fonts/vazirmatnFont.ts");
const CHUNK_WIDTH = 120;

const ttf = fs.readFileSync(TTF);
const sha256 = crypto.createHash("sha256").update(ttf).digest("hex");
const base64 = ttf.toString("base64");

const chunks = [];
for (let i = 0; i < base64.length; i += CHUNK_WIDTH) {
  chunks.push(base64.slice(i, i + CHUNK_WIDTH));
}

const header = `/**
 * Vazirmatn font (SIL Open Font License 1.1) embedded as base64.
 *
 * GENERATED FILE - do not edit by hand. Regenerate with:
 *   node scripts/regen-font-embed.mjs   (see the header of that script)
 *
 * Source: https://github.com/google/fonts (ofl/vazirmatn/Vazirmatn[wght].ttf)
 * License: ./OFL.txt (SIL OFL 1.1, (c) Vazirmatn contributors).
 *
 * The font is inlined (rather than read from disk at runtime) so server-side
 * PDF/image generation works identically in dev, standalone servers and
 * serverless functions, where filesystem tracing of binary assets is
 * unreliable.
 *
 * The payload is held as an ARRAY of base64 chunks joined once at module
 * load, not as a chain of \`+\` concatenations: a 2,600-deep left-nested
 * BinaryExpression overflows the recursive AST walkers of both ESLint and the
 * Next.js production minifier ("Maximum call stack size exceeded"), while a
 * flat array literal is iterated rather than recursed. The exported string is
 * byte-for-byte identical either way (sha256 of the decoded TTF:
 * ${sha256}).
 */

/* eslint-disable max-len */

const VAZIRMATN_FONT_BASE64_CHUNKS: string[] = [
`;

const body = chunks.map((chunk) => `  ${JSON.stringify(chunk)},`).join("\n");
const footer = `
];

/** Base64 of the Vazirmatn TTF (identical to the previous \`+\` chain). */
export const VAZIRMATN_FONT_BASE64: string = VAZIRMATN_FONT_BASE64_CHUNKS.join("");
`;

const emitted = header + body + footer;

// Prove the round-trip before touching the file on disk.
const parsed = [...emitted.matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((m) => m[1]).join("");
const decoded = Buffer.from(parsed, "base64");
if (parsed !== base64 || Buffer.compare(decoded, ttf) !== 0) {
  console.error("ABORT: regenerated payload does not round-trip to Vazirmatn.ttf");
  process.exit(1);
}

fs.writeFileSync(OUT, emitted);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
console.log(`  chunks:        ${chunks.length} x ${CHUNK_WIDTH} chars`);
console.log(`  base64 length: ${base64.length}`);
console.log(`  decoded bytes: ${decoded.length}`);
console.log(`  sha256:        ${sha256}`);
