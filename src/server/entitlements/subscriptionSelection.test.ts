import { describe, it, expect } from "vitest";
import {
  SUBSCRIPTION_ORDER_BY,
  enforcedSubscriptionContext,
  evaluateSubscriptionRow,
  selectCurrentSubscription,
} from "./subscriptionSelection";
import type { SubscriptionRowWithPlan } from "./subscriptionSelection";

/**
 * Pure tests for the "which subscription is current?" rule. No Prisma, no
 * session, no mocking: `subscriptionSelection.ts` only reads rows it is handed.
 *
 * Dates are fixed to keep the assertions independent of the wall clock.
 */

const NOW = new Date("2026-03-15T12:00:00.000Z");
const MONTH_START = new Date("2026-03-01T00:00:00.000Z");
const MONTH_END = new Date("2026-04-01T00:00:00.000Z");

interface PlanOverrides {
  key?: string;
  isActive?: boolean;
  businessLimit?: number;
  invoiceLimit?: number;
  features?: string[];
}

function plan(overrides: PlanOverrides = {}) {
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

interface SubscriptionOverrides {
  id?: string;
  status?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  createdAt?: Date;
  plan?: ReturnType<typeof plan>;
}

/** A row whose paid window covers NOW unless overridden. */
function subscriptionRow(overrides: SubscriptionOverrides = {}): SubscriptionRowWithPlan {
  return {
    id: "sub-1",
    status: "ACTIVE",
    startDate: MONTH_START,
    endDate: MONTH_END,
    createdAt: MONTH_START,
    plan: plan(),
    ...overrides,
  };
}

describe("SUBSCRIPTION_ORDER_BY", () => {
  it("is newest-first with deterministic tie-breakers", () => {
    expect(SUBSCRIPTION_ORDER_BY).toEqual([
      { startDate: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });
});

describe("evaluateSubscriptionRow", () => {
  it("marks an in-force row on an active plan as granting paid access", () => {
    const evaluation = evaluateSubscriptionRow(subscriptionRow(), NOW);
    expect(evaluation.grantsPaidAccess).toBe(true);
    expect(evaluation.effectiveness.inForce).toBe(true);
    expect(evaluation.storedStatus).toBe("ACTIVE");
    expect(evaluation.planActive).toBe(true);
  });

  it("marks an ACTIVE row past its endDate as not granting, without changing the stored status", () => {
    const evaluation = evaluateSubscriptionRow(
      subscriptionRow({ startDate: new Date("2026-01-01"), endDate: new Date("2026-02-01") }),
      NOW,
    );
    expect(evaluation.grantsPaidAccess).toBe(false);
    expect(evaluation.effectiveness.lapse).toBe("ENDED");
    expect(evaluation.effectiveness.status).toBe("EXPIRED");
    expect(evaluation.storedStatus).toBe("ACTIVE"); // what the row says, for diagnostics
  });

  it("marks a row on a deactivated plan as not granting, even inside its window", () => {
    const evaluation = evaluateSubscriptionRow(subscriptionRow({ plan: plan({ isActive: false }) }), NOW);
    expect(evaluation.effectiveness.inForce).toBe(true);
    expect(evaluation.planActive).toBe(false);
    expect(evaluation.grantsPaidAccess).toBe(false);
  });

  it("reads a missing isActive (partial select) as not deactivated", () => {
    const evaluation = evaluateSubscriptionRow({ id: "sub-1", status: "ACTIVE" }, NOW);
    expect(evaluation.planActive).toBe(true);
    expect(evaluation.grantsPaidAccess).toBe(true);
  });

  it("throws on a subscription status this build does not know rather than guessing", () => {
    expect(() => evaluateSubscriptionRow(subscriptionRow({ status: "REFUNDED" }), NOW)).toThrow(
      /Unknown subscription status/,
    );
  });
});

describe("selectCurrentSubscription", () => {
  it("selects the in-force subscription and reports no fallback", () => {
    const row = subscriptionRow();
    const selection = selectCurrentSubscription([row], NOW);
    expect(selection.selected).toBe(row);
    expect(selection.granting).toBe(row);
    expect(selection.reason).toBe("NONE");
  });

  it("reports NO_SUBSCRIPTION when the account has no rows at all", () => {
    const selection = selectCurrentSubscription([], NOW);
    expect(selection).toEqual({ selected: null, granting: null, evaluation: null, reason: "NO_SUBSCRIPTION" });
  });

  it("demotes an ACTIVE row whose endDate has passed", () => {
    const selection = selectCurrentSubscription(
      [subscriptionRow({ startDate: new Date("2026-01-01"), endDate: new Date("2026-02-01") })],
      NOW,
    );
    expect(selection.granting).toBeNull();
    expect(selection.reason).toBe("ENDED");
  });

  it("demotes a row whose startDate is still in the future", () => {
    const selection = selectCurrentSubscription(
      [subscriptionRow({ startDate: new Date("2026-04-01"), endDate: new Date("2026-05-01") })],
      NOW,
    );
    expect(selection.granting).toBeNull();
    expect(selection.reason).toBe("NOT_STARTED");
  });

  it("demotes an impossible window", () => {
    const selection = selectCurrentSubscription(
      [subscriptionRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-05-01") })],
      NOW,
    );
    expect(selection.reason).toBe("INCONSISTENT_WINDOW");
  });

  it.each([
    ["PENDING", "STATUS_PENDING"],
    ["EXPIRED", "STATUS_EXPIRED"],
    ["CANCELLED", "STATUS_CANCELLED"],
    ["PAYMENT_FAILED", "STATUS_PAYMENT_FAILED"],
  ])("reports %s as %s", (status, reason) => {
    const selection = selectCurrentSubscription([subscriptionRow({ status })], NOW);
    expect(selection.granting).toBeNull();
    expect(selection.reason).toBe(reason);
  });

  it("reports PLAN_INACTIVE for an in-force row on a deactivated plan", () => {
    const selection = selectCurrentSubscription(
      [subscriptionRow({ plan: plan({ isActive: false }) })],
      NOW,
    );
    expect(selection.granting).toBeNull();
    expect(selection.reason).toBe("PLAN_INACTIVE");
  });

  it("prefers an older in-force subscription over a newer lapsed one", () => {
    const lapsed = subscriptionRow({
      id: "sub-new",
      startDate: new Date("2026-03-01"),
      endDate: new Date("2026-03-10"),
      createdAt: new Date("2026-03-01"),
    });
    const inForce = subscriptionRow({
      id: "sub-old",
      startDate: new Date("2026-02-01"),
      endDate: new Date("2027-02-01"),
      createdAt: new Date("2026-02-01"),
    });

    // Rows arrive newest-first, exactly as SUBSCRIPTION_ORDER_BY returns them.
    const selection = selectCurrentSubscription([lapsed, inForce], NOW);
    expect(selection.selected?.id).toBe("sub-old");
    expect(selection.granting?.id).toBe("sub-old");
    expect(selection.reason).toBe("NONE");
  });

  it("skips a newer row on a deactivated plan in favour of an older valid one", () => {
    const retired = subscriptionRow({ id: "sub-new", plan: plan({ key: "PRO", isActive: false }) });
    const valid = subscriptionRow({
      id: "sub-old",
      plan: plan({ key: "BASIC", businessLimit: 1, invoiceLimit: 10 }),
      startDate: new Date("2026-02-01"),
      endDate: new Date("2027-02-01"),
    });

    const selection = selectCurrentSubscription([retired, valid], NOW);
    expect(selection.granting?.id).toBe("sub-old");
    expect(selection.reason).toBe("NONE");
  });

  it("still returns the newest row when nothing grants, so callers can report and reference it", () => {
    const newest = subscriptionRow({ id: "sub-new", status: "CANCELLED" });
    const older = subscriptionRow({ id: "sub-old", status: "EXPIRED" });

    const selection = selectCurrentSubscription([newest, older], NOW);
    expect(selection.selected?.id).toBe("sub-new");
    expect(selection.granting).toBeNull();
    expect(selection.reason).toBe("STATUS_CANCELLED");
    expect(selection.evaluation?.storedStatus).toBe("CANCELLED");
  });
});

describe("enforcedSubscriptionContext", () => {
  it("is ACTIVE only when a subscription genuinely grants paid access", () => {
    const selection = selectCurrentSubscription([subscriptionRow()], NOW);
    expect(enforcedSubscriptionContext(selection)).toEqual({ status: "ACTIVE" });
  });

  it("demotes a date-lapsed ACTIVE row to EXPIRED so effectivePlan falls back to Free", () => {
    const selection = selectCurrentSubscription(
      [subscriptionRow({ startDate: new Date("2026-01-01"), endDate: new Date("2026-02-01") })],
      NOW,
    );
    expect(enforcedSubscriptionContext(selection)).toEqual({ status: "EXPIRED" });
  });

  it("demotes a not-yet-started ACTIVE row to PENDING", () => {
    const selection = selectCurrentSubscription(
      [subscriptionRow({ startDate: new Date("2026-04-01"), endDate: new Date("2026-05-01") })],
      NOW,
    );
    expect(enforcedSubscriptionContext(selection)).toEqual({ status: "PENDING" });
  });

  it("demotes an in-force row on a deactivated plan, which the stored status alone would not catch", () => {
    const selection = selectCurrentSubscription(
      [subscriptionRow({ plan: plan({ isActive: false }) })],
      NOW,
    );
    expect(selection.evaluation?.effectiveness.status).toBe("ACTIVE"); // in force by date...
    expect(enforcedSubscriptionContext(selection)).toEqual({ status: "EXPIRED" }); // ...but grants nothing
  });

  it("passes a non-ACTIVE stored status through", () => {
    const selection = selectCurrentSubscription([subscriptionRow({ status: "PAYMENT_FAILED" })], NOW);
    expect(enforcedSubscriptionContext(selection)).toEqual({ status: "PAYMENT_FAILED" });
  });

  it("is EXPIRED when the account has no subscription row", () => {
    expect(enforcedSubscriptionContext(selectCurrentSubscription([], NOW))).toEqual({ status: "EXPIRED" });
  });
});
