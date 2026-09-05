import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  calculateLineItem,
  calculateInvoice,
  derivePaymentStatus,
  calculateRemainingAmount,
  InvoiceCalculationError,
} from "./invoice-calculation";

describe("calculateLineItem", () => {
  it("computes subtotal, discount and total correctly", () => {
    const result = calculateLineItem({ unitPrice: 100000, quantity: 2, discountPercent: 10 });
    expect(result.subtotal.toString()).toBe("200000");
    expect(result.discountAmount.toString()).toBe("20000");
    expect(result.total.toString()).toBe("180000");
  });

  it("rejects zero quantity", () => {
    expect(() => calculateLineItem({ unitPrice: 100, quantity: 0, discountPercent: 0 })).toThrow(
      InvoiceCalculationError,
    );
  });

  it("rejects negative price", () => {
    expect(() => calculateLineItem({ unitPrice: -100, quantity: 1, discountPercent: 0 })).toThrow(
      InvoiceCalculationError,
    );
  });

  it("handles 100% discount (line total is zero)", () => {
    const result = calculateLineItem({ unitPrice: 5000, quantity: 1, discountPercent: 100 });
    expect(result.total.toString()).toBe("0");
  });

  it("rejects discount over 100%", () => {
    expect(() => calculateLineItem({ unitPrice: 5000, quantity: 1, discountPercent: 150 })).toThrow(
      InvoiceCalculationError,
    );
  });
});

describe("calculateInvoice", () => {
  it("computes a full multi-line invoice with global discount and VAT", () => {
    const result = calculateInvoice({
      items: [
        { unitPrice: 100000, quantity: 2, discountPercent: 10 }, // 180,000
        { unitPrice: 50000, quantity: 1, discountPercent: 0 }, // 50,000
      ],
      globalDiscountPercent: 5,
      taxPercent: 9,
    });

    expect(result.subtotalAfterLineDiscounts.toString()).toBe("230000");
    // global discount 5% of 230000 = 11500
    expect(result.globalDiscountAmount.toString()).toBe("11500");
    // taxable = 218500
    expect(result.taxableAmount.toString()).toBe("218500");
    // VAT 9% of 218500 = 19665
    expect(result.taxAmount.toString()).toBe("19665");
    expect(result.total.toString()).toBe("238165");
  });

  it("rejects an invoice with no items", () => {
    expect(() => calculateInvoice({ items: [], globalDiscountPercent: 0, taxPercent: 0 })).toThrow(
      InvoiceCalculationError,
    );
  });

  it("handles zero VAT correctly", () => {
    const result = calculateInvoice({
      items: [{ unitPrice: 1000, quantity: 1, discountPercent: 0 }],
      globalDiscountPercent: 0,
      taxPercent: 0,
    });
    expect(result.taxAmount.toString()).toBe("0");
    expect(result.total.toString()).toBe("1000");
  });
});

describe("derivePaymentStatus", () => {
  it("is PENDING_PAYMENT when nothing paid", () => {
    expect(derivePaymentStatus({ total: 1000, paidAmount: 0, dueDate: null })).toBe("PENDING_PAYMENT");
  });

  it("is PARTIALLY_PAID for partial payment", () => {
    expect(derivePaymentStatus({ total: 1000, paidAmount: 400, dueDate: null })).toBe("PARTIALLY_PAID");
  });

  it("is PAID when paidAmount equals total", () => {
    expect(derivePaymentStatus({ total: 1000, paidAmount: 1000, dueDate: null })).toBe("PAID");
  });

  it("is PAID (not error) when payment exceeds total (overpayment)", () => {
    expect(derivePaymentStatus({ total: 1000, paidAmount: 1500, dueDate: null })).toBe("PAID");
  });

  it("is OVERDUE when due date passed and balance remains", () => {
    const dueDate = new Date("2020-01-01");
    const now = new Date("2020-02-01");
    expect(derivePaymentStatus({ total: 1000, paidAmount: 0, dueDate, now })).toBe("OVERDUE");
  });

  it("is not OVERDUE once fully paid, even past due date", () => {
    const dueDate = new Date("2020-01-01");
    const now = new Date("2020-02-01");
    expect(derivePaymentStatus({ total: 1000, paidAmount: 1000, dueDate, now })).toBe("PAID");
  });

  it("rejects negative paid amount", () => {
    expect(() => derivePaymentStatus({ total: 1000, paidAmount: -1, dueDate: null })).toThrow();
  });
});

describe("calculateRemainingAmount", () => {
  it("computes remaining balance", () => {
    expect(calculateRemainingAmount(1000, 400).toString()).toBe("600");
  });

  it("never returns negative-looking confusion for overpayment (caller clamps display only)", () => {
    // Calculation itself is honest about the raw delta; UI/business layer
    // decides whether to clamp remainingAmount to 0 for display.
    expect(calculateRemainingAmount(1000, 1500).toString()).toBe("-500");
  });
});
