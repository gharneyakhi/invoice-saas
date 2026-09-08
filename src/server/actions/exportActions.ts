"use server";

import { requireSession } from "@/server/auth/requireSession";
import { getInvoiceExportBundle } from "@/server/export/exportService";
import type { ExportFileFormat } from "@/server/export/filename";
import { generateInvoicePdf } from "@/server/export/pdfService";
import {
  defaultGmailBody,
  defaultGmailRecipient,
  defaultGmailSubject,
  getGmailConnectionStatus as getGmailConnectionStatusService,
  sendInvoicePdfViaGmail,
} from "@/server/export/gmailService";
import { getTelegramShare, type TelegramSharePayload } from "@/server/export/telegram";
import { exportDownloadUrl, type ExportDownloadFormat } from "@/lib/invoice-export";
import { runAction, type ActionResult } from "@/server/actions/actionResult";

/**
 * Export & Sharing V1 — Server Actions (application boundary).
 *
 * Three actions feed the "خروجی و اشتراک‌گذاری" menu:
 *
 *   - `getExportMetadata` — one authorized read returning every download
 *     link, the honest Telegram share payload and the prefilled Gmail
 *     draft for one invoice;
 *   - `getGmailConnectionStatus` — session-only connection check;
 *   - `sendInvoiceGmail` — server-side Gmail send of the generated PDF.
 *
 * Auth inherits the export-service contract: the session's user/account is
 * proven first, then business ownership + invoice membership are proven
 * inside `getInvoiceExportBundle` (ids from the client are untrusted and
 * never authoritative). Nothing here embeds tokens or connection secrets
 * in the returned DTOs — downloads go through the authenticated export
 * route, and Gmail tokens never leave the server.
 */

const DOWNLOAD_FORMATS: readonly ExportDownloadFormat[] = ["pdf", "png", "jpg", "xlsx"];

export interface ExportDownloadLink {
  format: ExportDownloadFormat;
  url: string;
  filename: string;
}

export interface GmailDraftDTO {
  connected: boolean;
  to: string;
  subject: string;
  body: string;
}

export interface ExportMetadataDTO {
  businessId: string;
  invoiceId: string;
  isDraft: boolean;
  displayNumber: string;
  downloads: ExportDownloadLink[];
  telegram: TelegramSharePayload;
  gmail: GmailDraftDTO;
}

function toDownloadLinks(
  businessId: string,
  invoiceId: string,
  filenames: Record<ExportFileFormat, { filename: string }>,
): ExportDownloadLink[] {
  return DOWNLOAD_FORMATS.map((format) => ({
    format,
    url: exportDownloadUrl(businessId, invoiceId, format),
    filename: filenames[format].filename,
  }));
}

/**
 * One authorized read for the export menu: download links for all four
 * file formats, the Telegram share text/URL and the Gmail draft, all
 * derived from the same preview model (single visual source of truth).
 */
export async function getExportMetadata(
  businessId: string,
  invoiceId: string,
): Promise<ActionResult<ExportMetadataDTO>> {
  return runAction(async () => {
    const { userId } = await requireSession();
    const { model, filenames } = await getInvoiceExportBundle(businessId, invoiceId);
    const gmailStatus = await getGmailConnectionStatusService(userId);
    return {
      businessId,
      invoiceId: model.invoice.id,
      isDraft: model.isDraft,
      displayNumber: model.officialNumber ?? "پیش‌نویس",
      downloads: toDownloadLinks(businessId, model.invoice.id, filenames),
      telegram: getTelegramShare(model, process.env.APP_URL ?? null),
      gmail: {
        connected: gmailStatus.connected,
        to: defaultGmailRecipient(model),
        subject: defaultGmailSubject(model),
        body: defaultGmailBody(model),
      },
    };
  });
}

/** Session-only Gmail connection check (no invoice context needed). */
export async function getGmailConnectionStatus(): Promise<ActionResult<{ connected: boolean }>> {
  return runAction(async () => {
    const { userId } = await requireSession();
    return getGmailConnectionStatusService(userId);
  });
}

export interface SendInvoiceGmailInput {
  to: string;
  subject: string;
  body: string;
}

/**
 * Sends the invoice PDF through the caller's connected Gmail account.
 *
 * The PDF is generated server-side from the authorized preview model at
 * send time and attached by the service (never from client bytes).
 * Success is returned only after the Gmail API confirms with a message
 * id; a missing or revoked connection maps to `GMAIL_NOT_CONNECTED` so
 * the UI can offer the connect flow instead of failing silently.
 */
export async function sendInvoiceGmail(
  businessId: string,
  invoiceId: string,
  input: SendInvoiceGmailInput,
): Promise<ActionResult<{ messageId: string }>> {
  return runAction(async () => {
    const { userId } = await requireSession();
    const { model, filenames } = await getInvoiceExportBundle(businessId, invoiceId);
    const pdfBytes = await generateInvoicePdf(model);
    return sendInvoicePdfViaGmail(
      userId,
      model,
      {
        to: input.to,
        subject: input.subject,
        body: input.body,
        filename: filenames.pdf.filename,
      },
      { pdfBytes },
    );
  });
}
