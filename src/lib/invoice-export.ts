/**
 * Client-safe helpers for the export & sharing UI.
 *
 * Pure URL builders only — no secrets, no tokens, no server access. The
 * authenticated export routes they point at re-verify the session and the
 * business membership on every request; knowing a URL grants nothing.
 */

export type ExportDownloadFormat = "pdf" | "png" | "jpg" | "xlsx";

/**
 * Download URL for the export API route. Ids are path-encoded so hostile
 * values cannot escape the route segment.
 */
export function exportDownloadUrl(
  businessId: string,
  invoiceId: string,
  format: ExportDownloadFormat,
): string {
  return `/api/businesses/${encodeURIComponent(businessId)}/invoices/${encodeURIComponent(invoiceId)}/export?format=${format}`;
}

/** Entry point of the Gmail OAuth connect flow. */
export function gmailConnectUrl(returnTo: string): string {
  return `/api/gmail/connect?returnTo=${encodeURIComponent(returnTo)}`;
}
