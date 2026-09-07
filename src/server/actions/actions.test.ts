import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";

/**
 * Application-boundary tests for the Server Action layer.
 *
 * These prove the boundary contract only — authentication gating, delegation to
 * the existing domain services, safe error mapping and serializable DTO output.
 * The domain rules themselves (ownership, entitlement limits, Decimal math,
 * archive semantics) are covered by the existing service unit tests, so the
 * services are mocked here to keep this suite focused and fast.
 */

const requireSession = vi.hoisted(() => vi.fn());

const businessSvc = vi.hoisted(() => ({
  listBusinesses: vi.fn(),
  getBusiness: vi.fn(),
  createBusiness: vi.fn(),
  updateBusiness: vi.fn(),
  archiveBusiness: vi.fn(),
  setPrimaryBusiness: vi.fn(),
}));

const customerSvc = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  archiveCustomer: vi.fn(),
}));

const productSvc = vi.hoisted(() => ({
  listProducts: vi.fn(),
  getProduct: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  archiveProduct: vi.fn(),
}));

const invoiceSvc = vi.hoisted(() => ({
  listInvoices: vi.fn(),
  getInvoice: vi.fn(),
  createDraftInvoice: vi.fn(),
  updateDraftInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
}));

const paymentSvc = vi.hoisted(() => ({
  listInvoicePayments: vi.fn(),
  createInvoicePayment: vi.fn(),
  updateInvoicePayment: vi.fn(),
  deleteInvoicePayment: vi.fn(),
}));

const dashboardSvc = vi.hoisted(() => ({
  getDashboardData: vi.fn(),
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

vi.mock("@/server/business/businessService", () => businessSvc);
vi.mock("@/server/customer/customerService", () => customerSvc);
vi.mock("@/server/product/productService", () => productSvc);
vi.mock("@/server/invoice/invoiceService", () => invoiceSvc);
vi.mock("@/server/payment/paymentService", () => paymentSvc);
vi.mock("@/server/dashboard/dashboardService", () => dashboardSvc);

const SESSION = { userId: "user-1", accountId: "acc-1" };

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(SESSION);
});

// ---------------------------------------------------------------------------
// Fixtures (service-returned records -> DTO serialization)
// ---------------------------------------------------------------------------

function businessRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "biz-1",
    accountId: "acc-1",
    name: "کسب‌وکار من",
    isActive: true,
    isLocked: false,
    isPrimary: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-02T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function customerRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cus-1",
    businessId: "biz-1",
    name: "مشتری",
    mobile: null,
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

function productRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "prod-1",
    businessId: "biz-1",
    name: "محصول",
    description: null,
    price: new Decimal("100000.00"),
    unit: null,
    active: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function invoiceRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inv-1",
    businessId: "biz-1",
    customerId: "cus-1",
    invoiceNumber: "DRAFT-abc",
    invoiceType: "FINAL",
    issueDate: new Date("2026-03-05T00:00:00.000Z"),
    dueDate: null,
    status: "DRAFT",
    subtotal: new Decimal("100000.00"),
    itemDiscountAmount: new Decimal("0.00"),
    globalDiscountPercent: new Decimal("0.00"),
    globalDiscountAmount: new Decimal("0.00"),
    taxPercent: new Decimal("9.00"),
    taxAmount: new Decimal("9000.00"),
    taxableAmount: new Decimal("100000.00"),
    total: new Decimal("109000.00"),
    paidAmount: new Decimal("0.00"),
    remainingAmount: new Decimal("109000.00"),
    notes: null,
    createdAt: new Date("2026-03-05T00:00:00.000Z"),
    updatedAt: new Date("2026-03-05T00:00:00.000Z"),
    finalizedAt: null,
    cancelledAt: null,
    items: [
      {
        id: "item-1",
        invoiceId: "inv-1",
        productId: null,
        title: "خدمت",
        description: null,
        itemDate: null,
        unitPrice: new Decimal("100000.00"),
        quantity: new Decimal("1.000"),
        unit: null,
        discountPercent: new Decimal("0.00"),
        discountAmount: new Decimal("0.00"),
        subtotal: new Decimal("100000.00"),
        total: new Decimal("100000.00"),
        sortOrder: 0,
      },
    ],
    ...overrides,
  };
}

function paymentRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pay-1",
    invoiceId: "inv-1",
    amount: new Decimal("50000.00"),
    paymentDate: new Date("2026-03-06T00:00:00.000Z"),
    method: "CASH",
    referenceNumber: null,
    notes: null,
    createdAt: new Date("2026-03-06T00:00:00.000Z"),
    ...overrides,
  };
}

// ===========================================================================
// AUTHENTICATION
// ===========================================================================

describe("authentication", () => {
  it("rejects an unauthenticated action before touching the service", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { listBusinesses } = await import("./businessActions");
    requireSession.mockRejectedValue(new UnauthorizedError());

    const result = await listBusinesses();

    expect(result).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    expect(businessSvc.listBusinesses).not.toHaveBeenCalled();
  });

  it("exposes a generic error for an unexpected infrastructure failure (no leakage)", async () => {
    const { listBusinesses } = await import("./businessActions");
    businessSvc.listBusinesses.mockRejectedValue(new Error("SQL syntax error at invoices"));

    const result = await listBusinesses();

    expect(result).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred. Please try again." },
    });
  });
});

// ===========================================================================
// BUSINESS
// ===========================================================================

describe("business actions", () => {
  it("lists only the authenticated account's businesses and serializes them", async () => {
    const { listBusinesses } = await import("./businessActions");
    const rows = [
      businessRecord(),
      businessRecord({ id: "biz-2", isPrimary: false, name: "شعبه دو" }),
    ];
    businessSvc.listBusinesses.mockResolvedValue(rows);

    const result = await listBusinesses();

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
    const first = result.data[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first).toMatchObject({ id: "biz-1", name: "کسب‌وکار من", isPrimary: true });
    // dates serialized to ISO strings, accountId stripped
    expect(first.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(first).not.toHaveProperty("accountId");
  });

  it("creates a business through the service and returns a DTO", async () => {
    const { createBusiness } = await import("./businessActions");
    businessSvc.createBusiness.mockResolvedValue(businessRecord());

    const result = await createBusiness({ name: "کسب‌وکار" });

    expect(businessSvc.createBusiness).toHaveBeenCalledWith({ name: "کسب‌وکار" });
    expect(result).toEqual({ success: true, data: expect.objectContaining({ id: "biz-1" }) });
  });

  it("maps a business-limit (entitlement) rejection safely", async () => {
    const { BusinessLimitReachedError } = await import("@/server/errors");
    const { createBusiness } = await import("./businessActions");
    businessSvc.createBusiness.mockRejectedValue(
      new BusinessLimitReachedError("Business limit reached: the FREE plan allows 1 active business(es)."),
    );

    const result = await createBusiness({ name: "دوم" });

    expect(result).toEqual({
      success: false,
      error: {
        code: "BUSINESS_LIMIT_REACHED",
        message: "Business limit reached: the FREE plan allows 1 active business(es).",
      },
    });
  });

  it("maps cross-account business access to FORBIDDEN", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { getBusiness } = await import("./businessActions");
    businessSvc.getBusiness.mockRejectedValue(new ForbiddenError("Business does not belong to this account"));

    const result = await getBusiness("biz-other");

    expect(businessSvc.getBusiness).toHaveBeenCalledWith("biz-other");
    expect(result).toEqual({ success: false, error: { code: "FORBIDDEN", message: "Business does not belong to this account" } });
  });

  it("forwards update and archive to the service", async () => {
    const { updateBusiness, archiveBusiness } = await import("./businessActions");
    businessSvc.updateBusiness.mockResolvedValue(businessRecord({ name: "جدید" }));
    const archived = businessRecord({ archivedAt: new Date("2026-03-08T00:00:00.000Z") });
    businessSvc.archiveBusiness.mockResolvedValue(archived);

    const updated = await updateBusiness("biz-1", { name: "جدید" });
    expect(businessSvc.updateBusiness).toHaveBeenCalledWith("biz-1", { name: "جدید" });
    expect(updated).toEqual({ success: true, data: expect.objectContaining({ name: "جدید" }) });

    const archResult = await archiveBusiness("biz-1");
    expect(businessSvc.archiveBusiness).toHaveBeenCalledWith("biz-1");
    expect(archResult).toEqual({
      success: true,
      data: expect.objectContaining({ archivedAt: "2026-03-08T00:00:00.000Z" }),
    });
  });

  it("sets primary business and serializes the updated DTO", async () => {
    const { setPrimaryBusiness } = await import("./businessActions");
    businessSvc.setPrimaryBusiness.mockResolvedValue(businessRecord({ id: "biz-2", isPrimary: true }));

    const result = await setPrimaryBusiness("biz-2");

    expect(businessSvc.setPrimaryBusiness).toHaveBeenCalledWith("biz-2");
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ id: "biz-2", isPrimary: true }),
    });
  });
});

// ===========================================================================
// CUSTOMER
// ===========================================================================

describe("customer actions", () => {
  it("maps cross-business access to FORBIDDEN", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { listCustomers } = await import("./customerActions");
    customerSvc.listCustomers.mockRejectedValue(new ForbiddenError("Business does not belong to this account"));

    const result = await listCustomers("biz-other");

    expect(customerSvc.listCustomers).toHaveBeenCalledWith("biz-other");
    expect(result).toEqual({ success: false, error: { code: "FORBIDDEN", message: "Business does not belong to this account" } });
  });

  it("create / update / archive work through the action", async () => {
    const { createCustomer, updateCustomer, archiveCustomer, getCustomer } = await import("./customerActions");
    customerSvc.createCustomer.mockResolvedValue(customerRecord());
    customerSvc.updateCustomer.mockResolvedValue(customerRecord({ name: "مشتری جدید" }));
    customerSvc.archiveCustomer.mockResolvedValue(customerRecord({ archivedAt: new Date("2026-03-08T00:00:00.000Z") }));
    customerSvc.getCustomer.mockResolvedValue(customerRecord());

    const created = await createCustomer("biz-1", { name: "مشتری" });
    expect(customerSvc.createCustomer).toHaveBeenCalledWith("biz-1", { name: "مشتری" });
    expect(created).toEqual({ success: true, data: expect.objectContaining({ id: "cus-1" }) });

    const updated = await updateCustomer("biz-1", "cus-1", { name: "مشتری جدید" });
    expect(customerSvc.updateCustomer).toHaveBeenCalledWith("biz-1", "cus-1", { name: "مشتری جدید" });
    expect(updated).toEqual({ success: true, data: expect.objectContaining({ name: "مشتری جدید" }) });

    const archived = await archiveCustomer("biz-1", "cus-1");
    expect(customerSvc.archiveCustomer).toHaveBeenCalledWith("biz-1", "cus-1");
    expect(archived).toEqual({ success: true, data: expect.objectContaining({ archivedAt: expect.any(String) }) });

    const got = await getCustomer("biz-1", "cus-1");
    expect(got).toEqual({ success: true, data: expect.objectContaining({ id: "cus-1" }) });
  });
});

// ===========================================================================
// PRODUCT
// ===========================================================================

describe("product actions", () => {
  it("maps cross-business access to FORBIDDEN", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { listProducts } = await import("./productActions");
    productSvc.listProducts.mockRejectedValue(new ForbiddenError("Business does not belong to this account"));

    const result = await listProducts("biz-other");

    expect(result).toEqual({ success: false, error: { code: "FORBIDDEN", message: "Business does not belong to this account" } });
  });

  it("create / update / archive work through the action and serialize Decimal price", async () => {
    const { createProduct, updateProduct, archiveProduct } = await import("./productActions");
    productSvc.createProduct.mockResolvedValue(productRecord());
    productSvc.updateProduct.mockResolvedValue(productRecord({ price: new Decimal("999.99") }));
    productSvc.archiveProduct.mockResolvedValue(productRecord({ archivedAt: new Date("2026-03-08T00:00:00.000Z") }));

    const created = await createProduct("biz-1", { name: "محصول", price: "100000" });
    expect(productSvc.createProduct).toHaveBeenCalledWith("biz-1", { name: "محصول", price: "100000" });
    if (!created.success) return;
    expect(created.data.price).toBe("100000.00");

    const updated = await updateProduct("biz-1", "prod-1", { price: "999.99" });
    expect(productSvc.updateProduct).toHaveBeenCalledWith("biz-1", "prod-1", { price: "999.99" });
    if (!updated.success) return;
    expect(updated.data.price).toBe("999.99");

    const archived = await archiveProduct("biz-1", "prod-1");
    expect(productSvc.archiveProduct).toHaveBeenCalledWith("biz-1", "prod-1");
    if (!archived.success) return;
    expect(archived.data.archivedAt).toBe("2026-03-08T00:00:00.000Z");
  });
});

// ===========================================================================
// INVOICE
// ===========================================================================

describe("invoice actions", () => {
  it("creates a draft invoice and returns a serializable detail DTO", async () => {
    const { createDraftInvoice } = await import("./invoiceActions");
    invoiceSvc.createDraftInvoice.mockResolvedValue(invoiceRecord());

    const result = await createDraftInvoice("biz-1", {
      items: [{ title: "خدمت", unitPrice: 100000, quantity: 1 }],
    });

    expect(invoiceSvc.createDraftInvoice).toHaveBeenCalledWith(
      "biz-1",
      { items: [{ title: "خدمت", unitPrice: 100000, quantity: 1 }] },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe("inv-1");
    expect(result.data.total).toBe("109000.00");
    expect(result.data.issueDate).toBe("2026-03-05T00:00:00.000Z");
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]?.unitPrice).toBe("100000.00");
    expect(result.data).not.toHaveProperty("createdAt", expect.any(Date));
  });

  it("updates a draft invoice, forwarding (businessId, invoiceId, input) and returning a detail DTO", async () => {
    const { updateDraftInvoice } = await import("./invoiceActions");
    invoiceSvc.updateDraftInvoice.mockResolvedValue(invoiceRecord());

    const payload = {
      invoiceType: "PROFORMA",
      items: [{ title: "خدمت ویرایش‌شده", unitPrice: 50000, quantity: 2 }],
    };
    const result = await updateDraftInvoice("biz-1", "inv-1", payload);

    expect(invoiceSvc.updateDraftInvoice).toHaveBeenCalledWith("biz-1", "inv-1", payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe("inv-1");
    expect(result.data.total).toBe("109000.00");
    expect(result.data.items).toHaveLength(1);
  });

  it("maps a draft-update lifecycle rejection to VALIDATION_ERROR", async () => {
    const { ValidationError } = await import("@/server/errors");
    const { updateDraftInvoice } = await import("./invoiceActions");
    invoiceSvc.updateDraftInvoice.mockRejectedValue(
      new ValidationError("Only draft invoices can be edited; this invoice is already finalized"),
    );

    const result = await updateDraftInvoice("biz-1", "inv-1", {
      items: [{ title: "x", unitPrice: 1, quantity: 1 }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("finalizes an invoice and returns a fully serializable result (no Decimal/Date objects)", async () => {
    const { finalizeInvoice } = await import("./invoiceActions");
    invoiceSvc.finalizeInvoice.mockResolvedValue(
      invoiceRecord({
        invoiceNumber: "101",
        status: "PENDING_PAYMENT",
        finalizedAt: new Date("2026-03-05T10:00:00.000Z"),
      }),
    );

    const result = await finalizeInvoice("inv-1");

    expect(invoiceSvc.finalizeInvoice).toHaveBeenCalledWith("inv-1");
    const json = JSON.parse(JSON.stringify(result));
    expect(json).toEqual({
      success: true,
      data: expect.objectContaining({ invoiceNumber: "101", status: "PENDING_PAYMENT" }),
    });
    // money is a plain string, dates are ISO strings -> safe to serialize
    expect(json.data.total).toBe("109000.00");
    expect(json.data.finalizedAt).toBe("2026-03-05T10:00:00.000Z");
  });

  it("maps a cross-business invoice to FORBIDDEN", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { getInvoice } = await import("./invoiceActions");
    invoiceSvc.getInvoice.mockRejectedValue(new ForbiddenError("Invoice does not belong to this business"));

    const result = await getInvoice("biz-1", "inv-other");

    expect(result).toEqual({ success: false, error: { code: "FORBIDDEN", message: "Invoice does not belong to this business" } });
  });

  it("maps an invoice-quota (entitlement) rejection safely", async () => {
    const { InvoiceLimitReachedError } = await import("@/server/errors");
    const { finalizeInvoice } = await import("./invoiceActions");
    invoiceSvc.finalizeInvoice.mockRejectedValue(
      new InvoiceLimitReachedError("Invoice limit reached: the FREE plan allows 3 finalized invoice(s) per month."),
    );

    const result = await finalizeInvoice("inv-1");

    expect(result).toEqual({
      success: false,
      error: {
        code: "INVOICE_LIMIT_REACHED",
        message: "Invoice limit reached: the FREE plan allows 3 finalized invoice(s) per month.",
      },
    });
  });

  it("maps an unknown invoice to NOT_FOUND during finalization", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const { finalizeInvoice } = await import("./invoiceActions");
    invoiceSvc.finalizeInvoice.mockRejectedValue(new NotFoundError("Invoice not found"));

    const result = await finalizeInvoice("inv-missing");

    expect(result).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Invoice not found" },
    });
  });

  it("maps already-finalized, archived-business and concurrency lifecycle rejections to VALIDATION_ERROR", async () => {
    const { ValidationError } = await import("@/server/errors");
    const { finalizeInvoice } = await import("./invoiceActions");

    const scenarios = [
      {
        message: "Only draft invoices can be finalized; this invoice is already finalized",
        expected: "Only draft invoices can be finalized; this invoice is already finalized",
      },
      {
        message: "Cannot finalize invoice for an archived business",
        expected: "Cannot finalize invoice for an archived business",
      },
      {
        message: "Invoice is no longer in draft status and cannot be finalized",
        expected: "Invoice is no longer in draft status and cannot be finalized",
      },
    ];

    for (const scenario of scenarios) {
      invoiceSvc.finalizeInvoice.mockRejectedValueOnce(new ValidationError(scenario.message));
      const result = await finalizeInvoice("inv-1");
      expect(result).toEqual({
        success: false,
        error: { code: "VALIDATION_ERROR", message: scenario.expected },
      });
    }
  });

  it("rejects unauthenticated finalization before touching the service", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { finalizeInvoice } = await import("./invoiceActions");
    requireSession.mockRejectedValue(new UnauthorizedError());

    const result = await finalizeInvoice("inv-1");

    expect(result).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    expect(invoiceSvc.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("does not duplicate finalization logic; it delegates every attempt to the service", async () => {
    const { ValidationError } = await import("@/server/errors");
    const { finalizeInvoice } = await import("./invoiceActions");

    invoiceSvc.finalizeInvoice
      .mockResolvedValueOnce(
        invoiceRecord({
          invoiceNumber: "101",
          status: "PENDING_PAYMENT",
          finalizedAt: new Date("2026-03-05T10:00:00.000Z"),
        }),
      )
      .mockRejectedValueOnce(
        new ValidationError("Only draft invoices can be finalized; this invoice is already finalized"),
      );

    const first = await finalizeInvoice("inv-1");
    expect(first.success).toBe(true);

    const second = await finalizeInvoice("inv-1");
    expect(second).toEqual({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Only draft invoices can be finalized; this invoice is already finalized",
      },
    });

    expect(invoiceSvc.finalizeInvoice).toHaveBeenCalledTimes(2);
    expect(invoiceSvc.finalizeInvoice).toHaveBeenNthCalledWith(1, "inv-1");
    expect(invoiceSvc.finalizeInvoice).toHaveBeenNthCalledWith(2, "inv-1");
  });

  it("lists invoices and forwards the status/limit filter", async () => {
    const { listInvoices } = await import("./invoiceActions");
    invoiceSvc.listInvoices.mockResolvedValue([invoiceRecord()]);

    const result = await listInvoices({ businessId: "biz-1", status: "DRAFT", limit: 10 });

    expect(invoiceSvc.listInvoices).toHaveBeenCalledWith("biz-1", { status: "DRAFT", limit: 10 });
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// PAYMENT
// ===========================================================================

describe("payment actions", () => {
  it("creates / updates / deletes a payment through the service", async () => {
    const { createInvoicePayment, updateInvoicePayment, deleteInvoicePayment, listInvoicePayments } =
      await import("./paymentActions");

    paymentSvc.createInvoicePayment.mockResolvedValue(paymentRecord());
    paymentSvc.updateInvoicePayment.mockResolvedValue(paymentRecord({ amount: new Decimal("60000.00") }));
    paymentSvc.deleteInvoicePayment.mockResolvedValue(paymentRecord());
    paymentSvc.listInvoicePayments.mockResolvedValue([paymentRecord()]);

    const created = await createInvoicePayment("inv-1", { amount: "50000", method: "CASH" });
    expect(paymentSvc.createInvoicePayment).toHaveBeenCalledWith("inv-1", { amount: "50000", method: "CASH" });
    if (!created.success) return;
    expect(created.data.amount).toBe("50000.00");

    const updated = await updateInvoicePayment("pay-1", { amount: "60000" });
    expect(paymentSvc.updateInvoicePayment).toHaveBeenCalledWith("pay-1", { amount: "60000" });
    if (!updated.success) return;
    expect(updated.data.amount).toBe("60000.00");

    const deleted = await deleteInvoicePayment("pay-1");
    expect(paymentSvc.deleteInvoicePayment).toHaveBeenCalledWith("pay-1");
    expect(deleted.success).toBe(true);

    const listed = await listInvoicePayments("inv-1");
    expect(paymentSvc.listInvoicePayments).toHaveBeenCalledWith("inv-1");
    if (!listed.success) return;
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.paymentDate).toBe("2026-03-06T00:00:00.000Z");
  });

  it("maps an overpayment (validation) rejection safely", async () => {
    const { ValidationError } = await import("@/server/errors");
    const { createInvoicePayment } = await import("./paymentActions");
    paymentSvc.createInvoicePayment.mockRejectedValue(
      new ValidationError("Payment exceeds the invoice remaining balance: ..."),
    );

    const result = await createInvoicePayment("inv-1", { amount: "999999", method: "CASH" });

    expect(result).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Payment exceeds the invoice remaining balance: ..." },
    });
  });

  it("maps cross-business payment access to FORBIDDEN", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { listInvoicePayments } = await import("./paymentActions");
    paymentSvc.listInvoicePayments.mockRejectedValue(new ForbiddenError("Invoice does not belong to this account"));

    const result = await listInvoicePayments("inv-other");

    expect(result).toEqual({ success: false, error: { code: "FORBIDDEN", message: "Invoice does not belong to this account" } });
  });
});

// ===========================================================================
// DASHBOARD
// ===========================================================================

describe("dashboard action", () => {
  it("requires authentication before returning dashboard data", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { getDashboardDataAction } = await import("./dashboardActions");
    requireSession.mockRejectedValue(new UnauthorizedError());

    const result = await getDashboardDataAction();

    expect(result).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    expect(dashboardSvc.getDashboardData).not.toHaveBeenCalled();
  });

  it("returns the assembled dashboard payload from the service", async () => {
    const { getDashboardDataAction } = await import("./dashboardActions");
    dashboardSvc.getDashboardData.mockResolvedValue({ anything: "works" } as never);

    const result = await getDashboardDataAction({ recentInvoicesLimit: 5 });

    expect(dashboardSvc.getDashboardData).toHaveBeenCalledWith({ recentInvoicesLimit: 5 });
    expect(result).toEqual({ success: true, data: { anything: "works" } });
  });
});
