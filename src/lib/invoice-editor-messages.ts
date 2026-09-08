import type { ActionError, ActionErrorCode } from "@/server/actions/actionResult";

/**
 * Friendly Persian copy for every stable action error code.
 *
 * The action boundary (`runAction` → `toActionError`) is what keeps Prisma
 * errors, SQL, AWS details and stack traces inside the server: it replaces
 * anything unrecognised with `INTERNAL_ERROR` and an opaque message. This map
 * is the second half of that contract — the browser only ever renders a fixed,
 * human Persian string per code, never the raw error.
 *
 * Shared by the invoice editor (draft save + live preview) and the invoice
 * list/detail screens so the same code always reads the same way.
 */
export const EDITOR_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.",
  FORBIDDEN: "شما مجاز به انجام این عملیات نیستید.",
  NOT_FOUND: "فاکتور یا مورد مرتبط با آن یافت نشد. ممکن است حذف شده باشد.",
  VALIDATION_ERROR: "اطلاعات وارد شده معتبر نیست. لطفاً فرم را دوباره بررسی کنید.",
  BUSINESS_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  INVOICE_LIMIT_REACHED: "سقف صدور فاکتور پلن فعلی شما تکمیل شده است.",
  ENTITLEMENT_DATA_ERROR: "اطلاعات اشتراک در دسترس نیست. لطفاً با پشتیبانی تماس بگیرید.",
  FILE_STORAGE_NOT_CONFIGURED: "سرویس ذخیره‌سازی فایل در دسترس نیست.",
  FILE_STORAGE_UPLOAD_FAILED: "بارگذاری فایل ناموفق بود؛ دوباره تلاش کنید.",
  INTERNAL_ERROR: "خطای غیرمنتظره‌ای رخ داد. لطفاً چند لحظه بعد دوباره تلاش کنید.",
};

/**
 * Safe, Persian summary for an action error. Unknown codes fall back to the
 * generic internal-error copy rather than echoing the server message, so a new
 * error code can never leak a raw English/infra string into the UI.
 */
export function editorActionErrorMessage(error: ActionError): string {
  return EDITOR_ERROR_MESSAGES[error.code] ?? EDITOR_ERROR_MESSAGES.INTERNAL_ERROR;
}

/**
 * Whether the server's own message may be shown as a detail line.
 *
 * Only `VALIDATION_ERROR` qualifies: its message is produced by the action
 * boundary from zod issues on the user's own fields (e.g.
 * `"items.0.title: Item title is required"`), which is information the user
 * needs and contains no internals. Quota, entitlement and infrastructure
 * messages stay hidden behind the friendly summary above.
 */
export function editorActionErrorDetail(error: ActionError): string | undefined {
  return error.code === "VALIDATION_ERROR" ? error.message : undefined;
}
