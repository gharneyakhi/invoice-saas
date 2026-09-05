import { describe, it, expect, vi, beforeEach } from "vitest";
import { EntitlementDataError } from "@/server/errors";
import type { ResolveEntitlementsOptions } from "./entitlementService";

/**
 * Unit tests for the server-side entitlement resolver, in the same style as
 * `src/server/business/businessService.test.ts` and
 * `src/server/auth/requireBusinessOwnership.test.ts`: the Prisma singleton is
 * mocked (no PostgreSQL needed) and the session is mocked, while the *real*
 * pure entitlement logic and the real subscription-selection rule run against
 * those mocked rows.
 */
const prismaMock = vi.hoisted(() => ({
  plan: { findUnique: vi.fn() },
  subscription: { findMany: vi.fn() },
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

// Do not importOriginal() this module: it pulls auth-options.ts, which throws
// at load time when GOOGLE_CLIENT_ID is unset (same sandbox constraint the
// other server tests document).
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
  return { UnauthorizedError, ForbiddenError, requireSession };
});

const SESSION = { userId: "user-1", accountId: "acc-1" };
const NOW = new Date("2026-03-15T12:00:00.000Z");
const MONTH_START = new Date("2026-03-01T00:00:00.000Z");
const MONTH_END = new Date("2026-04-01T00:00:00.000Z");

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

/** The seeded FREE baseline (prisma/seed.ts): 1 business, 3 invoices. */
const FREE_PLAN_ROW = () => planRow({ key: "FREE", businessLimit: 1, invoiceLimit: 3, features: ["PDF_EXPORT"] });
const PRO_PLAN_ROW = () => planRow({ key: "PRO", businessLimit: 3, invoiceLimit: 50, features: ["ADVANCED_REPORTS"] });

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
    startDate: MONTH_START,
    endDate: MONTH_END,
    createdAt: MONTH_START,
    plan: PRO_PLAN_ROW(),
    ...overrides,
  };
}

/** Wires the two queries the resolver makes. `free: null` simulates an unseeded FREE plan. */
function mockRows(
  { free, subscriptions }: { free?: ReturnType<typeof planRow> | null; subscriptions?: unknown[] } = {},
) {
  prismaMock.plan.findUnique.mockResolvedValue(free === undefined ? FREE_PLAN_ROW() : free);
  prismaMock.subscription.findMany.mockResolvedValue(subscriptions ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(SESSION);
});

describe("resolveEntitlements", () => {
  it("resolves the account's own plan when the subscription is genuinely in force", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({ subscriptions: [subscriptionRow()] });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.userId).toBe("user-1");
    expect(context.accountId).toBe("acc-1");
    expect(context.plan.planKey).toBe("PRO");
    expect(context.hasEffectiveSubscription).toBe(true);
    expect(context.fallbackReason).toBe("NONE");
    expect(context.subscription).toEqual({ status: "ACTIVE" });
    expect(context.resolvedAt).toEqual(NOW);
  });

  it("takes every limit and feature from the database rows, never from this module", async () => {
    const { resolveEntitlements } = await import("./entitlementService");

    // Deliberately un-seeded numbers: if anything were hard-coded here, these
    // assertions would fail.
    mockRows({
      free: planRow({ key: "FREE", businessLimit: 1, invoiceLimit: 4, features: ["PDF_EXPORT"] }),
      subscriptions: [
        subscriptionRow({
          plan: planRow({ key: "PRO", businessLimit: 7, invoiceLimit: 42, features: ["ADVANCED_REPORTS", "EMAIL_SEND"] }),
        }),
      ],
    });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.businessLimit).toBe(7);
    expect(context.invoiceLimit).toBe(42);
    expect(context.plan.businessLimit).toBe(7);
    expect(context.plan.invoiceLimit).toBe(42);
    expect(context.features.has("EMAIL_SEND")).toBe(true);
    expect(context.freePlan.invoiceLimit).toBe(4);
  });

  it("only counts PlanFeature rows that are enabled", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({
      subscriptions: [
        subscriptionRow({
          plan: {
            ...PRO_PLAN_ROW(),
            planFeatures: [
              { enabled: true, feature: { key: "ADVANCED_REPORTS" } },
              { enabled: false, feature: { key: "EMAIL_SEND" } },
            ],
          },
        }),
      ],
    });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.features.has("ADVANCED_REPORTS")).toBe(true);
    expect(context.features.has("EMAIL_SEND")).toBe(false);
  });

  it.each(["PENDING", "EXPIRED", "CANCELLED", "PAYMENT_FAILED"])(
    "falls back to the seeded FREE plan when the stored status is %s",
    async (status) => {
      const { resolveEntitlements } = await import("./entitlementService");
      mockRows({ subscriptions: [subscriptionRow({ status })] });

      const context = await resolveEntitlements({ now: NOW });

      expect(context.plan.planKey).toBe("FREE");
      expect(context.invoiceLimit).toBe(3);
      expect(context.businessLimit).toBe(1);
      expect(context.hasEffectiveSubscription).toBe(false);
      expect(context.subscription).not.toEqual({ status: "ACTIVE" });
    },
  );

  it("falls back to FREE when the row says ACTIVE but endDate has already passed", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({
      subscriptions: [
        subscriptionRow({ startDate: new Date("2026-01-01"), endDate: new Date("2026-02-01") }),
      ],
    });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.plan.planKey).toBe("FREE");
    expect(context.hasEffectiveSubscription).toBe(false);
    expect(context.fallbackReason).toBe("ENDED");
    // Diagnostics keep both views: what the row says, and what was enforced.
    expect(context.subscriptionRecord?.storedStatus).toBe("ACTIVE");
    expect(context.subscriptionRecord?.enforcedStatus).toBe("EXPIRED");
  });

  it("falls back to FREE when the row says ACTIVE but has not started yet", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({
      subscriptions: [
        subscriptionRow({ startDate: new Date("2026-04-01"), endDate: new Date("2026-05-01") }),
      ],
    });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.plan.planKey).toBe("FREE");
    expect(context.fallbackReason).toBe("NOT_STARTED");
    expect(context.subscriptionRecord?.enforcedStatus).toBe("PENDING");
  });

  it("falls back to FREE when the account has no subscription row at all", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({ subscriptions: [] });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.plan.planKey).toBe("FREE");
    expect(context.subscriptionRecord).toBeNull();
    expect(context.hasEffectiveSubscription).toBe(false);
    expect(context.fallbackReason).toBe("NO_SUBSCRIPTION");
    expect(context.subscription).toEqual({ status: "EXPIRED" });
  });

  it("falls back to FREE when the plan row has been deactivated, even inside its window", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({ subscriptions: [subscriptionRow({ plan: { ...PRO_PLAN_ROW(), isActive: false } })] });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.plan.planKey).toBe("FREE");
    expect(context.fallbackReason).toBe("PLAN_INACTIVE");
    expect(context.subscriptionRecord?.storedStatus).toBe("ACTIVE");
    expect(context.subscriptionRecord?.enforcedStatus).toBe("EXPIRED");
  });

  it("keeps an older in-force subscription when the newest one has lapsed", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({
      subscriptions: [
        // Newest-first, as SUBSCRIPTION_ORDER_BY returns them.
        subscriptionRow({
          id: "sub-new",
          startDate: new Date("2026-03-01"),
          endDate: new Date("2026-03-10"),
          createdAt: new Date("2026-03-01"),
        }),
        subscriptionRow({
          id: "sub-old",
          startDate: new Date("2026-02-01"),
          endDate: new Date("2027-02-01"),
          createdAt: new Date("2026-02-01"),
          plan: planRow({ key: "BASIC", businessLimit: 1, invoiceLimit: 10, features: ["EMAIL_SEND"] }),
        }),
      ],
    });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.subscriptionRecord?.id).toBe("sub-old");
    expect(context.plan.planKey).toBe("BASIC");
    expect(context.hasEffectiveSubscription).toBe(true);
    expect(context.fallbackReason).toBe("NONE");
  });

  it("is time-driven: the same rows resolve differently for a different `now`", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({ subscriptions: [subscriptionRow()] });

    const inside = await resolveEntitlements({ now: NOW });
    const after = await resolveEntitlements({ now: new Date("2026-05-01T00:00:00.000Z") });

    expect(inside.plan.planKey).toBe("PRO");
    expect(after.plan.planKey).toBe("FREE");
    expect(after.fallbackReason).toBe("ENDED");
  });

  it("throws EntitlementDataError instead of guessing when the FREE plan is not seeded", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({ free: null, subscriptions: [subscriptionRow()] });

    await expect(resolveEntitlements({ now: NOW })).rejects.toBeInstanceOf(EntitlementDataError);
    await expect(resolveEntitlements({ now: NOW })).rejects.toThrow(/FREE plan is not seeded/);
    expect(prismaMock.subscription.findMany).not.toHaveBeenCalled();
  });

  it("propagates an invalid session without touching the database", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { resolveEntitlements } = await import("./entitlementService");
    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(resolveEntitlements({ now: NOW })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.subscription.findMany).not.toHaveBeenCalled();
  });
});

describe("resolveEntitlements — account scoping and trust boundary", () => {
  it("loads the FREE plan by key and subscriptions only for the session account", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows();

    await resolveEntitlements({ now: NOW });

    expect(prismaMock.plan.findUnique).toHaveBeenCalledWith({
      where: { key: "FREE" },
      include: { planFeatures: { include: { feature: true } } },
    });
    expect(prismaMock.subscription.findMany.mock.calls[0]?.[0].where).toEqual({ accountId: "acc-1" });
  });

  it("follows the session, not any argument: a different session queries a different account", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    requireSession.mockResolvedValue({ userId: "user-2", accountId: "acc-2" });
    mockRows();

    const context = await resolveEntitlements({ now: NOW });

    expect(context.accountId).toBe("acc-2");
    expect(prismaMock.subscription.findMany.mock.calls[0]?.[0].where).toEqual({ accountId: "acc-2" });
  });

  it("ignores an accountId or planKey smuggled into the options object", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    mockRows({ subscriptions: [subscriptionRow()] });

    // A JS caller can still hand us extra keys; nothing may select an account,
    // a subscription, or a plan.
    await resolveEntitlements({
      now: NOW,
      accountId: "acc-evil",
      subscriptionId: "sub-evil",
      planKey: "PRO",
      status: "ACTIVE",
    } as unknown as Parameters<typeof resolveEntitlements>[0]);

    expect(prismaMock.subscription.findMany.mock.calls[0]?.[0].where).toEqual({ accountId: "acc-1" });
    expect(prismaMock.plan.findUnique).toHaveBeenCalledWith({
      where: { key: "FREE" },
      include: { planFeatures: { include: { feature: true } } },
    });
  });

  it("cannot be talked into a paid plan by a Free account's input", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    // The account's only row is an expired FREE subscription.
    mockRows({
      subscriptions: [
        subscriptionRow({ status: "EXPIRED", plan: planRow({ key: "FREE", businessLimit: 1, invoiceLimit: 3 }) }),
      ],
    });

    const context = await resolveEntitlements({
      now: NOW,
      plan: { planKey: "PRO", businessLimit: 99, invoiceLimit: 999, features: new Set<string>() },
    } as unknown as Parameters<typeof resolveEntitlements>[0]);

    expect(context.plan.planKey).toBe("FREE");
    expect(context.invoiceLimit).toBe(3);
    expect(context.features.has("ADVANCED_REPORTS")).toBe(false);
  });

  it("resolves through a supplied transaction client instead of the global singleton", async () => {
    const { resolveEntitlements } = await import("./entitlementService");
    const tx = {
      plan: { findUnique: vi.fn().mockResolvedValue(FREE_PLAN_ROW()) },
      subscription: { findMany: vi.fn().mockResolvedValue([subscriptionRow()]) },
    };

    const context = await resolveEntitlements({
      now: NOW,
      // A hand-rolled double stands in for a `$transaction` client; the cast is
      // test-only and keeps the source signature honest.
      client: tx as unknown as ResolveEntitlementsOptions["client"],
    });

    expect(context.plan.planKey).toBe("PRO");
    expect(tx.plan.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.subscription.findMany.mock.calls[0]?.[0].where).toEqual({ accountId: "acc-1" });
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.subscription.findMany).not.toHaveBeenCalled();
  });
});

describe("entitlement context helpers", () => {
  it("entitlementCanCreateBusiness applies the effective plan's business limit", async () => {
    const { resolveEntitlements, entitlementCanCreateBusiness } = await import("./entitlementService");
    mockRows({ subscriptions: [subscriptionRow()] }); // PRO, limit 3

    const context = await resolveEntitlements({ now: NOW });

    expect(entitlementCanCreateBusiness(context, { currentBusinessCount: 2, currentPeriodInvoiceCount: 0 })).toBe(true);
    expect(entitlementCanCreateBusiness(context, { currentBusinessCount: 3, currentPeriodInvoiceCount: 0 })).toBe(false);
  });

  it("entitlementCanCreateBusiness drops to the FREE limit once the subscription lapses", async () => {
    const { resolveEntitlements, entitlementCanCreateBusiness } = await import("./entitlementService");
    mockRows({
      subscriptions: [subscriptionRow({ startDate: new Date("2026-01-01"), endDate: new Date("2026-02-01") })],
    });

    const context = await resolveEntitlements({ now: NOW });

    expect(context.plan.planKey).toBe("FREE");
    expect(entitlementCanCreateBusiness(context, { currentBusinessCount: 1, currentPeriodInvoiceCount: 0 })).toBe(false);
  });

  it("entitlementHasFeature follows the effective plan's feature set", async () => {
    const { resolveEntitlements, entitlementHasFeature } = await import("./entitlementService");
    mockRows({ subscriptions: [subscriptionRow()] });

    const context = await resolveEntitlements({ now: NOW });

    expect(entitlementHasFeature(context, "ADVANCED_REPORTS")).toBe(true);
    expect(entitlementHasFeature(context, "NOT_A_REAL_FEATURE")).toBe(false);
  });
});
