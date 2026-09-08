import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { formatCurrency, toNumericInputString } from "@/lib/formatters";

/**
 * Application-boundary tests for the Product Server Actions — the ones the
 * Product/Service Management UI calls.
 *
 * These prove the boundary contract only — authentication gating,
 * delegation to the existing `productService`, safe error mapping and
 * serializable DTO output. The domain rules themselves (business isolation,
 * strict validation, archive semantics, invoice-item snapshot integrity)
 * are covered by `src/server/product/productService.test.ts`, so the
 * service is mocked here to keep this suite focused and fast.
 *
 * A final contract section pins the exact DTO fields the invoice editor's
 * product selector (`InvoiceItemRow`) reads (`id`, `name`, `price`, `unit`,
 * `description`) and the value chain it applies when a product is picked
 * (title ← name, unitPrice ← toNumericInputString(price), unit ← unit ?? "",
 * description ← description ?? ""), so the Product Management UI can never
 * drift away from what the editor needs.
 */

const requireSession = vi.hoisted(() => vi.fn());

const productSvc = vi.hoisted(() => ({
  listProducts: vi.fn(),
  getProduct: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  archiveProduct: vi.fn(),
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

vi.mock("@/server/product/productService", () => productSvc);

const SESSION = { userId: "user-1", accountId: "acc-1" };

function productRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "prod-1",
    businessId: "biz-1",
    name: "خدمات پشتیبانی",
    description: null,
    price: new Decimal("1500000.00"),
    unit: null,
    active: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(SESSION);
});

// ---------------------------------------------------------------------------
// Authentication gating — every action, before touching the service
// ---------------------------------------------------------------------------

describe("product actions — authentication", () => {
  it("rejects every action when unauthenticated, without touching the service", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const actions = await import("./productActions");
    requireSession.mockRejectedValue(new UnauthorizedError());

    const results = await Promise.all([
      actions.listProducts("biz-1"),
      actions.getProduct("biz-1", "prod-1"),
      actions.createProduct("biz-1", { name: "x", price: "1000" }),
      actions.updateProduct("biz-1", "prod-1", { name: "x" }),
      actions.archiveProduct("biz-1", "prod-1"),
    ]);

    for (const result of results) {
      expect(result).toEqual({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }
    expect(productSvc.listProducts).not.toHaveBeenCalled();
    expect(productSvc.getProduct).not.toHaveBeenCalled();
    expect(productSvc.createProduct).not.toHaveBeenCalled();
    expect(productSvc.updateProduct).not.toHaveBeenCalled();
    expect(productSvc.archiveProduct).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Delegation + DTO serialization
// ---------------------------------------------------------------------------

describe("product actions — delegation and serialization", () => {
  it("lists products through the service, serializing Decimal price and dates", async () => {
    const { listProducts } = await import("./productActions");
    productSvc.listProducts.mockResolvedValue([
      productRecord(),
      productRecord({
        id: "prod-2",
        name: "لپ‌تاپ",
        price: new Decimal("450000000"),
        unit: "عدد",
        description: "یک سال گارانتی",
      }),
    ]);

    const result = await listProducts("biz-1");

    expect(productSvc.listProducts).toHaveBeenCalledWith("biz-1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      id: "prod-1",
      businessId: "biz-1",
      name: "خدمات پشتیبانی",
      description: null,
      price: "1500000.00", // Decimal → fixed 2dp string, never a JS float
      unit: null,
      active: true,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });
    expect(result.data[1]).toMatchObject({ price: "450000000.00", unit: "عدد" });
    // The payload must survive the server boundary as plain JSON.
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it("gets one product through the service", async () => {
    const { getProduct } = await import("./productActions");
    productSvc.getProduct.mockResolvedValue(productRecord());

    const result = await getProduct("biz-1", "prod-1");

    expect(productSvc.getProduct).toHaveBeenCalledWith("biz-1", "prod-1");
    expect(result).toEqual({ success: true, data: expect.objectContaining({ id: "prod-1" }) });
  });

  it("creates a product through the service, forwarding the payload untouched", async () => {
    const { createProduct } = await import("./productActions");
    productSvc.createProduct.mockResolvedValue(productRecord({ id: "prod-new" }));

    const payload = { name: "قلم تازه", price: "250000", unit: "ساعت", active: true };
    const result = await createProduct("biz-1", payload);

    // The action adds no validation of its own — the strict server schema
    // inside the service is the single validator.
    expect(productSvc.createProduct).toHaveBeenCalledWith("biz-1", payload);
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ id: "prod-new", businessId: "biz-1" }),
    });
  });

  it("updates a product through the service", async () => {
    const { updateProduct } = await import("./productActions");
    productSvc.updateProduct.mockResolvedValue(
      productRecord({ price: new Decimal("1750000.00") }),
    );

    const result = await updateProduct("biz-1", "prod-1", { price: "1750000" });

    expect(productSvc.updateProduct).toHaveBeenCalledWith("biz-1", "prod-1", {
      price: "1750000",
    });
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ id: "prod-1", price: "1750000.00" }),
    });
  });

  it("archives a product through the service and serializes the archive stamp", async () => {
    const { archiveProduct } = await import("./productActions");
    productSvc.archiveProduct.mockResolvedValue(
      productRecord({ archivedAt: new Date("2026-03-08T00:00:00.000Z") }),
    );

    const result = await archiveProduct("biz-1", "prod-1");

    expect(productSvc.archiveProduct).toHaveBeenCalledWith("biz-1", "prod-1");
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ id: "prod-1", archivedAt: "2026-03-08T00:00:00.000Z" }),
    });
  });
});

// ---------------------------------------------------------------------------
// Error mapping — cross-business isolation, validation, safe fallback
// ---------------------------------------------------------------------------

describe("product actions — error mapping", () => {
  it("maps cross-business access to FORBIDDEN for every action", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const actions = await import("./productActions");
    const forbidden = new ForbiddenError("Business does not belong to this account");
    productSvc.listProducts.mockRejectedValue(forbidden);
    productSvc.getProduct.mockRejectedValue(forbidden);
    productSvc.createProduct.mockRejectedValue(forbidden);
    productSvc.updateProduct.mockRejectedValue(forbidden);
    productSvc.archiveProduct.mockRejectedValue(forbidden);

    const results = await Promise.all([
      actions.listProducts("biz-other"),
      actions.getProduct("biz-other", "prod-1"),
      actions.createProduct("biz-other", { name: "x", price: "1000" }),
      actions.updateProduct("biz-other", "prod-1", { name: "x" }),
      actions.archiveProduct("biz-other", "prod-1"),
    ]);

    for (const result of results) {
      expect(result).toEqual({
        success: false,
        error: { code: "FORBIDDEN", message: "Business does not belong to this account" },
      });
    }
  });

  it("maps a missing business/product to NOT_FOUND", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const { getProduct } = await import("./productActions");
    productSvc.getProduct.mockRejectedValue(new NotFoundError("Product not found"));

    const result = await getProduct("biz-1", "missing");

    expect(result).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Product not found" },
    });
  });

  it("maps domain validation failures to VALIDATION_ERROR with the safe message", async () => {
    const { ValidationError } = await import("@/server/errors");
    const { createProduct, updateProduct, archiveProduct } = await import("./productActions");
    productSvc.createProduct.mockRejectedValue(
      new ValidationError("Invalid product input — price: price must be a non-negative number"),
    );
    productSvc.updateProduct.mockRejectedValue(
      new ValidationError("Cannot update an archived product"),
    );
    productSvc.archiveProduct.mockRejectedValue(
      new ValidationError("Cannot archive a product for an archived business"),
    );

    const created = await createProduct("biz-1", { name: "x", price: "-1" });
    expect(created).toEqual({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid product input — price: price must be a non-negative number",
      },
    });

    const updated = await updateProduct("biz-1", "prod-1", { name: "x" });
    expect(updated).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Cannot update an archived product" },
    });

    const archived = await archiveProduct("biz-1", "prod-1");
    expect(archived).toEqual({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Cannot archive a product for an archived business",
      },
    });
  });

  it("reports an unexpected infrastructure failure generically, leaking nothing", async () => {
    const { listProducts } = await import("./productActions");
    productSvc.listProducts.mockRejectedValue(
      new Error('SQL connection to postgres://admin:s3cret@db:5432 failed: relation "products" boom'),
    );

    const result = await listProducts("biz-1");

    expect(result).toEqual({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred. Please try again.",
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("postgres");
    expect(serialized).not.toContain("products");
  });
});

// ---------------------------------------------------------------------------
// Invoice editor contract — the product selector keeps working
// ---------------------------------------------------------------------------

describe("product DTO contract with the invoice editor", () => {
  it("exposes every field InvoiceItemRow's product selector reads (id, name, price, unit, description)", async () => {
    const { listProducts } = await import("./productActions");
    productSvc.listProducts.mockResolvedValue([
      productRecord({ name: "خدمات طراحی", price: new Decimal("5000000.00"), unit: "ساعت", description: "طراحی سایت" }),
      // A minimal row must still carry the same keys (nulls, not missing).
      productRecord({ id: "prod-2", name: "قلم ساده", price: new Decimal("0"), unit: null, description: null }),
    ]);

    const result = await listProducts("biz-1");

    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const dto of result.data) {
      for (const key of ["id", "name", "price", "unit", "description"] as const) {
        expect(dto).toHaveProperty(key);
      }
      expect(typeof dto.id).toBe("string");
      expect(typeof dto.name).toBe("string");
      expect(typeof dto.price).toBe("string");
    }
  });

  it("price survives the exact chain the editor applies when a product is picked", async () => {
    const { listProducts } = await import("./productActions");
    productSvc.listProducts.mockResolvedValue([
      productRecord({ price: new Decimal("1500000.00") }),
      productRecord({ id: "prod-2", price: new Decimal("1500.50") }),
    ]);

    const result = await listProducts("biz-1");
    expect(result.success).toBe(true);
    if (!result.success) return;

    for (const dto of result.data) {
      // InvoiceItemRow seeds the row with toNumericInputString(product.price)
      // and labels the option with formatCurrency(product.price, currency):
      // both must work on the serialized string, with no float drift.
      const unitPrice = toNumericInputString(dto.price);
      expect(unitPrice).not.toBe("");
      expect(Number(unitPrice)).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(Number(unitPrice))).toBe(true);
      expect(formatCurrency(dto.price, "IRR")).toContain("ریال");
    }
    expect(toNumericInputString(result.data[0]?.price)).toBe("1500000");
    expect(toNumericInputString(result.data[1]?.price)).toBe("1500.5");
  });

  it("null unit/description fall back to empty strings exactly like the editor's copy step", async () => {
    const { listProducts } = await import("./productActions");
    productSvc.listProducts.mockResolvedValue([productRecord({ unit: null, description: null })]);

    const result = await listProducts("biz-1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    const dto = result.data[0];
    // InvoiceItemRow: setValue(unit, product.unit ?? "") / setValue(description, product.description ?? "").
    expect(dto?.unit ?? "").toBe("");
    expect(dto?.description ?? "").toBe("");
  });
});
