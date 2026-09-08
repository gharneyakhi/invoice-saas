/**
 * Sanitized export filenames + download headers (shared by every export).
 *
 * Filenames carry the human invoice number (`فاکتور-<number>.pdf`) so a
 * downloaded file is identifiable without opening it. Everything that ends
 * up in a `Content-Disposition` header or on a user's disk is sanitized
 * here: path separators, control characters and header-breaking bytes are
 * stripped, length is capped, and an ASCII fallback is always provided
 * alongside the Persian name (RFC 5987 `filename*`) for older clients.
 *
 * Pure and dependency-free; the API route is the only place that turns
 * these values into HTTP headers.
 */

export type ExportFileFormat = "pdf" | "png" | "jpg" | "xlsx";

export const EXPORT_FILE_FORMATS: readonly ExportFileFormat[] = ["pdf", "png", "jpg", "xlsx"];

export function isExportFileFormat(value: unknown): value is ExportFileFormat {
  return (
    typeof value === "string" &&
    (EXPORT_FILE_FORMATS as readonly string[]).includes(value.toLowerCase())
  );
}

export function normalizeExportFileFormat(value: unknown): ExportFileFormat | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  if (lower === "jpeg") return "jpg";
  return isExportFileFormat(lower) ? (lower as ExportFileFormat) : null;
}

export const EXPORT_MIME_TYPES: Record<ExportFileFormat, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function exportMimeType(format: ExportFileFormat): string {
  return EXPORT_MIME_TYPES[format];
}

/** Max persisted length of the human (unsuffixed) part of a filename. */
export const EXPORT_FILENAME_MAX_BASE_LENGTH = 80;

/**
 * Strips everything that must never reach a filesystem or a
 * `Content-Disposition` header: path separators, Windows-reserved symbols,
 * control characters (including CR/LF header injection), and leading dots /
 * whitespace. Collapses inner whitespace to single spaces. Never returns an
 * empty string — callers always get a usable fallback.
 */
export function sanitizeFilenameSegment(value: string, fallback = "invoice"): string {
  const withoutControls = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, "");
  const withoutSeparators = withoutControls.replace(/[\\/:*?"<>|]+/g, "");
  const collapsed = withoutSeparators.replace(/\s+/g, " ").trim();
  const withoutLeadingDots = collapsed.replace(/^\.+/, "").trim();
  if (withoutLeadingDots === "") return fallback;
  if (withoutLeadingDots.length <= EXPORT_FILENAME_MAX_BASE_LENGTH) return withoutLeadingDots;
  return withoutLeadingDots.slice(0, EXPORT_FILENAME_MAX_BASE_LENGTH).trim() || fallback;
}

/**
 * ASCII-only fallback for the `filename="..."` parameter: Persian labels
 * become `invoice`, remaining runs of unsafe characters collapse to `-`.
 */
export function toAsciiFilenameSegment(value: string, fallback = "invoice"): string {
  const ascii = (value ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (ascii === "") return fallback;
  return ascii.slice(0, EXPORT_FILENAME_MAX_BASE_LENGTH) || fallback;
}

export interface InvoiceExportFilenames {
  /** Persian display name, e.g. `فاکتور-1024.pdf`. */
  filename: string;
  /** ASCII fallback for legacy `filename="..."` clients. */
  asciiFallback: string;
  mimeType: string;
}

/**
 * Builds the download filenames for one invoice export.
 *
 * Finalized invoices use their official number; drafts have no official
 * number (their `DRAFT-<uuid>` placeholder must never leak into a user-
 * facing filename), so drafts fall back to `پیش‌نویس-<shortId>`.
 */
export function buildInvoiceExportFilenames(args: {
  officialNumber: string | null;
  invoiceId: string;
  isDraft: boolean;
  format: ExportFileFormat;
}): InvoiceExportFilenames {
  const ext = args.format;
  const rawBase =
    !args.isDraft && args.officialNumber && args.officialNumber.trim() !== ""
      ? `فاکتور-${args.officialNumber.trim()}`
      : `پیش‌نویس-${args.invoiceId.slice(0, 8)}`;
  const base = sanitizeFilenameSegment(rawBase);
  const asciiBase =
    !args.isDraft && args.officialNumber && args.officialNumber.trim() !== ""
      ? `invoice-${toAsciiFilenameSegment(args.officialNumber.trim(), args.invoiceId.slice(0, 8))}`
      : `draft-${toAsciiFilenameSegment(args.invoiceId.slice(0, 8))}`;
  return {
    filename: `${base}.${ext}`,
    asciiFallback: `${asciiBase}.${ext}`,
    mimeType: exportMimeType(ext),
  };
}

/**
 * Builds a safe `Content-Disposition` header carrying both the ASCII
 * fallback (`filename="..."`, quoted, quote-escaped) and the RFC 5987
 * encoded Persian name (`filename*=UTF-8''...`). No internal paths or ids
 * beyond the short draft fallback ever appear here.
 */
export function buildContentDisposition(filenames: InvoiceExportFilenames): string {
  const ascii = filenames.asciiFallback.replace(/["\\]/g, "");
  const encoded = encodeURIComponent(filenames.filename).replace(/['()]/g, (c) => {
    // encodeURIComponent leaves ' ( ) unescaped; RFC 5987 attr-char excludes
    // them, so percent-encode explicitly.
    return `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
  });
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
