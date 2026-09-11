import type { DashboardInvoiceStatus } from "@/server/dashboard/dashboardService";
import { invoiceCurrencyLabel } from "@/lib/currency";

/**
 * Persian number and locale formatters for the SaaS UI.
 * Pure and deterministic.
 */

const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/**
 * Converts English digits (0-9) to standard Persian digits (۰-۹).
 */
export function toPersianDigits(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/**
 * Formats a number with Persian thousands separators (e.g. ۱,۲۵۰,۰۰۰).
 */
export function formatPersianNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "۰";
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return "۰";
  const formatted = num.toLocaleString("en-US");
  return toPersianDigits(formatted);
}

/**
 * Formats monetary amounts in Iranian currency (ریال / تومان) with Persian numerals.
 */
export function formatCurrency(
  amount: string | number | null | undefined,
  currency: "IRR" | "IRT" | string = "IRR",
): string {
  const unit = invoiceCurrencyLabel(currency);
  if (amount === null || amount === undefined || amount === "") return `۰ ${unit}`;
  const num = typeof amount === "number" ? amount : Number(amount);
  if (isNaN(num)) return `۰ ${unit}`;
  const formatted = Math.round(num).toLocaleString("en-US");
  return `${toPersianDigits(formatted)} ${unit}`;
}

/**
 * Formats a stored percent decimal string ("9.00") as a Persian percent ("۹٪").
 *
 * Shared by the HTML preview document and the PDF export so both render the
 * identical label from the identical stored value. Pure formatting: trims
 * insignificant zeros, converts digits, appends the percent sign. Empty input
 * renders as "۰٪".
 */
export function formatPersianPercent(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (normalized === "") return "۰٪";
  const trimmed = normalized.replace(/0+$/, "").replace(/\.$/, "");
  const digits = trimmed === "" ? "0" : trimmed;
  return `${toPersianDigits(digits)}٪`;
}

/** Persian label for a stored InvoicePayment.method value. */
export function formatPaymentMethod(method: string | null | undefined): string {
  switch (method) {
    case "CASH":
      return "نقد";
    case "CARD":
      return "کارت";
    case "BANK_TRANSFER":
      return "انتقال بانکی";
    case "ONLINE":
      return "آنلاین";
    case "OTHER":
      return "سایر";
    default:
      return method && method.trim() !== "" ? method : "—";
  }
}

/**
 * Formats an ISO date string or Date object into Persian Solar (Jalali) date string.
 * Uses native browser/Node Intl.DateTimeFormat with 'fa-IR'.
 */
export function formatPersianDate(
  dateValue: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "long",
    day: "numeric",
  },
): string {
  if (!dateValue) return "—";
  try {
    const d = typeof dateValue === "string" ? new Date(dateValue) : dateValue;
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("fa-IR", options).format(d);
  } catch {
    return "—";
  }
}

/**
 * Short Persian date (e.g. ۱۴۰۵/۰۶/۱۶).
 */
export function formatPersianDateShort(dateValue: string | Date | null | undefined): string {
  if (!dateValue) return "—";
  try {
    const d = typeof dateValue === "string" ? new Date(dateValue) : dateValue;
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("fa-IR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return "—";
  }
}

/**
 * Normalizes a number typed by a Persian/Arabic keyboard into a canonical
 * ASCII decimal string: Persian digits (۰-۹) and Arabic-Indic digits (٠-٩)
 * become Latin digits, thousands separators (`,` `٬`) and spaces are removed,
 * and the Persian decimal separators (`٫` `/`) become `.`. Returns "" for
 * empty input or anything that is not a plain non-negative decimal — callers
 * treat "" as "not a number" and reject it with a friendly validation error.
 *
 * This is an *input* utility (parsing), the inverse of {@link toPersianDigits}
 * — both live here so digit normalization never gets re-implemented ad hoc.
 */
export function normalizeLocalizedNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value).trim();
  if (text === "") return "";

  // Arabic-Indic digits (U+0660–U+0669) and Extended Arabic-Indic / Persian
  // digits (U+06F0–U+06F9) → ASCII 0-9.
  text = text.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
  text = text.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));

  // Thousands separators (`1,234,567` / Persian `٬`) and any whitespace.
  text = text.replace(/[,٬\s_]/g, "");

  // Persian decimal separator `٫` and the commonly typed `/` → `.`
  text = text.replace(/[٫/]/g, ".");

  if (!/^\d+\.?\d*$/.test(text)) return "";
  return text;
}

/**
 * Converts a stored decimal string (e.g. ProductDTO.price "5000000.00") into
 * the shortest string a form input should show ("5000000", "9"). Trailing
 * zeros after the decimal point are trimmed. Returns "" for non-numeric input.
 */
export function toNumericInputString(value: string | number | null | undefined): string {
  const normalized = normalizeLocalizedNumber(value);
  if (normalized === "") return "";
  if (normalized.includes(".")) {
    const trimmed = normalized.replace(/0+$/, "").replace(/\.$/, "");
    return trimmed === "" ? "0" : trimmed;
  }
  return normalized;
}

/**
 * Formats a Date as a Gregorian `YYYY-MM-DD` value for an HTML date input,
 * evaluated in the given time zone (defaults to Asia/Tehran so the default
 * "today" matches the user's business day, not the server's UTC day).
 * Falls back to the UTC date when the time zone is unavailable.
 */
export function formatGregorianDateInput(
  dateValue: Date | string | null | undefined = new Date(),
  timeZone = "Asia/Tehran",
): string {
  const d = dateValue === null || dateValue === undefined ? new Date() : dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const lookup: Record<string, string> = {};
    for (const part of parts) {
      lookup[part.type] = part.value;
    }
    if (lookup.year && lookup.month && lookup.day) {
      return `${lookup.year}-${lookup.month}-${lookup.day}`;
    }
  } catch {
    // fall through to the UTC fallback below
  }
  return d.toISOString().slice(0, 10);
}

export type StatusBadgeVariant =
  | "default"
  | "secondary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "draft";

export interface InvoiceStatusMeta {
  label: string;
  variant: StatusBadgeVariant;
  dotColor: string;
}

/**
 * Maps domain invoice statuses to Persian labels and visual badge variants.
 */
export function formatInvoiceStatus(status: DashboardInvoiceStatus | string): InvoiceStatusMeta {
  switch (status) {
    case "DRAFT":
      return { label: "پیش‌نویس", variant: "draft", dotColor: "bg-gray-400" };
    case "ISSUED":
      return { label: "صادر شده", variant: "info", dotColor: "bg-blue-500" };
    case "SENT":
      return { label: "ارسال شده", variant: "info", dotColor: "bg-sky-500" };
    case "PENDING_PAYMENT":
      return { label: "در انتظار پرداخت", variant: "warning", dotColor: "bg-amber-500" };
    case "PARTIALLY_PAID":
      return { label: "پرداخت جزئی", variant: "warning", dotColor: "bg-orange-500" };
    case "PAID":
      return { label: "پرداخت شده", variant: "success", dotColor: "bg-emerald-500" };
    case "OVERDUE":
      return { label: "سررسید گذشته", variant: "danger", dotColor: "bg-rose-500" };
    case "CANCELLED":
      return { label: "لغو شده", variant: "secondary", dotColor: "bg-zinc-400" };
    default:
      return { label: status, variant: "secondary", dotColor: "bg-gray-400" };
  }
}

/**
 * Formats invoice type to Persian.
 */
export function formatInvoiceType(type: "PROFORMA" | "FINAL" | string): string {
  switch (type) {
    case "PROFORMA":
      return "پیش‌فاکتور";
    case "FINAL":
      return "فاکتور رسمی";
    default:
      return type;
  }
}

export interface SubscriptionStatusMeta {
  label: string;
  variant: StatusBadgeVariant;
}

/**
 * Maps a stored `Subscription.status` value to its Persian label and badge
 * variant. The UI passes the *enforced* (date/plan-adjusted) status from the
 * display DTO, so a row that says ACTIVE but has lapsed by date is labelled
 * as expired — the label always matches what entitlements actually enforce.
 */
export function formatSubscriptionStatus(status: string): SubscriptionStatusMeta {
  switch (status) {
    case "ACTIVE":
      return { label: "فعال", variant: "success" };
    case "PENDING":
      return { label: "در انتظار پرداخت", variant: "info" };
    case "EXPIRED":
      return { label: "منقضی‌شده", variant: "secondary" };
    case "CANCELLED":
      return { label: "لغو شده", variant: "secondary" };
    case "PAYMENT_FAILED":
      return { label: "پرداخت ناموفق", variant: "danger" };
    default:
      return { label: status, variant: "secondary" };
  }
}

/**
 * Maps a stored `SubscriptionPayment.status` value to its Persian label and
 * badge variant for the payment-history table.
 */
export function formatSubscriptionPaymentStatus(status: string): SubscriptionStatusMeta {
  switch (status) {
    case "PENDING":
      return { label: "در انتظار", variant: "info" };
    case "SUCCESS":
      return { label: "موفق", variant: "success" };
    case "FAILED":
      return { label: "ناموفق", variant: "danger" };
    case "CANCELLED":
      return { label: "لغو شده", variant: "secondary" };
    case "REFUNDED":
      return { label: "مسترد شده", variant: "warning" };
    default:
      return { label: status, variant: "secondary" };
  }
}

/**
 * Formats subscription plan key to Persian label.
 */
export function formatPlanKey(planKey: "FREE" | "BASIC" | "PRO" | string): string {
  switch (planKey) {
    case "FREE":
      return "پلن رایگان";
    case "BASIC":
      return "پلن پایه";
    case "PRO":
      return "پلن حرفه‌ای";
    default:
      return `پلن ${planKey}`;
  }
}
