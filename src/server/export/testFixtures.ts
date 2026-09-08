import type { InvoicePreviewModel } from "@/lib/invoice-preview-model";

/**
 * Shared fixtures for the export test suites (PDF, image, Excel, share).
 *
 * The finalized fixture deliberately differs from any "current profile" so
 * tests can prove snapshot usage: seller/customer names carry a
 * `(snapshot)` marker, the currency snapshot is تومان (IRT) and the
 * branding/footer/banking values are snapshot-shaped.
 */

/** 1x1 red PNG bytes (avoids sharp/network in image-handling tests). */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function finalizedPreviewModel(
  overrides: Partial<InvoicePreviewModel> = {},
): InvoicePreviewModel {
  return {
    invoice: {
      id: "inv-1",
      businessId: "biz-1",
      customerId: "cust-1",
      invoiceNumber: "1024",
      invoiceType: "FINAL",
      issueDate: "2026-03-05T00:00:00.000Z",
      dueDate: "2026-03-30T00:00:00.000Z",
      status: "PENDING_PAYMENT",
      subtotal: "200000.00",
      itemDiscountAmount: "20000.00",
      globalDiscountPercent: "5.00",
      globalDiscountAmount: "9000.00",
      taxPercent: "9.00",
      taxAmount: "15390.00",
      taxableAmount: "171000.00",
      total: "186390.00",
      paidAmount: "50000.00",
      remainingAmount: "136390.00",
      currency: "IRT",
      notes: "پرداخت ظرف ده روز",
      createdAt: "2026-03-05T00:00:00.000Z",
      updatedAt: "2026-03-05T00:00:00.000Z",
      finalizedAt: "2026-03-05T12:00:00.000Z",
      cancelledAt: null,
      items: [
        {
          id: "item-1",
          productId: null,
          title: "خدمات طراحی وب",
          description: "صفحه اصلی و وبلاگ",
          itemDate: null,
          unitPrice: "100000.00",
          quantity: "2",
          unit: "عدد",
          discountPercent: "10.00",
          discountAmount: "20000.00",
          subtotal: "200000.00",
          total: "180000.00",
          sortOrder: 0,
        },
      ],
    },
    businessId: "biz-1",
    lifecycle: "FINALIZED",
    isDraft: false,
    officialNumber: "1024",
    seller: {
      source: "SNAPSHOT",
      businessName: "فروشگاه البرز (snapshot)",
      slogan: "شعار snapshot",
      ownerName: "مالک snapshot",
      address: "آدرس snapshot",
      email: "snap@example.ir",
      mobile: "09120000001",
      landline: "02120000001",
      cardNumber: "6037991111111111",
      accountNumber: "1111111111",
      iban: "IR111111111111111111111111",
      primaryColor: "#0055ff",
      footerBackgroundColor: "#111827",
      footerText: "پانوشت snapshot",
      logo: { fileId: "file-logo", url: "https://cdn.example/logo.png" },
      sellerStamp: null,
      sellerSignature: { fileId: "file-sign", url: "https://cdn.example/sign.png" },
    },
    customer: {
      name: "مشتری snapshot",
      mobile: "09120000002",
      phone: "02120000002",
      email: "snap-cust@example.ir",
      address: "آدرس مشتری snapshot",
      nationalId: "1010101010",
      economicCode: "4111222333",
    },
    currency: "IRT",
    ...overrides,
  };
}

export function draftPreviewModel(): InvoicePreviewModel {
  const base = finalizedPreviewModel();
  return {
    ...base,
    invoice: {
      ...base.invoice,
      id: "inv-draft",
      invoiceNumber: "DRAFT-xyz",
      status: "DRAFT",
      paidAmount: "0.00",
      remainingAmount: "186390.00",
      currency: null,
      finalizedAt: null,
    },
    lifecycle: "DRAFT",
    isDraft: true,
    officialNumber: null,
    seller: base.seller
      ? {
          ...base.seller,
          source: "PROFILE",
          businessName: "فروشگاه البرز (profile)",
          logo: null,
          sellerSignature: null,
        }
      : null,
    currency: "IRR",
  };
}
