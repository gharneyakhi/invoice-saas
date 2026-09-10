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

/** Domain rule surfaced to the UI: only finalized, un-cancelled invoices can be cancelled. */
export function canCancelInvoice(invoice: InvoiceLifecycleView): boolean {
  return isFinalizedInvoice(invoice) && !isCancelledInvoice(invoice);
}

/** Domain rule surfaced to the UI: only untouched DRAFT rows can be deleted. */
export function canDeleteDraftInvoice(invoice: InvoiceLifecycleView): boolean {
  return invoice.status === "DRAFT" && invoice.finalizedAt == null;
}

export const FINALIZATION_CONFIRMATION_MESSAGE =
  "پس از نهایی کردن، فاکتور قابل ویرایش نخواهد بود. آیا مطمئن هستید؟";

export const CANCEL_CONFIRMATION_MESSAGE =
  "آیا از لغو این فاکتور مطمئن هستید؟ پس از لغو، امکان ویرایش یا ثبت پرداخت جدید وجود نخواهد داشت.";

export const DELETE_DRAFT_CONFIRMATION_MESSAGE =
  "آیا از حذف این پیش‌نویس مطمئن هستید؟ این عملیات غیرقابل بازگشت است.";

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

export const CANCEL_CONFIRMATION = {
  title: "لغو فاکتور رسمی",
  message:
    "آیا از لغو این فاکتور مطمئن هستید؟ وضعیت فاکتور به «لغو شده» تغییر می‌کند و امکان ثبت پرداخت یا تغییر اطلاعات آن وجود نخواهد داشت.",
  warning: "شماره رسمی فاکتور و سوابق پرداخت‌های آن در سیستم محفوظ می‌ماند و سهمیه مصرف‌شده بازگردانده نمی‌شود.",
  confirmLabel: "بله، فاکتور لغو شود",
  cancelLabel: "انصراف",
} as const;

export const DELETE_DRAFT_CONFIRMATION = {
  title: "حذف پیش‌نویس فاکتور",
  message:
    "آیا از حذف این پیش‌نویس مطمئن هستید؟ تمام اطلاعات و اقلام ثبت‌شده در این پیش‌نویس به‌طور کامل حذف خواهند شد.",
  warning: "این عملیات غیرقابل بازگشت است و پیش‌نویس حذف‌شده قابل بازیابی نیست.",
  confirmLabel: "حذف پیش‌نویس",
  cancelLabel: "انصراف",
} as const;

export const DUPLICATE_CONFIRMATION = {
  title: "ایجاد رونوشت (کپی فاکتور)",
  message: "یک پیش‌نویس جدید بر اساس اقلام و اطلاعات این فاکتور ایجاد می‌شود.",
  warning: "پیش‌نویس جدید شماره رسمی نخواهد داشت و سوابق پرداخت کپی نمی‌شوند.",
  confirmLabel: "ایجاد پیش‌نویس جدید",
  cancelLabel: "انصراف",
} as const;

const FALLBACK_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "برای انجام این عملیات باید وارد حساب کاربری شوید.",
  FORBIDDEN: "شما به این فاکتور یا قابلیت دسترسی ندارید.",
  NOT_FOUND: "فاکتور مورد نظر یافت نشد.",
  VALIDATION_ERROR: "انجام این عملیات برای این فاکتور امکان‌پذیر نیست.",
  INVOICE_LIMIT_REACHED: "سقف تعداد فاکتورهای نهایی‌شده در این ماه تکمیل شده است.",
  BUSINESS_LIMIT_REACHED: "سقف کسب‌وکارهای فعال تکمیل شده است.",
  ENTITLEMENT_DATA_ERROR: "اطلاعات اشتراک در دسترس نیست. لطفاً با پشتیبانی تماس بگیرید.",
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

export function cancelErrorMessage(error: ActionError): string {
  if (error.code === "VALIDATION_ERROR") {
    const message = error.message.toLowerCase();
    if (message.includes("already cancelled")) {
      return "این فاکتور قبلاً لغو شده است.";
    }
    if (message.includes("draft")) {
      return "فاکتورهای پیش‌نویس قابل لغو نیستند؛ می‌توانید آن‌ها را حذف کنید.";
    }
    if (message.includes("archived")) {
      return "امکان لغو فاکتور برای کسب‌وکار بایگانی‌شده وجود ندارد.";
    }
    return FALLBACK_MESSAGES.VALIDATION_ERROR;
  }
  return FALLBACK_MESSAGES[error.code] ?? FALLBACK_MESSAGES.INTERNAL_ERROR;
}

export function deleteDraftErrorMessage(error: ActionError): string {
  if (error.code === "VALIDATION_ERROR") {
    const message = error.message.toLowerCase();
    if (message.includes("finalized") || message.includes("cancelled")) {
      return "تنها فاکتورهای پیش‌نویس قابل حذف هستند؛ فاکتورهای رسمی یا لغوشده به عنوان سابقه نگهداری می‌شوند.";
    }
    if (message.includes("archived")) {
      return "امکان حذف پیش‌نویس برای کسب‌وکار بایگانی‌شده وجود ندارد.";
    }
    return FALLBACK_MESSAGES.VALIDATION_ERROR;
  }
  return FALLBACK_MESSAGES[error.code] ?? FALLBACK_MESSAGES.INTERNAL_ERROR;
}

export function duplicateErrorMessage(error: ActionError): string {
  if (error.code === "FORBIDDEN") {
    return "قابلیت کپی فاکتور در پلن رایگان فعال نیست. لطفاً پلن خود را به پایه یا حرفه‌ای ارتقا دهید.";
  }
  if (error.code === "VALIDATION_ERROR") {
    const message = error.message.toLowerCase();
    if (message.includes("archived customer") || message.includes("archived product")) {
      return "این فاکتور به مشتری یا محصول بایگانی‌شده وابسته است و امکان کپی آن وجود ندارد.";
    }
    if (message.includes("archived business")) {
      return "امکان کپی فاکتور برای کسب‌وکار بایگانی‌شده وجود ندارد.";
    }
    if (message.includes("no line items")) {
      return "فاکتور بدون قلم قابل کپی نیست.";
    }
    return FALLBACK_MESSAGES.VALIDATION_ERROR;
  }
  return FALLBACK_MESSAGES[error.code] ?? FALLBACK_MESSAGES.INTERNAL_ERROR;
}
