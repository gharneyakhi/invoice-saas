import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUsagePeriodBounds } from "@/lib/usage-period";
import type { ResolveEntitlementsOptions } from "./entitlementService";

/**
 * Unit tests for the finalized-invoice quota check.
 *
 * The resolver, the pure entitlement logic and the period-key helper all run for
 * real; only Prisma and the session are mocked. The most important assertions
 * here are negative ones: this check must never write.
 */
const prismaMock = vi.hoisted(() => ({
  plan: { findUnique: vi.fn() },
  subscription: { findMany: vi.fn() },
  usagePeriod: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

// Do not importOriginal(): it pulls auth-options.ts, which throws at load time
// when GOOGLE_CLIENT_ID is unset.
vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  return { UnauthorizedError, requireSession };
});

const SESSION = { userId: "user-1", accountId: "acc-1" };
const NOW = new Date(2026, 2, 15, 12, 0, 0); // 15 March 2026, local time
const BOUNDS = getUsagePeriodBounds(NOW);

interface PlanOverrides {
  key?: "FREE" | "BASIC" | "PRO";
  isActive?: boolean;
  businessLimit?: number;
  invoiceLimit?: number;
  features?: string[];
}

function planRow(overrides: PlanOverrides = {}) {
  const { key = "PRO", isActive = true, businessLimit = 3, invoiceLimit = 50, features = [] } = overrides;
  return {
    id: `plan-${key.toLowerCase()}`,
    key,
    isActive,
    businessLimit,
    invoiceLimit,
    planFeatures: features.map((featureKey) => ({ enabled: true, feature: { key: featureKey } })),
  };
}

/** The seeded FREE baseline: 3 finalized invoices per month. */
const FREE_PLAN_ROW = () => planRow({ key: "FREE", businessLimit: 1, invoiceLimit: 3 });

interface SubscriptionOverrides {
  id?: string;
  status?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  createdAt?: Date;
  plan?: ReturnType<typeof planRow>;
}

function subscriptionRow(overrides: SubscriptionOverrides = {}) {
  return {
    id: "sub-1",
    accountId: "acc-1",
    status: "ACTIVE",
    startDate: new Date(2026, 2, 1),
    endDate: new Date(2026, 3, 1),
    createdAt: new Date(2026, 2, 1),
    plan: planRow(),
    ...overrides,
  };
}

interface PeriodOverrides {
  id?: string;
  accountId?: string;
  subscriptionId?: string;
}

function periodRow(invoiceCount: number, overrides: PeriodOverrides = {}) {
  return {
    id: "period-1",
    accountId: "acc-1",
    subscriptionId: "sub-1",
    periodStart: BOUNDS.periodStart,
    periodEnd: BOUNDS.periodEnd,
    invoiceCount,
    createdAt: BOUNDS.periodStart,
    updatedAt: BOUNDS.periodStart,
    ...overrides,
  };
}

/**
 * Wires the three reads the quota check makes.
 * `plan` defaults to the seeded FREE row, `subscriptions` to one in-force PRO row.
 */
function mockDb({
  free,
  subscriptions,
  period,
}: {
  free?: ReturnType<typeof planRow> | null;
  subscriptions?: unknown[];
  period?: unknown;
} = {}) {
  prismaMock.plan.findUnique.mockResolvedValue(free === undefined ? FREE_PLAN_ROW() : free);
  prismaMock.subscription.findMany.mockResolvedValue(subscriptions ?? [subscriptionRow()]);
  prismaMock.usagePeriod.findUnique.mockResolvedValue(period === undefined ? null : period);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(SESSION);
});

describe("getInvoiceQuotaStatus", () => {
  it("reports the effective plan's limit, the current usage, and the remainder", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({ period: periodRow(12) }); // in-force PRO, limit 50

    const status = await getInvoiceQuotaStatus({ now: NOW });

    expect(status).toMatchObject({
      planKey: "PRO",
      invoiceLimit: 50,
      usedInvoices: 12,
      remainingInvoices: 38,
      canFinalize: true,
      usagePeriodId: "period-1",
      fallbackReason: "NONE",
    });
  });

  it("allows finalizing below the limit and refuses at it", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");

    mockDb({ period: periodRow(2) }); // FREE would allow 3; PRO allows 50
    expect((await getInvoiceQuotaStatus({ now: NOW })).canFinalize).toBe(true);

    mockDb({ subscriptions: [], period: periodRow(3) }); // no subscription -> FREE limit 3
    const atLimit = await getInvoiceQuotaStatus({ now: NOW });
    expect(atLimit.planKey).toBe("FREE");
    expect(atLimit.invoiceLimit).toBe(3);
    expect(atLimit.canFinalize).toBe(false);
    expect(atLimit.remainingInvoices).toBe(0);
  });

  it("clamps remainingInvoices at zero when the counter has overshot the limit", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({ subscriptions: [], period: periodRow(5) }); // FREE limit 3, 5 used

    const status = await getInvoiceQuotaStatus({ now: NOW });

    expect(status.usedInvoices).toBe(5);
    expect(status.remainingInvoices).toBe(0);
    expect(status.canFinalize).toBe(false);
  });

  it("applies the FREE limit to a PRO subscription whose endDate has passed", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({
      subscriptions: [
        subscriptionRow({ startDate: new Date(2026, 0, 1), endDate: new Date(2026, 1, 1) }), // lapsed
      ],
      period: periodRow(3),
    });

    const status = await getInvoiceQuotaStatus({ now: NOW });

    expect(status.planKey).toBe("FREE");
    expect(status.invoiceLimit).toBe(3); // not PRO's 50
    expect(status.canFinalize).toBe(false);
    expect(status.fallbackReason).toBe("ENDED");
  });

  it("treats a missing period as zero usage without creating one", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({ period: null });

    const status = await getInvoiceQuotaStatus({ now: NOW });

    expect(status.usedInvoices).toBe(0);
    expect(status.usagePeriodId).toBeNull();
    expect(status.remainingInvoices).toBe(50);
    expect(status.canFinalize).toBe(true);
  });

  // Explicit tuple type so `used` stays a number for the callback below.
  const WARNING_CASES: ReadonlyArray<[number, "OK" | "WARNING_80" | "REACHED"]> = [
    [0, "OK"],
    [39, "OK"], // 78% of 50
    [40, "WARNING_80"], // exactly 80% of 50
    [49, "WARNING_80"],
    [50, "REACHED"],
  ];

  it.each(WARNING_CASES)("reports warning level %s for %i of 50 used", async (used, expected) => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({ period: periodRow(used) });

    const status = await getInvoiceQuotaStatus({ now: NOW });

    expect(status.warningLevel).toBe(expected);
  });

  it("reads the current calendar-month bucket for the session account", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({ period: periodRow(1) });

    await getInvoiceQuotaStatus({ now: NOW });

    expect(prismaMock.usagePeriod.findUnique).toHaveBeenCalledWith({
      where: {
        accountId_periodStart_periodEnd: {
          accountId: "acc-1",
          periodStart: BOUNDS.periodStart,
          periodEnd: BOUNDS.periodEnd,
        },
      },
    });
  });

  it("is strictly read-only: it never creates, updates, or deletes a usage period", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({ period: periodRow(49) }); // one invoice short of the PRO limit

    await getInvoiceQuotaStatus({ now: NOW });

    expect(prismaMock.usagePeriod.create).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.delete).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.deleteMany).not.toHaveBeenCalled();
  });

  it("is read-only even when this month's bucket does not exist yet", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({ period: null });

    await getInvoiceQuotaStatus({ now: NOW });

    expect(prismaMock.usagePeriod.create).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();
  });

  it("scopes every query to the session account, ignoring smuggled options", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    mockDb({ period: periodRow(0) });

    await getInvoiceQuotaStatus({
      now: NOW,
      accountId: "acc-evil",
      usagePeriodId: "period-evil",
      invoiceLimit: 999,
    } as unknown as ResolveEntitlementsOptions);

    expect(prismaMock.subscription.findMany.mock.calls[0]?.[0].where).toEqual({ accountId: "acc-1" });
    expect(prismaMock.usagePeriod.findUnique.mock.calls[0]?.[0].where.accountId_periodStart_periodEnd.accountId).toBe(
      "acc-1",
    );
    expect((await getInvoiceQuotaStatus({ now: NOW })).invoiceLimit).toBe(50);
  });

  it("follows the session when a different account is signed in", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    requireSession.mockResolvedValue({ userId: "user-2", accountId: "acc-2" });
    mockDb({ period: periodRow(0, { accountId: "acc-2" }) });

    await getInvoiceQuotaStatus({ now: NOW });

    expect(prismaMock.usagePeriod.findUnique.mock.calls[0]?.[0].where.accountId_periodStart_periodEnd.accountId).toBe(
      "acc-2",
    );
  });

  it("resolves through a supplied transaction client instead of the global singleton", async () => {
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    const tx = {
      plan: { findUnique: vi.fn().mockResolvedValue(FREE_PLAN_ROW()) },
      subscription: { findMany: vi.fn().mockResolvedValue([subscriptionRow()]) },
      usagePeriod: { findUnique: vi.fn().mockResolvedValue(periodRow(20)) },
    };

    const status = await getInvoiceQuotaStatus({
      now: NOW,
      client: tx as unknown as ResolveEntitlementsOptions["client"],
    });

    expect(status.usedInvoices).toBe(20);
    expect(tx.usagePeriod.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.usagePeriod.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
  });

  it("propagates an invalid session without reading anything", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { getInvoiceQuotaStatus } = await import("./invoiceQuota");
    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(getInvoiceQuotaStatus({ now: NOW })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.usagePeriod.findUnique).not.toHaveBeenCalled();
  });
});
