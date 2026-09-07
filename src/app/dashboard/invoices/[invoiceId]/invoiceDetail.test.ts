import { describe, it, expect } from "vitest";
import { toInvoiceDetailDTO } from "@/server/actions/dto";
import type { InvoiceRecord } from "@/server/invoice/invoiceService";

function draftRow(overrides: Partial<Record<string, unknown>> = {}): InvoiceRecord {
  return {
    id: "inv-draft-1",
    businessId: "biz-1",
    customerId: "cust-1",
    invoiceNumber: "DRAFT-abc",
    invoiceType: "FINAL",
    issueDate: new Date("2026-03-05"),
    dueDate: new Date("2026-03-30"),
    status: "DRAFT",
    subtotal: { toString: () => "100000" } as unknown as import("decimal.js").default,
    itemDiscountAmount: { toString: () => "0" } as unknown as import("decimal.js").default,
    globalDiscountPercent: { toString: () => "0" } as unknown as import("decimal.js").default,
    globalDiscountAmount: { toString: () => "0" } as unknown as import("decimal.js").default,
    taxPercent: { toString: () => "9" } as unknown as import("decimal.js").default,
    taxAmount: { toString: () => "9000" } as unknown as import("decimal.js").default,
    taxableAmount: { toString: () => "100000" } as unknown as import("decimal.js").default,
    total: { toString: () => "109000" } as unknown as import("decimal.js").default,
    paidAmount: { toString: () => "0" } as unknown as import("decimal.js").default,
    remainingAmount: { toString: () => "109000" } as unknown as import("decimal.js").default,
    notes: "پیش‌نویس",
    createdAt: new Date("2026-03-05"),
    updatedAt: new Date("2026-03-05"),
    finalizedAt: null,
    cancelledAt: null,
    items: [
      {
        id: "item-1",
        invoiceId: "inv-draft-1",
        productId: null,
        title: "خدمت طراحی",
        description: null,
        itemDate: null,
        unitPrice: { toString: () => "100000" } as unknown as import("decimal.js").default,
        quantity: { toString: () => "1" } as unknown as import("decimal.js").default,
        unit: "ساعت",
        discountPercent: { toString: () => "0" } as unknown as import("decimal.js").default,
        discountAmount: { toString: () => "0" } as unknown as import("decimal.js").default,
        subtotal: { toString: () => "100000" } as unknown as import("decimal.js").default,
        total: { toString: () => "100000" } as unknown as import("decimal.js").default,
        sortOrder: 0,
      },
    ],
    sellerSnapshot: null,
    customerSnapshot: null,
    ...overrides,
  };
}

function finalizedRow(overrides: Partial<Record<string, unknown>> = {}): InvoiceRecord {
  return {
    ...draftRow({
      status: "PENDING_PAYMENT",
      invoiceNumber: "INV-101",
      finalizedAt: new Date("2026-03-10"),
      items: [
        {
          id: "item-f-1",
          invoiceId: "inv-final-1",
          productId: null,
          title: "خدمت نهایی",
          description: null,
          itemDate: null,
          unitPrice: { toString: () => "200000" } as unknown as import("decimal.js").default,
          quantity: { toString: () => "2" } as unknown as import("decimal.js").default,
          unit: "ساعت",
          discountPercent: { toString: () => "10" } as unknown as import("decimal.js").default,
          discountAmount: { toString: () => "40000" } as unknown as import("decimal.js").default,
          subtotal: { toString: () => "400000" } as unknown as import("decimal.js").default,
          total: { toString: () => "360000" } as unknown as import("decimal.js").default,
          sortOrder: 0,
        },
      ],
    }),
    id: "inv-final-1",
    businessId: "biz-1",
    customerId: "cust-1",
    sellerSnapshot: {
      id: "snap-seller-1",
      invoiceId: "inv-final-1",
      businessName: "فروشگاه رسمی البرز",
      slogan: "کیفیت برتر",
      ownerName: "علی رضایی",
      address: "تهران، خیابان آزادی",
      email: "contact@alborz.ir",
      mobile: "09121111111",
      landline: "02166554433",
      cardNumber: "6037991122334455",
      accountNumber: "0101010101001",
      iban: "IR120000000000000000000001",
      logoFileId: null,
      sellerStampFileId: null,
      sellerSignatureFileId: null,
      primaryColor: "#0055ff",
      footerText: "از خرید شما سپاسگزاریم",
    },
    customerSnapshot: {
      id: "snap-customer-1",
      invoiceId: "inv-final-1",
      name: "شرکت صنایع پارس",
      mobile: "09123456789",
      phone: "02188776655",
      email: "info@pars.ir",
      address: "تهران، میدان ونک",
      nationalId: "10101010101",
      economicCode: "4111222333",
    },
    ...overrides,
  };
}

describe("invoice detail DTO", () => {
  it("maps a draft invoice with line items to a detail DTO", () => {
    const row = draftRow();
    const dto = toInvoiceDetailDTO(row);

    expect(dto.id).toBe("inv-draft-1");
    expect(dto.status).toBe("DRAFT");
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0]?.title).toBe("خدمت طراحی");
    expect(dto.items[0]?.unitPrice).toBe("100000.00");
  });

  it("maps a finalized invoice and includes line items and snapshot fields in the record", () => {
    const row = finalizedRow();
    const dto = toInvoiceDetailDTO(row);

    expect(dto.id).toBe("inv-final-1");
    expect(dto.status).toBe("PENDING_PAYMENT");
    expect(dto.invoiceNumber).toBe("INV-101");
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0]?.title).toBe("خدمت نهایی");
    expect(dto.items[0]?.quantity).toBe("2");
  });

  it("handles zero items for a draft", () => {
    const row = draftRow({ items: [] });
    const dto = toInvoiceDetailDTO(row);
    expect(dto.items).toHaveLength(0);
  });
});
