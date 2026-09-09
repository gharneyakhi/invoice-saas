import {
  getInvoicePreviewData,
  type InvoicePreviewModel,
} from "@/server/invoice/previewService";
import {
  buildInvoiceExportFilenames,
  type ExportFileFormat,
  type InvoiceExportFilenames,
} from "./filename";

/**
 * Export & Sharing V1 — central service boundary.
 *
 * Every export (Print view, PDF, PNG, JPG, Excel, Telegram share text,
 * Gmail send) starts here. The function below is the ONLY authorized way
 * to load invoice data for export purposes, and it inherits the exact
 * authorization + data-source contract of the invoice preview:
 *
 *   - authenticated session required;
 *   - `businessId` is untrusted: ownership is proven server-side by
 *     `requireBusinessOwnership` (session account vs the Business row);
 *   - the invoice must belong to exactly that business (`getInvoice`):
 *     missing → NotFoundError, foreign → ForbiddenError — so a
 *     cross-business `invoiceId` can never leak another business' data or
 *     logo/storage objects;
 *   - finalized/cancelled invoices expose ONLY their immutable seller /
 *     customer / currency snapshots; drafts expose the current
 *     BusinessProfile + live customer row (the preview model's law);
 *   - read-only: no writes, no quota, no numbering, no snapshot creation.
 *
 * Money is never recomputed here: the preview model carries the stored
 * authoritative values (`paidAmount`, `remainingAmount`, `status`, totals)
 * as exact Decimal strings, and every generator below (PDF/image/Excel/
 * Gmail) renders those values verbatim. There is no second calculation
 * engine in this directory.
 */

export interface ExportSource {
  /** Fully authorized preview payload (single source of truth). */
  model: InvoicePreviewModel;
  /** Download filenames for one format (sanitized, Persian + ASCII). */
  filenames: InvoiceExportFilenames;
}

export interface ExportBundleSource {
  /** Fully authorized preview payload (single source of truth). */
  model: InvoicePreviewModel;
  /** Download filenames for every file format (one preview load). */
  filenames: Record<ExportFileFormat, InvoiceExportFilenames>;
}

/**
 * Loads the authorized export payload for one invoice + format.
 *
 * Thin by design: authorization and snapshot selection live in
 * `previewService.getInvoicePreviewData`; this wrapper only pairs the
 * model with the sanitized download filenames for the requested format.
 */
export async function getInvoiceExportSource(
  businessId: string,
  invoiceId: unknown,
  format: ExportFileFormat,
): Promise<ExportSource> {
  const model = await getInvoicePreviewData(businessId, invoiceId);
  const filenames = buildInvoiceExportFilenames({
    officialNumber: model.officialNumber,
    invoiceId: model.invoice.id,
    isDraft: model.isDraft,
    format,
  });
  return { model, filenames };
}

const BUNDLE_FORMATS: readonly ExportFileFormat[] = ["pdf", "png", "jpg", "xlsx"];

/**
 * Loads the authorized export payload once, paired with the download
 * filenames for EVERY file format. Used by the export metadata action so
 * the "خروجی و اشتراک‌گذاری" menu can link all downloads after a single
 * preview read (same auth + snapshot contract as `getInvoiceExportSource`).
 */
export async function getInvoiceExportBundle(
  businessId: string,
  invoiceId: unknown,
): Promise<ExportBundleSource> {
  const model = await getInvoicePreviewData(businessId, invoiceId);
  const input = {
    officialNumber: model.officialNumber,
    invoiceId: model.invoice.id,
    isDraft: model.isDraft,
  };
  const filenames = Object.fromEntries(
    BUNDLE_FORMATS.map((format) => [format, buildInvoiceExportFilenames({ ...input, format })]),
  ) as Record<ExportFileFormat, InvoiceExportFilenames>;
  return { model, filenames };
}

export { DRAFT_EXPORT_NOTICE } from "./exportCopy";

export function isDraftExport(model: Pick<InvoicePreviewModel, "isDraft">): boolean {
  return model.isDraft;
}
