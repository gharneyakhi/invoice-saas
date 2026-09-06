import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ValidationError } from "@/server/errors";

/**
 * Unit tests for the Customer domain layer, in the same style as
 * `src/server/business/businessService.test.ts`: the Prisma singleton is
 * mocked (no PostgreSQL needed) and only the delegates the service actually
 * uses are stubbed.
 *
 * `@/server/auth/requireBusinessOwnership` is deliberately NOT mocked, so the
 * real ownership guard runs against `prismaMock.business.findUnique` and the
 * 403/404 behaviour is covered end to end.
 */
const prismaMock = vi.hoisted(() => ({
  business: {
    findUnique: vi.fn(),
  },
  customer: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // Present only so we can assert the archive path never reaches for a hard
    // delete (a customer may be referenced by invoices).
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  // Present only so we can assert that editing a customer never rewrites the
  // immutable snapshot taken at finalization time.
  invoiceCustomerSnapshot: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  invoice: {
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

// Do not importOriginal() this module: it pulls auth-options.ts, which throws
// at load time when GOOGLE_CLIENT_ID is unset. The error classes are
// re-declared here so instanceof checks match what the guard throws.
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

interface BusinessRowOverrides {
  id?: string;
  accountId?: string;
  archivedAt?: Date | null;
}

function businessRow(overrides: BusinessRowOverrides = {}) {
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

interface CustomerRowOverrides {
  id?: string;
  businessId?: string;
  name?: string;
  archivedAt?: Date | null;
}

function customerRow(overrides: CustomerRowOverrides = {}) {
  return {
    id: "cus-1",
    businessId: "biz-1",
    name: "مشتری یک",
    mobile: "09120000000",
    phone: null,
    email: "customer@example.com",
    address: null,
    nationalId: null,
    economicCode: null,
    notes: null,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

const LIST_ORDER = [{ name: "asc" }, { id: "asc" }];

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback(prismaMock),
  );
  requireSession.mockResolvedValue(SESSION);
});

// ---------------------------------------------------------------------------
// Authentication / business resolution — applies to every operation
// ---------------------------------------------------------------------------

describe("customer service — authentication and business resolution", () => {
  it("rejects every operation when there is no valid session", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const service = await import("./customerService");

    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(service.listCustomers("biz-1")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.getCustomer("biz-1", "cus-1")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.createCustomer("biz-1", { name: "x" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(service.updateCustomer("biz-1", "cus-1", { name: "x" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(service.archiveCustomer("biz-1", "cus-1")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    // Nothing may touch the customers table without a session.
    expect(prismaMock.customer.findMany).not.toHaveBeenCalled();
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  it("rejects every operation with NotFoundError when the business does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const service = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(null);

    await expect(service.listCustomers("missing-biz")).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.getCustomer("missing-biz", "cus-1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.createCustomer("missing-biz", { name: "x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      service.updateCustomer("missing-biz", "cus-1", { name: "x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.archiveCustomer("missing-biz", "cus-1")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(prismaMock.customer.findMany).not.toHaveBeenCalled();
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
  });

  it("rejects every operation with ForbiddenError for another account's business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const service = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ id: "biz-other", accountId: "acc-other" }),
    );

    await expect(service.listCustomers("biz-other")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.getCustomer("biz-other", "cus-1")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.createCustomer("biz-other", { name: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      service.updateCustomer("biz-other", "cus-1", { name: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.archiveCustomer("biz-other", "cus-1")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    expect(prismaMock.customer.findMany).not.toHaveBeenCalled();
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listCustomers
// ---------------------------------------------------------------------------

describe("listCustomers", () => {
  it("returns only the requested business's live customers, in a deterministic order", async () => {
    const { listCustomers } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const rows = [customerRow(), customerRow({ id: "cus-2", name: "مشتری دو" })];
    prismaMock.customer.findMany.mockResolvedValue(rows);

    await expect(listCustomers("biz-1")).resolves.toEqual(rows);
    expect(prismaMock.customer.findMany).toHaveBeenCalledWith({
      where: { businessId: "biz-1", archivedAt: null },
      orderBy: LIST_ORDER,
    });
  });

  it("scopes the query to the verified business row, never to a caller-supplied value", async () => {
    const { listCustomers } = await import("./customerService");

    // The Business row is authoritative: even if the lookup were to resolve a
    // row under a different id, the `where` clause uses the row's own id.
    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.customer.findMany.mockResolvedValue([]);

    await listCustomers("biz-1");

    const call = prismaMock.customer.findMany.mock.calls[0]?.[0];
    expect(call.where.businessId).toBe("biz-1");
    expect(call.where).not.toHaveProperty("accountId");
  });

  it("excludes archived customers by default (archiving is a soft delete)", async () => {
    const { listCustomers } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findMany.mockResolvedValue([]);

    await listCustomers("biz-1");

    const call = prismaMock.customer.findMany.mock.calls[0]?.[0];
    expect(call.where.archivedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getCustomer
// ---------------------------------------------------------------------------

describe("getCustomer", () => {
  it("returns the customer when it belongs to the owned business", async () => {
    const { getCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const row = customerRow();
    prismaMock.customer.findUnique.mockResolvedValue(row);

    await expect(getCustomer("biz-1", "cus-1")).resolves.toEqual(row);
    expect(prismaMock.customer.findUnique).toHaveBeenCalledWith({ where: { id: "cus-1" } });
  });

  it("rejects a customer that lives in another business of the same account", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { getCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.customer.findUnique.mockResolvedValue(
      customerRow({ id: "cus-other", businessId: "biz-2" }),
    );

    await expect(getCustomer("biz-1", "cus-other")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects a customer belonging to another account's business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { getCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.customer.findUnique.mockResolvedValue(
      customerRow({ id: "cus-evil", businessId: "biz-of-acc-other" }),
    );

    await expect(getCustomer("biz-1", "cus-evil")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("propagates NotFoundError for a customer that does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const { getCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(null);

    await expect(getCustomer("biz-1", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("still resolves an archived customer, so existing invoices can display it", async () => {
    const { getCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const archived = customerRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") });
    prismaMock.customer.findUnique.mockResolvedValue(archived);

    await expect(getCustomer("biz-1", "cus-1")).resolves.toEqual(archived);
  });

  it("rejects a blank customer id with ValidationError", async () => {
    const { getCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(getCustomer("biz-1", "   ")).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createCustomer
// ---------------------------------------------------------------------------

describe("createCustomer", () => {
  it("creates a customer under the verified business, trimming and normalizing input", async () => {
    const { createCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const created = customerRow({ id: "cus-new" });
    prismaMock.customer.create.mockResolvedValue(created);

    const result = await createCustomer("biz-1", {
      name: "  مشتری تازه  ",
      mobile: "09120000000",
      email: "  buyer@example.com  ",
      notes: "   ",
    });

    expect(result).toEqual(created);
    expect(prismaMock.customer.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.customer.create).toHaveBeenCalledWith({
      data: {
        businessId: "biz-1",
        name: "مشتری تازه",
        mobile: "09120000000",
        phone: null,
        email: "buyer@example.com",
        address: null,
        nationalId: null,
        economicCode: null,
        // A whitespace-only string is normalized to null, not stored as "".
        notes: null,
      },
    });
  });

  it("rejects an empty name with ValidationError", async () => {
    const { createCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(createCustomer("biz-1", { name: "   " })).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
  });

  it.each([
    ["businessId", { name: "نفوذی", businessId: "biz-other" }],
    ["accountId", { name: "نفوذی", accountId: "acc-evil" }],
    ["id", { name: "نفوذی", id: "cus-forged" }],
    ["createdAt", { name: "نفوذی", createdAt: new Date("2020-01-01T00:00:00.000Z") }],
    ["updatedAt", { name: "نفوذی", updatedAt: new Date("2020-01-01T00:00:00.000Z") }],
    ["archivedAt", { name: "نفوذی", archivedAt: null }],
  ])("rejects a payload smuggling the server-owned field %s", async (_field, payload) => {
    const { createCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(createCustomer("biz-1", payload)).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
  });

  it("refuses to create a customer in an archived business", async () => {
    const { createCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
    );

    await expect(createCustomer("biz-1", { name: "مشتری" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.customer.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateCustomer
// ---------------------------------------------------------------------------

describe("updateCustomer", () => {
  it("updates only the fields present in the payload, keyed by the verified row id", async () => {
    const { updateCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(customerRow());
    const updated = customerRow({ name: "نام جدید" });
    prismaMock.customer.update.mockResolvedValue(updated);

    await expect(
      updateCustomer("biz-1", "cus-1", { name: "  نام جدید  ", phone: null }),
    ).resolves.toEqual(updated);

    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: "cus-1" },
      data: { name: "نام جدید", phone: null },
    });
  });

  it("rejects an empty update payload", async () => {
    const { updateCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(customerRow());

    await expect(updateCustomer("biz-1", "cus-1", {})).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  it.each([
    ["businessId", { name: "x", businessId: "biz-other" }],
    ["accountId", { name: "x", accountId: "acc-evil" }],
    ["id", { name: "x", id: "cus-forged" }],
    ["archivedAt", { name: "x", archivedAt: null }],
    ["updatedAt", { name: "x", updatedAt: new Date("2020-01-01T00:00:00.000Z") }],
  ])("rejects an update smuggling the server-owned field %s", async (_field, payload) => {
    const { updateCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(customerRow());

    await expect(updateCustomer("biz-1", "cus-1", payload)).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  it("refuses to update a customer that belongs to another business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { updateCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.customer.findUnique.mockResolvedValue(customerRow({ businessId: "biz-2" }));

    await expect(updateCustomer("biz-1", "cus-1", { name: "hack" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  it("refuses to update a customer inside an archived business", async () => {
    const { updateCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
    );

    await expect(updateCustomer("biz-1", "cus-1", { name: "x" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  it("refuses to update an archived customer", async () => {
    const { updateCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(
      customerRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
    );

    await expect(updateCustomer("biz-1", "cus-1", { name: "x" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  it("never rewrites the immutable InvoiceCustomerSnapshot of a finalized invoice", async () => {
    const { updateCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(customerRow({ name: "نام قدیمی" }));
    prismaMock.customer.update.mockResolvedValue(customerRow({ name: "نام جدید" }));

    await updateCustomer("biz-1", "cus-1", {
      name: "نام جدید",
      address: "آدرس جدید",
      email: "new@example.com",
    });

    // The snapshot captured at finalization time is the invoice's historical
    // truth; the customer edit must not reach it, nor the invoice itself.
    expect(prismaMock.invoiceCustomerSnapshot.update).not.toHaveBeenCalled();
    expect(prismaMock.invoiceCustomerSnapshot.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.invoiceCustomerSnapshot.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceCustomerSnapshot.delete).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();

    // Exactly one write, and it targets the customers table only.
    expect(prismaMock.customer.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// archiveCustomer
// ---------------------------------------------------------------------------

describe("archiveCustomer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("soft-deletes by stamping archivedAt and never hard-deletes", async () => {
    const { archiveCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(customerRow());
    const archived = customerRow({ archivedAt: NOW });
    prismaMock.customer.update.mockResolvedValue(archived);

    await expect(archiveCustomer("biz-1", "cus-1")).resolves.toEqual(archived);

    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: "cus-1" },
      data: { archivedAt: NOW },
    });
    expect(prismaMock.customer.delete).not.toHaveBeenCalled();
    expect(prismaMock.customer.deleteMany).not.toHaveBeenCalled();
  });

  it("is idempotent: archiving an already archived customer does not move the timestamp", async () => {
    const { archiveCustomer } = await import("./customerService");

    const already = customerRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") });
    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.customer.findUnique.mockResolvedValue(already);

    await expect(archiveCustomer("biz-1", "cus-1")).resolves.toEqual(already);
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  it("refuses to archive a customer that belongs to another business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { archiveCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.customer.findUnique.mockResolvedValue(customerRow({ businessId: "biz-2" }));

    await expect(archiveCustomer("biz-1", "cus-1")).rejects.toBeInstanceOf(ForbiddenError);
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });

  it("refuses to archive inside an archived business", async () => {
    const { archiveCustomer } = await import("./customerService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
    );

    await expect(archiveCustomer("biz-1", "cus-1")).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.customer.update).not.toHaveBeenCalled();
  });
});
