import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";

/**
 * The finalization action contract — the single server path the editor's
 * «صدور نهایی» button uses.
 *
 * Invoice Editor V2 deliberately added NO second issuing endpoint, no client
 * quota counter and no local invoice-number generator. These tests pin that:
 * `finalizeInvoice` is a thin gate over `invoiceService.finalizeInvoice`
 * (auth → delegation → safe DTO), and `createDraftInvoice` /
 * `updateDraftInvoice` keep rejecting any server-owned field a browser might
 * try to send. If one of these tests ever fails, someone has moved domain
 * authority into the UI — which is exactly the regression this milestone must
 * not introduce.
 */

const requireSession = vi.hoisted(() => vi.fn());
const authErrors = vi.hoisted(() => {
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
  return { UnauthorizedError, ForbiddenError, NotFoundError };
});
const invoiceSvc = vi.hoisted(() => ({
  createDraftInvoice: vi.fn(),
  updateDraftInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  getInvoice: vi.fn(),
  listInvoices: vi.fn(),
  queryInvoices: vi.fn(),
}));

vi.mock("@/server/auth/requireSession", () => ({ ...authErrors, requireSession }));
vi.mock("@/server/invoice/invoiceService", () => invoiceSvc);

import {
  createDraftInvoice,
  finalizeInvoice,
  updateDraftInvoice,
} from "@/server/actions/invoiceActions";
import {
  parseCreateDraftInvoiceInput,
  parseUpdateDraftInvoiceInput,
} from "@/server/invoice/schema";
import { buildDraftPayload } from "@/components/invoice/invoiceEditorFlow";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";
import { InvoiceLimitReachedError, ValidationError } from "@/server/errors";

const MONEY = (value: string) => new Decimal(value);

function finalizedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inv-1",
    businessId: "biz-1",
    customerId: "cust-1",
    invoiceNumber: "INV-000102",
    invoiceType: "FINAL",
    issueDate: new Date("2026-03-05"),
    dueDate: null,
    status: "PENDING_PAYMENT",
    subtotal: MONEY("200000"),
    itemDiscountAmount: MONEY("0"),
    globalDiscountPercent: MONEY("0"),
    globalDiscountAmount: MONEY("0"),
    taxPercent: MONEY("9"),
    taxAmount: MONEY("18000"),
    taxableAmount: MONEY("200000"),
    total: MONEY("218000"),
    paidAmount: MONEY("0"),
    remainingAmount: MONEY("218000"),
    notes: null,
    createdAt: new Date("2026-03-05"),
    updatedAt: new Date("2026-03-06"),
    finalizedAt: new Date("2026-03-06"),
    cancelledAt: null,
    items: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ accountId: "acc-1", email: "a@b.test" });
});

describe("finalizeInvoice (the action the editor calls)", () => {
  it("delegates to the existing service with nothing but the invoice id", async () => {
    invoiceSvc.finalizeInvoice.mockResolvedValue(finalizedRow());

    const result = await finalizeInvoice("inv-1");

    expect(invoiceSvc.finalizeInvoice).toHaveBeenCalledTimes(1);
    expect(invoiceSvc.finalizeInvoice).toHaveBeenCalledWith("inv-1");
    expect(result.success).toBe(true);
  });

  it("hands the browser the SERVER's official number and finalized status", async () => {
    invoiceSvc.finalizeInvoice.mockResolvedValue(finalizedRow());

    const result = await finalizeInvoice("inv-1");

    if (!result.success) throw new Error("expected success");
    expect(result.data.invoiceNumber).toBe("INV-000102");
    expect(result.data.status).toBe("PENDING_PAYMENT");
    expect(result.data.finalizedAt).not.toBeNull();
    // Money is the server's, exactly as the authoritative DTO maps it.
    expect(result.data.total).toBe("218000.00");
  });

  it("requires a session before the service is touched", async () => {
    requireSession.mockRejectedValueOnce(new authErrors.UnauthorizedError("Session expired"));

    const result = await finalizeInvoice("inv-1");

    expect(invoiceSvc.finalizeInvoice).not.toHaveBeenCalled();
    if (result.success) throw new Error("expected failure");
    expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("reports quota exhaustion as the server's own verdict — never a client guess", async () => {
    invoiceSvc.finalizeInvoice.mockRejectedValueOnce(
      new InvoiceLimitReachedError("Invoice limit reached: the free plan allows 5 finalized invoice(s) per month."),
    );

    const result = await finalizeInvoice("inv-1");

    if (result.success) throw new Error("expected failure");
    expect(result.error.code).toBe("INVOICE_LIMIT_REACHED");
    // The remaining count stays inside the server's message; the action invents
    // no counter of its own.
    expect(result.error.message).toContain("free plan allows 5");
  });

  it("maps a concurrent-finalization rejection to a safe validation error", async () => {
    invoiceSvc.finalizeInvoice.mockRejectedValueOnce(
      new ValidationError("Invoice is no longer in draft status and cannot be finalized"),
    );

    const result = await finalizeInvoice("inv-1");

    if (result.success) throw new Error("expected failure");
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("hides infrastructure failures behind an opaque internal error", async () => {
    invoiceSvc.finalizeInvoice.mockRejectedValueOnce(
      new Error("PrismaClientKnownRequestError: Transaction failed on SELECT invoices FOR UPDATE"),
    );

    const result = await finalizeInvoice("inv-1");

    if (result.success) throw new Error("expected failure");
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.message).not.toMatch(/Prisma|SELECT|invoices/);
  });
});

describe("the draft actions the issue flow reuses internally", () => {
  it("passes (businessId, payload) to the draft service unchanged", async () => {
    invoiceSvc.createDraftInvoice.mockResolvedValue(finalizedRow({ status: "DRAFT", invoiceNumber: "DRAFT-1" }));
    const payload = { invoiceType: "FINAL", items: [], taxPercent: "9" };

    const result = await createDraftInvoice("biz-1", payload);

    expect(invoiceSvc.createDraftInvoice).toHaveBeenCalledWith("biz-1", payload);
    expect(result.success).toBe(true);
  });

  it("passes (businessId, invoiceId, payload) to the draft update unchanged", async () => {
    invoiceSvc.updateDraftInvoice.mockResolvedValue(finalizedRow({ status: "DRAFT" }));
    const payload = { invoiceType: "FINAL", items: [] };

    const result = await updateDraftInvoice("biz-1", "inv-9", payload);

    expect(invoiceSvc.updateDraftInvoice).toHaveBeenCalledWith("biz-1", "inv-9", payload);
    expect(result.success).toBe(true);
  });

  it("produces a payload the strict server draft schema accepts", () => {
    // Editor payload → `createDraftInvoiceSchema` is the real cross-layer
    // contract of this milestone: the client may send editable inputs only, and
    // the server's strict schema is what enforces it (the action never
    // re-validates totals because no totals are ever sent).
    const payload = buildDraftPayload({
      invoiceType: "FINAL",
      issueDate: "2026-03-05",
      dueDate: "",
      customerId: "",
      notes: "  ",
      globalDiscountPercent: "5",
      taxPercent: "9",
      items: [
        {
          productId: "",
          title: "  خدمت طراحی  ",
          description: "",
          unit: "ساعت",
          quantity: "2",
          unitPrice: "100000",
          discountPercent: "10",
        },
      ],
    } as InvoiceEditorFields);

    const parsed = parseCreateDraftInvoiceInput({ ...payload, businessId: "biz-1" });

    expect(parsed.invoiceType).toBe("FINAL");
    expect(parsed.notes).toBeNull();
    expect(parsed.items[0]?.title).toBe("خدمت طراحی");
    expect(parsed).not.toHaveProperty("total");

    const smuggled = {
      ...payload,
      businessId: "biz-1",
      total: "1",
      subtotal: "1",
      invoiceNumber: "INV-999999",
      status: "PAID",
      paidAmount: "0",
      finalizedAt: null,
      accountId: "acc-2",
    };

    expect(() => parseCreateDraftInvoiceInput(smuggled)).toThrow(/Invalid draft invoice input/);
    // And the same for the update contract, which the issue flow uses.
    expect(() =>
      parseUpdateDraftInvoiceInput({ ...smuggled, invoiceId: "inv-1" }),
    ).toThrow(/Invalid draft invoice update input/);
  });
});
