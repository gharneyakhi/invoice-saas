import type Decimal from "decimal.js";
import type { InvoiceRecord } from "@/server/invoice/invoiceService";
import { buildInvoicePreviewModel, type InvoicePreviewModel } from "@/lib/invoice-preview-model";

/**
 * Fabricated invoice models for export tests and the visual verify script.
 * Decimal stubs suffice: the DTO mapping only calls toString() on money
 * columns (same fabrication as invoiceDetail.test.ts).
 */

// ---------------------------------------------------------------------------
// Fixtures (mirrors invoiceDetail.test.ts fabrication: Decimal stubs are
// enough because the DTO mapping only calls toString() on money columns).
// ---------------------------------------------------------------------------

type DecimalStub = { toString(): string };

export const money = (value: string): DecimalStub => ({ toString: () => value });

export function lineItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-1",
    invoiceId: "inv-final-1",
    productId: null,
    title: "خدمت طراحی",
    description: null,
    itemDate: null,
    unitPrice: money("100000"),
    quantity: money("1"),
    unit: "ساعت",
    discountPercent: money("0"),
    discountAmount: money("0"),
    subtotal: money("100000"),
    total: money("100000"),
    sortOrder: 0,
    ...overrides,
  };
}

export function finalizedRow(overrides: Record<string, unknown> = {}): InvoiceRecord {
  return {
    id: "inv-final-1",
    businessId: "biz-1",
    customerId: "cust-1",
    invoiceNumber: "INV-101",
    invoiceType: "FINAL",
    issueDate: new Date("2026-03-05"),
    dueDate: new Date("2026-03-30"),
    status: "PENDING_PAYMENT",
    subtotal: money("100000") as unknown as Decimal,
    itemDiscountAmount: money("0") as unknown as Decimal,
    globalDiscountPercent: money("10") as unknown as Decimal,
    globalDiscountAmount: money("10000") as unknown as Decimal,
    taxPercent: money("9") as unknown as Decimal,
    taxAmount: money("8100") as unknown as Decimal,
    taxableAmount: money("90000") as unknown as Decimal,
    total: money("98100") as unknown as Decimal,
    paidAmount: money("0") as unknown as Decimal,
    remainingAmount: money("98100") as unknown as Decimal,
    currency: "IRR",
    notes: "تحویل در محل انجام شد",
    createdAt: new Date("2026-03-05"),
    updatedAt: new Date("2026-03-05"),
    finalizedAt: new Date("2026-03-10"),
    cancelledAt: null,
    items: [lineItem()],
    sellerSnapshot: {
      businessName: "استودیو نمارو",
      slogan: "کیفیت برتر",
      ownerName: "علی رضایی",
      address: "تهران، خیابان آزادی",
      email: "contact@example.ir",
      mobile: "09121111111",
      landline: "02166554433",
      cardNumber: "6037991122334455",
      accountNumber: "0101010101001",
      iban: "IR120000000000000000000001",
      primaryColor: "#0055ff",
      footerBackgroundColor: "#111827",
      footerText: "از خرید شما سپاسگزاریم",
    },
    customerSnapshot: {
      name: "علیرضا قوایی",
      mobile: "09123456789",
      phone: "02188776655",
      email: "info@example.ir",
      address: "تهران، میدان ونک",
      nationalId: "10101010101",
      economicCode: "4111222333",
    },
    ...overrides,
  } as unknown as InvoiceRecord;
}

export function finalizedModel(rowOverrides: Record<string, unknown> = {}): InvoicePreviewModel {
  return buildInvoicePreviewModel({
    invoice: finalizedRow(rowOverrides),
    fallbackBusinessName: "Fallback Biz",
    currentProfile: null,
    currentCustomer: null,
    images: { logo: null, sellerStamp: null, sellerSignature: null },
    currency: "IRR",
  });
}

export function draftModel(): InvoicePreviewModel {
  return buildInvoicePreviewModel({
    invoice: finalizedRow({
      status: "DRAFT",
      invoiceNumber: "DRAFT-abcdef12",
      finalizedAt: null,
      sellerSnapshot: null,
      customerSnapshot: null,
    }),
    fallbackBusinessName: "Fallback Biz",
    currentProfile: {
      businessName: "استودیو نمارو",
      slogan: null,
      ownerName: null,
      address: null,
      email: null,
      mobile: null,
      landline: null,
      cardNumber: null,
      accountNumber: null,
      iban: null,
      logoFileId: null,
      sellerStampFileId: null,
      sellerSignatureFileId: null,
      primaryColor: "#0055ff",
      footerBackgroundColor: "#111827",
      footerText: "از خرید شما سپاسگزاریم",
    },
    currentCustomer: {
      name: "علیرضا قوایی",
      mobile: null,
      phone: null,
      email: null,
      address: null,
      nationalId: null,
      economicCode: null,
    },
    images: { logo: null, sellerStamp: null, sellerSignature: null },
    currency: "IRR",
  });
}
