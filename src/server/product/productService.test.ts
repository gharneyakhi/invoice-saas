import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Decimal from "decimal.js";
import { ValidationError } from "@/server/errors";

/**
 * Unit tests for the Product domain layer, in the same style as
 * `src/server/business/businessService.test.ts` and
 * `src/server/invoice/invoiceService.test.ts`: the Prisma singleton is mocked
 * (no PostgreSQL needed) and only the delegates the service actually uses are
 * stubbed.
 *
 * `@/server/auth/requireBusinessOwnership` is deliberately NOT mocked, so the
 * real ownership guard runs against `prismaMock.business.findUnique` and the
 * 403/404 behaviour is covered end to end.
 */
const prismaMock = vi.hoisted(() => ({
  business: {
    findUnique: vi.fn(),
  },
  product: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // Present only so we can assert the archive path never reaches for a hard
    // delete (a product may be referenced by invoice items).
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  // Present only so we can assert that editing a product never rewrites the
  // historical values stored on a finalized invoice.
  invoiceItem: {
    findMany: vi.fn(),
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

interface ProductRowOverrides {
  id?: string;
  businessId?: string;
  name?: string;
  price?: Decimal;
  active?: boolean;
  archivedAt?: Date | null;
}

function productRow(overrides: ProductRowOverrides = {}) {
  return {
    id: "prd-1",
    businessId: "biz-1",
    name: "کالای یک",
    description: null,
    price: new Decimal("1000.00"),
    unit: "عدد",
    active: true,
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

describe("product service — authentication and business resolution", () => {
  it("rejects every operation when there is no valid session", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const service = await import("./productService");

    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(service.listProducts("biz-1")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.getProduct("biz-1", "prd-1")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      service.createProduct("biz-1", { name: "x", price: 1 }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.updateProduct("biz-1", "prd-1", { price: 2 })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(service.archiveProduct("biz-1", "prd-1")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.product.create).not.toHaveBeenCalled();
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("rejects every operation with NotFoundError when the business does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const service = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(null);

    await expect(service.listProducts("missing-biz")).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.getProduct("missing-biz", "prd-1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.createProduct("missing-biz", { name: "x", price: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.updateProduct("missing-biz", "prd-1", { price: 2 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.archiveProduct("missing-biz", "prd-1")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
    expect(prismaMock.product.create).not.toHaveBeenCalled();
  });

  it("rejects every operation with ForbiddenError for another account's business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const service = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ id: "biz-other", accountId: "acc-other" }),
    );

    await expect(service.listProducts("biz-other")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.getProduct("biz-other", "prd-1")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.createProduct("biz-other", { name: "x", price: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.updateProduct("biz-other", "prd-1", { price: 2 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.archiveProduct("biz-other", "prd-1")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    expect(prismaMock.product.findMany).not.toHaveBeenCalled();
    expect(prismaMock.product.create).not.toHaveBeenCalled();
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listProducts
// ---------------------------------------------------------------------------

describe("listProducts", () => {
  it("returns only the requested business's live products, in a deterministic order", async () => {
    const { listProducts } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const rows = [productRow(), productRow({ id: "prd-2", name: "کالای دو" })];
    prismaMock.product.findMany.mockResolvedValue(rows);

    await expect(listProducts("biz-1")).resolves.toEqual(rows);
    expect(prismaMock.product.findMany).toHaveBeenCalledWith({
      where: { businessId: "biz-1", archivedAt: null },
      orderBy: LIST_ORDER,
    });
  });

  it("scopes the query to the verified business row, never to a caller-supplied value", async () => {
    const { listProducts } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.product.findMany.mockResolvedValue([]);

    await listProducts("biz-1");

    const call = prismaMock.product.findMany.mock.calls[0]?.[0];
    expect(call.where.businessId).toBe("biz-1");
    expect(call.where).not.toHaveProperty("accountId");
  });

  it("excludes archived products by default (archiving is a soft delete)", async () => {
    const { listProducts } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findMany.mockResolvedValue([]);

    await listProducts("biz-1");

    const call = prismaMock.product.findMany.mock.calls[0]?.[0];
    expect(call.where.archivedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getProduct
// ---------------------------------------------------------------------------

describe("getProduct", () => {
  it("returns the product when it belongs to the owned business", async () => {
    const { getProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const row = productRow();
    prismaMock.product.findUnique.mockResolvedValue(row);

    await expect(getProduct("biz-1", "prd-1")).resolves.toEqual(row);
    expect(prismaMock.product.findUnique).toHaveBeenCalledWith({ where: { id: "prd-1" } });
  });

  it("rejects a product that lives in another business of the same account", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { getProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.product.findUnique.mockResolvedValue(
      productRow({ id: "prd-other", businessId: "biz-2" }),
    );

    await expect(getProduct("biz-1", "prd-other")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects a product belonging to another account's business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { getProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.product.findUnique.mockResolvedValue(
      productRow({ id: "prd-evil", businessId: "biz-of-acc-other" }),
    );

    await expect(getProduct("biz-1", "prd-evil")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("propagates NotFoundError for a product that does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const { getProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(null);

    await expect(getProduct("biz-1", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("still resolves an archived product, so existing invoice items can resolve it", async () => {
    const { getProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const archived = productRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") });
    prismaMock.product.findUnique.mockResolvedValue(archived);

    await expect(getProduct("biz-1", "prd-1")).resolves.toEqual(archived);
  });

  it("rejects a blank product id with ValidationError", async () => {
    const { getProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(getProduct("biz-1", "   ")).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.product.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createProduct
// ---------------------------------------------------------------------------

describe("createProduct", () => {
  it("creates a product under the verified business with a Decimal price", async () => {
    const { createProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const created = productRow({ id: "prd-new" });
    prismaMock.product.create.mockResolvedValue(created);

    const result = await createProduct("biz-1", {
      name: "  کالای تازه  ",
      price: "1500.55",
      unit: " عدد ",
      description: "   ",
    });

    expect(result).toEqual(created);
    expect(prismaMock.product.create).toHaveBeenCalledTimes(1);

    const call = prismaMock.product.create.mock.calls[0]?.[0];
    expect(call.data.businessId).toBe("biz-1");
    expect(call.data.name).toBe("کالای تازه");
    expect(call.data.unit).toBe("عدد");
    // Whitespace-only text is normalized to null, not stored as "".
    expect(call.data.description).toBeNull();
    expect(call.data.price).toBeInstanceOf(Decimal);
    expect(call.data.price.toString()).toBe("1500.55");
    // `active` is left to the schema default when the caller omits it.
    expect(call.data).not.toHaveProperty("active");
  });

  it.each([
    ["a negative number", -1],
    ["a negative decimal string", "-0.01"],
    ["a negative Decimal instance", new Decimal("-1000")],
  ])("rejects %s as a price", async (_label, price) => {
    const { createProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(createProduct("biz-1", { name: "کالا", price })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.product.create).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing price", { name: "کالا" }],
    ["a non-numeric price", { name: "کالا", price: "abc" }],
    ["a NaN price", { name: "کالا", price: Number.NaN }],
    ["an Infinity price", { name: "کالا", price: Number.POSITIVE_INFINITY }],
    ["a boolean price", { name: "کالا", price: true }],
    ["a null price", { name: "کالا", price: null }],
  ])("rejects %s with ValidationError (Decimal-safe validation)", async (_label, payload) => {
    const { createProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(createProduct("biz-1", payload)).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.product.create).not.toHaveBeenCalled();
  });

  it("accepts a zero price", async () => {
    const { createProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.create.mockResolvedValue(productRow({ price: new Decimal(0) }));

    await createProduct("biz-1", { name: "نمونه رایگان", price: 0 });

    const call = prismaMock.product.create.mock.calls[0]?.[0];
    expect(call.data.price.toString()).toBe("0");
  });

  it("rejects an empty name with ValidationError", async () => {
    const { createProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(createProduct("biz-1", { name: "  ", price: 10 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.product.create).not.toHaveBeenCalled();
  });

  it.each([
    ["businessId", { name: "نفوذی", price: 1, businessId: "biz-other" }],
    ["accountId", { name: "نفوذی", price: 1, accountId: "acc-evil" }],
    ["id", { name: "نفوذی", price: 1, id: "prd-forged" }],
    ["createdAt", { name: "نفوذی", price: 1, createdAt: new Date("2020-01-01T00:00:00.000Z") }],
    ["updatedAt", { name: "نفوذی", price: 1, updatedAt: new Date("2020-01-01T00:00:00.000Z") }],
    ["archivedAt", { name: "نفوذی", price: 1, archivedAt: null }],
  ])("rejects a payload smuggling the server-owned field %s", async (_field, payload) => {
    const { createProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(createProduct("biz-1", payload)).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.product.create).not.toHaveBeenCalled();
  });

  it("refuses to create a product in an archived business", async () => {
    const { createProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
    );

    await expect(createProduct("biz-1", { name: "کالا", price: 10 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.product.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateProduct
// ---------------------------------------------------------------------------

describe("updateProduct", () => {
  it("updates only the fields present in the payload, keyed by the verified row id", async () => {
    const { updateProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(productRow());
    const updated = productRow({ name: "نام جدید", price: new Decimal("2500.00") });
    prismaMock.product.update.mockResolvedValue(updated);

    await expect(
      updateProduct("biz-1", "prd-1", { name: "  نام جدید  ", price: "2500" }),
    ).resolves.toEqual(updated);

    const call = prismaMock.product.update.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: "prd-1" });
    expect(call.data.name).toBe("نام جدید");
    expect(call.data.price).toBeInstanceOf(Decimal);
    expect(call.data.price.toString()).toBe("2500");
    // Untouched columns are not written at all.
    expect(call.data).not.toHaveProperty("unit");
    expect(call.data).not.toHaveProperty("description");
    expect(call.data).not.toHaveProperty("active");
  });

  it("rejects an empty update payload", async () => {
    const { updateProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(productRow());

    await expect(updateProduct("biz-1", "prd-1", {})).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("rejects a negative price on update", async () => {
    const { updateProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(productRow());

    await expect(updateProduct("biz-1", "prd-1", { price: -5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it.each([
    ["businessId", { price: 1, businessId: "biz-other" }],
    ["accountId", { price: 1, accountId: "acc-evil" }],
    ["id", { price: 1, id: "prd-forged" }],
    ["archivedAt", { price: 1, archivedAt: null }],
    ["updatedAt", { price: 1, updatedAt: new Date("2020-01-01T00:00:00.000Z") }],
  ])("rejects an update smuggling the server-owned field %s", async (_field, payload) => {
    const { updateProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(productRow());

    await expect(updateProduct("biz-1", "prd-1", payload)).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("refuses to update a product that belongs to another business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { updateProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.product.findUnique.mockResolvedValue(productRow({ businessId: "biz-2" }));

    await expect(updateProduct("biz-1", "prd-1", { price: 1 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("refuses to update a product inside an archived business", async () => {
    const { updateProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
    );

    await expect(updateProduct("biz-1", "prd-1", { price: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("refuses to update an archived product", async () => {
    const { updateProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(
      productRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
    );

    await expect(updateProduct("biz-1", "prd-1", { price: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("never rewrites the historical values of a finalized invoice when a product is repriced", async () => {
    const { updateProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(productRow({ price: new Decimal("1000.00") }));
    prismaMock.product.update.mockResolvedValue(productRow({ price: new Decimal("9999.00") }));

    await updateProduct("biz-1", "prd-1", { name: "نام جدید", price: "9999" });

    // InvoiceItem already stores its own title/unitPrice/quantity/unit, so the
    // catalogue edit must not reach invoice items or invoice totals.
    expect(prismaMock.invoiceItem.update).not.toHaveBeenCalled();
    expect(prismaMock.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.invoiceItem.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceItem.delete).not.toHaveBeenCalled();
    expect(prismaMock.invoiceItem.findMany).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    expect(prismaMock.invoice.updateMany).not.toHaveBeenCalled();

    // Exactly one write, and it targets the products table only.
    expect(prismaMock.product.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// archiveProduct
// ---------------------------------------------------------------------------

describe("archiveProduct", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("soft-deletes by stamping archivedAt and never hard-deletes", async () => {
    const { archiveProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(productRow());
    const archived = productRow({ archivedAt: NOW });
    prismaMock.product.update.mockResolvedValue(archived);

    await expect(archiveProduct("biz-1", "prd-1")).resolves.toEqual(archived);

    expect(prismaMock.product.update).toHaveBeenCalledWith({
      where: { id: "prd-1" },
      data: { archivedAt: NOW },
    });
    expect(prismaMock.product.delete).not.toHaveBeenCalled();
    expect(prismaMock.product.deleteMany).not.toHaveBeenCalled();
    // Archiving is not allowed to touch invoice history either.
    expect(prismaMock.invoiceItem.update).not.toHaveBeenCalled();
    expect(prismaMock.invoiceItem.updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent: archiving an already archived product does not move the timestamp", async () => {
    const { archiveProduct } = await import("./productService");

    const already = productRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") });
    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.product.findUnique.mockResolvedValue(already);

    await expect(archiveProduct("biz-1", "prd-1")).resolves.toEqual(already);
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("refuses to archive a product that belongs to another business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { archiveProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1" }));
    prismaMock.product.findUnique.mockResolvedValue(productRow({ businessId: "biz-2" }));

    await expect(archiveProduct("biz-1", "prd-1")).rejects.toBeInstanceOf(ForbiddenError);
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("refuses to archive inside an archived business", async () => {
    const { archiveProduct } = await import("./productService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ archivedAt: new Date("2026-03-01T00:00:00.000Z") }),
    );

    await expect(archiveProduct("biz-1", "prd-1")).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });
});
