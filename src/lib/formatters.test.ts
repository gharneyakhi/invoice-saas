import { describe, it, expect } from "vitest";
import {
  toPersianDigits,
  formatPersianNumber,
  formatCurrency,
  formatPersianDate,
  formatPersianDateShort,
  formatInvoiceStatus,
  formatInvoiceType,
  formatPlanKey,
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
