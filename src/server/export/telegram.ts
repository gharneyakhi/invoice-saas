import type { InvoicePreviewModel } from "@/lib/invoice-preview-model";
import {
  formatCurrency,
  formatInvoiceStatus,
  formatInvoiceType,
  formatPersianDate,
  toPersianDigits,
} from "@/lib/formatters";
import { DRAFT_EXPORT_NOTICE } from "./exportCopy";

/**
 * Telegram sharing V1 — an HONEST share flow.
 *
 * There is no Telegram Bot API integration in V1, so the application NEVER
 * claims it "sent" anything to Telegram: no `sent` status exists anywhere
 * in this module's output. What V1 provides:
 *
 *   1. a Persian invoice-summary text the user can copy;
 *   2. a `t.me/share/url` deep link that opens Telegram with that text
 *      prefilled so the user can choose the recipient/chat themselves;
 *   3. explicit UI copy stating that no automatic send happens and that
 *      files cannot be auto-attached through a deep link (the user
 *      downloads the PDF/PNG and attaches it manually in the chat).
 *
 * Pure and dependency-free.
 */

export const TELEGRAM_SHARE_BASE_URL = "https://t.me/share/url";

/** Honest Persian UI copy for the Telegram dialog (no "sent" claims). */
export const TELEGRAM_COPY = {
  title: "اشتراک‌گذاری در تلگرام",
  explainer:
    "سیستم به‌صورت خودکار پیامی در تلگرام ارسال نمی‌کند. می‌توانید متن خلاصه فاکتور را کپی کنید یا فایل فاکتور را دانلود کرده و در گفتگوی تلگرام ارسال کنید.",
  attachmentNote:
    "پیوست خودکار فایل به تلگرام امکان‌پذیر نیست؛ پس از دانلود فایل، آن را به‌صورت دستی در گفتگو ارسال کنید.",
  openTelegram: "باز کردن تلگرام",
  copyText: "کپی متن خلاصه",
  downloadPdf: "دانلود PDF برای ارسال",
} as const;

/**
 * Builds the copyable Persian summary of the invoice. Finalized rows use
 * their official number + snapshot names; drafts are clearly marked and
 * never show the internal `DRAFT-<uuid>` placeholder.
 */
export function buildTelegramShareText(model: InvoicePreviewModel): string {
  const invoice = model.invoice;
  const lines: string[] = [];

  if (model.isDraft) {
    lines.push(`🧾 پیش‌نویس ${formatInvoiceType(invoice.invoiceType)} (بدون شماره رسمی)`);
  } else {
    lines.push(
      `🧾 فاکتور ${toPersianDigits(model.officialNumber ?? invoice.invoiceNumber)} (${formatInvoiceType(invoice.invoiceType)})`,
    );
  }
  if (model.seller) {
    lines.push(model.seller.businessName);
  }
  lines.push(`مبلغ نهایی: ${formatCurrency(invoice.total, model.currency)}`);
  if (!model.isDraft) {
    lines.push(`پرداخت شده: ${formatCurrency(invoice.paidAmount, model.currency)}`);
    lines.push(`مانده: ${formatCurrency(invoice.remainingAmount, model.currency)}`);
  }
  lines.push(
    `وضعیت: ${model.isDraft ? "پیش‌نویس" : formatInvoiceStatus(invoice.status).label}`,
  );
  lines.push(`تاریخ صدور: ${formatPersianDate(invoice.issueDate)}`);
  if (model.isDraft) {
    lines.push(`⚠️ ${DRAFT_EXPORT_NOTICE}`);
  }
  return lines.join("\n");
}

/**
 * Builds the `t.me/share/url` deep link. `pageUrl` is a PUBLIC url (the
 * app homepage) — never an authenticated invoice route, which a recipient
 * could not open. Returns `null` when no public url is configured, in
 * which case the UI falls back to copy-text + file download only.
 */
export function buildTelegramShareUrl(args: { text: string; pageUrl: string | null }): string | null {
  const pageUrl = args.pageUrl?.trim();
  if (!pageUrl) return null;
  return `${TELEGRAM_SHARE_BASE_URL}?url=${encodeURIComponent(pageUrl)}&text=${encodeURIComponent(args.text)}`;
}

export interface TelegramSharePayload {
  /** Copyable Persian summary. */
  text: string;
  /** Deep link opening Telegram with the text prefilled (or null). */
  shareUrl: string | null;
  /**
   * ALWAYS false in V1: deep links cannot attach files. The UI must
   * surface this (see `TELEGRAM_COPY.attachmentNote`) instead of
   * implying the file travels with the link.
   */
  hasFileAttachment: false;
  /** True for drafts (the UI shows the stronger draft warning). */
  isDraft: boolean;
}

/** One honest payload for the Telegram dialog. */
export function getTelegramShare(
  model: InvoicePreviewModel,
  appUrl: string | null | undefined,
): TelegramSharePayload {
  const text = buildTelegramShareText(model);
  return {
    text,
    shareUrl: buildTelegramShareUrl({ text, pageUrl: appUrl ?? null }),
    hasFileAttachment: false,
    isDraft: model.isDraft,
  };
}
