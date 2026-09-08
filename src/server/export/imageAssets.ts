/**
 * Shared remote-image fetching for export generators (PDF + raster images).
 *
 * Stored business images (logo / stamp / signature) live in S3-compatible
 * object storage as PNG/JPEG/WebP and are referenced by public URL. Both
 * generators need them as PNG bytes — `pdf-lib` embeds PNG/JPG only (WebP
 * must be converted) and SVG `<image>` data URIs are safest as PNG — so
 * every fetch is normalized through `sharp` here.
 *
 * Failures degrade to `null` (the asset is omitted, exactly like the
 * preview document does); they never fail an export.
 */

export const EXPORT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const EXPORT_IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches a remote image and normalizes it to PNG bytes.
 * Returns `null` on any failure (network, timeout, oversize, decode).
 */
export async function fetchImageAsPng(url: string): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > EXPORT_IMAGE_MAX_BYTES) {
      return null;
    }
    // `sharp` is imported lazily so unit tests that stub image fetching
    // never pay for the native module.
    const { default: sharp } = await import("sharp");
    return await sharp(Buffer.from(arrayBuffer)).png().toBuffer();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** PNG bytes → SVG-embeddable `data:` URI. */
export function pngToDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}
