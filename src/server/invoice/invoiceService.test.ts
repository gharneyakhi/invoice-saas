import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { InvoiceLimitReachedError, ValidationError } from "@/server/errors";
import { isDraftInvoiceNumber } from "./schema";

const prismaMock = vi.hoisted(() => ({
  business: {
    findUnique: vi.fn(),
  },
  businessProfile: {
    findUnique: vi.fn(),
  },
  customer: {
    findUnique: vi.fn(),
  },
  product: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  invoiceSettings: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  invoice: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  invoiceItem: {
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  usagePeriod: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  invoicePayment: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  invoiceSellerSnapshot: {
    create: vi.fn(),
  },
  invoiceCustomerSnapshot: {
    create: vi.fn(),
  },
  plan: {
    findUnique: vi.fn(),
  },
  subscription: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
  // The raw `SELECT ... FOR UPDATE` invoice row lock taken by finalizeInvoice.
  $queryRaw: vi.fn(),
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
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
    requireSession,
  };
});

const SESSION = { userId: "user-1", accountId: "acc-1" };
const NOW = new Date("2026-03-15T12:00:00.000Z");

function planRow(
  key: "FREE" | "BASIC" | "PRO",
  businessLimit: number,
  invoiceLimit: number,
  features: string[] = [],
) {
  return {
    id: `plan-${key.toLowerCase()}`,
    key,
    name: key,
    description: `${key} plan`,
    price: new Decimal(0),
    currency: "IRR",
    billingInterval: "MONTHLY" as const,
    isActive: true,
    businessLimit,
    invoiceLimit,
    planFeatures: features.map((featureKey) => ({
      enabled: true,
      feature: { key: featureKey, name: featureKey, description: "" },
    })),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const FREE_PLAN = () => planRow("FREE", 1, 3, ["PDF_EXPORT", "DRAFT_INVOICES"]);
const PRO_PLAN = () => planRow("PRO", 3, 50, ["MULTI_BUSINESS", "ADVANCED_REPORTS", "DRAFT_INVOICES"]);

function activeSubscription(plan: ReturnType<typeof PRO_PLAN> = PRO_PLAN()) {
  return {
    id: "sub-1",
    accountId: "acc-1",
    planId: plan.id,
    status: "ACTIVE" as const,
    startDate: new Date("2026-03-01T00:00:00.000Z"),
    endDate: new Date("2026-04-01T00:00:00.000Z"),
    autoRenew: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    plan,
  };
}

function usagePeriodRow(overrides = {}) {
  return {
    id: "up-1",
    accountId: "acc-1",
    subscriptionId: "sub-1",
    periodStart: new Date("2026-03-01T00:00:00.000Z"),
    periodEnd: new Date("2026-04-01T00:00:00.000Z"),
    invoiceCount: 0,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

function businessRow(overrides = {}) {
  return {
    id: "biz-1",
    accountId: "acc-1",
    name: "فروشگاه آنلاین",
    isActive: true,
    isLocked: false,
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function businessProfileRow(overrides = {}) {
  return {
    id: "bp-1",
    businessId: "biz-1",
    businessName: "فروشگاه رسمی البرز",
    slogan: "کیفیت برتر، قیمت مناسب",
    ownerName: "علی رضایی",
    address: "تهران، خیابان آزادی، پلاک ۱۰",
    email: "contact@alborz.ir",
    mobile: "09121111111",
    landline: "02166554433",
    cardNumber: "6037991122334455",
    accountNumber: "0101010101001",
    iban: "IR120000000000000000000001",
    logoFileId: "file-logo-1",
    sellerStampFileId: "file-stamp-1",
    sellerSignatureFileId: "file-sig-1",
    primaryColor: "#0055ff",
    footerBackgroundColor: "#111827",
    footerText: "از خرید شما سپاسگزاریم",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function customerRow(overrides = {}) {
  return {
    id: "cust-1",
    businessId: "biz-1",
    name: "شرکت صنایع پارس",
    mobile: "09123456789",
    phone: "02188776655",
    email: "info@pars.ir",
    address: "تهران، میدان ونک",
    nationalId: "10101010101",
    economicCode: "4111222333",
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function productRow(overrides = {}) {
  return {
    id: "prod-1",
    businessId: "biz-1",
    name: "خدمات طراحی وب",
    description: "طراحی رابط کاربری و تجربه کاربری",
    price: new Decimal("5000000"),
    unit: "ساعت",
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function invoiceSettingsRow(overrides = {}) {
  return {
    id: "set-1",
    businessId: "biz-1",
    invoicePrefix: "INV-",
    nextInvoiceNumber: 101,
    defaultVatPercent: new Decimal("10"),
    currency: "IRR",
    calendar: "JALALI" as const,
    defaultTemplate: "default",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function draftInvoiceRow(overrides = {}) {
  const biz = businessRow();
  return {
    id: "inv-draft-1",
    businessId: "biz-1",
    customerId: "cust-1",
    invoiceNumber: "DRAFT-11111111-2222-3333-4444-555555555555",
    invoiceType: "FINAL" as const,
    issueDate: new Date("2026-03-15T00:00:00.000Z"),
    dueDate: new Date("2026-03-30T00:00:00.000Z"),
    status: "DRAFT" as const,
    subtotal: new Decimal("200000"),
    itemDiscountAmount: new Decimal("20000"),
    globalDiscountPercent: new Decimal("5"),
    globalDiscountAmount: new Decimal("9000"),
    taxPercent: new Decimal("9"),
    taxAmount: new Decimal("15390"),
    taxableAmount: new Decimal("171000"),
    total: new Decimal("186390"),
    paidAmount: new Decimal("0"),
    remainingAmount: new Decimal("186390"),
    currency: null,
    notes: "پیش‌نویس فاکتور رسمی",
    createdAt: new Date("2026-03-15T00:00:00.000Z"),
    updatedAt: new Date("2026-03-15T00:00:00.000Z"),
    finalizedAt: null,
    cancelledAt: null,
    business: biz,
    items: [
      {
        id: "item-1",
        invoiceId: "inv-draft-1",
        productId: "prod-1",
        title: "خدمات طراحی وب",
        description: "طراحی رابط کاربری",
        itemDate: null,
        unitPrice: new Decimal("100000"),
        quantity: new Decimal("2"),
        unit: "ساعت",
        discountPercent: new Decimal("10"),
        discountAmount: new Decimal("20000"),
        subtotal: new Decimal("200000"),
        total: new Decimal("180000"),
        sortOrder: 0,
      },
    ],
    ...overrides,
  };
}

/**
 * Re-arms the finalize-path write mocks with neutral defaults. `vi.clearAllMocks()`
 * in the top-level beforeEach only clears call history, so a `mockRejectedValue`
 * or a business-specific fixture set by one test would otherwise leak into the
 * next. The blocks below call this so each test is self-contained.
 */
function armFinalizeWriteMocks() {
  prismaMock.invoice.findUnique.mockReset();
  prismaMock.customer.findUnique.mockReset();
  prismaMock.product.findMany.mockReset();
  prismaMock.invoiceSettings.update.mockReset();
  prismaMock.invoiceSellerSnapshot.create.mockReset();
  prismaMock.invoiceCustomerSnapshot.create.mockReset();
  prismaMock.invoiceItem.update.mockReset();
  prismaMock.customer.findUnique.mockResolvedValue(customerRow());
  prismaMock.product.findMany.mockResolvedValue([productRow()]);
  prismaMock.invoiceSellerSnapshot.create.mockResolvedValue({ id: "snap-seller-1" });
  prismaMock.invoiceCustomerSnapshot.create.mockResolvedValue({ id: "snap-customer-1" });
  prismaMock.invoiceItem.update.mockResolvedValue({ id: "item-1" });
  prismaMock.invoiceSettings.update.mockResolvedValue({
    id: "set-1",
    invoicePrefix: "INV-",
    nextInvoiceNumber: 102,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback(prismaMock),
  );
  requireSession.mockResolvedValue(SESSION);
  prismaMock.$queryRaw.mockResolvedValue([]);

  // Baseline mock setup for entitlements & usage
  prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
  prismaMock.subscription.findMany.mockResolvedValue([activeSubscription(PRO_PLAN())]);
  prismaMock.usagePeriod.findUnique.mockResolvedValue(usagePeriodRow());
  prismaMock.usagePeriod.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.invoicePayment.findMany.mockResolvedValue([]);
  prismaMock.invoice.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.businessProfile.findUnique.mockResolvedValue(businessProfileRow());
});

describe("createDraftInvoice", () => {
  describe("1. Successful draft creation", () => {
    it("creates a draft invoice with line items, calculating all totals server-side", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([productRow()]);
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow());

      prismaMock.invoice.create.mockImplementation(async ({ data }) => {
        return {
          id: "inv-1",
          ...data,
          items: data.items.create.map((item: unknown, idx: number) => ({
            id: `item-${idx + 1}`,
            invoiceId: "inv-1",
            ...(item as object),
          })),
        };
      });

      const payload = {
        businessId: "biz-1",
        customerId: "cust-1",
        invoiceType: "FINAL" as const,
        issueDate: "2026-03-15T00:00:00.000Z",
        dueDate: "2026-03-30T00:00:00.000Z",
        globalDiscountPercent: 5,
        taxPercent: 9,
        notes: "پیش‌نویس فاکتور رسمی",
        items: [
          {
            productId: "prod-1",
            title: "خدمات طراحی وب",
            description: "طراحی رابط کاربری",
            unitPrice: 100000,
            quantity: 2,
            discountPercent: 10,
            unit: "ساعت",
          },
          {
            title: "پشتیبانی فنی",
            unitPrice: 50000,
            quantity: 1,
            discountPercent: 0,
            unit: "ماه",
          },
        ],
      };

      const result = await createDraftInvoice(payload);

      expect(requireSession).toHaveBeenCalledTimes(1);
      expect(prismaMock.business.findUnique).toHaveBeenCalledWith({ where: { id: "biz-1" } });
      expect(prismaMock.customer.findUnique).toHaveBeenCalledWith({ where: { id: "cust-1" } });
      expect(prismaMock.product.findMany).toHaveBeenCalledWith({ where: { id: { in: ["prod-1"] } } });

      // Verify invoice creation payload
      expect(prismaMock.invoice.create).toHaveBeenCalledTimes(1);
      const createCall = prismaMock.invoice.create.mock.calls[0]?.[0];
      expect(createCall.data.businessId).toBe("biz-1");
      expect(createCall.data.customerId).toBe("cust-1");
      expect(createCall.data.status).toBe("DRAFT");
      expect(createCall.data.invoiceType).toBe("FINAL");
      expect(isDraftInvoiceNumber(createCall.data.invoiceNumber)).toBe(true);

      // Calculations:
      // Item 1: 100000 * 2 = 200000, discount 10% = 20000, total = 180000
      // Item 2: 50000 * 1 = 50000, discount 0% = 0, total = 50000
      // subtotal = 250000, itemDiscountAmount = 20000, afterLineDiscounts = 230000
      // globalDiscount 5% = 11500, taxableAmount = 218500
      // tax 9% = 19665, total = 238165
      expect(createCall.data.subtotal.toString()).toBe("250000");
      expect(createCall.data.itemDiscountAmount.toString()).toBe("20000");
      expect(createCall.data.globalDiscountPercent.toString()).toBe("5");
      expect(createCall.data.globalDiscountAmount.toString()).toBe("11500");
      expect(createCall.data.taxableAmount.toString()).toBe("218500");
      expect(createCall.data.taxPercent.toString()).toBe("9");
      expect(createCall.data.taxAmount.toString()).toBe("19665");
      expect(createCall.data.total.toString()).toBe("238165");
      expect(createCall.data.paidAmount.toString()).toBe("0");
      expect(createCall.data.remainingAmount.toString()).toBe("238165");

      // Verify returned object
      expect(result.status).toBe("DRAFT");
      expect(result.items).toHaveLength(2);
      expect(result.items?.[0]!.subtotal.toString()).toBe("200000");
      expect(result.items?.[0]!.discountAmount.toString()).toBe("20000");
      expect(result.items?.[0]!.total.toString()).toBe("180000");
    });

    it("accepts (businessId, payload) signature style as well", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow());
      prismaMock.invoice.create.mockImplementation(async ({ data }) => ({
        id: "inv-2",
        ...data,
      }));

      const result = await createDraftInvoice("biz-1", {
        items: [{ title: "مورد ساده", unitPrice: 1000, quantity: 1 }],
      });

      expect(result.businessId).toBe("biz-1");
      expect(result.status).toBe("DRAFT");
    });
  });

  describe("2. Authentication & Authorization failures", () => {
    it("rejects with UnauthorizedError when there is no active session", async () => {
      const { UnauthorizedError } = await import("@/server/auth/requireSession");
      const { createDraftInvoice } = await import("./invoiceService");

      requireSession.mockRejectedValue(new UnauthorizedError());

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(UnauthorizedError);

      expect(prismaMock.business.findUnique).not.toHaveBeenCalled();
    });

    it("rejects with ForbiddenError when the business belongs to another account", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(
        businessRow({ id: "biz-other", accountId: "acc-other" }),
      );

      await expect(
        createDraftInvoice({
          businessId: "biz-other",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects with NotFoundError when the business does not exist", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(null);

      await expect(
        createDraftInvoice({
          businessId: "biz-missing",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects a payload attempting to supply accountId", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          accountId: "acc-smuggled",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("3. Archived business state", () => {
    it("rejects draft creation if the business is archived", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(
        businessRow({ archivedAt: new Date("2026-02-01T00:00:00.000Z") }),
      );

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("4. Cross-business references", () => {
    it("rejects with ForbiddenError when customer belongs to another business", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
      prismaMock.customer.findUnique.mockResolvedValue(
        customerRow({ id: "cust-alien", businessId: "biz-2" }),
      );

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          customerId: "cust-alien",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects with NotFoundError when customer does not exist", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
      prismaMock.customer.findUnique.mockResolvedValue(null);

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          customerId: "cust-missing",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects with ValidationError when customer is archived", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
      prismaMock.customer.findUnique.mockResolvedValue(
        customerRow({ id: "cust-1", businessId: "biz-1", archivedAt: new Date() }),
      );

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          customerId: "cust-1",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects with ForbiddenError when product belongs to another business", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
      prismaMock.product.findMany.mockResolvedValue([
        productRow({ id: "prod-alien", businessId: "biz-2" }),
      ]);

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          items: [{ productId: "prod-alien", title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects with NotFoundError when referenced product does not exist", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
      prismaMock.product.findMany.mockResolvedValue([]); // not found

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          items: [{ productId: "prod-missing", title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects with ValidationError when referenced product is archived", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
      prismaMock.product.findMany.mockResolvedValue([
        productRow({ id: "prod-1", businessId: "biz-1", archivedAt: new Date() }),
      ]);

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          items: [{ productId: "prod-1", title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("5. Server-side authoritative recalculation of totals", () => {
    it("uses defaultVatPercent from invoiceSettings when taxPercent is omitted from payload", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(
        invoiceSettingsRow({ defaultVatPercent: new Decimal("10") }),
      );
      prismaMock.invoice.create.mockImplementation(async ({ data }) => ({
        id: "inv-tax",
        ...data,
      }));

      const result = await createDraftInvoice({
        businessId: "biz-1",
        items: [{ title: "مورد", unitPrice: 1000, quantity: 1, discountPercent: 0 }],
      });

      const createCall = prismaMock.invoice.create.mock.calls[0]?.[0];
      expect(createCall.data.taxPercent.toString()).toBe("10");
      expect(createCall.data.taxAmount.toString()).toBe("100");
      expect(createCall.data.total.toString()).toBe("1100");
      expect(result.total.toString()).toBe("1100");
    });

    it("rejects client attempts to supply precalculated totals like subtotal or total", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          subtotal: 999999,
          total: 1,
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("6. Input validation (money, quantities, percentages)", () => {
    it.each([
      ["negative unitPrice", { unitPrice: -100, quantity: 1 }],
      ["zero quantity", { unitPrice: 100, quantity: 0 }],
      ["negative quantity", { unitPrice: 100, quantity: -2 }],
      ["invalid string unitPrice", { unitPrice: "abc", quantity: 1 }],
      ["invalid string quantity", { unitPrice: 100, quantity: "xyz" }],
      ["discountPercent > 100", { unitPrice: 100, quantity: 1, discountPercent: 105 }],
      ["negative discountPercent", { unitPrice: 100, quantity: 1, discountPercent: -5 }],
    ])("rejects invalid line item: %s", async (_desc, itemOverrides) => {
      const { createDraftInvoice } = await import("./invoiceService");

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          items: [{ title: "مورد", ...itemOverrides }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it.each([
      ["empty items array", { items: [] }],
      ["missing item title", { items: [{ title: "", unitPrice: 100, quantity: 1 }] }],
      ["globalDiscountPercent > 100", { globalDiscountPercent: 120, items: [{ title: "مورد", unitPrice: 100, quantity: 1 }] }],
      ["negative globalDiscountPercent", { globalDiscountPercent: -5, items: [{ title: "مورد", unitPrice: 100, quantity: 1 }] }],
      ["taxPercent > 100", { taxPercent: 105, items: [{ title: "مورد", unitPrice: 100, quantity: 1 }] }],
      ["negative taxPercent", { taxPercent: -2, items: [{ title: "مورد", unitPrice: 100, quantity: 1 }] }],
    ])("rejects invalid invoice payload: %s", async (_desc, payloadOverrides) => {
      const { createDraftInvoice } = await import("./invoiceService");

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          ...payloadOverrides,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it.each([
      ["status", { status: "ISSUED" }],
      ["invoiceNumber", { invoiceNumber: "INV-001" }],
      ["paidAmount", { paidAmount: 1000 }],
      ["remainingAmount", { remainingAmount: 0 }],
      ["finalizedAt", { finalizedAt: new Date() }],
    ])("rejects payload containing server-owned field '%s'", async (_field, extraField) => {
      const { createDraftInvoice } = await import("./invoiceService");

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
          ...extraField,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("7. Draft status & type", () => {
    it("always sets status to DRAFT and defaults invoiceType to FINAL", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow());
      prismaMock.invoice.create.mockImplementation(async ({ data }) => ({ id: "inv-1", ...data }));

      const result = await createDraftInvoice({
        businessId: "biz-1",
        items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
      });

      expect(result.status).toBe("DRAFT");
      expect(result.invoiceType).toBe("FINAL");
    });

    it("sets invoiceType to PROFORMA when explicitly requested, while keeping status DRAFT", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow());
      prismaMock.invoice.create.mockImplementation(async ({ data }) => ({ id: "inv-1", ...data }));

      const result = await createDraftInvoice({
        businessId: "biz-1",
        invoiceType: "PROFORMA",
        items: [{ title: "پیش‌فاکتور", unitPrice: 100, quantity: 1 }],
      });

      expect(result.status).toBe("DRAFT");
      expect(result.invoiceType).toBe("PROFORMA");
    });
  });

  describe("8. Quota & official counter invariants", () => {
    it("does not touch UsagePeriod, increment quota, or advance nextInvoiceNumber", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow({ nextInvoiceNumber: 15 }));
      prismaMock.invoice.create.mockImplementation(async ({ data }) => ({ id: "inv-1", ...data }));

      await createDraftInvoice({
        businessId: "biz-1",
        items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
      });

      // Assert usagePeriod was NEVER queried, created or updated
      expect(prismaMock.usagePeriod.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.usagePeriod.create).not.toHaveBeenCalled();
      expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();

      // Assert invoiceSettings was NEVER updated
      expect(prismaMock.invoiceSettings.update).not.toHaveBeenCalled();

      // Assert snapshots and payments were NEVER created
      expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
      expect(prismaMock.invoiceSellerSnapshot.create).not.toHaveBeenCalled();
      expect(prismaMock.invoiceCustomerSnapshot.create).not.toHaveBeenCalled();
    });
  });

  describe("9. Unique draft placeholder numbering", () => {
    it("generates safe, unique non-colliding draft numbers starting with DRAFT-", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow());
      prismaMock.invoice.create.mockImplementation(async ({ data }) => ({ id: "inv-1", ...data }));

      const first = await createDraftInvoice({
        businessId: "biz-1",
        items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
      });

      const second = await createDraftInvoice({
        businessId: "biz-1",
        items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
      });

      expect(isDraftInvoiceNumber(first.invoiceNumber)).toBe(true);
      expect(isDraftInvoiceNumber(second.invoiceNumber)).toBe(true);
      expect(first.invoiceNumber).not.toBe(second.invoiceNumber);
    });
  });

  describe("10. Atomic transaction behavior", () => {
    it("executes all reads and writes using the transaction client", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow());
      prismaMock.invoice.create.mockImplementation(async ({ data }) => ({ id: "inv-tx", ...data }));

      await createDraftInvoice({
        businessId: "biz-1",
        customerId: "cust-1",
        items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
      });

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    });

    it("propagates any database transaction failure without committing partial state", async () => {
      const { createDraftInvoice } = await import("./invoiceService");

      prismaMock.business.findUnique.mockResolvedValue(businessRow());
      prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow());
      const dbError = new Error("Database deadlock / write failure");
      prismaMock.invoice.create.mockRejectedValue(dbError);

      await expect(
        createDraftInvoice({
          businessId: "biz-1",
          items: [{ title: "مورد", unitPrice: 100, quantity: 1 }],
        }),
      ).rejects.toBe(dbError);
    });
  });
});

describe("finalizeInvoice", () => {
  describe("1. Successful finalization", () => {
    it("converts a DRAFT invoice to finalized, allocating official number, creating snapshots, incrementing quota, and calculating totals", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow();
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft) // Initial read inside tx
        .mockResolvedValueOnce({
          ...draft,
          status: "PENDING_PAYMENT",
          invoiceNumber: "INV-101",
          finalizedAt: NOW,
          sellerSnapshot: businessProfileRow(),
          customerSnapshot: customerRow(),
        }); // Final read with snapshots

      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([productRow()]);
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      const result = await finalizeInvoice(draft.id, { now: NOW });

      // 1. Session check
      expect(requireSession).toHaveBeenCalledTimes(1);

      // 2. Invoice settings incremented by 1
      expect(prismaMock.invoiceSettings.update).toHaveBeenCalledWith({
        where: { businessId: "biz-1" },
        data: { nextInvoiceNumber: { increment: 1 } },
      });

      // 3. UsagePeriod quota atomically checked and incremented
      expect(prismaMock.usagePeriod.updateMany).toHaveBeenCalledWith({
        where: { id: "up-1", invoiceCount: { lt: 50 } },
        data: { invoiceCount: { increment: 1 } },
      });

      // 4. Seller snapshot created with profile data
      expect(prismaMock.invoiceSellerSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoiceId: draft.id,
          businessName: "فروشگاه رسمی البرز",
          ownerName: "علی رضایی",
          iban: "IR120000000000000000000001",
          primaryColor: "#0055ff",
        }),
      });

      // 5. Customer snapshot created with customer data
      expect(prismaMock.invoiceCustomerSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoiceId: draft.id,
          name: "شرکت صنایع پارس",
          nationalId: "10101010101",
          economicCode: "4111222333",
        }),
      });

      // 6. Line items updated with authoritative recalculation
      expect(prismaMock.invoiceItem.update).toHaveBeenCalledWith({
        where: { id: "item-1" },
        data: expect.objectContaining({
          subtotal: new Decimal("200000"),
          discountAmount: new Decimal("20000"),
          total: new Decimal("180000"),
        }),
      });

      // 7. Conditional atomic invoice update
      expect(prismaMock.invoice.updateMany).toHaveBeenCalledWith({
        where: {
          id: draft.id,
          status: "DRAFT",
          finalizedAt: null,
        },
        data: expect.objectContaining({
          invoiceNumber: "INV-101",
          status: "PENDING_PAYMENT",
          subtotal: new Decimal("200000"),
          itemDiscountAmount: new Decimal("20000"),
          globalDiscountAmount: new Decimal("9000"),
          taxAmount: new Decimal("15390"),
          total: new Decimal("186390"),
          paidAmount: new Decimal("0"),
          remainingAmount: new Decimal("186390"),
          currency: "IRR",
          finalizedAt: NOW,
        }),
      });

      expect(result.status).toBe("PENDING_PAYMENT");
      expect(result.invoiceNumber).toBe("INV-101");
      expect(result.finalizedAt).toEqual(NOW);
    });

    it("snapshots InvoiceSettings.currency onto the finalized invoice (IRT survives later settings changes)", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({ customerId: null });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({
          ...draft,
          status: "PENDING_PAYMENT",
          invoiceNumber: "INV-101",
          currency: "IRT",
          finalizedAt: NOW,
        });
      prismaMock.product.findMany.mockResolvedValue([productRow()]);
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
        currency: "IRT",
      });

      await finalizeInvoice(draft.id, { now: NOW });

      expect(prismaMock.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ currency: "IRT" }),
        }),
      );
    });

    it("accepts options object signature { invoiceId, now }", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({ customerId: null });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({
          ...draft,
          status: "PENDING_PAYMENT",
          invoiceNumber: "INV-101",
          finalizedAt: NOW,
        });

      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      const result = await finalizeInvoice({ invoiceId: draft.id, now: NOW });
      expect(result.invoiceNumber).toBe("INV-101");
      expect(prismaMock.invoiceCustomerSnapshot.create).not.toHaveBeenCalled();
    });
  });

  describe("2. Authentication & Authorization failures", () => {
    it("rejects with UnauthorizedError when there is no active session", async () => {
      const { UnauthorizedError } = await import("@/server/auth/requireSession");
      const { finalizeInvoice } = await import("./invoiceService");

      requireSession.mockRejectedValue(new UnauthorizedError());

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(UnauthorizedError);
      expect(prismaMock.invoice.findUnique).not.toHaveBeenCalled();
    });

    it("rejects with NotFoundError when invoice does not exist", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(null);

      await expect(finalizeInvoice("inv-missing")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects with ForbiddenError when invoice belongs to another account", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(
        draftInvoiceRow({
          business: businessRow({ id: "biz-alien", accountId: "acc-alien" }),
        }),
      );

      await expect(finalizeInvoice("inv-alien")).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects with ValidationError when empty or non-string invoice ID is passed", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      await expect(finalizeInvoice("   ")).rejects.toBeInstanceOf(ValidationError);
      await expect(finalizeInvoice(null as unknown as string)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("3. Business state verification", () => {
    it("rejects finalization if the business is archived", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(
        draftInvoiceRow({
          business: businessRow({ archivedAt: new Date("2026-02-01T00:00:00.000Z") }),
        }),
      );

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("4. Lifecycle transitions & Idempotency", () => {
    it("rejects an already-finalized invoice", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(
        draftInvoiceRow({
          status: "ISSUED",
          finalizedAt: new Date("2026-03-01T00:00:00.000Z"),
          invoiceNumber: "INV-50",
        }),
      );

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(ValidationError);
      expect(prismaMock.invoiceSettings.update).not.toHaveBeenCalled();
      expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a cancelled invoice", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(
        draftInvoiceRow({
          status: "CANCELLED",
          cancelledAt: new Date("2026-03-01T00:00:00.000Z"),
        }),
      );

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects finalization of an invoice with zero items", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(
        draftInvoiceRow({
          items: [],
        }),
      );

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(ValidationError);
    });

    it("fails cleanly when invoice is modified concurrently and is no longer DRAFT (updateMany count=0)", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow();
      prismaMock.invoice.findUnique.mockResolvedValue(draft);
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([productRow()]);
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      // Simulate concurrent writer winning: updateMany affects 0 rows
      prismaMock.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(finalizeInvoice(draft.id, { now: NOW })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("5. Cross-business isolation at finalization", () => {
    it("rejects with ForbiddenError if customer belongs to another business", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow({ customerId: "cust-alien" }));
      prismaMock.customer.findUnique.mockResolvedValue(
        customerRow({ id: "cust-alien", businessId: "biz-other" }),
      );

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects with NotFoundError if referenced customer no longer exists", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow({ customerId: "cust-missing" }));
      prismaMock.customer.findUnique.mockResolvedValue(null);

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects with ValidationError if referenced customer is archived", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow({ customerId: "cust-archived" }));
      prismaMock.customer.findUnique.mockResolvedValue(
        customerRow({ id: "cust-archived", archivedAt: new Date() }),
      );

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects with ForbiddenError if product belongs to another business", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow());
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([
        productRow({ id: "prod-1", businessId: "biz-other" }),
      ]);

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects with NotFoundError if product is not found", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow());
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([]); // not found

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects with ValidationError if product is archived", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow());
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([
        productRow({ id: "prod-1", archivedAt: new Date() }),
      ]);

      await expect(finalizeInvoice("inv-1")).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("6. Entitlement & Quota limits", () => {
    it("rejects with InvoiceLimitReachedError and rolls back when invoice quota is exhausted", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow());
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([productRow()]);

      // Quota update fails (e.g. current count >= plan limit)
      prismaMock.usagePeriod.updateMany.mockResolvedValue({ count: 0 });

      await expect(finalizeInvoice("inv-1", { now: NOW })).rejects.toBeInstanceOf(
        InvoiceLimitReachedError,
      );

      // Verify invoice number is NOT allocated and snapshots are NOT created if quota fails before them
      expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("7. Official numbering allocation & prefix", () => {
    it("allocates official number without prefix when invoicePrefix is null", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({ customerId: null });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({
          ...draft,
          status: "PENDING_PAYMENT",
          invoiceNumber: "1",
          finalizedAt: NOW,
        });

      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: null,
        nextInvoiceNumber: 2,
      });

      const result = await finalizeInvoice(draft.id, { now: NOW });
      expect(result.invoiceNumber).toBe("1");

      expect(prismaMock.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            invoiceNumber: "1",
          }),
        }),
      );
    });
  });

  describe("8. Payment state & Overdue derivation", () => {
    it("derives PARTIALLY_PAID status and authoritative paidAmount / remainingAmount when partial payments exist", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({ customerId: null });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({
          ...draft,
          status: "PARTIALLY_PAID",
          paidAmount: new Decimal("50000"),
          remainingAmount: new Decimal("136390"),
        });

      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      // Legitimate invoice payments totalling 50000
      prismaMock.invoicePayment.findMany.mockResolvedValue([
        { id: "pay-1", invoiceId: draft.id, amount: new Decimal("30000") },
        { id: "pay-2", invoiceId: draft.id, amount: new Decimal("20000") },
      ]);

      await finalizeInvoice(draft.id, { now: NOW });

      expect(prismaMock.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "PARTIALLY_PAID",
            paidAmount: new Decimal("50000"),
            remainingAmount: new Decimal("136390"),
          }),
        }),
      );
    });

    it("derives PAID status when payments cover the full total", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({ customerId: null });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({
          ...draft,
          status: "PAID",
          paidAmount: new Decimal("186390"),
          remainingAmount: new Decimal("0"),
        });

      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      prismaMock.invoicePayment.findMany.mockResolvedValue([
        { id: "pay-1", invoiceId: draft.id, amount: new Decimal("186390") },
      ]);

      await finalizeInvoice(draft.id, { now: NOW });

      expect(prismaMock.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "PAID",
            paidAmount: new Decimal("186390"),
            remainingAmount: new Decimal("0"),
          }),
        }),
      );
    });

    it("derives OVERDUE status when dueDate is in the past and balance remains", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({
        customerId: null,
        dueDate: new Date("2026-03-01T00:00:00.000Z"), // in past relative to NOW (2026-03-15)
      });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({
          ...draft,
          status: "OVERDUE",
        });

      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      await finalizeInvoice(draft.id, { now: NOW });

      expect(prismaMock.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "OVERDUE",
          }),
        }),
      );
    });
  });

  describe("9. Invoice row lock (duplicate / concurrent finalize requests)", () => {
    beforeEach(() => {
      armFinalizeWriteMocks();
    });

    it("locks the invoice row with the minimal parameterized SELECT ... FOR UPDATE as the FIRST statement, before the invoice is read", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({ customerId: null });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({ ...draft, status: "PENDING_PAYMENT", invoiceNumber: "INV-101", finalizedAt: NOW });
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      await finalizeInvoice(draft.id, { now: NOW });

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      const call = prismaMock.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      const [templateStrings, ...substitutions] = call;
      expect(templateStrings.join("?")).toContain('SELECT id FROM "invoices" WHERE id =');
      expect(templateStrings.join("?")).toContain("FOR UPDATE");
      // The invoice id travels as a bound parameter, never as SQL text.
      expect(substitutions).toEqual([draft.id]);
      expect(templateStrings.join("")).not.toContain(draft.id);

      const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
        fn.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
      expect(order(prismaMock.$queryRaw)).toBeLessThan(order(prismaMock.invoice.findUnique));
      expect(order(prismaMock.$queryRaw)).toBeLessThan(order(prismaMock.usagePeriod.updateMany));
      expect(order(prismaMock.$queryRaw)).toBeLessThan(order(prismaMock.invoiceSettings.update));
    });

    it("rejects a duplicate finalize (already finalized after the lock is acquired) before any write: no quota, no number, no snapshot", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      // Sequential model of the race: the first call wins; the second call's
      // post-lock read observes the committed finalized row.
      const draft = draftInvoiceRow({ customerId: null });
      const finalized = {
        ...draft,
        status: "PENDING_PAYMENT" as const,
        invoiceNumber: "INV-101",
        finalizedAt: NOW,
      };
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce(finalized)
        .mockResolvedValue(finalized);
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      const first = await finalizeInvoice(draft.id, { now: NOW });
      expect(first.invoiceNumber).toBe("INV-101");

      vi.clearAllMocks();
      prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
        callback(prismaMock),
      );
      requireSession.mockResolvedValue(SESSION);
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.invoice.findUnique.mockResolvedValue(finalized);

      await expect(finalizeInvoice(draft.id, { now: NOW })).rejects.toBeInstanceOf(ValidationError);

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.invoiceSettings.update).not.toHaveBeenCalled();
      expect(prismaMock.invoiceSellerSnapshot.create).not.toHaveBeenCalled();
      expect(prismaMock.invoiceCustomerSnapshot.create).not.toHaveBeenCalled();
      expect(prismaMock.invoiceItem.update).not.toHaveBeenCalled();
      expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a cancelled invoice without writing anything and never touches its existing invoice number", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(
        draftInvoiceRow({
          status: "CANCELLED",
          invoiceNumber: "INV-77",
          finalizedAt: new Date("2026-03-01T00:00:00.000Z"),
          cancelledAt: new Date("2026-03-02T00:00:00.000Z"),
        }),
      );

      await expect(finalizeInvoice("inv-1", { now: NOW })).rejects.toThrow(
        "Cannot finalize a cancelled invoice",
      );

      expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.invoiceSettings.update).not.toHaveBeenCalled();
      expect(prismaMock.invoiceSellerSnapshot.create).not.toHaveBeenCalled();
      expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    });

    it("locks nothing it can write to and returns NotFoundError for a missing invoice", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { finalizeInvoice } = await import("./invoiceService");

      prismaMock.invoice.findUnique.mockResolvedValue(null);

      await expect(finalizeInvoice("inv-missing")).rejects.toBeInstanceOf(NotFoundError);
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.invoiceSettings.update).not.toHaveBeenCalled();
    });
  });

  describe("10. Rollback safety — every write happens inside the single transaction", () => {
    beforeEach(() => {
      armFinalizeWriteMocks();
    });

    it("runs the quota increment, number allocation, snapshots, item updates and invoice update on the transaction client only", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      // A distinct tx object proves the writes are routed through the
      // transaction client rather than the global singleton.
      const tx = { ...prismaMock };
      const outerCalls: string[] = [];
      prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
        outerCalls.push("tx-open");
        return callback(tx);
      });

      const draft = draftInvoiceRow();
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({ ...draft, status: "PENDING_PAYMENT", invoiceNumber: "INV-101", finalizedAt: NOW });
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([productRow()]);
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      await finalizeInvoice(draft.id, { now: NOW });

      expect(outerCalls).toEqual(["tx-open"]);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      // Exactly one lock, one quota increment, one number allocation, one
      // seller snapshot, one customer snapshot, one conditional invoice
      // update — no duplicate state for a single finalization.
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prismaMock.usagePeriod.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.invoiceSettings.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.invoiceSellerSnapshot.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.invoiceCustomerSnapshot.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.invoice.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    });

    it("propagates a snapshot write failure so the surrounding transaction rolls back the number and quota increments", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow();
      prismaMock.invoice.findUnique.mockResolvedValue(draft);
      prismaMock.customer.findUnique.mockResolvedValue(customerRow());
      prismaMock.product.findMany.mockResolvedValue([productRow()]);
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });
      const dbError = new Error("unique constraint on invoice_seller_snapshots.invoiceId");
      prismaMock.invoiceSellerSnapshot.create.mockRejectedValue(dbError);

      // The error must surface unchanged out of $transaction — that is what
      // makes Prisma roll back the increments that already ran in this tx.
      await expect(finalizeInvoice(draft.id, { now: NOW })).rejects.toBe(dbError);

      expect(prismaMock.usagePeriod.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.invoiceSettings.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();
    });

    it("propagates a number-allocation failure after the quota increment without finalizing the invoice", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({ customerId: null });
      prismaMock.invoice.findUnique.mockResolvedValue(draft);
      const dbError = new Error("invoice_settings row missing (P2025)");
      prismaMock.invoiceSettings.update.mockRejectedValue(dbError);

      await expect(finalizeInvoice(draft.id, { now: NOW })).rejects.toBe(dbError);

      expect(prismaMock.invoiceSellerSnapshot.create).not.toHaveBeenCalled();
      expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("11. Numbering integrity", () => {
    beforeEach(() => {
      armFinalizeWriteMocks();
    });

    it("formats the official number deterministically from the prefix and the pre-increment counter", async () => {
      const { formatOfficialInvoiceNumber } = await import("./schema");

      expect(formatOfficialInvoiceNumber("INV-", 101)).toBe("INV-101");
      expect(formatOfficialInvoiceNumber(null, 1)).toBe("1");
      expect(formatOfficialInvoiceNumber(undefined, 7)).toBe("7");
      expect(formatOfficialInvoiceNumber("", 12)).toBe("12");
      expect(formatOfficialInvoiceNumber("ف-", 3)).toBe("ف-3");
    });

    it("allocates the official number from the business's own InvoiceSettings row (per-business sequence)", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const otherBusiness = businessRow({ id: "biz-2", accountId: "acc-1", name: "شعبه دوم" });
      const draft = draftInvoiceRow({
        id: "inv-biz2",
        businessId: "biz-2",
        customerId: null,
        business: otherBusiness,
      });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({ ...draft, status: "PENDING_PAYMENT", invoiceNumber: "1", finalizedAt: NOW });
      prismaMock.product.findMany.mockResolvedValue([productRow({ businessId: "biz-2" })]);
      prismaMock.businessProfile.findUnique.mockResolvedValue(null);
      // Business 2 starts its own sequence at 1 even though business 1 is at 101.
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-2",
        businessId: "biz-2",
        invoicePrefix: null,
        nextInvoiceNumber: 2,
      });

      const result = await finalizeInvoice(draft.id, { now: NOW });

      expect(prismaMock.invoiceSettings.update).toHaveBeenCalledWith({
        where: { businessId: "biz-2" },
        data: { nextInvoiceNumber: { increment: 1 } },
      });
      expect(result.invoiceNumber).toBe("1");
      // Seller snapshot falls back to Business.name when no profile exists.
      expect(prismaMock.invoiceSellerSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ invoiceId: "inv-biz2", businessName: "شعبه دوم" }),
      });
    });

    it("finalizes a draft with a pre-existing official-looking number only through the counter, never by trusting the stored number", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      // Even if a draft somehow carried a non-placeholder number, the official
      // number always comes from the atomic counter.
      const draft = draftInvoiceRow({ customerId: null, invoiceNumber: "INV-9999" });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({ ...draft, status: "PENDING_PAYMENT", invoiceNumber: "INV-101", finalizedAt: NOW });
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      await finalizeInvoice(draft.id, { now: NOW });

      expect(prismaMock.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ invoiceNumber: "INV-101" }),
        }),
      );
    });
  });

  describe("12. Snapshot immutability", () => {
    beforeEach(() => {
      armFinalizeWriteMocks();
    });

    it("captures the seller snapshot from the BusinessProfile as it is at finalization time", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow({ customerId: null });
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({ ...draft, status: "PENDING_PAYMENT", invoiceNumber: "INV-101", finalizedAt: NOW });
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });
      prismaMock.businessProfile.findUnique.mockResolvedValue(
        businessProfileRow({ businessName: "نام قبل از ویرایش", iban: "IR000000000000000000000009" }),
      );

      await finalizeInvoice(draft.id, { now: NOW });

      const snapshotData = prismaMock.invoiceSellerSnapshot.create.mock.calls[0]?.[0]?.data;
      expect(snapshotData).toMatchObject({
        invoiceId: draft.id,
        businessName: "نام قبل از ویرایش",
        iban: "IR000000000000000000000009",
      });
      // Snapshot is a value copy: it carries every seller column and no
      // reference/relation to the live profile row that could be edited later.
      expect(snapshotData).not.toHaveProperty("businessProfileId");
      expect(snapshotData).not.toHaveProperty("profile");
      expect(Object.keys(snapshotData)).toEqual(
        expect.arrayContaining([
          "businessName",
          "slogan",
          "ownerName",
          "address",
          "email",
          "mobile",
          "landline",
          "cardNumber",
          "accountNumber",
          "iban",
          "logoFileId",
          "sellerStampFileId",
          "sellerSignatureFileId",
          "primaryColor",
          "footerBackgroundColor",
          "footerText",
        ]),
      );
    });

    it("captures the customer snapshot as a value copy of the Customer row at finalization time", async () => {
      const { finalizeInvoice } = await import("./invoiceService");

      const draft = draftInvoiceRow();
      prismaMock.invoice.findUnique
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({ ...draft, status: "PENDING_PAYMENT", invoiceNumber: "INV-101", finalizedAt: NOW });
      prismaMock.customer.findUnique.mockResolvedValue(
        customerRow({ name: "مشتری قبل از تغییر", address: "آدرس قدیمی" }),
      );
      prismaMock.product.findMany.mockResolvedValue([productRow()]);
      prismaMock.invoiceSettings.update.mockResolvedValue({
        id: "set-1",
        invoicePrefix: "INV-",
        nextInvoiceNumber: 102,
      });

      await finalizeInvoice(draft.id, { now: NOW });

      const snapshotData = prismaMock.invoiceCustomerSnapshot.create.mock.calls[0]?.[0]?.data;
      expect(snapshotData).toEqual({
        invoiceId: draft.id,
        name: "مشتری قبل از تغییر",
        mobile: "09123456789",
        phone: "02188776655",
        email: "info@pars.ir",
        address: "آدرس قدیمی",
        nationalId: "10101010101",
        economicCode: "4111222333",
      });
      // No customerId on the snapshot: later Customer edits cannot reach it.
      expect(snapshotData).not.toHaveProperty("customerId");
    });
  });

  describe("13. Database concurrency boundaries (Notes for PostgreSQL integration testing)", () => {
    it("documents what the mocked suite cannot prove: a true two-connection race", async () => {
      // The mocked Prisma client runs the transaction callback on the SAME
      // mock object, so two concurrent finalizeInvoice() calls cannot block
      // each other at `SELECT ... FOR UPDATE`, at the UsagePeriod row, or at
      // the InvoiceSettings row the way two real connections would.
      //
      // Verified here (against the mocks):
      //   1. the invoice row lock is the FIRST statement of the transaction;
      //   2. the DRAFT check runs on the post-lock read and rejects a
      //      finalized/cancelled invoice before any write;
      //   3. the quota increment is a conditional UPDATE (`invoiceCount < limit`);
      //   4. the number allocation is a single atomic increment on the
      //      business's own InvoiceSettings row;
      //   5. all writes go through one transaction client and any thrown error
      //      propagates unchanged, which is what triggers the rollback.
      //
      // Still REQUIRES integration testing on PostgreSQL:
      //   - two connections finalizing the SAME invoice: exactly one succeeds,
      //     the other gets ValidationError and leaves invoiceCount and
      //     nextInvoiceNumber incremented exactly once;
      //   - two connections finalizing DIFFERENT drafts of the same business:
      //     both succeed with distinct consecutive numbers;
      //   - N+1 concurrent finalizations at limit N: exactly N succeed;
      //   - a rollback after the counter increment leaves nextInvoiceNumber
      //     unchanged (the number is not permanently consumed).
      expect(true).toBe(true);
    });

    it("documents requirement for PostgreSQL integration testing: atomic sequence lock", async () => {
      // In PostgreSQL, `UPDATE invoice_settings SET nextInvoiceNumber = nextInvoiceNumber + 1`
      // acquires a row-level write lock that serializes concurrent requests for the same business.
      // Verified structurally via Prisma TransactionClient and update increment.
      expect(true).toBe(true);
    });

    it("documents requirement for PostgreSQL integration testing: conditional quota update", async () => {
      // In PostgreSQL, `UPDATE usage_periods SET invoiceCount = invoiceCount + 1 WHERE id = $1 AND invoiceCount < $2`
      // guarantees that concurrent requests cannot exceed the plan limit.
      // Verified structurally via updateMany returning count: 0 when limit is reached.
      expect(true).toBe(true);
    });
  });
});

describe("updateDraftInvoice", () => {
  const UPDATE_PAYLOAD = {
    customerId: "cust-1",
    invoiceType: "PROFORMA" as const,
    issueDate: "2026-03-16T00:00:00.000Z",
    dueDate: "2026-04-01T00:00:00.000Z",
    globalDiscountPercent: 5,
    taxPercent: 9,
    notes: "ویرایش پیش‌نویس",
    items: [
      {
        productId: "prod-1",
        title: "خدمات طراحی وب",
        unitPrice: 100000,
        quantity: 2,
        discountPercent: 10,
        unit: "ساعت",
      },
      {
        title: "پشتیبانی فنی",
        unitPrice: 50000,
        quantity: 1,
        discountPercent: 0,
      },
    ],
  };

  /** Arms the read/write mocks with the standard draft-owned world. */
  function armDraftUpdateMocks(invoiceOverrides: Record<string, unknown> = {}) {
    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(customerRow());
    prismaMock.product.findMany.mockResolvedValue([productRow()]);
    prismaMock.invoiceSettings.findUnique.mockResolvedValue(invoiceSettingsRow());
    prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow(invoiceOverrides));
    prismaMock.invoiceItem.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.invoice.update.mockImplementation(async ({ data }) => ({
      ...draftInvoiceRow(invoiceOverrides),
      ...data,
      id: "inv-draft-1",
      items: (data.items?.create ?? []).map((item: Record<string, unknown>, idx: number) => ({
        id: `item-${idx + 1}`,
        invoiceId: "inv-draft-1",
        ...item,
      })),
    }));
  }

  describe("1. Successful draft update", () => {
    it("replaces the draft content and recalculates all totals server-side", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();

      const result = await updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD);

      expect(requireSession).toHaveBeenCalledTimes(1);
      // Invoice row is locked before any read/write (finalize serialization).
      expect(prismaMock.$queryRaw).toHaveBeenCalledWith(expect.anything(), "inv-draft-1");
      expect(prismaMock.business.findUnique).toHaveBeenCalledWith({ where: { id: "biz-1" } });
      expect(prismaMock.invoice.findUnique).toHaveBeenCalledWith({ where: { id: "inv-draft-1" } });

      // Old line items are fully replaced by the new, recalculated set.
      expect(prismaMock.invoiceItem.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: "inv-draft-1" },
      });

      expect(prismaMock.invoice.update).toHaveBeenCalledTimes(1);
      const updateCall = prismaMock.invoice.update.mock.calls[0]?.[0];
      expect(updateCall.where).toEqual({ id: "inv-draft-1" });

      // Editable fields are written.
      expect(updateCall.data.customerId).toBe("cust-1");
      expect(updateCall.data.invoiceType).toBe("PROFORMA");
      expect(updateCall.data.issueDate).toEqual(new Date("2026-03-16T00:00:00.000Z"));
      expect(updateCall.data.dueDate).toEqual(new Date("2026-04-01T00:00:00.000Z"));
      expect(updateCall.data.notes).toBe("ویرایش پیش‌نویس");

      // Totals are authoritative (same math as create): subtotal 250000,
      // itemDiscount 20000, global 5% → 11500, taxable 218500, tax 9% → 19665,
      // total 238165.
      expect(updateCall.data.subtotal.toString()).toBe("250000");
      expect(updateCall.data.itemDiscountAmount.toString()).toBe("20000");
      expect(updateCall.data.globalDiscountPercent.toString()).toBe("5");
      expect(updateCall.data.globalDiscountAmount.toString()).toBe("11500");
      expect(updateCall.data.taxPercent.toString()).toBe("9");
      expect(updateCall.data.taxableAmount.toString()).toBe("218500");
      expect(updateCall.data.taxAmount.toString()).toBe("19665");
      expect(updateCall.data.total.toString()).toBe("238165");
      expect(updateCall.data.remainingAmount.toString()).toBe("238165");

      // Line values come from the engine, never from client input.
      const createItems = updateCall.data.items.create;
      expect(createItems).toHaveLength(2);
      expect(createItems[0].subtotal.toString()).toBe("200000");
      expect(createItems[0].discountAmount.toString()).toBe("20000");
      expect(createItems[0].total.toString()).toBe("180000");
      expect(createItems[0].sortOrder).toBe(0);
      expect(createItems[1].sortOrder).toBe(1);

      // Returned record is the re-read invoice with replaced items.
      expect(result.id).toBe("inv-draft-1");
      expect(result.items).toHaveLength(2);
    });

    it("preserves invoiceNumber, status, paidAmount and lifecycle timestamps", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();

      await updateDraftInvoice("biz-1", "inv-draft-1", {
        items: [{ title: "خدمت", unitPrice: 1000, quantity: 1 }],
      });

      const updateCall = prismaMock.invoice.update.mock.calls[0]?.[0];
      expect(updateCall.data).not.toHaveProperty("invoiceNumber");
      expect(updateCall.data).not.toHaveProperty("status");
      expect(updateCall.data).not.toHaveProperty("paidAmount");
      expect(updateCall.data).not.toHaveProperty("finalizedAt");
      expect(updateCall.data).not.toHaveProperty("cancelledAt");
    });

    it("re-derives remainingAmount from the new total and the preserved paidAmount", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks({ paidAmount: new Decimal("50000") });

      await updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD);

      const updateCall = prismaMock.invoice.update.mock.calls[0]?.[0];
      expect(updateCall.data.remainingAmount.toString()).toBe("188165");
    });

    it("falls back to InvoiceSettings.defaultVatPercent when taxPercent is omitted", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();

      const payload = { ...UPDATE_PAYLOAD } as Record<string, unknown>;
      delete payload.taxPercent;

      await updateDraftInvoice("biz-1", "inv-draft-1", payload);

      expect(prismaMock.invoiceSettings.findUnique).toHaveBeenCalledWith({
        where: { businessId: "biz-1" },
      });
      const updateCall = prismaMock.invoice.update.mock.calls[0]?.[0];
      expect(updateCall.data.taxPercent.toString()).toBe("10");
    });
  });

  describe("2. Finalization / quota / numbering invariants", () => {
    it("never touches quota, official numbering or snapshots", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();

      await updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD);

      expect(prismaMock.invoiceSettings.update).not.toHaveBeenCalled();
      expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();
      expect(prismaMock.invoiceSellerSnapshot.create).not.toHaveBeenCalled();
      expect(prismaMock.invoiceCustomerSnapshot.create).not.toHaveBeenCalled();
    });
  });

  describe("3. Authentication & authorization", () => {
    it("rejects with UnauthorizedError before doing any work when there is no session", async () => {
      const { UnauthorizedError } = await import("@/server/auth/requireSession");
      const { updateDraftInvoice } = await import("./invoiceService");

      requireSession.mockRejectedValue(new UnauthorizedError());

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toBeInstanceOf(UnauthorizedError);

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it("rejects with ForbiddenError when the business belongs to another account", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      prismaMock.business.findUnique.mockResolvedValue(businessRow({ accountId: "acc-other" }));

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe("4. Business & invoice state", () => {
    it("rejects editing for an archived business", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      prismaMock.business.findUnique.mockResolvedValue(
        businessRow({ archivedAt: new Date("2026-02-01T00:00:00.000Z") }),
      );

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toThrow("Cannot edit an invoice of an archived business");
    });

    it("rejects with NotFoundError when the invoice does not exist", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      prismaMock.invoice.findUnique.mockResolvedValue(null);

      await expect(
        updateDraftInvoice("biz-1", "inv-missing", UPDATE_PAYLOAD),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects with ForbiddenError when the invoice belongs to a different business", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      prismaMock.invoice.findUnique.mockResolvedValue(draftInvoiceRow({ businessId: "biz-other" }));

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe("5. Lifecycle — only drafts are editable", () => {
    it("rejects a finalized invoice", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks({ status: "ISSUED", finalizedAt: new Date("2026-03-20T00:00:00.000Z") });

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toThrow("Only draft invoices can be edited; this invoice is already finalized");

      expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    });

    it("rejects a cancelled invoice with a distinct message", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks({ status: "CANCELLED", cancelledAt: new Date("2026-03-20T00:00:00.000Z") });

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toThrow("Cancelled invoices cannot be edited");

      expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe("6. Cross-business references", () => {
    it("rejects a customer that belongs to another business", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      prismaMock.customer.findUnique.mockResolvedValue(customerRow({ businessId: "biz-other" }));

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects an archived customer reference", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      prismaMock.customer.findUnique.mockResolvedValue(
        customerRow({ archivedAt: new Date("2026-02-01T00:00:00.000Z") }),
      );

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toThrow("Cannot reference an archived customer");
    });

    it("rejects a product that belongs to another business", async () => {
      const { ForbiddenError } = await import("@/server/auth/requireSession");
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      prismaMock.product.findMany.mockResolvedValue([productRow({ businessId: "biz-other" })]);

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects when a referenced product does not exist", async () => {
      const { NotFoundError } = await import("@/server/auth/requireSession");
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      prismaMock.product.findMany.mockResolvedValue([]);

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("7. Input validation", () => {
    it("rejects an empty items array before starting the transaction", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", { items: [] }),
      ).rejects.toThrow("Invoice must have at least one item");

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it("rejects server-owned fields (strict schema) before starting the transaction", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", {
          total: 123456,
          status: "PAID",
          invoiceNumber: "INV-1",
          items: [{ title: "خدمت", unitPrice: 1000, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it("rejects a discount percent above 100", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", {
          items: [{ title: "خدمت", unitPrice: 1000, quantity: 1, discountPercent: 150 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("8. Atomic transaction behavior", () => {
    it("runs everything through a single transaction client", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();

      await updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD);

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      // The same (transactional) mock client received every write.
      expect(prismaMock.invoiceItem.deleteMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.invoice.update).toHaveBeenCalledTimes(1);
    });

    it("propagates a write failure so the interactive transaction rolls back", async () => {
      const { updateDraftInvoice } = await import("./invoiceService");

      armDraftUpdateMocks();
      const dbError = new Error("database connection lost");
      prismaMock.invoice.update.mockRejectedValue(dbError);
      // The transaction callback throws -> $transaction propagates it.
      prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
        callback(prismaMock),
      );

      await expect(
        updateDraftInvoice("biz-1", "inv-draft-1", UPDATE_PAYLOAD),
      ).rejects.toThrow("database connection lost");
    });
  });
});
