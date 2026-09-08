import { describe, expect, it, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";
import type { InvoiceRecord } from "@/server/invoice/invoiceService";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { getInvoicePreviewData } from "@/server/invoice/previewService";

/**
 * Loader tests for `getInvoicePreviewData` — authorization boundaries and
 * data-source rules at the service level (Prisma + auth mocked).
 *
 * The invoice-loading/isolation contract itself (`getInvoice`) is already
 * unit-tested in `invoiceService.test.ts`; here `getInvoice` is mocked and
 * these tests pin what the PREVIEW loader adds: the same ownership guard, a
 * never-read of current profile/customer for finalized rows, image resolution
 * scoped to the owning business, and currency from InvoiceSettings.
 */

const prismaMock = vi.hoisted(() => ({
  businessProfile: { findUnique: vi.fn() },
  customer: { findUnique: vi.fn() },
  invoiceSettings: { findUnique: vi.fn() },
  file: { findMany: vi.fn() },
}));

const getInvoiceMock = vi.hoisted(() => vi.fn());
const requireBusinessOwnershipMock = vi.hoisted(() => vi.fn());
const requireSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/server/invoice/invoiceService", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getInvoice: getInvoiceMock };
});
vi.mock("@/server/auth/requireBusinessOwnership", () => ({
  requireBusinessOwnership: requireBusinessOwnershipMock,
}));
vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  class ForbiddenError extends Error {
    constructor(message = "Forbidden") {
      super(message);
      this.name = "ForbiddenError";
    }
  }
  class NotFoundError extends Error {
    constructor(message = "Not found") {
      super(message);
      this.name = "NotFoundError";
    }
  }
  return {
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    requireSession: requireSessionMock,
  };
});

const MONEY = (value: string) => new Decimal(value);

function businessRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "biz-1",
    accountId: "acc-1",
    name: "فروشگاه البرز",
    isActive: true,
    isLocked: false,
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

const SNAPSHOT_SELLER = {
  id: "snap-seller-1",
  invoiceId: "inv-1",
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
  logoFileId: "file-logo-snap",
  sellerStampFileId: null,
  sellerSignatureFileId: "file-sign-snap",
  primaryColor: "#0055ff",
  footerBackgroundColor: "#111827",
  footerText: "پانوشت snapshot",
};

const SNAPSHOT_CUSTOMER = {
  id: "snap-customer-1",
  invoiceId: "inv-1",
  name: "مشتری snapshot",
  mobile: "09120000002",
  phone: "02120000002",
  email: "snap-cust@example.ir",
  address: "آدرس مشتری snapshot",
  nationalId: "10101010101",
  economicCode: "4111222333",
};

function finalizedRecord(overrides: Partial<Record<string, unknown>> = {}): InvoiceRecord {
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
    currency: "IRR",
    notes: null,
    createdAt: new Date("2026-03-05T00:00:00.000Z"),
    updatedAt: new Date("2026-03-05T00:00:00.000Z"),
    finalizedAt: new Date("2026-03-05T12:00:00.000Z"),
    cancelledAt: null,
    items: [
      {
        id: "item-1",
        invoiceId: "inv-1",
        productId: null,
        title: "خدمت",
        description: null,
        itemDate: null,
        unitPrice: MONEY("100000"),
        quantity: MONEY("1"),
        unit: null,
        discountPercent: MONEY("0"),
        discountAmount: MONEY("0"),
        subtotal: MONEY("100000"),
        total: MONEY("100000"),
        sortOrder: 0,
      },
    ],
    sellerSnapshot: SNAPSHOT_SELLER,
    customerSnapshot: SNAPSHOT_CUSTOMER,
    ...overrides,
  };
}

function draftRecord(overrides: Partial<Record<string, unknown>> = {}): InvoiceRecord {
  return finalizedRecord({
    id: "inv-draft",
    customerId: "cust-1",
    invoiceNumber: "DRAFT-xyz",
    status: "DRAFT",
    paidAmount: MONEY("0"),
    remainingAmount: MONEY("196200"),
    currency: null,
    finalizedAt: null,
    sellerSnapshot: null,
    customerSnapshot: null,
    ...overrides,
  });
}

const PROFILE_ROW = {
  id: "profile-1",
  businessId: "biz-1",
  businessName: "فروشگاه البرز (profile)",
  slogan: "شعار profile",
  ownerName: "مالک profile",
  address: "آدرس profile",
  email: "profile@example.ir",
  mobile: "09129999999",
  landline: "02129999999",
  cardNumber: "6037992222222222",
  accountNumber: "2222222222",
  iban: "IR222222222222222222222222",
  logoFileId: "file-logo-profile",
  sellerStampFileId: null,
  sellerSignatureFileId: null,
  primaryColor: "#123456",
  footerBackgroundColor: "#fde68a",
  footerText: "پانوشت profile",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const CUSTOMER_ROW = {
  id: "cust-1",
  businessId: "biz-1",
  name: "مشتری live",
  mobile: "09121111111",
  phone: "02121111111",
  email: "live@customer.ir",
  address: "آدرس live",
  nationalId: "2222222222",
  economicCode: "5555666777",
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  archivedAt: null,
};

describe("getInvoicePreviewData — authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessOwnershipMock.mockResolvedValue(businessRow());
    requireSessionMock.mockResolvedValue({ userId: "user-1", accountId: "acc-1" });
    prismaMock.invoiceSettings.findUnique.mockResolvedValue({ id: "set-1", currency: "IRR" });
    prismaMock.file.findMany.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers", async () => {
    requireBusinessOwnershipMock.mockRejectedValue(new (UnauthorizedError)());

    await expect(getInvoicePreviewData("biz-1", "inv-1")).rejects.toThrow("Unauthorized");
  });

  it("rejects a business that belongs to another account", async () => {
    requireBusinessOwnershipMock.mockRejectedValue(new (ForbiddenError)("Business does not belong to this account"));

    await expect(getInvoicePreviewData("biz-foreign", "inv-1")).rejects.toThrow("Business does not belong");
  });

  it("rejects a missing business (NotFound)", async () => {
    requireBusinessOwnershipMock.mockRejectedValue(new (NotFoundError)("Business not found"));

    await expect(getInvoicePreviewData("biz-missing", "inv-1")).rejects.toThrow("Business not found");
  });

  it("rejects an invoice that belongs to a DIFFERENT business of the same account", async () => {
    requireBusinessOwnershipMock.mockResolvedValue(businessRow());
    getInvoiceMock.mockRejectedValue(new (ForbiddenError)("Invoice does not belong to this business"));

    await expect(getInvoicePreviewData("biz-1", "inv-other-business")).rejects.toThrow("Invoice does not belong to this business");
    expect(getInvoiceMock).toHaveBeenCalledWith("biz-1", "inv-other-business");
  });

  it("propagates not-found for a missing invoice", async () => {
    getInvoiceMock.mockRejectedValue(new (NotFoundError)("Invoice not found"));

    await expect(getInvoicePreviewData("biz-1", "inv-missing")).rejects.toThrow("Invoice not found");
  });

  it("rejects an empty invoice id without querying", async () => {
    await expect(getInvoicePreviewData("biz-1", "   ")).rejects.toThrow("Invoice not found");
    expect(getInvoiceMock).not.toHaveBeenCalled();
  });

  it("keeps finalized invoices of an archived business readable (history)", async () => {
    requireBusinessOwnershipMock.mockResolvedValue(
      businessRow({ archivedAt: new Date("2026-02-01T00:00:00.000Z") }),
    );
    getInvoiceMock.mockResolvedValue(finalizedRecord());

    const model = await getInvoicePreviewData("biz-1", "inv-1");

    expect(model.lifecycle).toBe("FINALIZED");
    expect(model.seller?.businessName).toBe("فروشگاه البرز (snapshot)");
  });
});

describe("getInvoicePreviewData — finalized rows read snapshots only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessOwnershipMock.mockResolvedValue(businessRow());
    getInvoiceMock.mockResolvedValue(finalizedRecord());
    prismaMock.invoiceSettings.findUnique.mockResolvedValue({ id: "set-1", currency: "IRR" });
  });

  it("never reads the current BusinessProfile or live Customer for finalized rows", async () => {
    // If the loader touched the profile/customer tables the test would fail:
    // no mock resolution is registered for them.
    prismaMock.file.findMany.mockResolvedValue([]);
    const model = await getInvoicePreviewData("biz-1", "inv-1");

    expect(prismaMock.businessProfile.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled();
    expect(model.seller?.source).toBe("SNAPSHOT");
    expect(model.seller?.businessName).toBe("فروشگاه البرز (snapshot)");
    expect(model.customer?.name).toBe("مشتری snapshot");
    expect(model.officialNumber).toBe("INV-101");
  });

  it("resolves snapshot image file ids through the File ledger (scoped + live)", async () => {
    const previousBase = process.env.STORAGE_PUBLIC_BASE_URL;
    process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.test";
    try {
      prismaMock.file.findMany.mockImplementation(async ({ where }) => {
        // assert the loader scopes file reads to the owning business and
        // excludes soft-deleted rows
        expect(where.businessId).toBe("biz-1");
        expect(where.deletedAt).toBeNull();
        return [
          { id: "file-logo-snap", storageKey: "business/biz-1/logo/x.png" },
          { id: "file-sign-snap", storageKey: "business/biz-1/sign/y.png" },
        ];
      });

      const model = await getInvoicePreviewData("biz-1", "inv-1");

      expect(model.seller?.logo?.url).toBe("https://cdn.example.test/business/biz-1/logo/x.png");
      expect(model.seller?.sellerSignature?.url).toBe("https://cdn.example.test/business/biz-1/sign/y.png");
      expect(model.seller?.sellerStamp).toBeNull();
      expect(prismaMock.file.findMany).toHaveBeenCalledTimes(1);
    } finally {
      if (previousBase === undefined) {
        delete process.env.STORAGE_PUBLIC_BASE_URL;
      } else {
        process.env.STORAGE_PUBLIC_BASE_URL = previousBase;
      }
    }
  });

  it("uses the stored Invoice.currency snapshot and never consults later InvoiceSettings", async () => {
    prismaMock.invoiceSettings.findUnique.mockResolvedValue({ id: "set-1", currency: "IRT" });
    prismaMock.file.findMany.mockResolvedValue([]);

    const model = await getInvoicePreviewData("biz-1", "inv-1");
    expect(model.currency).toBe("IRR");
    expect(prismaMock.invoiceSettings.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to InvoiceSettings for a legacy finalized row with a null currency snapshot", async () => {
    getInvoiceMock.mockResolvedValue(finalizedRecord({ currency: null }));
    prismaMock.invoiceSettings.findUnique.mockResolvedValue({ id: "set-1", currency: "IRT" });
    prismaMock.file.findMany.mockResolvedValue([]);

    const model = await getInvoicePreviewData("biz-1", "inv-1");
    expect(model.currency).toBe("IRT");
  });

  it("defaults a legacy finalized row to IRR when no InvoiceSettings row exists", async () => {
    getInvoiceMock.mockResolvedValue(finalizedRecord({ currency: null }));
    prismaMock.invoiceSettings.findUnique.mockResolvedValue(null);
    prismaMock.file.findMany.mockResolvedValue([]);

    const model = await getInvoicePreviewData("biz-1", "inv-1");
    expect(model.currency).toBe("IRR");
  });
});

describe("getInvoicePreviewData — drafts read current profile / customer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessOwnershipMock.mockResolvedValue(businessRow());
    getInvoiceMock.mockResolvedValue(draftRecord());
    prismaMock.businessProfile.findUnique.mockResolvedValue(PROFILE_ROW);
    prismaMock.customer.findUnique.mockResolvedValue(CUSTOMER_ROW);
    prismaMock.invoiceSettings.findUnique.mockResolvedValue({ id: "set-1", currency: "IRR" });
    prismaMock.file.findMany.mockResolvedValue([]);
  });

  it("assembles a draft preview from the CURRENT profile + live customer", async () => {
    const model = await getInvoicePreviewData("biz-1", "inv-draft");

    expect(model.isDraft).toBe(true);
    expect(model.officialNumber).toBeNull();
    expect(model.seller?.source).toBe("PROFILE");
    expect(model.seller?.businessName).toBe("فروشگاه البرز (profile)");
    expect(model.customer?.name).toBe("مشتری live");
    expect(prismaMock.businessProfile.findUnique).toHaveBeenCalledWith({
      where: { businessId: "biz-1" },
    });
    expect(prismaMock.customer.findUnique).toHaveBeenCalledWith({ where: { id: "cust-1" } });
  });

  it("resolves draft image file ids from the current profile", async () => {
    prismaMock.file.findMany.mockResolvedValue([
      { id: "file-logo-profile", storageKey: "business/biz-1/logo/profile.png" },
    ]);

    const model = await getInvoicePreviewData("biz-1", "inv-draft");

    expect(prismaMock.file.findMany).toHaveBeenCalledTimes(1);
    expect(model.seller?.logo).not.toBeNull();
    expect(model.seller?.sellerStamp).toBeNull();
  });

  it("does not query a customer when the draft references none", async () => {
    getInvoiceMock.mockResolvedValue(draftRecord({ customerId: null }));

    const model = await getInvoicePreviewData("biz-1", "inv-draft");

    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled();
    expect(model.customer).toBeNull();
  });

  it("uses the current InvoiceSettings currency for drafts", async () => {
    prismaMock.invoiceSettings.findUnique.mockResolvedValue({ id: "set-1", currency: "IRT" });

    const model = await getInvoicePreviewData("biz-1", "inv-draft");
    expect(model.currency).toBe("IRT");
  });

  it("falls back to the business name when no profile row exists", async () => {
    prismaMock.businessProfile.findUnique.mockResolvedValue(null);

    const model = await getInvoicePreviewData("biz-1", "inv-draft");

    expect(model.seller?.source).toBe("PROFILE");
    expect(model.seller?.businessName).toBe("فروشگاه البرز");
    expect(model.seller?.address).toBeNull();
    expect(prismaMock.file.findMany).not.toHaveBeenCalled();
  });
});
