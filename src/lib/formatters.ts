import type { DashboardInvoiceStatus } from "@/server/dashboard/dashboardService";

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
 * Formats monetary amounts in Iranian currency (IRR / ریال) with Persian numerals.
 */
export function formatCurrency(
  amount: string | number | null | undefined,
  currency: "IRR" | string = "IRR",
): string {
  if (amount === null || amount === undefined || amount === "") return "۰ ریال";
  const num = typeof amount === "number" ? amount : Number(amount);
  if (isNaN(num)) return "۰ ریال";
  const formatted = Math.round(num).toLocaleString("en-US");
  const currencyLabel = currency === "IRR" ? "ریال" : currency;
  return `${toPersianDigits(formatted)} ${currencyLabel}`;
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
