import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { ValidationError } from "@/server/errors";
import { parseInvoiceListQuery } from "./schema";

/**
 * Invoice List V1 — server-side query contract.
 *
 * These tests pin the three properties the list depends on for correctness and
 * safety: (1) business isolation — the query is always scoped to the *verified*
 * business row; (2) bounded results — page size is clamped and sort keys are
 * allow-listed; (3) the search / filter / sort translation into Prisma.
 */

const prismaMock = vi.hoisted(() => ({
  business: { findUnique: vi.fn() },
  invoice: { findMany: vi.fn(), count: vi.fn() },
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  class NotFoundError extends Error {}
  return { UnauthorizedError, ForbiddenError, NotFoundError, requireSession };
});

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    businessId: "biz-1",
    customerId: "cus-1",
    invoiceNumber: "INV-1001",
    invoiceType: "FINAL",
    issueDate: new Date("2026-03-01T00:00:00.000Z"),
    dueDate: null,
    status: "PAID",
    subtotal: new Decimal(100),
    itemDiscountAmount: new Decimal(0),
    globalDiscountPercent: new Decimal(0),
    globalDiscountAmount: new Decimal(0),
    taxPercent: new Decimal(0),
    taxAmount: new Decimal(0),
    taxableAmount: new Decimal(100),
    total: new Decimal(100),
    paidAmount: new Decimal(100),
    remainingAmount: new Decimal(0),
    notes: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    finalizedAt: new Date("2026-03-01T00:00:00.000Z"),
    cancelledAt: null,
    customer: { name: "شرکت آلفا" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ userId: "user-1", accountId: "acc-1" });
  prismaMock.business.findUnique.mockResolvedValue({
    id: "biz-1",
    accountId: "acc-1",
    name: "Biz",
    archivedAt: null,
  });
  prismaMock.invoice.findMany.mockResolvedValue([invoiceRow()]);
  prismaMock.invoice.count.mockResolvedValue(1);
});

describe("queryInvoices", () => {
  it("scopes the query to the verified business row and returns bounded pages", async () => {
    const { queryInvoices } = await import("./invoiceService");

    const result = await queryInvoices("biz-1", { page: 2, pageSize: 5 });

    const args = prismaMock.invoice.findMany.mock.calls[0]![0]!;
    expect(args.where.businessId).toBe("biz-1");
    expect(args.take).toBe(5);
    expect(args.skip).toBe(5);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(5);
    expect(result.rows[0]!.customerName).toBe("شرکت آلفا");
  });

  it("clamps an oversized page size so the list can never be unbounded", async () => {
    const { queryInvoices, INVOICE_LIST_MAX_PAGE_SIZE } = await import("./invoiceService");

    await queryInvoices("biz-1", { pageSize: 100000 });

    expect(prismaMock.invoice.findMany.mock.calls[0]![0]!.take).toBe(INVOICE_LIST_MAX_PAGE_SIZE);
  });

  it("rejects a foreign business before touching invoices", async () => {
    prismaMock.business.findUnique.mockResolvedValue({
      id: "biz-2",
      accountId: "other-acc",
      archivedAt: null,
    });
    const { queryInvoices } = await import("./invoiceService");

    await expect(queryInvoices("biz-2")).rejects.toThrow();
    expect(prismaMock.invoice.findMany).not.toHaveBeenCalled();
  });

  it("falls back to the default sort when an unknown sort key is supplied", async () => {
    const { queryInvoices } = await import("./invoiceService");

    await queryInvoices("biz-1", { sortBy: "id; DROP TABLE" as never });

    expect(prismaMock.invoice.findMany.mock.calls[0]![0]!.orderBy).toEqual([
      { createdAt: "desc" },
      { id: "asc" },
    ]);
  });

  it("searches invoice number, notes and customer name", async () => {
    const { queryInvoices } = await import("./invoiceService");

    await queryInvoices("biz-1", { search: "آلفا" });

    const or = prismaMock.invoice.findMany.mock.calls[0]![0]!.where.OR;
    expect(or).toHaveLength(3);
    expect(or[2]).toEqual({ customer: { is: { name: { contains: "آلفا", mode: "insensitive" } } } });
  });

  it("treats the issue-date upper bound as inclusive of the whole day", async () => {
    const { queryInvoices } = await import("./invoiceService");

    await queryInvoices("biz-1", {
      issuedFrom: new Date("2026-03-01T00:00:00.000Z"),
      issuedTo: new Date("2026-03-01T00:00:00.000Z"),
    });

    // `issueDate` is a timestamp: an invoice issued at 14:30 on 2026-03-01 must
    // still match a "to 2026-03-01" filter, so the upper bound is exclusive of
    // the *next* midnight rather than `lte` midnight of the selected day.
    expect(prismaMock.invoice.findMany.mock.calls[0]![0]!.where.issueDate).toEqual({
      gte: new Date("2026-03-01T00:00:00.000Z"),
      lt: new Date("2026-03-02T00:00:00.000Z"),
    });
  });

  it("leaves an explicit timestamp upper bound untouched", async () => {
    const { queryInvoices } = await import("./invoiceService");

    await queryInvoices("biz-1", { issuedTo: new Date("2026-03-01T09:15:00.000Z") });

    expect(prismaMock.invoice.findMany.mock.calls[0]![0]!.where.issueDate).toEqual({
      lt: new Date("2026-03-01T09:15:00.000Z"),
    });
  });

  it("maps the FINALIZED lifecycle group onto the finalized statuses", async () => {
    const { queryInvoices } = await import("./invoiceService");

    await queryInvoices("biz-1", { lifecycle: "FINALIZED" });

    expect(prismaMock.invoice.findMany.mock.calls[0]![0]!.where.status).toEqual({
      in: ["ISSUED", "SENT", "PENDING_PAYMENT", "PARTIALLY_PAID", "PAID", "OVERDUE"],
    });
  });

  it("returns lifecycle counts for the whole business, independent of the filters", async () => {
    prismaMock.invoice.count
      .mockResolvedValueOnce(1) // filtered total
      .mockResolvedValueOnce(2) // draft
      .mockResolvedValueOnce(7) // finalized
      .mockResolvedValueOnce(1) // cancelled
      .mockResolvedValueOnce(10); // all
    const { queryInvoices } = await import("./invoiceService");

    const result = await queryInvoices("biz-1", { lifecycle: "DRAFT" });

    expect(result.total).toBe(1);
    expect(result.lifecycleCounts).toEqual({ all: 10, draft: 2, finalized: 7, cancelled: 1 });
  });

  it("computes the page count from the filtered total", async () => {
    prismaMock.invoice.count.mockResolvedValue(21);
    const { queryInvoices } = await import("./invoiceService");

    const result = await queryInvoices("biz-1", { pageSize: 20 });

    expect(result.pageCount).toBe(2);
  });
});

describe("parseInvoiceListQuery", () => {
  it("applies safe defaults", () => {
    expect(parseInvoiceListQuery({})).toMatchObject({
      lifecycle: "ALL",
      sortBy: "createdAt",
      sortDirection: "desc",
      page: 1,
      pageSize: 20,
    });
  });

  it("rejects an unsupported sort column", () => {
    expect(() => parseInvoiceListQuery({ sortBy: "paidAmount" })).toThrow(ValidationError);
  });

  it("rejects a page size above the hard cap", () => {
    expect(() => parseInvoiceListQuery({ pageSize: 5000 })).toThrow(ValidationError);
  });

  it("rejects unknown keys", () => {
    expect(() => parseInvoiceListQuery({ businessId: "biz-1" })).toThrow(ValidationError);
  });

  it("coerces numeric params coming from the URL", () => {
    expect(parseInvoiceListQuery({ page: "3" }).page).toBe(3);
  });
});
