import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { ValidationError } from "@/server/errors";

/**
 * Unit tests for the InvoicePayment domain layer, in the same style as
 * `src/server/customer/customerService.test.ts` and
 * `src/server/invoice/invoiceService.test.ts`: the Prisma singleton is mocked
 * (no PostgreSQL needed) and only the delegates the service actually uses are
 * stubbed.
 *
 * `@/server/auth/requireSession` is deliberately NOT bypassed and
 * `@/lib/invoice-calculation` (the shared `derivePaymentStatus()` /
 * `calculateRemainingAmount()` engines) is deliberately NOT mocked, so the
 * real authorization gate and the real payment-status vocabulary
 * (PENDING_PAYMENT / PARTIALLY_PAID / PAID / OVERDUE) are covered end to end.
 *
 * Concurrency note: a true two-connection race cannot be reproduced against a
 * mocked Prisma client — see the "concurrency and transaction boundaries"
 * block near the end, which asserts the lock ORDER and documents the remaining
 * need for real PostgreSQL integration testing.
 */
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  // The raw `SELECT ... FOR UPDATE` invoice row lock.
  $queryRaw: vi.fn(),
  // Present only to assert that payment authorization never routes through
  // requireBusinessOwnership — the business is derived from the invoice.
  business: {
    findUnique: vi.fn(),
  },
  invoice: {
    findUnique: vi.fn(),
    update: vi.fn(),
    // Payment mutations must never take the conditional finalize/updateMany path.
    updateMany: vi.fn(),
  },
  invoicePayment: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  // Present only so integrity tests can assert the official numbering,
  // immutable snapshots and usage quota are never touched by payment CRUD.
  invoiceSettings: {
    update: vi.fn(),
  },
  invoiceSellerSnapshot: {
    create: vi.fn(),
  },
  invoiceCustomerSnapshot: {
    create: vi.fn(),
  },
  usagePeriod: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

// Do not importOriginal() this module: it pulls auth-options.ts, which throws
// at load time when GOOGLE_CLIENT_ID is unset. The error classes are
// re-declared here so instanceof checks match what the gate throws.
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

const INVOICE_TOTAL = "100000";

function businessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "biz-1",
    accountId: "acc-1",
    name: "کسب‌وکار من",
    isActive: true,
    isLocked: false,
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    businessId: "biz-1",
    customerId: "cust-1",
    invoiceNumber: "INV-101",
    invoiceType: "FINAL" as const,
    issueDate: new Date("2026-03-01T00:00:00.000Z"),
    // Far future by default so OVERDUE never appears unless a test asks for it.
    dueDate: new Date("3000-01-01T00:00:00.000Z"),
    status: "PENDING_PAYMENT" as const,
    subtotal: new Decimal("90000"),
    itemDiscountAmount: new Decimal("0"),
    globalDiscountPercent: new Decimal("0"),
    globalDiscountAmount: new Decimal("0"),
    taxPercent: new Decimal("0"),
    taxAmount: new Decimal("10000"),
    taxableAmount: new Decimal("90000"),
    total: new Decimal(INVOICE_TOTAL),
    paidAmount: new Decimal("0"),
    remainingAmount: new Decimal(INVOICE_TOTAL),
    currency: "IRR",
    notes: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    finalizedAt: new Date("2026-03-10T00:00:00.000Z"),
    cancelledAt: null,
    business: businessRow(),
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    invoiceId: "inv-1",
    amount: new Decimal("40000"),
    paymentDate: new Date("2026-03-20T10:00:00.000Z"),
    method: "CARD" as const,
    referenceNumber: "REF-001",
    notes: null,
    createdAt: new Date("2026-03-20T10:00:00.000Z"),
    ...overrides,
  };
}

const VALID_CREATE = { amount: "40000", method: "CARD" as const };

/**
 * Returns one recorded mock call, failing the test loudly when absent —
 * `noUncheckedIndexedAccess` makes bare `mock.calls[i]` possibly-undefined,
 * and an assertion on `undefined` would read as a confusing type error
 * instead of a clear test failure.
 */
/* eslint-disable */
function nthCall(fn: { mock: { calls: any[] } }, index: number): any {
  const call = fn.mock.calls[index];
  if (!call) {
    throw new Error(`Expected the mock to have been called at index ${index}`);
  }
  return call;
}

/**
 * Invocation order of a mock's first call. A mock that was never invoked
 * sorts LAST, so an ordering assertion against it fails instead of passing
 * vacuously.
 */
function firstInvocationOrder(fn: { mock: { invocationCallOrder: number[] } }): number {
  return fn.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback(prismaMock),
  );
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.invoice.findUnique.mockResolvedValue(invoiceRow());
  prismaMock.invoice.update.mockResolvedValue(invoiceRow());
  prismaMock.invoicePayment.findMany.mockResolvedValue([]);
  prismaMock.invoicePayment.findUnique.mockResolvedValue(
    paymentRow({ invoice: invoiceRow() }),
  );
  prismaMock.invoicePayment.create.mockImplementation(async ({ data }: { data: unknown }) =>
    paymentRow(data as Record<string, unknown>),
  );
  prismaMock.invoicePayment.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      paymentRow({ id: where.id, ...data }),
  );
  prismaMock.invoicePayment.delete.mockImplementation(
    async ({ where }: { where: { id: string } }) => paymentRow({ id: where.id }),
  );
  requireSession.mockResolvedValue(SESSION);
});

// ---------------------------------------------------------------------------
// Authentication / business resolution — applies to every operation
// ---------------------------------------------------------------------------

describe("payment service — authentication and business resolution", () => {
  it("rejects every operation when there is no valid session", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const service = await import("./paymentService");

    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(service.createInvoicePayment("inv-1", VALID_CREATE)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(service.listInvoicePayments("inv-1")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.getInvoicePayment("pay-1")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.updateInvoicePayment("pay-1", { notes: "x" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(service.deleteInvoicePayment("pay-1")).rejects.toBeInstanceOf(UnauthorizedError);

    // Nothing may touch the database — not even the row lock — without a session.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.invoice.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.findMany).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.delete).not.toHaveBeenCalled();
  });

  it("rejects create and list with NotFoundError when the invoice does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(null);

    await expect(service.createInvoicePayment("inv-missing", VALID_CREATE)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.listInvoicePayments("inv-missing")).rejects.toBeInstanceOf(NotFoundError);

    // Create must fail before any payment row is written.
    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects create, update and delete with ForbiddenError when the invoice belongs to another account (cross-business create/update/delete)", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const service = await import("./paymentService");

    const foreignInvoice = invoiceRow({
      id: "inv-alien",
      businessId: "biz-alien",
      business: businessRow({ id: "biz-alien", accountId: "acc-alien" }),
    });
    prismaMock.invoice.findUnique.mockResolvedValue(foreignInvoice);
    prismaMock.invoicePayment.findUnique.mockResolvedValue(
      paymentRow({ id: "pay-alien", invoiceId: "inv-alien" }),
    );

    await expect(service.createInvoicePayment("inv-alien", VALID_CREATE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.updateInvoicePayment("pay-alien", { notes: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.deleteInvoicePayment("pay-alien")).rejects.toBeInstanceOf(ForbiddenError);

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.delete).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects list and get with ForbiddenError for another account's invoice (cross-business list/get)", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({
        business: businessRow({ id: "biz-alien", accountId: "acc-alien" }),
      }),
    );
    prismaMock.invoicePayment.findUnique.mockResolvedValue(
      paymentRow({
        invoice: invoiceRow({
          business: businessRow({ id: "biz-alien", accountId: "acc-alien" }),
        }),
      }),
    );

    await expect(service.listInvoicePayments("inv-alien")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.getInvoicePayment("pay-alien")).rejects.toBeInstanceOf(ForbiddenError);

    expect(prismaMock.invoicePayment.findMany).not.toHaveBeenCalled();
  });

  it("serves every operation on a second business of the SAME account and keeps each payment bound to its own invoice (same account, different business isolation)", async () => {
    const service = await import("./paymentService");

    // Invoice of biz-2, still owned by acc-1: account is the isolation boundary.
    const secondBusinessInvoice = invoiceRow({
      id: "inv-2",
      businessId: "biz-2",
      business: businessRow({ id: "biz-2", accountId: "acc-1" }),
    });
    prismaMock.invoice.findUnique.mockResolvedValue(secondBusinessInvoice);

    const created = await service.createInvoicePayment("inv-2", VALID_CREATE);
    expect(created.invoiceId).toBe("inv-2");
    // The payment is attached to the verified invoice — never re-parented.
    expect(prismaMock.invoicePayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ invoiceId: "inv-2" }),
    });

    // Listing one invoice's payments can never leak another invoice's rows:
    // the query is scoped to the verified invoice id.
    await service.listInvoicePayments("inv-2");
    expect(prismaMock.invoicePayment.findMany).toHaveBeenLastCalledWith({
      where: { invoiceId: "inv-2" },
      orderBy: [
        { paymentDate: "desc" },
        { createdAt: "desc" },
        { id: "asc" },
      ],
    });

    // A payment whose invoice lives in another business of the same account is
    // reachable only through its own invoice's account — proven, not assumed.
    prismaMock.invoicePayment.findUnique.mockResolvedValue(
      paymentRow({
        id: "pay-2",
        invoiceId: "inv-2",
        invoice: secondBusinessInvoice,
      }),
    );
    const fetched = await service.getInvoicePayment("pay-2");
    expect(fetched.id).toBe("pay-2");
    expect(fetched.invoiceId).toBe("inv-2");
  });
});

// ---------------------------------------------------------------------------
// createInvoicePayment
// ---------------------------------------------------------------------------

describe("createInvoicePayment", () => {
  it("records a valid payment and persists the authoritative denormalized state", async () => {
    const service = await import("./paymentService");

    const created = await service.createInvoicePayment("inv-1", VALID_CREATE);

    expect(created.invoiceId).toBe("inv-1");
    expect(prismaMock.invoicePayment.create).toHaveBeenCalledWith({
      data: {
        invoiceId: "inv-1",
        amount: new Decimal("40000"),
        paymentDate: expect.any(Date),
        method: "CARD",
        referenceNumber: null,
        notes: null,
      },
    });

    // The invoice row receives exactly the three denormalized columns.
    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("40000"),
        remainingAmount: new Decimal("60000"),
        status: "PARTIALLY_PAID",
      },
    });
  });

  it("accepts amount as string, number or Decimal — never coercing through floats", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", { amount: "40000", method: "CASH" });
    await service.createInvoicePayment("inv-1", { amount: 40000, method: "CASH" });
    await service.createInvoicePayment("inv-1", { amount: new Decimal("40000"), method: "CASH" });

    for (const call of prismaMock.invoicePayment.create.mock.calls) {
      expect(call[0].data.amount).toEqual(new Decimal("40000"));
    }
  });

  it("defaults paymentDate to the server clock when omitted and honors explicit dates", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", VALID_CREATE);
    const defaulted = nthCall(prismaMock.invoicePayment.create, 0)[0].data.paymentDate as Date;
    expect(defaulted).toBeInstanceOf(Date);
    expect(Number.isNaN(defaulted.getTime())).toBe(false);

    await service.createInvoicePayment("inv-1", {
      ...VALID_CREATE,
      paymentDate: "2026-03-05T00:00:00.000Z",
    });
    await service.createInvoicePayment("inv-1", {
      ...VALID_CREATE,
      paymentDate: new Date("2026-03-06T00:00:00.000Z"),
    });

    expect(nthCall(prismaMock.invoicePayment.create, 1)[0].data.paymentDate).toEqual(
      new Date("2026-03-05T00:00:00.000Z"),
    );
    expect(nthCall(prismaMock.invoicePayment.create, 2)[0].data.paymentDate).toEqual(
      new Date("2026-03-06T00:00:00.000Z"),
    );
  });

  it("accepts all supported payment methods", async () => {
    const service = await import("./paymentService");

    const methods = ["CASH", "CARD", "BANK_TRANSFER", "ONLINE", "OTHER"] as const;
    for (const method of methods) {
      prismaMock.invoicePayment.create.mockClear();
      await service.createInvoicePayment("inv-1", { amount: "1000", method });
      expect(prismaMock.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ method }),
      });
    }
  });

  it("accepts a payment equal to the exact remaining balance", async () => {
    const service = await import("./paymentService");

    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal("40000") }]);

    await service.createInvoicePayment("inv-1", { amount: "60000", method: "ONLINE" });

    expect(prismaMock.invoicePayment.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("100000"),
        remainingAmount: new Decimal("0"),
        status: "PAID",
      },
    });
  });

  it("allows multiple payments, summing them with Decimal arithmetic", async () => {
    const service = await import("./paymentService");

    // First payment: 40000.
    await service.createInvoicePayment("inv-1", { amount: "40000", method: "CASH" });

    // Second payment: authoritative sum now includes the first.
    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal("40000") }]);
    await service.createInvoicePayment("inv-1", { amount: "30000", method: "CARD" });

    expect(prismaMock.invoicePayment.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.invoice.update).toHaveBeenLastCalledWith({
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("70000"),
        remainingAmount: new Decimal("30000"),
        status: "PARTIALLY_PAID",
      },
    });
  });

  it("rejects a zero amount", async () => {
    const service = await import("./paymentService");

    await expect(service.createInvoicePayment("inv-1", { amount: "0", method: "CASH" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      service.createInvoicePayment("inv-1", { amount: "0.00", method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects a negative amount", async () => {
    const service = await import("./paymentService");

    await expect(
      service.createInvoicePayment("inv-1", { amount: "-40000", method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { amount: -0.01, method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects a payment exceeding the remaining balance (overpayment)", async () => {
    const service = await import("./paymentService");

    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal("40000") }]);

    await expect(
      service.createInvoicePayment("inv-1", { amount: "60001", method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects a payment on a fully paid invoice (remaining balance is zero)", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({
        status: "PAID",
        paidAmount: new Decimal(INVOICE_TOTAL),
        remainingAmount: new Decimal("0"),
      }),
    );
    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal(INVOICE_TOTAL) }]);

    await expect(
      service.createInvoicePayment("inv-1", { amount: "1", method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid payment method", async () => {
    const service = await import("./paymentService");

    await expect(
      service.createInvoicePayment("inv-1", { amount: "40000", method: "BITCOIN" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { amount: "40000", method: "cash" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid paymentDate (unparseable string or invalid Date instance)", async () => {
    const service = await import("./paymentService");

    await expect(
      service.createInvoicePayment("inv-1", {
        ...VALID_CREATE,
        paymentDate: "not-a-date",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", {
        ...VALID_CREATE,
        paymentDate: new Date("still-not-a-date"),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects amounts with more than 2 decimal places", async () => {
    const service = await import("./paymentService");

    await expect(
      service.createInvoicePayment("inv-1", { amount: "40000.999", method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { amount: "0.001", method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects amounts outside the Decimal(14,2) range", async () => {
    const service = await import("./paymentService");

    // 13 integer digits — one more than Decimal(14,2) can hold.
    await expect(
      service.createInvoicePayment("inv-1", { amount: "1000000000000", method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { amount: new Decimal("999999999999.99").plus("0.01"), method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects non-numeric amounts instead of coercing them", async () => {
    const service = await import("./paymentService");

    const invalidAmounts = [
      "abc",
      "",
      "   ",
      true,
      false,
      { amount: 1 },
      [],
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const amount of invalidAmounts) {
      await expect(
        service.createInvoicePayment("inv-1", { amount, method: "CASH" }),
      ).rejects.toBeInstanceOf(ValidationError);
    }

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects server-owned field injection (unknown keys are refused, never silently applied)", async () => {
    const service = await import("./paymentService");

    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, invoiceId: "inv-other" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, id: "pay-hijack" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, accountId: "acc-1" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, businessId: "biz-1" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, status: "PAID" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, paidAmount: "100000" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, remainingAmount: "0" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, createdAt: new Date() }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing reached the database: the lock never ran, nothing was written.
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects a payment against a draft (non-finalized) invoice", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: "DRAFT", finalizedAt: null }),
    );

    await expect(service.createInvoicePayment("inv-1", VALID_CREATE)).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects a payment against a cancelled invoice", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: "CANCELLED", cancelledAt: new Date("2026-03-15T00:00:00.000Z") }),
    );

    await expect(service.createInvoicePayment("inv-1", VALID_CREATE)).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects a payment inside an archived business", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({
        business: businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
      }),
    );

    await expect(service.createInvoicePayment("inv-1", VALID_CREATE)).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateInvoicePayment
// ---------------------------------------------------------------------------

describe("updateInvoicePayment", () => {
  it("updates only the fields present in the payload", async () => {
    const service = await import("./paymentService");

    const updated = await service.updateInvoicePayment("pay-1", {
      referenceNumber: "REF-002",
      notes: "پرداخت قسط دوم",
    });

    expect(updated.referenceNumber).toBe("REF-002");
    expect(prismaMock.invoicePayment.update).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: {
        referenceNumber: "REF-002",
        notes: "پرداخت قسط دوم",
      },
    });
    // Amount untouched → paid amount stays this payment's authoritative amount.
    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("40000"),
        remainingAmount: new Decimal("60000"),
        status: "PARTIALLY_PAID",
      },
    });
  });

  it("applies a valid amount update and re-derives the payment status", async () => {
    const service = await import("./paymentService");

    await service.updateInvoicePayment("pay-1", { amount: "60000", method: "BANK_TRANSFER" });

    expect(prismaMock.invoicePayment.update).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { amount: new Decimal("60000"), method: "BANK_TRANSFER" },
    });
    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("60000"),
        remainingAmount: new Decimal("40000"),
        status: "PARTIALLY_PAID",
      },
    });
  });

  it("accepts an update that raises total paid to exactly the invoice total (PAID)", async () => {
    const service = await import("./paymentService");

    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal("40000") }]);

    await service.updateInvoicePayment("pay-1", { amount: "60000" });

    expect(prismaMock.invoicePayment.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("100000"),
        remainingAmount: new Decimal("0"),
        status: "PAID",
      },
    });
  });

  it("rejects an update that would cause overpayment", async () => {
    const service = await import("./paymentService");

    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal("70000") }]);

    await expect(service.updateInvoicePayment("pay-1", { amount: "30001" })).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects a zero or negative amount in an update", async () => {
    const service = await import("./paymentService");

    await expect(service.updateInvoicePayment("pay-1", { amount: "0" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.updateInvoicePayment("pay-1", { amount: "-5" })).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects invoiceId re-parenting in the payload", async () => {
    const service = await import("./paymentService");

    await expect(
      service.updateInvoicePayment("pay-1", { invoiceId: "inv-other" } as Record<string, unknown>),
    ).rejects.toBeInstanceOf(ValidationError);

    // The payment was never re-parented (strict schema refused before the tx).
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an update on a cancelled invoice", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: "CANCELLED", cancelledAt: new Date("2026-03-15T00:00:00.000Z") }),
    );

    await expect(service.updateInvoicePayment("pay-1", { notes: "x" })).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects an update on a draft invoice", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: "DRAFT", finalizedAt: null }),
    );

    await expect(service.updateInvoicePayment("pay-1", { notes: "x" })).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
  });

  it("rejects an update inside an archived business", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({
        business: businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
      }),
    );

    await expect(service.updateInvoicePayment("pay-1", { notes: "x" })).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects with NotFoundError when the payment does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const service = await import("./paymentService");

    prismaMock.invoicePayment.findUnique.mockResolvedValue(null);

    await expect(service.updateInvoicePayment("pay-missing", { notes: "x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
  });

  it("rejects with an empty update payload", async () => {
    const service = await import("./paymentService");

    await expect(service.updateInvoicePayment("pay-1", {})).rejects.toBeInstanceOf(ValidationError);
    await expect(service.updateInvoicePayment("pay-1", undefined)).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
  });

  it("normalizes whitespace-only referenceNumber and notes to null", async () => {
    const service = await import("./paymentService");

    await service.updateInvoicePayment("pay-1", { referenceNumber: "   ", notes: "" });

    expect(prismaMock.invoicePayment.update).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { referenceNumber: null, notes: null },
    });
  });

  it("rejects excessively long referenceNumber and notes", async () => {
    const service = await import("./paymentService");

    await expect(
      service.updateInvoicePayment("pay-1", { referenceNumber: "R".repeat(101) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(service.updateInvoicePayment("pay-1", { notes: "n".repeat(2001) })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, referenceNumber: "R".repeat(101) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createInvoicePayment("inv-1", { ...VALID_CREATE, notes: "n".repeat(2001) }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.update).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteInvoicePayment
// ---------------------------------------------------------------------------

describe("deleteInvoicePayment", () => {
  it("deletes a payment and re-derives the invoice payment state", async () => {
    const service = await import("./paymentService");

    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal("30000") }]);

    const deleted = await service.deleteInvoicePayment("pay-1");

    expect(deleted.id).toBe("pay-1");
    expect(prismaMock.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-1" } });
    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("30000"),
        remainingAmount: new Decimal("70000"),
        status: "PARTIALLY_PAID",
      },
    });
  });

  it("derives PARTIALLY_PAID when deleting one payment of a PAID invoice with two payments", async () => {
    const service = await import("./paymentService");

    // pay-1 (40000) is deleted; pay-2 (60000) remains of the 100000 total.
    prismaMock.invoicePayment.findUnique.mockResolvedValue(
      paymentRow({ id: "pay-1", amount: new Decimal("40000") }),
    );
    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal("60000") }]);

    await service.deleteInvoicePayment("pay-1");

    expect(prismaMock.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-1" } });
    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("60000"),
        remainingAmount: new Decimal("40000"),
        status: "PARTIALLY_PAID",
      },
    });
  });

  it("derives PENDING_PAYMENT when the last remaining payment is deleted", async () => {
    const service = await import("./paymentService");

    // Sequential deletes: after the first, 30000 remains (partial);
    // after the second, nothing remains (pending again).
    prismaMock.invoicePayment.findUnique.mockResolvedValue(
      paymentRow({ id: "pay-1", amount: new Decimal("30000") }),
    );
    prismaMock.invoicePayment.findMany
      .mockResolvedValueOnce([{ amount: new Decimal("30000") }]) // after deleting pay-2
      .mockResolvedValueOnce([]); // after deleting pay-1

    await service.deleteInvoicePayment("pay-2");
    await service.deleteInvoicePayment("pay-1");

    expect(prismaMock.invoice.update).toHaveBeenNthCalledWith(1, {
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("30000"),
        remainingAmount: new Decimal("70000"),
        status: "PARTIALLY_PAID",
      },
    });
    expect(prismaMock.invoice.update).toHaveBeenNthCalledWith(2, {
      where: { id: "inv-1" },
      data: {
        paidAmount: new Decimal("0"),
        remainingAmount: new Decimal("100000"),
        status: "PENDING_PAYMENT",
      },
    });
  });

  it("never restores the invoice quota when a payment is deleted", async () => {
    const service = await import("./paymentService");

    await service.deleteInvoicePayment("pay-1");

    expect(prismaMock.usagePeriod.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.create).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
  });

  it("rejects deletion on a cancelled invoice", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({ status: "CANCELLED", cancelledAt: new Date("2026-03-15T00:00:00.000Z") }),
    );

    await expect(service.deleteInvoicePayment("pay-1")).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.delete).not.toHaveBeenCalled();
  });

  it("rejects deletion inside an archived business", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({
        business: businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
      }),
    );

    await expect(service.deleteInvoicePayment("pay-1")).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.invoicePayment.delete).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects with NotFoundError when the payment to delete does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const service = await import("./paymentService");

    prismaMock.invoicePayment.findUnique.mockResolvedValue(null);

    await expect(service.deleteInvoicePayment("pay-missing")).rejects.toBeInstanceOf(NotFoundError);

    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMock.invoicePayment.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Payment status derivation — reuses the shared derivePaymentStatus vocabulary
// ---------------------------------------------------------------------------

describe("payment status derivation (shared derivePaymentStatus)", () => {
  it("derives PENDING_PAYMENT when no payments remain", async () => {
    const service = await import("./paymentService");

    prismaMock.invoicePayment.findMany.mockResolvedValue([]);

    await service.deleteInvoicePayment("pay-1");

    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: expect.objectContaining({ status: "PENDING_PAYMENT" }),
    });
  });

  it("derives PARTIALLY_PAID for a partial payment", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", { amount: "1", method: "CASH" });

    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: expect.objectContaining({ status: "PARTIALLY_PAID" }),
    });
  });

  it("derives PAID when payments reach the exact total", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", { amount: "100000", method: "CASH" });

    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: expect.objectContaining({ status: "PAID" }),
    });
  });

  it("derives OVERDUE when a balance remains past the due date", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({ dueDate: new Date("2020-01-01T00:00:00.000Z") }),
    );

    await service.createInvoicePayment("inv-1", { amount: "40000", method: "CASH" });

    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: expect.objectContaining({ status: "OVERDUE" }),
    });
  });

  it("derives PAID — not OVERDUE — when the total is settled past the due date", async () => {
    const service = await import("./paymentService");

    prismaMock.invoice.findUnique.mockResolvedValue(
      invoiceRow({ dueDate: new Date("2020-01-01T00:00:00.000Z") }),
    );

    await service.createInvoicePayment("inv-1", { amount: "100000", method: "CASH" });

    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: expect.objectContaining({ status: "PAID" }),
    });
  });

  it("uses only the established vocabulary: PENDING_PAYMENT, PARTIALLY_PAID, PAID, OVERDUE", async () => {
    const service = await import("./paymentService");

    const allowedStatuses = new Set(["PENDING_PAYMENT", "PARTIALLY_PAID", "PAID", "OVERDUE"]);

    for (const data of prismaMock.invoice.update.mock.calls.map((call) => call[0].data)) {
      expect(allowedStatuses.has((data as { status: string }).status)).toBe(true);
    }

    // Exercise every transition above in one go.
    await service.createInvoicePayment("inv-1", { amount: "40000", method: "CASH" });
    await service.createInvoicePayment("inv-1", { amount: "60000", method: "CASH" });

    for (const data of prismaMock.invoice.update.mock.calls.map((call) => call[0].data)) {
      expect(allowedStatuses.has((data as { status: string }).status)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invoice integrity — protected fields
// ---------------------------------------------------------------------------

describe("invoice integrity — fields payment CRUD must never touch", () => {
  it("writes ONLY paidAmount, remainingAmount and status to the invoice row", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", { amount: "40000", method: "CASH" });
    await service.updateInvoicePayment("pay-1", { amount: "50000" });
    await service.deleteInvoicePayment("pay-1");

    for (const call of prismaMock.invoice.update.mock.calls) {
      expect(Object.keys(call[0].data).sort()).toEqual([
        "paidAmount",
        "remainingAmount",
        "status",
      ]);
    }
    // And never via the conditional bulk path used by finalization.
    expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("leaves invoice.total and the tax/discount breakdown untouched", async () => {
    const service = await import("./paymentService");

    const before = invoiceRow();
    await service.createInvoicePayment("inv-1", VALID_CREATE);

    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: expect.not.objectContaining({
        total: expect.anything(),
        subtotal: expect.anything(),
        taxAmount: expect.anything(),
        taxPercent: expect.anything(),
        globalDiscountAmount: expect.anything(),
        itemDiscountAmount: expect.anything(),
      }),
    });
    // The authoritative total used for the balance check was the stored one.
    expect(prismaMock.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { paidAmount: new Decimal("40000"), remainingAmount: new Decimal("60000"), status: "PARTIALLY_PAID" },
    });
    expect(before.total).toEqual(new Decimal(INVOICE_TOTAL));
  });

  it("never writes the immutable seller/customer snapshots", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", VALID_CREATE);
    await service.listInvoicePayments("inv-1");
    await service.getInvoicePayment("pay-1");
    await service.updateInvoicePayment("pay-1", { notes: "x" });
    await service.deleteInvoicePayment("pay-1");

    expect(prismaMock.invoiceSellerSnapshot.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceCustomerSnapshot.create).not.toHaveBeenCalled();
  });

  it("never advances or rewrites the official invoice numbering", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", VALID_CREATE);
    await service.updateInvoicePayment("pay-1", { amount: "50000" });
    await service.deleteInvoicePayment("pay-1");

    expect(prismaMock.invoiceSettings.update).not.toHaveBeenCalled();
    expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("never touches the usage period / invoice quota on any mutation", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", VALID_CREATE);
    await service.updateInvoicePayment("pay-1", { amount: "50000" });
    await service.deleteInvoicePayment("pay-1");

    expect(prismaMock.usagePeriod.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.create).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Concurrency & transaction boundaries
// ---------------------------------------------------------------------------

describe("concurrency and transaction boundaries", () => {
  it("wraps every mutation in an interactive transaction", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", VALID_CREATE);
    await service.updateInvoicePayment("pay-1", { notes: "x" });
    await service.deleteInvoicePayment("pay-1");

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3);
    // Reads stay outside transactions.
    await service.listInvoicePayments("inv-1");
    await service.getInvoicePayment("pay-1");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3);
  });

  it("locks the invoice row (SELECT ... FOR UPDATE) BEFORE summing payments on create", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", VALID_CREATE);

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    const lockOrder = firstInvocationOrder(prismaMock.$queryRaw);
    const sumOrder = firstInvocationOrder(prismaMock.invoicePayment.findMany);
    const writeOrder = firstInvocationOrder(prismaMock.invoicePayment.create);
    expect(lockOrder).toBeLessThan(sumOrder);
    expect(sumOrder).toBeLessThan(writeOrder);
  });

  it("locks the invoice row BEFORE re-reading and summing payments on update and delete", async () => {
    const service = await import("./paymentService");

    await service.updateInvoicePayment("pay-1", { amount: "50000" });

    let lockOrder = firstInvocationOrder(prismaMock.$queryRaw);
    let sumOrder = firstInvocationOrder(prismaMock.invoicePayment.findMany);
    let writeOrder = firstInvocationOrder(prismaMock.invoicePayment.update);
    expect(lockOrder).toBeLessThan(sumOrder);
    expect(sumOrder).toBeLessThan(writeOrder);

    prismaMock.$queryRaw.mockClear();
    prismaMock.invoicePayment.findUnique.mockClear();
    prismaMock.invoicePayment.findMany.mockClear();
    prismaMock.invoicePayment.update.mockClear();

    await service.deleteInvoicePayment("pay-1");

    lockOrder = firstInvocationOrder(prismaMock.$queryRaw);
    sumOrder = firstInvocationOrder(prismaMock.invoicePayment.findMany);
    writeOrder = firstInvocationOrder(prismaMock.invoicePayment.delete);
    expect(lockOrder).toBeLessThan(sumOrder);
    expect(sumOrder).toBeLessThan(writeOrder);
  });

  it("issues the minimal parameterized PostgreSQL lock: SELECT id FROM \"invoices\" WHERE id = $1 FOR UPDATE", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", VALID_CREATE);
    await service.updateInvoicePayment("pay-1", { notes: "x" });

    for (const call of prismaMock.$queryRaw.mock.calls) {
      const [templateStrings, ...substitutions] = call as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(templateStrings.join("?")).toContain('SELECT id FROM "invoices" WHERE id =');
      expect(templateStrings.join("?")).toContain("FOR UPDATE");
      // The invoice id travels as a bound parameter, never as SQL text.
      expect(substitutions).toEqual(["inv-1"]);
      expect(templateStrings.join("")).not.toContain("inv-1");
    }

    // Update/delete lock the invoice derived from the payment row itself.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("updates the invoice denormalized state only after the payment mutation, inside the same transaction", async () => {
    const service = await import("./paymentService");

    await service.createInvoicePayment("inv-1", VALID_CREATE);

    const writeOrder = firstInvocationOrder(prismaMock.invoicePayment.create);
    const invoiceSyncOrder = firstInvocationOrder(prismaMock.invoice.update);
    expect(writeOrder).toBeLessThan(invoiceSyncOrder);
  });

  it("documents that a true two-connection race requires real PostgreSQL integration testing", async () => {
    // The mocked Prisma client executes the transaction callback on the SAME
    // mock object, so two concurrent $transaction calls cannot block each other
    // at `SELECT ... FOR UPDATE` the way two real connections would.
    //
    // What IS verified here (against the mocks):
    //   1. every mutation opens an interactive transaction;
    //   2. the invoice row lock is the FIRST statement of that transaction;
    //   3. payment summation happens strictly after the lock;
    //   4. the overpayment check runs against the post-lock authoritative sum
    //      (asserted by the create/update overpayment tests above);
    //   5. the lock is the minimal `SELECT ... FOR UPDATE` on "invoices" with a
    //      bound-parameter id.
    //
    // What still REQUIRES integration testing on PostgreSQL:
    //   - two connections racing "pay the remaining balance" must serialize at
    //     the row lock so exactly one succeeds and the loser is rejected as an
    //     overpayment (this cannot be reproduced with an in-process mock);
    //   - the lock is released only at commit/rollback (Prisma interactive
    //     transaction semantics);
    //   - no deadlocks across concurrent multi-payment reorders (single-row
    //     lock per invoice makes this ordering total).
    const service = await import("./paymentService");

    // The guarantees the integration suite will rely on, re-asserted here so
    // the documented contract cannot silently rot:
    prismaMock.invoicePayment.findMany.mockResolvedValue([{ amount: new Decimal("99999") }]);
    await expect(
      service.createInvoicePayment("inv-1", { amount: "2", method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });
});
