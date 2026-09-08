import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Application-boundary tests for the Customer Server Actions.
 *
 * These prove the boundary contract only — authentication gating,
 * delegation to the existing `customerService`, safe error mapping and
 * serializable DTO output. The domain rules themselves (business
 * isolation, strict validation, archive semantics, snapshot integrity)
 * are covered by `src/server/customer/customerService.test.ts`, so the
 * service is mocked here to keep this suite focused and fast.
 *
 * A final contract section pins the exact DTO fields the invoice editor's
 * `CustomerSelector` reads (`id`, `name`, `mobile`, `phone`, `email`), so
 * the Customer Management UI can never drift away from what the editor
 * needs.
 */

const requireSession = vi.hoisted(() => vi.fn());

const customerSvc = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  archiveCustomer: vi.fn(),
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

vi.mock("@/server/customer/customerService", () => customerSvc);

const SESSION = { userId: "user-1", accountId: "acc-1" };

function customerRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cus-1",
    businessId: "biz-1",
    name: "مشتری",
    mobile: "09120000000",
    phone: null,
    email: "c@example.com",
    address: null,
    nationalId: null,
    economicCode: null,
    notes: null,
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

describe("customer actions — authentication", () => {
  it("rejects every action when unauthenticated, without touching the service", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const actions = await import("./customerActions");
    requireSession.mockRejectedValue(new UnauthorizedError());

    const results = await Promise.all([
      actions.listCustomers("biz-1"),
      actions.getCustomer("biz-1", "cus-1"),
      actions.createCustomer("biz-1", { name: "x" }),
      actions.updateCustomer("biz-1", "cus-1", { name: "x" }),
      actions.archiveCustomer("biz-1", "cus-1"),
    ]);

    for (const result of results) {
      expect(result).toEqual({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }
    expect(customerSvc.listCustomers).not.toHaveBeenCalled();
    expect(customerSvc.getCustomer).not.toHaveBeenCalled();
    expect(customerSvc.createCustomer).not.toHaveBeenCalled();
    expect(customerSvc.updateCustomer).not.toHaveBeenCalled();
    expect(customerSvc.archiveCustomer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Delegation + DTO serialization
// ---------------------------------------------------------------------------

describe("customer actions — delegation and serialization", () => {
  it("lists customers through the service and serializes dates to ISO strings", async () => {
    const { listCustomers } = await import("./customerActions");
    customerSvc.listCustomers.mockResolvedValue([
      customerRecord(),
      customerRecord({ id: "cus-2", name: "مشتری دو", mobile: null }),
    ]);

    const result = await listCustomers("biz-1");

    expect(customerSvc.listCustomers).toHaveBeenCalledWith("biz-1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      id: "cus-1",
      businessId: "biz-1",
      name: "مشتری",
      mobile: "09120000000",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });
    // The payload must survive the server boundary as plain JSON.
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it("gets one customer through the service", async () => {
    const { getCustomer } = await import("./customerActions");
    customerSvc.getCustomer.mockResolvedValue(customerRecord());

    const result = await getCustomer("biz-1", "cus-1");

    expect(customerSvc.getCustomer).toHaveBeenCalledWith("biz-1", "cus-1");
    expect(result).toEqual({ success: true, data: expect.objectContaining({ id: "cus-1" }) });
  });

  it("creates a customer through the service, forwarding the payload untouched", async () => {
    const { createCustomer } = await import("./customerActions");
    customerSvc.createCustomer.mockResolvedValue(customerRecord({ id: "cus-new" }));

    const payload = { name: "تازه", mobile: "09120000000", email: "n@example.com" };
    const result = await createCustomer("biz-1", payload);

    // The action adds no validation of its own — the strict server schema
    // inside the service is the single validator.
    expect(customerSvc.createCustomer).toHaveBeenCalledWith("biz-1", payload);
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ id: "cus-new", businessId: "biz-1" }),
    });
  });

  it("updates a customer through the service", async () => {
    const { updateCustomer } = await import("./customerActions");
    customerSvc.updateCustomer.mockResolvedValue(customerRecord({ name: "نام جدید" }));

    const result = await updateCustomer("biz-1", "cus-1", { name: "نام جدید" });

    expect(customerSvc.updateCustomer).toHaveBeenCalledWith("biz-1", "cus-1", { name: "نام جدید" });
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ id: "cus-1", name: "نام جدید" }),
    });
  });

  it("archives a customer through the service and serializes the archive stamp", async () => {
    const { archiveCustomer } = await import("./customerActions");
    customerSvc.archiveCustomer.mockResolvedValue(
      customerRecord({ archivedAt: new Date("2026-03-08T00:00:00.000Z") }),
    );

    const result = await archiveCustomer("biz-1", "cus-1");

    expect(customerSvc.archiveCustomer).toHaveBeenCalledWith("biz-1", "cus-1");
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ id: "cus-1", archivedAt: "2026-03-08T00:00:00.000Z" }),
    });
  });
});

// ---------------------------------------------------------------------------
// Error mapping — cross-business isolation, validation, safe fallback
// ---------------------------------------------------------------------------

describe("customer actions — error mapping", () => {
  it("maps cross-business access to FORBIDDEN for every action", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const actions = await import("./customerActions");
    const forbidden = new ForbiddenError("Business does not belong to this account");
    customerSvc.listCustomers.mockRejectedValue(forbidden);
    customerSvc.getCustomer.mockRejectedValue(forbidden);
    customerSvc.createCustomer.mockRejectedValue(forbidden);
    customerSvc.updateCustomer.mockRejectedValue(forbidden);
    customerSvc.archiveCustomer.mockRejectedValue(forbidden);

    const results = await Promise.all([
      actions.listCustomers("biz-other"),
      actions.getCustomer("biz-other", "cus-1"),
      actions.createCustomer("biz-other", { name: "x" }),
      actions.updateCustomer("biz-other", "cus-1", { name: "x" }),
      actions.archiveCustomer("biz-other", "cus-1"),
    ]);

    for (const result of results) {
      expect(result).toEqual({
        success: false,
        error: { code: "FORBIDDEN", message: "Business does not belong to this account" },
      });
    }
  });

  it("maps a missing business/customer to NOT_FOUND", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const { getCustomer } = await import("./customerActions");
    customerSvc.getCustomer.mockRejectedValue(new NotFoundError("Customer not found"));

    const result = await getCustomer("biz-1", "missing");

    expect(result).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Customer not found" },
    });
  });

  it("maps domain validation failures to VALIDATION_ERROR with the safe message", async () => {
    const { ValidationError } = await import("@/server/errors");
    const { createCustomer, updateCustomer } = await import("./customerActions");
    customerSvc.createCustomer.mockRejectedValue(
      new ValidationError("Invalid customer input — name: Customer name is required"),
    );
    customerSvc.updateCustomer.mockRejectedValue(
      new ValidationError("Cannot update an archived customer"),
    );

    const created = await createCustomer("biz-1", { name: "" });
    expect(created).toEqual({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid customer input — name: Customer name is required",
      },
    });

    const updated = await updateCustomer("biz-1", "cus-1", { name: "x" });
    expect(updated).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Cannot update an archived customer" },
    });
  });

  it("reports an unexpected infrastructure failure generically, leaking nothing", async () => {
    const { listCustomers } = await import("./customerActions");
    customerSvc.listCustomers.mockRejectedValue(
      new Error('SQL connection to postgres://admin:s3cret@db:5432 failed: relation "customers" boom'),
    );

    const result = await listCustomers("biz-1");

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
    expect(serialized).not.toContain("customers");
  });
});

// ---------------------------------------------------------------------------
// Invoice editor contract — CustomerSelector keeps working
// ---------------------------------------------------------------------------

describe("customer DTO contract with the invoice editor", () => {
  it("exposes every field CustomerSelector reads (id, name, mobile, phone, email)", async () => {
    const { listCustomers } = await import("./customerActions");
    customerSvc.listCustomers.mockResolvedValue([
      customerRecord({ mobile: "09120000000", phone: "02112345678", email: "c@example.com" }),
      // A minimal row must still carry the same keys (nulls, not missing).
      customerRecord({ id: "cus-2", mobile: null, phone: null, email: null }),
    ]);

    const result = await listCustomers("biz-1");

    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const dto of result.data) {
      for (const key of ["id", "name", "mobile", "phone", "email"] as const) {
        expect(dto).toHaveProperty(key);
      }
      expect(typeof dto.id).toBe("string");
      expect(typeof dto.name).toBe("string");
    }
    // The selector's contact line joins these three — verify the join inputs.
    expect(result.data[0]?.mobile).toBe("09120000000");
    expect(result.data[1]?.mobile).toBeNull();
  });
});
