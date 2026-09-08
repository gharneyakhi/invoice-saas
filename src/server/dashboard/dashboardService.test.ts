import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";

const prismaMock = vi.hoisted(() => ({
  account: { findUnique: vi.fn() },
  invoice: { aggregate: vi.fn(), findMany: vi.fn() },
  invoiceSettings: { findUnique: vi.fn() },
}));

const requireSession = vi.hoisted(() => vi.fn());
const listBusinesses = vi.hoisted(() => vi.fn());
const getInvoiceQuotaStatus = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

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
  return { UnauthorizedError, ForbiddenError, NotFoundError, requireSession };
});

vi.mock("@/server/business/businessService", () => ({ listBusinesses }));
vi.mock("@/server/entitlements/invoiceQuota", () => ({ getInvoiceQuotaStatus }));

const SESSION = { userId: "user-1", accountId: "acc-1" };

function businessRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "biz-1",
    accountId: "acc-1",
    name: "کسب‌وکار اصلی",
    isActive: true,
    isLocked: false,
    isPrimary: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function accountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "acc-1",
    name: "حساب اصلی",
    owner: { name: "کاربر", email: "user@example.com", avatarUrl: null },
    ...overrides,
  };
}

function quota(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    planKey: "FREE",
    invoiceLimit: 3,
    usedInvoices: 1,
    remainingInvoices: 2,
    canFinalize: true,
    warningLevel: "OK",
    usagePeriodId: "period-1",
    periodStart: new Date("2026-03-01T00:00:00.000Z"),
    periodEnd: new Date("2026-03-31T23:59:59.999Z"),
    fallbackReason: "NONE",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(SESSION);
  listBusinesses.mockResolvedValue([businessRow()]);
  getInvoiceQuotaStatus.mockResolvedValue(quota());
  prismaMock.account.findUnique.mockResolvedValue(accountRow());
  prismaMock.invoice.aggregate.mockResolvedValue({
    _sum: { remainingAmount: new Decimal("0"), paidAmount: new Decimal("0") },
  });
  prismaMock.invoice.findMany.mockResolvedValue([]);
  prismaMock.invoiceSettings.findUnique.mockResolvedValue({ currency: "IRR" });
});

describe("getDashboardData", () => {
  it("rejects when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { getDashboardData } = await import("./dashboardService");
    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(getDashboardData()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("surfaces account/user display info", async () => {
    const { getDashboardData } = await import("./dashboardService");
    const data = await getDashboardData();

    expect(data.account).toEqual({
      accountId: "acc-1",
      accountName: "حساب اصلی",
      userName: "کاربر",
      userEmail: "user@example.com",
      userAvatarUrl: null,
    });
    expect(prismaMock.account.findUnique).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      select: { id: true, name: true, owner: { select: { name: true, email: true, avatarUrl: true } } },
    });
  });

  it("resolves the current business to the primary live business and lists live businesses", async () => {
    const { getDashboardData } = await import("./dashboardService");
    listBusinesses.mockResolvedValue([
      businessRow({ id: "biz-1", isPrimary: true, name: "اصلی" }),
      businessRow({ id: "biz-2", isPrimary: false, name: "شعبه" }),
    ]);

    const data = await getDashboardData();

    expect(data.businesses).toHaveLength(2);
    expect(data.currentBusiness?.id).toBe("biz-1");
    expect(data.currentBusiness?.isPrimary).toBe(true);
  });

  it("is null-safe when the account has no live business", async () => {
    const { getDashboardData } = await import("./dashboardService");
    listBusinesses.mockResolvedValue([]);

    const data = await getDashboardData();

    expect(data.currentBusiness).toBeNull();
    expect(data.businesses).toEqual([]);
    expect(data.totals).toEqual({ pendingAmount: "0", paidAmount: "0", currency: "IRR" });
    expect(data.recentInvoices).toEqual([]);
    expect(prismaMock.invoice.aggregate).not.toHaveBeenCalled();
    expect(prismaMock.invoice.findMany).not.toHaveBeenCalled();
  });

  it("reports the correct effective plan", async () => {
    const { getDashboardData } = await import("./dashboardService");
    getInvoiceQuotaStatus.mockResolvedValue(quota({ planKey: "PRO", invoiceLimit: 50 }));

    const data = await getDashboardData();

    expect(data.plan.planKey).toBe("PRO");
    expect(data.plan.planName).toBe("Pro");
    expect(data.plan.monthlyInvoiceLimit).toBe(50);
  });

  it("reports the correct monthly quota usage and remaining count", async () => {
    const { getDashboardData } = await import("./dashboardService");
    getInvoiceQuotaStatus.mockResolvedValue(
      quota({
        planKey: "BASIC",
        invoiceLimit: 10,
        usedInvoices: 8,
        remainingInvoices: 2,
        canFinalize: true,
        warningLevel: "WARNING_80",
      }),
    );

    const data = await getDashboardData();

    expect(data.plan.currentMonthlyFinalizedInvoiceCount).toBe(8);
    expect(data.plan.remainingInvoiceQuota).toBe(2);
    expect(data.plan.canFinalize).toBe(true);
    expect(data.plan.warningLevel).toBe("WARNING_80");
    // getInvoiceQuotaStatus is called (reusing the existing quota helper).
    expect(getInvoiceQuotaStatus).toHaveBeenCalledTimes(1);
  });

  it("computes paid/pending totals via SQL-side aggregate over finalized, non-cancelled invoices", async () => {
    const { getDashboardData } = await import("./dashboardService");
    prismaMock.invoice.aggregate.mockResolvedValue({
      _sum: { remainingAmount: new Decimal("250000.00"), paidAmount: new Decimal("80000.00") },
    });

    const data = await getDashboardData();

    expect(prismaMock.invoice.aggregate).toHaveBeenCalledWith({
      where: {
        businessId: "biz-1",
        finalizedAt: { not: null },
        status: { not: "CANCELLED" },
      },
      _sum: { remainingAmount: true, paidAmount: true },
    });
    expect(data.totals).toEqual({
      pendingAmount: "250000.00",
      paidAmount: "80000.00",
      currency: "IRR",
    });
  });

  it("returns a zeroed total (as a string) when no finalized invoices exist", async () => {
    const { getDashboardData } = await import("./dashboardService");
    prismaMock.invoice.aggregate.mockResolvedValue({ _sum: { remainingAmount: null, paidAmount: null } });

    const data = await getDashboardData();

    expect(data.totals.pendingAmount).toBe("0");
    expect(data.totals.paidAmount).toBe("0");
  });

  it("loads recent invoices with a deterministic ordering, a bounded take and an explicit select (no big relations)", async () => {
    const { getDashboardData } = await import("./dashboardService");
    const recent = [
      {
        id: "inv-1",
        invoiceNumber: "101",
        invoiceType: "FINAL",
        status: "PAID",
        total: new Decimal("100000.00"),
        paidAmount: new Decimal("100000.00"),
        remainingAmount: new Decimal("0.00"),
        currency: "IRR",
        issueDate: new Date("2026-03-05T00:00:00.000Z"),
        dueDate: null,
        finalizedAt: new Date("2026-03-05T01:00:00.000Z"),
        createdAt: new Date("2026-03-05T00:00:00.000Z"),
      },
    ];
    prismaMock.invoice.findMany.mockResolvedValue(recent);

    const data = await getDashboardData({ recentInvoicesLimit: 5 });

    expect(prismaMock.invoice.findMany).toHaveBeenCalledWith({
      where: { businessId: "biz-1" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 5,
      select: {
        id: true,
        invoiceNumber: true,
        invoiceType: true,
        status: true,
        total: true,
        paidAmount: true,
        remainingAmount: true,
        currency: true,
        issueDate: true,
        dueDate: true,
        finalizedAt: true,
        createdAt: true,
      },
    });
    expect(data.recentInvoices).toHaveLength(1);
    expect(data.recentInvoices[0]).toMatchObject({
      id: "inv-1",
      invoiceNumber: "101",
      status: "PAID",
      total: "100000.00",
      createdAt: "2026-03-05T00:00:00.000Z",
    });
  });

  it("clamps the recent-invoices limit to a small bound", async () => {
    const { getDashboardData } = await import("./dashboardService");
    prismaMock.invoice.findMany.mockResolvedValue([]);

    await getDashboardData({ recentInvoicesLimit: 999 });

    expect(prismaMock.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
  });

  it("serializes every Decimal to a string (never a Decimal/float) across the payload", async () => {
    const { getDashboardData } = await import("./dashboardService");
    prismaMock.invoice.aggregate.mockResolvedValue({
      _sum: { remainingAmount: new Decimal("125000.50"), paidAmount: new Decimal("10.25") },
    });
    prismaMock.invoice.findMany.mockResolvedValue([
      {
        id: "inv-1",
        invoiceNumber: "1",
        invoiceType: "FINAL",
        status: "PENDING_PAYMENT",
        total: new Decimal("125000.50"),
        paidAmount: new Decimal("10.25"),
        remainingAmount: new Decimal("124990.25"),
        currency: "IRT",
        issueDate: new Date("2026-03-05T00:00:00.000Z"),
        dueDate: null,
        finalizedAt: null,
        createdAt: new Date("2026-03-05T00:00:00.000Z"),
      },
    ]);

    const data = await getDashboardData();

    const walk = (value: unknown): void => {
      if (value instanceof Decimal) throw new Error("Decimal leaked into dashboard payload");
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(data);

    expect(data.totals.pendingAmount).toBe("125000.50");
    expect(data.recentInvoices[0]?.total).toBe("125000.50");
    expect(data.recentInvoices[0]?.paidAmount).toBe("10.25");
    // Round-trips cleanly through JSON
    expect(JSON.parse(JSON.stringify(data)).totals.pendingAmount).toBe("125000.50");
  });

  it("uses the current InvoiceSettings currency (IRT) for dashboard totals", async () => {
    const { getDashboardData } = await import("./dashboardService");
    prismaMock.invoiceSettings.findUnique.mockResolvedValue({ currency: "IRT" });

    const data = await getDashboardData();

    expect(data.totals.currency).toBe("IRT");
    expect(prismaMock.invoiceSettings.findUnique).toHaveBeenCalledWith({
      where: { businessId: "biz-1" },
      select: { currency: true },
    });
  });

  it("carries each recent invoice's snapshotted currency (null for drafts)", async () => {
    const { getDashboardData } = await import("./dashboardService");
    prismaMock.invoice.findMany.mockResolvedValue([
      {
        id: "inv-draft",
        invoiceNumber: "DRAFT-1",
        invoiceType: "FINAL",
        status: "DRAFT",
        total: new Decimal("1000.00"),
        paidAmount: new Decimal("0.00"),
        remainingAmount: new Decimal("1000.00"),
        currency: null,
        issueDate: new Date("2026-03-05T00:00:00.000Z"),
        dueDate: null,
        finalizedAt: null,
        createdAt: new Date("2026-03-05T00:00:00.000Z"),
      },
      {
        id: "inv-final",
        invoiceNumber: "101",
        invoiceType: "FINAL",
        status: "PAID",
        total: new Decimal("2000.00"),
        paidAmount: new Decimal("2000.00"),
        remainingAmount: new Decimal("0.00"),
        currency: "IRT",
        issueDate: new Date("2026-03-05T00:00:00.000Z"),
        dueDate: null,
        finalizedAt: new Date("2026-03-05T01:00:00.000Z"),
        createdAt: new Date("2026-03-05T00:00:00.000Z"),
      },
    ]);

    const data = await getDashboardData();

    expect(data.recentInvoices[0]?.currency).toBeNull();
    expect(data.recentInvoices[1]?.currency).toBe("IRT");
  });
});
