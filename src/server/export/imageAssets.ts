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
 * Returns `null` on any failure (network, timeout, oversize, decode) and
 * for BLANK payloads: zero-size, ≤2px placeholder/tracker dots, or fully
 * transparent images (all of which would otherwise render as a bare white
 * backing rectangle in the PDF header). Blank detection fails OPEN: if the
 * pixel probe itself errors, the normalized bytes are kept.
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
    const normalized = await sharp(Buffer.from(arrayBuffer)).png().toBuffer();
    try {
      const probe = sharp(normalized);
      const meta = await probe.metadata();
      if ((meta.width ?? 0) <= 2 || (meta.height ?? 0) <= 2) return null;
      if (meta.hasAlpha) {
        const stats = await probe.stats();
        const alpha = stats.channels[stats.channels.length - 1];
        if (alpha && alpha.max === 0) return null;
      }
    } catch {
      // Fail open: keep the image when the blank probe cannot run.
    }
    return normalized;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when a logo needs the opaque white rectangle behind it in the PDF /
 * image header. Near-white logos (mean opaque-pixel brightness ≥235/255)
 * skip the backing: the rectangle would be indistinguishable from — or
 * wrongly read as — the logo itself. Fails CLOSED (returns true) when the
 * probe cannot run, preserving the historical behavior.
 */
export async function logoNeedsWhiteBacking(png: Buffer): Promise<boolean> {
  try {
    const { default: sharp } = await import("sharp");
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels < 4 || data.length === 0) return true;
    let sum = 0;
    let count = 0;
    for (let i = 0; i + 3 < data.length; i += info.channels) {
      if ((data[i + 3] as number) < 128) continue; // transparent pixel
      sum += (data[i] as number) + (data[i + 1] as number) + (data[i + 2] as number);
      count += 1;
    }
    if (count === 0) return false;
    return sum / (3 * count) < 235;
  } catch {
    return true;
  }
}

/** PNG bytes → SVG-embeddable `data:` URI. */
export function pngToDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}
