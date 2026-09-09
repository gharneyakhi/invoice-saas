import type { ActionError, ActionErrorCode } from "@/server/actions/actionResult";

/**
 * Small, pure helpers for the invoice finalization UI.
 *
 * These functions deliberately contain NO business logic. The only source of
 * truth for authorization, validation, calculation, numbering, quota, snapshots
 * and transaction safety is `invoiceService.finalizeInvoice`; this module only
 * turns the existing lifecycle facts (status + finalizedAt) into what the
 * detail page may render/action safely, and maps a Server Action error payload
 * to a friendly Persian message.
 */

export interface InvoiceLifecycleView {
  status: string;
  finalizedAt?: string | Date | null;
}

const FINALIZED_STATUSES = new Set([
  "ISSUED",
  "SENT",
  "PENDING_PAYMENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
]);

/** Domain rule surfaced to the UI: only untouched DRAFT rows can be finalized. */
export function canFinalizeInvoice(invoice: InvoiceLifecycleView): boolean {
  return invoice.status === "DRAFT" && invoice.finalizedAt == null;
}

/** A row carrying `finalizedAt` in a non-draft payment status is finalized. */
export function isFinalizedInvoice(invoice: InvoiceLifecycleView): boolean {
  return invoice.finalizedAt != null && FINALIZED_STATUSES.has(invoice.status);
}

export function isCancelledInvoice(invoice: InvoiceLifecycleView): boolean {
  return invoice.status === "CANCELLED";
}

export const FINALIZATION_CONFIRMATION_MESSAGE =
  "پس از نهایی کردن، فاکتور قابل ویرایش نخواهد بود. آیا مطمئن هستید؟";

/**
 * Confirmation content for the editor's «صدور نهایی» dialog.
 *
 * The editor asks the same question the detail page's `window.confirm` asks,
 * but as a real dialog with explicit Persian action labels (a native confirm
 * dialog cannot control its buttons). Both texts state the same irreversible
 * rule — one more reason the copy lives next to the rule it describes.
 */
export const FINALIZATION_CONFIRMATION = {
  title: "صدور نهایی فاکتور",
  message:
    "پس از صدور نهایی، فاکتور قابل ویرایش نخواهد بود. آیا از صدور فاکتور مطمئن هستید؟",
  warning: "شماره رسمی فاکتور هنگام صدور صادر می‌شود و یک سهمیه از پلن شما مصرف می‌گردد.",
  confirmLabel: "صدور نهایی",
  cancelLabel: "انصراف",
} as const;

const FALLBACK_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "برای نهایی کردن فاکتور باید وارد حساب کاربری شوید.",
  FORBIDDEN: "شما به این فاکتور دسترسی ندارید.",
  NOT_FOUND: "فاکتور مورد نظر یافت نشد.",
  VALIDATION_ERROR: "نهایی کردن این فاکتور ممکن نیست. لطفاً اطلاعات فاکتور را بررسی کنید.",
  INVOICE_LIMIT_REACHED: "سقف تعداد فاکتورهای نهایی‌شده در این ماه تکمیل شده است.",
  BUSINESS_LIMIT_REACHED: "سقف کسب‌وکارهای فعال تکمیل شده است.",
  ENTITLEMENT_DATA_ERROR: "اطلاعات اشتراک برای نهایی کردن در دسترس نیست. کمی بعد تلاش کنید.",
  FILE_STORAGE_NOT_CONFIGURED: "سرویس ذخیره‌سازی فایل در دسترس نیست.",
  FILE_STORAGE_UPLOAD_FAILED: "ذخیره‌سازی فایل ناموفق بود؛ دوباره تلاش کنید.",
  GMAIL_NOT_CONNECTED: "حساب جیمیل متصل نیست. ابتدا جیمیل را متصل کنید.",
  GMAIL_SEND_FAILED: "ارسال از طریق جیمیل ناموفق بود. لطفاً دوباره تلاش کنید.",
  GMAIL_NOT_CONFIGURED: "سرویس ارسال جیمیل در دسترس نیست.",
  INTERNAL_ERROR: "خطای غیرمنتظره‌ای رخ داد. دوباره تلاش کنید و در صورت تکرار بعداً مراجعه کنید.",
};

/**
 * Maps the stable error payload returned by the Server Action to a clear,
 * user-facing Persian message. The action has already stripped Prisma/infra
 * details; this helper keeps those safe messages predictable in the UI too.
 */
export function finalizationErrorMessage(error: ActionError): string {
  if (error.code === "VALIDATION_ERROR") {
    const message = error.message.toLowerCase();
    if (message.includes("archived business") || message.includes("archived customer") || message.includes("archived product")) {
      return "این فاکتور به کسب‌وکار، مشتری یا محصول بایگانی‌شده وابسته است و امکان نهایی‌سازی وجود ندارد.";
    }
    if (message.includes("no line items")) {
      return "برای نهایی کردن، فاکتور باید حداقل یک قلم داشته باشد.";
    }
    if (message.includes("already finalized") || message.includes("no longer in draft")) {
      return "این فاکتور نهایی شده یا وضعیت آن تغییر کرده است. صفحه دوباره بارگذاری شد.";
    }
    if (message.includes("cancelled")) {
      return "این فاکتور لغو شده است و قابل نهایی‌سازی نیست.";
    }
    return FALLBACK_MESSAGES.VALIDATION_ERROR;
  }

  return FALLBACK_MESSAGES[error.code] ?? FALLBACK_MESSAGES.INTERNAL_ERROR;
}
