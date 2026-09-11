import { describe, it, expect } from "vitest";
import {
  toPersianDigits,
  formatPersianNumber,
  formatCurrency,
  formatPersianDate,
  formatPersianDateShort,
  formatInvoiceStatus,
  formatInvoiceType,
  formatSubscriptionStatus,
  formatSubscriptionPaymentStatus,
  formatPlanKey,
  normalizeLocalizedNumber,
  toNumericInputString,
  formatGregorianDateInput,
  formatPaymentMethod,
} from "./formatters";

describe("formatters", () => {
  describe("toPersianDigits", () => {
    it("converts 0-9 to Persian digits", () => {
      expect(toPersianDigits("0123456789")).toBe("۰۱۲۳۴۵۶۷۸۹");
      expect(toPersianDigits(123)).toBe("۱۲۳");
    });

    it("handles empty or nullish values", () => {
      expect(toPersianDigits(null)).toBe("");
      expect(toPersianDigits(undefined)).toBe("");
      expect(toPersianDigits("")).toBe("");
    });
  });

  describe("formatPersianNumber", () => {
    it("formats numbers with thousand separators in Persian digits", () => {
      expect(formatPersianNumber(1000)).toBe("۱,۰۰۰");
      expect(formatPersianNumber(2500000)).toBe("۲,۵۰۰,۰۰۰");
      expect(formatPersianNumber("1234567")).toBe("۱,۲۳۴,۵۶۷");
    });

    it("handles zero and nullish values", () => {
      expect(formatPersianNumber(0)).toBe("۰");
      expect(formatPersianNumber(null)).toBe("۰");
      expect(formatPersianNumber(undefined)).toBe("۰");
      expect(formatPersianNumber("")).toBe("۰");
    });
  });

  describe("formatCurrency", () => {
    it("formats monetary amounts with ریال suffix", () => {
      expect(formatCurrency(1000)).toBe("۱,۰۰۰ ریال");
      expect(formatCurrency("2500000.00")).toBe("۲,۵۰۰,۰۰۰ ریال");
      expect(formatCurrency("0")).toBe("۰ ریال");
    });

    it("handles null or undefined safely", () => {
      expect(formatCurrency(null)).toBe("۰ ریال");
      expect(formatCurrency(undefined)).toBe("۰ ریال");
      expect(formatCurrency("")).toBe("۰ ریال");
    });

    it("formats تومان when the unit is IRT (not a relabel of ریال)", () => {
      expect(formatCurrency(1000, "IRT")).toBe("۱,۰۰۰ تومان");
      expect(formatCurrency("2500000.00", "IRT")).toBe("۲,۵۰۰,۰۰۰ تومان");
      expect(formatCurrency(null, "IRT")).toBe("۰ تومان");
      expect(formatCurrency(1000, "IRR")).toBe("۱,۰۰۰ ریال");
    });
  });

  describe("formatPersianDate & formatPersianDateShort", () => {
    it("formats valid ISO dates to Persian calendar string", () => {
      const date = "2026-09-07T00:00:00.000Z";
      const formatted = formatPersianDate(date);
      expect(formatted).toContain("۱۴۰۵");
      expect(formatted).toContain("شهریور");

      const short = formatPersianDateShort(date);
      expect(short).toContain("۱۴۰۵");
    });

    it("handles invalid or null dates safely", () => {
      expect(formatPersianDate(null)).toBe("—");
      expect(formatPersianDate(undefined)).toBe("—");
      expect(formatPersianDate("invalid-date")).toBe("—");
      expect(formatPersianDateShort(null)).toBe("—");
    });
  });

  describe("formatInvoiceStatus", () => {
    it("maps all domain invoice statuses correctly", () => {
      expect(formatInvoiceStatus("DRAFT")).toMatchObject({ label: "پیش‌نویس", variant: "draft" });
      expect(formatInvoiceStatus("ISSUED")).toMatchObject({ label: "صادر شده", variant: "info" });
      expect(formatInvoiceStatus("SENT")).toMatchObject({ label: "ارسال شده", variant: "info" });
      expect(formatInvoiceStatus("PENDING_PAYMENT")).toMatchObject({ label: "در انتظار پرداخت", variant: "warning" });
      expect(formatInvoiceStatus("PARTIALLY_PAID")).toMatchObject({ label: "پرداخت جزئی", variant: "warning" });
      expect(formatInvoiceStatus("PAID")).toMatchObject({ label: "پرداخت شده", variant: "success" });
      expect(formatInvoiceStatus("OVERDUE")).toMatchObject({ label: "سررسید گذشته", variant: "danger" });
      expect(formatInvoiceStatus("CANCELLED")).toMatchObject({ label: "لغو شده", variant: "secondary" });
    });

    it("handles unknown status gracefully", () => {
      const unknown = formatInvoiceStatus("OTHER_STATUS");
      expect(unknown.label).toBe("OTHER_STATUS");
      expect(unknown.variant).toBe("secondary");
    });
  });

  describe("formatInvoiceType", () => {
    it("maps invoice types to Persian labels", () => {
      expect(formatInvoiceType("PROFORMA")).toBe("پیش‌فاکتور");
      expect(formatInvoiceType("FINAL")).toBe("فاکتور رسمی");
    });
  });

  describe("formatPlanKey", () => {
    it("maps plan keys to Persian labels", () => {
      expect(formatPlanKey("FREE")).toBe("پلن رایگان");
      expect(formatPlanKey("BASIC")).toBe("پلن پایه");
      expect(formatPlanKey("PRO")).toBe("پلن حرفه‌ای");
      expect(formatPlanKey("ENTERPRISE")).toBe("پلن ENTERPRISE");
    });
  });
});

describe("normalizeLocalizedNumber", () => {
  it("converts Persian digits to ASCII", () => {
    expect(normalizeLocalizedNumber("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
    expect(normalizeLocalizedNumber("۲,۵۰۰,۰۰۰")).toBe("2500000");
  });

  it("converts Arabic-Indic digits to ASCII", () => {
    expect(normalizeLocalizedNumber("٠١٢٣")).toBe("0123");
  });

  it("normalizes Persian decimal separators", () => {
    expect(normalizeLocalizedNumber("۱۲۳٫۵")).toBe("123.5");
    expect(normalizeLocalizedNumber("۱۲۳/۵")).toBe("123.5");
  });

  it("strips thousands separators and whitespace", () => {
    expect(normalizeLocalizedNumber("1,234,567")).toBe("1234567");
    expect(normalizeLocalizedNumber("۱٬۲۳۴")).toBe("1234");
    expect(normalizeLocalizedNumber(" 123 ")).toBe("123");
  });

  it("passes plain ASCII decimals through unchanged", () => {
    expect(normalizeLocalizedNumber("12345.67")).toBe("12345.67");
    expect(normalizeLocalizedNumber(42)).toBe("42");
  });

  it("rejects non-numeric and negative input with empty string", () => {
    expect(normalizeLocalizedNumber("abc")).toBe("");
    expect(normalizeLocalizedNumber("-100")).toBe("");
    expect(normalizeLocalizedNumber("۱۲a۳")).toBe("");
    expect(normalizeLocalizedNumber("")).toBe("");
    expect(normalizeLocalizedNumber(null)).toBe("");
    expect(normalizeLocalizedNumber(undefined)).toBe("");
  });
});

describe("toNumericInputString", () => {
  it("trims trailing decimal zeros for form inputs", () => {
    expect(toNumericInputString("5000000.00")).toBe("5000000");
    expect(toNumericInputString("9.00")).toBe("9");
    expect(toNumericInputString("2.50")).toBe("2.5");
    expect(toNumericInputString("0.50")).toBe("0.5");
  });

  it("keeps plain integers and zero intact", () => {
    expect(toNumericInputString("2.5")).toBe("2.5");
    expect(toNumericInputString("100")).toBe("100");
    expect(toNumericInputString("0")).toBe("0");
    expect(toNumericInputString(10)).toBe("10");
  });

  it("returns empty string for non-numeric input", () => {
    expect(toNumericInputString(null)).toBe("");
    expect(toNumericInputString("abc")).toBe("");
  });
});

describe("formatGregorianDateInput", () => {
  it("formats a Date as YYYY-MM-DD in the given time zone", () => {
    // 2026-09-07 00:30 UTC is 04:00 in Asia/Tehran — still day 7 there.
    expect(formatGregorianDateInput(new Date("2026-09-07T00:30:00.000Z"), "Asia/Tehran")).toBe(
      "2026-09-07",
    );
  });

  it("respects time zone day boundaries", () => {
    // 2026-09-06 21:00 UTC is 2026-09-07 00:30 in Asia/Tehran.
    expect(formatGregorianDateInput(new Date("2026-09-06T21:00:00.000Z"), "Asia/Tehran")).toBe(
      "2026-09-07",
    );
    // ...but still 2026-09-06 in UTC.
    expect(formatGregorianDateInput(new Date("2026-09-06T21:00:00.000Z"), "UTC")).toBe(
      "2026-09-06",
    );
  });

  it("accepts ISO strings and returns empty for invalid input", () => {
    expect(formatGregorianDateInput("2026-03-15T12:00:00.000Z", "UTC")).toBe("2026-03-15");
    expect(formatGregorianDateInput("not-a-date")).toBe("");
  });
});

describe("formatSubscriptionStatus", () => {
  it("maps every stored subscription status to a Persian label and variant", () => {
    expect(formatSubscriptionStatus("ACTIVE")).toEqual({ label: "فعال", variant: "success" });
    expect(formatSubscriptionStatus("PENDING")).toEqual({ label: "در انتظار پرداخت", variant: "info" });
    expect(formatSubscriptionStatus("EXPIRED")).toEqual({ label: "منقضی‌شده", variant: "secondary" });
    expect(formatSubscriptionStatus("CANCELLED")).toEqual({ label: "لغو شده", variant: "secondary" });
    expect(formatSubscriptionStatus("PAYMENT_FAILED")).toEqual({ label: "پرداخت ناموفق", variant: "danger" });
  });

  it("falls back to the raw value with a neutral variant for unknown statuses", () => {
    expect(formatSubscriptionStatus("SOMETHING_NEW")).toEqual({ label: "SOMETHING_NEW", variant: "secondary" });
  });
});

describe("formatSubscriptionPaymentStatus", () => {
  it("maps every stored payment status to a Persian label and variant", () => {
    expect(formatSubscriptionPaymentStatus("PENDING")).toEqual({ label: "در انتظار", variant: "info" });
    expect(formatSubscriptionPaymentStatus("SUCCESS")).toEqual({ label: "موفق", variant: "success" });
    expect(formatSubscriptionPaymentStatus("FAILED")).toEqual({ label: "ناموفق", variant: "danger" });
    expect(formatSubscriptionPaymentStatus("CANCELLED")).toEqual({ label: "لغو شده", variant: "secondary" });
    expect(formatSubscriptionPaymentStatus("REFUNDED")).toEqual({ label: "مسترد شده", variant: "warning" });
  });

  it("falls back to the raw value with a neutral variant for unknown statuses", () => {
    expect(formatSubscriptionPaymentStatus("WEIRD")).toEqual({ label: "WEIRD", variant: "secondary" });
  });
});
