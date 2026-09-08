import { describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import type { InvoiceRecord } from "@/server/invoice/invoiceService";

// The module under test is value-imported; its server-side dependencies
// (session/auth modules) must not evaluate in the node test environment.
vi.mock("@/server/auth/requireBusinessOwnership", () => ({
  requireBusinessOwnership: vi.fn(),
}));
vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  class NotFoundError extends Error {}
  return {
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    requireSession: vi.fn(),
  };
});
import {
  buildInvoicePreviewModel,
  previewLifecycle,
  previewSellerSourceKind,
  type BuildInvoicePreviewModelInput,
  type PreviewImages,
  type PreviewProfileSource,
} from "@/server/invoice/previewService";

/**
 * Pure preview-model tests (no DB, no mocks).
 *
 * These pin the data-source law of the preview: DRAFT rows read the CURRENT
 * profile/customer; FINALIZED / CANCELLED rows read the immutable snapshots
 * and NEVER fall back to current profile/customer — including after those
 * rows were edited (the snapshot-regression guarantee).
 */

const MONEY = (value: string) => new Decimal(value);

function itemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-1",
    invoiceId: "inv-1",
    productId: null,
    title: "خدمت طراحی",
    description: "طراحی سامانه فروشگاهی",
    itemDate: null,
    unitPrice: MONEY("100000"),
    quantity: MONEY("2"),
    unit: "ساعت",
    discountPercent: MONEY("10"),
    discountAmount: MONEY("20000"),
    subtotal: MONEY("200000"),
    total: MONEY("180000"),
    sortOrder: 0,
    ...overrides,
  };
}

function invoiceRow(overrides: Partial<Record<string, unknown>> = {}): InvoiceRecord {
  return {
    id: "inv-1",
    businessId: "biz-1",
    customerId: "cust-1",
    invoiceNumber: "INV-101",
    invoiceType: "FINAL",
    issueDate: new Date("2026-03-05T00:00:00.000Z"),
    dueDate: new Date("2026-03-30T00:00:00.000Z"),
    status: "PENDING_PAYMENT",
    subtotal: MONEY("200000"),
    itemDiscountAmount: MONEY("20000"),
    globalDiscountPercent: MONEY("0"),
    globalDiscountAmount: MONEY("0"),
    taxPercent: MONEY("9"),
    taxAmount: MONEY("16200"),
    taxableAmount: MONEY("180000"),
    total: MONEY("196200"),
    paidAmount: MONEY("50000"),
    remainingAmount: MONEY("146200"),
    notes: "یادداشت فاکتور",
    createdAt: new Date("2026-03-05T00:00:00.000Z"),
    updatedAt: new Date("2026-03-05T00:00:00.000Z"),
    finalizedAt: new Date("2026-03-05T12:00:00.000Z"),
    cancelledAt: null,
    items: [itemRow()],
    sellerSnapshot: {
      id: "snap-seller-1",
      invoiceId: "inv-1",
      businessName: "فروشگاه البرز (snapshot)",
      slogan: "کیفیت برتر (snapshot)",
      ownerName: "علی رضایی (snapshot)",
      address: "تهران، snapshot",
      email: "snapshot@example.ir",
      mobile: "09120000001",
      landline: "02110000001",
      cardNumber: "6037990000000001",
      accountNumber: "0000000001",
      iban: "IR000000000000000000000001",
      logoFileId: "file-logo-snap",
      sellerStampFileId: null,
      sellerSignatureFileId: "file-sign-snap",
      primaryColor: "#0055ff",
      footerText: "با تشکر (snapshot)",
    },
    customerSnapshot: {
      id: "snap-customer-1",
      invoiceId: "inv-1",
      name: "شرکت پارس (snapshot)",
      mobile: "09120000002",
      phone: "02120000002",
      email: "snap@pars.ir",
      address: "تهران، snapshot مشتری",
      nationalId: "10101010101",
      economicCode: "4111222333",
    },
    ...overrides,
  };
}

/** Current BusinessProfile row — deliberately DIFFERENT from the snapshot. */
const CURRENT_PROFILE: PreviewProfileSource = {
  businessName: "فروشگاه البرز (profile جدید)",
  slogan: "شعار جدید",
  ownerName: "مدیر جدید",
  address: "اصفهان، profile",
  email: "profile@example.ir",
  mobile: "09129999999",
  landline: "03119999999",
  cardNumber: "6037999999999999",
  accountNumber: "9999999999",
  iban: "IR999999999999999999999999",
  logoFileId: "file-logo-profile",
  sellerStampFileId: "file-stamp-profile",
  sellerSignatureFileId: "file-sign-profile",
  primaryColor: "#123456",
  footerText: "پانوشت جدید profile",
};

const CURRENT_CUSTOMER = {
  name: "مشتری فعلی (live)",
  mobile: "09121111111",
  phone: "02121111111",
  email: "live@customer.ir",
  address: "شیراز، live",
  nationalId: "2222222222",
  economicCode: "5555666777",
};

const EMPTY_IMAGES: PreviewImages = { logo: null, sellerStamp: null, sellerSignature: null };

/** Resolved images for the snapshot source (what the loader would build). */
const SNAPSHOT_IMAGES: PreviewImages = {
  logo: { fileId: "file-logo-snap", url: "https://cdn.example/snap-logo.png" },
  sellerStamp: null,
  sellerSignature: { fileId: "file-sign-snap", url: "https://cdn.example/snap-sign.png" },
};

/** Resolved images for the current-profile source (draft rows). */
const PROFILE_IMAGES: PreviewImages = {
  logo: { fileId: "file-logo-profile", url: "https://cdn.example/profile-logo.png" },
  sellerStamp: { fileId: "file-stamp-profile", url: "https://cdn.example/profile-stamp.png" },
  sellerSignature: { fileId: "file-sign-profile", url: "https://cdn.example/profile-sign.png" },
};

function draftRow(overrides: Partial<Record<string, unknown>> = {}): InvoiceRecord {
  return invoiceRow({
    id: "inv-draft-1",
    invoiceNumber: "DRAFT-abc",
    status: "DRAFT",
    finalizedAt: null,
    paidAmount: MONEY("0"),
    remainingAmount: MONEY("196200"),
    sellerSnapshot: null,
    customerSnapshot: null,
    ...overrides,
  });
}

function baseInput(overrides: Partial<BuildInvoicePreviewModelInput> = {}): BuildInvoicePreviewModelInput {
  return {
    invoice: invoiceRow(),
    fallbackBusinessName: "فروشگاه البرز",
    currentProfile: CURRENT_PROFILE,
    currentCustomer: CURRENT_CUSTOMER,
    images: EMPTY_IMAGES,
    currency: "IRR",
    ...overrides,
  };
}

describe("preview model — FINALIZED rows read the immutable snapshots", () => {
  it("uses the seller snapshot for every seller field, never the current profile", () => {
    // current profile differs from the snapshot in every field
    const model = buildInvoicePreviewModel(baseInput());

    expect(model.seller?.source).toBe("SNAPSHOT");
    expect(model.seller?.businessName).toBe("فروشگاه البرز (snapshot)");
    expect(model.seller?.slogan).toBe("کیفیت برتر (snapshot)");
    expect(model.seller?.ownerName).toBe("علی رضایی (snapshot)");
    expect(model.seller?.address).toBe("تهران، snapshot");
    expect(model.seller?.email).toBe("snapshot@example.ir");
    expect(model.seller?.mobile).toBe("09120000001");
    expect(model.seller?.landline).toBe("02110000001");
    expect(model.seller?.cardNumber).toBe("6037990000000001");
    expect(model.seller?.accountNumber).toBe("0000000001");
    expect(model.seller?.iban).toBe("IR000000000000000000000001");
    expect(model.seller?.primaryColor).toBe("#0055ff");
    expect(model.seller?.footerText).toBe("با تشکر (snapshot)");
  });

  it("keeps the snapshot values even when the current profile changed after finalization", () => {
    const model = buildInvoicePreviewModel(baseInput({ images: SNAPSHOT_IMAGES }));

    expect(model.seller?.businessName).not.toBe(CURRENT_PROFILE.businessName);
    expect(model.seller?.address).not.toBe(CURRENT_PROFILE.address);
    expect(model.seller?.primaryColor).not.toBe(CURRENT_PROFILE.primaryColor);
    expect(model.seller?.logo?.fileId).toBe("file-logo-snap");
    // stamp missing in snapshot → null (draft/profile stamp is not substituted)
    expect(model.seller?.sellerStamp).toBeNull();
    expect(model.seller?.sellerSignature?.fileId).toBe("file-sign-snap");
  });

  it("uses the customer snapshot, not the live customer row", () => {
    const model = buildInvoicePreviewModel(baseInput());

    expect(model.customer?.name).toBe("شرکت پارس (snapshot)");
    expect(model.customer?.mobile).toBe("09120000002");
    expect(model.customer?.address).toBe("تهران، snapshot مشتری");
    expect(model.customer?.nationalId).toBe("10101010101");
    expect(model.customer?.economicCode).toBe("4111222333");
    expect(model.customer?.name).not.toBe(CURRENT_CUSTOMER.name);
  });

  it("exposes the official number and lifecycle for finalized rows", () => {
    const model = buildInvoicePreviewModel(baseInput());

    expect(model.lifecycle).toBe("FINALIZED");
    expect(model.isDraft).toBe(false);
    expect(model.officialNumber).toBe("INV-101");
  });

  it("keeps the authoritative totals and payment status untouched", () => {
    const model = buildInvoicePreviewModel(baseInput());
    const invoice = model.invoice;

    expect(invoice.total).toBe("196200.00");
    expect(invoice.subtotal).toBe("200000.00");
    expect(invoice.itemDiscountAmount).toBe("20000.00");
    expect(invoice.globalDiscountPercent).toBe("0.00");
    expect(invoice.globalDiscountAmount).toBe("0.00");
    expect(invoice.taxPercent).toBe("9.00");
    expect(invoice.taxAmount).toBe("16200.00");
    expect(invoice.paidAmount).toBe("50000.00");
    expect(invoice.remainingAmount).toBe("146200.00");
    expect(invoice.status).toBe("PENDING_PAYMENT");
    expect(invoice.notes).toBe("یادداشت فاکتور");
  });

  it("maps line items 1:1 with description and exact decimal strings", () => {
    const model = buildInvoicePreviewModel(baseInput());

    expect(model.invoice.items).toHaveLength(1);
    const item = model.invoice.items[0]!;
    expect(item.title).toBe("خدمت طراحی");
    expect(item.description).toBe("طراحی سامانه فروشگاهی");
    expect(item.quantity).toBe("2");
    expect(item.unitPrice).toBe("100000.00");
    expect(item.discountAmount).toBe("20000.00");
    expect(item.total).toBe("180000.00");
  });
});

describe("preview model — CANCELLED rows behave like finalized (snapshot)", () => {
  it("reads snapshots and keeps the official number for cancelled invoices", () => {
    const model = buildInvoicePreviewModel(
      baseInput({ invoice: invoiceRow({ status: "CANCELLED" }) }),
    );

    expect(model.lifecycle).toBe("CANCELLED");
    expect(model.isDraft).toBe(false);
    expect(model.officialNumber).toBe("INV-101");
    expect(model.seller?.source).toBe("SNAPSHOT");
    expect(model.seller?.businessName).toBe("فروشگاه البرز (snapshot)");
    expect(model.customer?.name).toBe("شرکت پارس (snapshot)");
  });
});

describe("preview model — DRAFT rows read the current profile / live customer", () => {
  it("uses the current profile as the seller source", () => {
    const model = buildInvoicePreviewModel(
      baseInput({ invoice: draftRow(), images: PROFILE_IMAGES }),
    );

    expect(model.lifecycle).toBe("DRAFT");
    expect(model.isDraft).toBe(true);
    expect(model.seller?.source).toBe("PROFILE");
    expect(model.seller?.businessName).toBe(CURRENT_PROFILE.businessName);
    expect(model.seller?.address).toBe(CURRENT_PROFILE.address);
    expect(model.seller?.primaryColor).toBe(CURRENT_PROFILE.primaryColor);
    expect(model.seller?.footerText).toBe(CURRENT_PROFILE.footerText);
    expect(model.seller?.logo?.fileId).toBe("file-logo-profile");
    expect(model.seller?.sellerStamp?.fileId).toBe("file-stamp-profile");
    expect(model.seller?.sellerSignature?.fileId).toBe("file-sign-profile");
  });

  it("uses the live customer row for drafts", () => {
    const model = buildInvoicePreviewModel(baseInput({ invoice: draftRow() }));

    expect(model.customer?.name).toBe(CURRENT_CUSTOMER.name);
    expect(model.customer?.mobile).toBe(CURRENT_CUSTOMER.mobile);
    expect(model.customer?.economicCode).toBe(CURRENT_CUSTOMER.economicCode);
  });

  it("hides the DRAFT placeholder number (officialNumber null)", () => {
    const model = buildInvoicePreviewModel(baseInput({ invoice: draftRow() }));
    expect(model.officialNumber).toBeNull();
  });

  it("never consults the snapshot of another row for drafts", () => {
    const model = buildInvoicePreviewModel(baseInput({ invoice: draftRow() }));
    expect(model.seller?.businessName).not.toContain("snapshot");
    expect(model.customer?.name).not.toContain("snapshot");
  });

  it("falls back to the business name alone when no profile row exists yet", () => {
    const model = buildInvoicePreviewModel(
      baseInput({ invoice: draftRow(), currentProfile: null, images: EMPTY_IMAGES }),
    );

    expect(model.seller).not.toBeNull();
    expect(model.seller?.source).toBe("PROFILE");
    expect(model.seller?.businessName).toBe("فروشگاه البرز");
    expect(model.seller?.slogan).toBeNull();
    expect(model.seller?.address).toBeNull();
    expect(model.seller?.logo).toBeNull();
    expect(model.seller?.primaryColor).toBeNull();
  });

  it("omits the customer block when a draft references no customer", () => {
    const model = buildInvoicePreviewModel(
      baseInput({
        invoice: draftRow({ customerId: null }),
        currentCustomer: null,
      }),
    );
    expect(model.customer).toBeNull();
  });
});

describe("preview model — missing optional data / edge cases", () => {
  it("normalizes blank optional strings to null", () => {
    const withBlanks = invoiceRow({
      sellerSnapshot: {
        ...(invoiceRow().sellerSnapshot as NonNullable<InvoiceRecord["sellerSnapshot"]>),
        slogan: "   ",
        email: "",
        mobile: "  ",
        cardNumber: "",
      },
    });
    const model = buildInvoicePreviewModel(baseInput({ invoice: withBlanks }));

    expect(model.seller?.slogan).toBeNull();
    expect(model.seller?.email).toBeNull();
    expect(model.seller?.mobile).toBeNull();
    expect(model.seller?.cardNumber).toBeNull();
  });

  it("omits the customer block when a finalized invoice has no customer snapshot", () => {
    const model = buildInvoicePreviewModel(
      baseInput({ invoice: invoiceRow({ customerId: null, customerSnapshot: null }) }),
    );
    expect(model.customer).toBeNull();
  });

  it("keeps a finalized row without snapshots readable with a null seller block", () => {
    // Defensive data-anomaly case (finalization always writes snapshots, but
    // a broken row must never crash the preview).
    const model = buildInvoicePreviewModel(
      baseInput({ invoice: invoiceRow({ sellerSnapshot: null, customerSnapshot: null }), currentProfile: null }),
    );
    expect(model.seller).toBeNull();
    expect(model.customer).toBeNull();
    expect(model.officialNumber).toBe("INV-101");
  });

  it("defaults currency to IRR when no settings value is available", () => {
    const model = buildInvoicePreviewModel(baseInput({ currency: "" }));
    expect(model.currency).toBe("IRR");
  });

  it("passes a non-IRR currency through", () => {
    const model = buildInvoicePreviewModel(baseInput({ currency: "IRT" }));
    expect(model.currency).toBe("IRT");
  });

  it("maps image refs only when present", () => {
    const model = buildInvoicePreviewModel(
      baseInput({
        images: {
          logo: { fileId: "file-logo-snap", url: "https://cdn.example/logo.png" },
          sellerStamp: null,
          sellerSignature: null,
        },
      }),
    );
    expect(model.seller?.logo).toEqual({ fileId: "file-logo-snap", url: "https://cdn.example/logo.png" });
    expect(model.seller?.sellerStamp).toBeNull();
    expect(model.seller?.sellerSignature).toBeNull();
  });
});

describe("preview lifecycle / source-kind helpers", () => {
  it("classifies lifecycles from status + finalizedAt", () => {
    expect(previewLifecycle("DRAFT", null)).toBe("DRAFT");
    expect(previewLifecycle("ISSUED", new Date())).toBe("FINALIZED");
    expect(previewLifecycle("PAID", new Date())).toBe("FINALIZED");
    expect(previewLifecycle("CANCELLED", new Date())).toBe("CANCELLED");
  });

  it("chooses snapshot vs profile seller source", () => {
    expect(previewSellerSourceKind(draftRow())).toBe("PROFILE");
    expect(previewSellerSourceKind(invoiceRow())).toBe("SNAPSHOT");
    expect(previewSellerSourceKind(invoiceRow({ status: "CANCELLED" }))).toBe("SNAPSHOT");
  });
});
