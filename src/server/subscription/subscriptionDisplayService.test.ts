import { beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";

/**
 * Unit tests for the subscription display service. The Prisma singleton is
 * mocked (no PostgreSQL needed) and only the delegates the service uses are
 * stubbed — same style as `dashboardService.test.ts` and
 * `subscriptionPaymentService.test.ts`.
 *
 * The entitlement verdict itself (`resolveEntitlements`) and the quota line
 * (`getInvoiceQuotaStatus`) are mocked: their rules are covered by their own
 * test suites, and here we assert this service faithfully MAPS what they
 * return, orders/presents plans correctly, mirrors the checkout purchasable
 * guard, and never leaks raw Decimal/Date values into the DTO.
 */
const prismaMock = vi.hoisted(() => ({
  plan: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  subscriptionPayment: {
    findMany: vi.fn(),
  },
}));

const requireSession = vi.hoisted(() => vi.fn());
const resolveEntitlements = vi.hoisted(() => vi.fn());
const getInvoiceQuotaStatus = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Same treatment as the other service tests: do not importOriginal() —
// auth-options.ts throws at load time when GOOGLE_CLIENT_ID is unset.
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

vi.mock("@/server/entitlements/entitlementService", () => ({ resolveEntitlements }));
vi.mock("@/server/entitlements/invoiceQuota", () => ({ getInvoiceQuotaStatus }));

const SESSION = { userId: "user-1", accountId: "acc-1" };
const NOW = new Date("2026-09-11T12:00:00.000Z");

function freeFeatures() {
  return [
    { enabled: true, feature: { key: "PRINT", name: "چاپ", description: "چاپ فاکتور" } },
    { enabled: true, feature: { key: "DRAFT_INVOICES", name: "پیش‌فاکتور", description: "ذخیره پیش‌فاکتور" } },
  ];
}

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `plan-${overrides.key ?? "free"}`,
    key: "FREE",
    name: "رایگان",
    description: "برای شروع و آزمایش سامانه",
    price: new Decimal("0"),
    currency: "IRR",
    billingInterval: "MONTHLY",
    businessLimit: 1,
    invoiceLimit: 3,
    isActive: true,
    planFeatures: freeFeatures(),
    ...overrides,
  };
}

/** The resolver context for the realistic default: the bootstrap FREE baseline. */
function entitlementCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    accountId: "acc-1",
    plan: { planKey: "FREE", businessLimit: 1, invoiceLimit: 3, features: new Set(["PRINT"]) },
    freePlan: { planKey: "FREE", businessLimit: 1, invoiceLimit: 3, features: new Set(["PRINT"]) },
    subscription: { status: "ACTIVE" },
    subscriptionRecord: {
      id: "sub-free",
      planKey: "FREE",
      storedStatus: "ACTIVE",
      enforcedStatus: "ACTIVE",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: null,
    },
    hasEffectiveSubscription: true,
    fallbackReason: "NONE",
    businessLimit: 1,
    invoiceLimit: 3,
    features: new Set(["PRINT"]),
    resolvedAt: NOW,
    ...overrides,
  };
}

function quotaStatus(overrides: Record<string, unknown> = {}) {
  return {
    planKey: "FREE",
    invoiceLimit: 3,
    usedInvoices: 1,
    remainingInvoices: 2,
    canFinalize: true,
    warningLevel: "OK",
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-30T23:59:59.999Z"),
    usagePeriodId: "period-1",
    fallbackReason: "NONE",
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    provider: "sandbox",
    amount: new Decimal("990000"),
    currency: "IRR",
    status: "SUCCESS",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    verifiedAt: new Date("2026-09-01T10:05:00.000Z"),
    subscription: { plan: { key: "PRO", name: "حرفه‌ای" } },
    ...overrides,
  };
}

function allActivePlans() {
  // Deliberately out of display order — the service must sort them.
  return [
    planRow({ key: "PRO", id: "plan-pro", name: "حرفه‌ای", price: new Decimal("2970000"), businessLimit: 3, invoiceLimit: 50 }),
    planRow({ key: "FREE", id: "plan-free" }),
    planRow({ key: "BASIC", id: "plan-basic", name: "پایه", price: new Decimal("990000"), businessLimit: 1, invoiceLimit: 10 }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(SESSION);
  resolveEntitlements.mockResolvedValue(entitlementCtx());
  getInvoiceQuotaStatus.mockResolvedValue(quotaStatus());
  prismaMock.plan.findMany.mockResolvedValue(allActivePlans());
  prismaMock.plan.findUnique.mockResolvedValue(null);
  prismaMock.subscriptionPayment.findMany.mockResolvedValue([]);
});

describe("getSubscriptionDisplay", () => {
  it("rejects when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(getSubscriptionDisplay()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.plan.findMany).not.toHaveBeenCalled();
  });

  it("forwards one shared time source to the entitlement and quota resolvers", async () => {
    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");

    await getSubscriptionDisplay({ now: NOW });

    expect(resolveEntitlements).toHaveBeenCalledWith({ now: NOW, session: SESSION });
    expect(getInvoiceQuotaStatus).toHaveBeenCalledWith({ now: NOW, session: SESSION });
  });

  it("maps the FREE-baseline state: in-force current row, FREE effective plan, ordered plans", async () => {
    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    const data = await getSubscriptionDisplay({ now: NOW });

    expect(data.effectivePlanKey).toBe("FREE");
    expect(data.current).toEqual({
      id: "sub-free",
      planKey: "FREE",
      planName: "رایگان",
      planActive: true,
      storedStatus: "ACTIVE",
      enforcedStatus: "ACTIVE",
      inForce: true,
      fallbackReason: "NONE",
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: null,
      price: "0.00",
      currency: "IRR",
      businessLimit: 1,
      invoiceLimit: 3,
      features: [
        { key: "PRINT", name: "چاپ", description: "چاپ فاکتور" },
        { key: "DRAFT_INVOICES", name: "پیش‌فاکتور", description: "ذخیره پیش‌فاکتور" },
      ],
    });
    expect(data.quota).toEqual({
      usedInvoices: 1,
      invoiceLimit: 3,
      remainingInvoices: 2,
      warningLevel: "OK",
      periodEnd: "2026-09-30T23:59:59.999Z",
    });
  });

  it("sorts plans FREE → BASIC → PRO and mirrors the checkout purchasable guard", async () => {
    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    const data = await getSubscriptionDisplay();

    expect(data.plans.map((plan) => plan.key)).toEqual(["FREE", "BASIC", "PRO"]);
    // Granting FREE baseline: never purchasable itself, and it does NOT block
    // buying BASIC/PRO (the signup baseline is not a purchase).
    expect(data.plans[0]).toMatchObject({ key: "FREE", isCurrent: true, purchasable: false, notPurchasableReason: "FREE_PLAN", price: "0.00" });
    expect(data.plans[1]).toMatchObject({ key: "BASIC", isCurrent: false, purchasable: true, notPurchasableReason: null, price: "990000.00" });
    expect(data.plans[2]).toMatchObject({ key: "PRO", isCurrent: false, purchasable: true, notPurchasableReason: null, price: "2970000.00" });
  });

  it("refuses to purchase when a PAID plan is genuinely in force (mirrors SubscriptionAlreadyActiveError)", async () => {
    resolveEntitlements.mockResolvedValue(
      entitlementCtx({
        plan: { planKey: "BASIC", businessLimit: 1, invoiceLimit: 10, features: new Set(["PRINT"]) },
        subscription: { status: "ACTIVE" },
        subscriptionRecord: {
          id: "sub-basic",
          planKey: "BASIC",
          storedStatus: "ACTIVE",
          enforcedStatus: "ACTIVE",
          startDate: new Date("2026-09-01T00:00:00.000Z"),
          endDate: new Date("2026-10-01T00:00:00.000Z"),
        },
        hasEffectiveSubscription: true,
        fallbackReason: "NONE",
      }),
    );

    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    const data = await getSubscriptionDisplay();

    expect(data.effectivePlanKey).toBe("BASIC");
    expect(data.current?.inForce).toBe(true);
    expect(data.plans.find((plan) => plan.key === "FREE")).toMatchObject({ isCurrent: false, purchasable: false, notPurchasableReason: "FREE_PLAN" });
    expect(data.plans.find((plan) => plan.key === "BASIC")).toMatchObject({ isCurrent: true, purchasable: false, notPurchasableReason: "ACTIVE_PAID_SUBSCRIPTION" });
    expect(data.plans.find((plan) => plan.key === "PRO")).toMatchObject({ isCurrent: false, purchasable: false, notPurchasableReason: "ACTIVE_PAID_SUBSCRIPTION" });
  });

  it("re-opens purchases for a date-lapsed subscription (row says ACTIVE, window closed)", async () => {
    resolveEntitlements.mockResolvedValue(
      entitlementCtx({
        plan: { planKey: "FREE", businessLimit: 1, invoiceLimit: 3, features: new Set(["PRINT"]) },
        subscription: { status: "EXPIRED" },
        subscriptionRecord: {
          id: "sub-pro",
          planKey: "PRO",
          storedStatus: "ACTIVE",
          enforcedStatus: "EXPIRED",
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          endDate: new Date("2026-08-01T00:00:00.000Z"),
        },
        hasEffectiveSubscription: false,
        fallbackReason: "ENDED",
      }),
    );

    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    const data = await getSubscriptionDisplay({ now: NOW });

    expect(data.effectivePlanKey).toBe("FREE");
    expect(data.current).toMatchObject({
      planKey: "PRO",
      planName: "حرفه‌ای",
      storedStatus: "ACTIVE",
      enforcedStatus: "EXPIRED",
      inForce: false,
      fallbackReason: "ENDED",
      endDate: "2026-08-01T00:00:00.000Z",
    });
    // Lapsed → the paid plans are buyable again.
    expect(data.plans.find((plan) => plan.key === "BASIC")?.purchasable).toBe(true);
    expect(data.plans.find((plan) => plan.key === "PRO")?.purchasable).toBe(true);
  });

  it("returns a null current subscription when the account has no rows", async () => {
    resolveEntitlements.mockResolvedValue(
      entitlementCtx({ subscriptionRecord: null, hasEffectiveSubscription: false, fallbackReason: "NO_SUBSCRIPTION" }),
    );

    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    const data = await getSubscriptionDisplay();

    expect(data.current).toBeNull();
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
  });

  it("loads the plan row directly when the current plan was deactivated after purchase", async () => {
    const deactivated = planRow({ key: "PRO", id: "plan-pro", name: "حرفه‌ای", price: new Decimal("2970000"), isActive: false });
    resolveEntitlements.mockResolvedValue(
      entitlementCtx({
        subscription: { status: "EXPIRED" },
        subscriptionRecord: {
          id: "sub-pro",
          planKey: "PRO",
          storedStatus: "ACTIVE",
          enforcedStatus: "EXPIRED",
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          endDate: new Date("2026-08-01T00:00:00.000Z"),
        },
        hasEffectiveSubscription: false,
        fallbackReason: "PLAN_INACTIVE",
      }),
    );
    prismaMock.plan.findMany.mockResolvedValue(allActivePlans().filter((row) => row.key !== "PRO"));
    prismaMock.plan.findUnique.mockResolvedValue(deactivated);

    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    const data = await getSubscriptionDisplay();

    expect(prismaMock.plan.findUnique).toHaveBeenCalledWith({
      where: { key: "PRO" },
      include: { planFeatures: { where: { enabled: true }, include: { feature: true } } },
    });
    expect(data.current).toMatchObject({ planKey: "PRO", planName: "حرفه‌ای", planActive: false, price: "2970000.00" });
    // The deactivated plan must not appear in the upgrade grid.
    expect(data.plans.map((plan) => plan.key)).toEqual(["FREE", "BASIC"]);
  });

  it("throws on a missing plan row behind the current subscription (inconsistent data)", async () => {
    const { EntitlementDataError } = await import("@/server/errors");
    resolveEntitlements.mockResolvedValue(
      entitlementCtx({
        subscription: { status: "EXPIRED" },
        subscriptionRecord: {
          id: "sub-pro",
          planKey: "PRO",
          storedStatus: "ACTIVE",
          enforcedStatus: "EXPIRED",
          startDate: null,
          endDate: null,
        },
        hasEffectiveSubscription: false,
        fallbackReason: "PLAN_INACTIVE",
      }),
    );
    prismaMock.plan.findMany.mockResolvedValue(allActivePlans().filter((row) => row.key !== "PRO"));
    prismaMock.plan.findUnique.mockResolvedValue(null);

    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    await expect(getSubscriptionDisplay()).rejects.toBeInstanceOf(EntitlementDataError);
  });

  it("throws on an unknown plan key in the plans table", async () => {
    const { EntitlementDataError } = await import("@/server/errors");
    prismaMock.plan.findMany.mockResolvedValue(allActivePlans().concat(planRow({ key: "ULTRA", id: "plan-ultra" })));

    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    await expect(getSubscriptionDisplay()).rejects.toBeInstanceOf(EntitlementDataError);
  });

  it("maps payment history: money strings, plan join, newest-first query, null plan when the subscription is gone", async () => {
    prismaMock.subscriptionPayment.findMany.mockResolvedValue([
      paymentRow({ id: "pay-new", createdAt: new Date("2026-09-05T10:00:00.000Z"), status: "PENDING", verifiedAt: null, subscription: null }),
      paymentRow({ id: "pay-1", amount: new Decimal("990000") }),
      paymentRow({ id: "pay-0", createdAt: new Date("2026-08-01T10:00:00.000Z"), status: "REFUNDED" }),
    ]);

    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");
    const data = await getSubscriptionDisplay({ now: NOW, paymentHistoryLimit: 5 });

    expect(prismaMock.subscriptionPayment.findMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5,
      include: { subscription: { select: { plan: { select: { key: true, name: true } } } } },
    });
    expect(data.paymentHistory).toEqual([
      {
        id: "pay-new",
        planKey: null,
        planName: null,
        provider: "sandbox",
        amount: "990000.00",
        currency: "IRR",
        status: "PENDING",
        createdAt: "2026-09-05T10:00:00.000Z",
        verifiedAt: null,
      },
      {
        id: "pay-1",
        planKey: "PRO",
        planName: "حرفه‌ای",
        provider: "sandbox",
        amount: "990000.00",
        currency: "IRR",
        status: "SUCCESS",
        createdAt: "2026-09-01T10:00:00.000Z",
        verifiedAt: "2026-09-01T10:05:00.000Z",
      },
      {
        id: "pay-0",
        planKey: "PRO",
        planName: "حرفه‌ای",
        provider: "sandbox",
        amount: "990000.00",
        currency: "IRR",
        status: "REFUNDED",
        createdAt: "2026-08-01T10:00:00.000Z",
        verifiedAt: "2026-09-01T10:05:00.000Z",
      },
    ]);
  });

  it("clamps the history cap to the documented range (default 20, hard max 50)", async () => {
    const { getSubscriptionDisplay } = await import("./subscriptionDisplayService");

    await getSubscriptionDisplay();
    expect(prismaMock.subscriptionPayment.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 20 }),
    );

    await getSubscriptionDisplay({ paymentHistoryLimit: 999 });
    expect(prismaMock.subscriptionPayment.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 50 }),
    );

    await getSubscriptionDisplay({ paymentHistoryLimit: 0 });
    expect(prismaMock.subscriptionPayment.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });
});
