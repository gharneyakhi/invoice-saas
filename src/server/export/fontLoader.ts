import { VAZIRMATN_FONT_BASE64 } from "./fonts/vazirmatnFont";

/**
 * Server-side Persian font bytes for export generation (PDF + raster images).
 *
 * The Vazirmatn TTF (SIL OFL 1.1, see `./fonts/OFL.txt`) is embedded as a
 * base64 module rather than read from disk at request time, so PDF/image
 * generation behaves identically in development, standalone servers and
 * serverless functions — where filesystem tracing of binary assets is
 * unreliable. The decoded buffer is cached process-wide (the font is
 * ~240 KB and every export of every invoice reuses it).
 *
 * Source of the embedded bytes: `google/fonts` (`ofl/vazirmatn`,
 * `Vazirmatn[wght].ttf`), whose default instance is the Regular weight.
 */
let cachedBytes: Buffer | null = null;

/** Raw TTF bytes of the embedded Vazirmatn font (cached, shared). */
export function getVazirmatnFontBytes(): Buffer {
  if (!cachedBytes) {
    cachedBytes = Buffer.from(VAZIRMATN_FONT_BASE64, "base64");
  }
  return cachedBytes;
}

/** Base64 TTF payload for `@font-face` embedding inside generated SVG. */
export function getVazirmatnFontBase64(): string {
  return VAZIRMATN_FONT_BASE64;
}
