import { describe, it, expect } from "vitest";
import { toPlanContext, toSubscriptionContext } from "./planContext";

describe("toPlanContext", () => {
  it("maps the plan row limits and key onto the entitlement PlanContext", () => {
    const context = toPlanContext({
      key: "PRO",
      businessLimit: 3,
      invoiceLimit: 50,
      planFeatures: [
        { enabled: true, feature: { key: "MULTI_BUSINESS" } },
        { enabled: true, feature: { key: "ADVANCED_REPORTS" } },
      ],
    });

    expect(context).toEqual({
      planKey: "PRO",
      businessLimit: 3,
      invoiceLimit: 50,
      features: new Set(["MULTI_BUSINESS", "ADVANCED_REPORTS"]),
    });
  });

  it("grants only the features whose PlanFeature row is enabled", () => {
    const context = toPlanContext({
      key: "BASIC",
      businessLimit: 1,
      invoiceLimit: 10,
      planFeatures: [
        { enabled: true, feature: { key: "EMAIL_SEND" } },
        { enabled: false, feature: { key: "ADVANCED_REPORTS" } },
      ],
    });

    expect(context.features.has("EMAIL_SEND")).toBe(true);
    expect(context.features.has("ADVANCED_REPORTS")).toBe(false);
  });

  it("throws on a plan key this build does not know instead of guessing a limit", () => {
    expect(() =>
      toPlanContext({ key: "ENTERPRISE", businessLimit: 99, invoiceLimit: 999, planFeatures: [] }),
    ).toThrow(/Unknown plan key/);
  });
});

describe("toSubscriptionContext", () => {
  it("passes through the statuses the entitlement system understands", () => {
    expect(toSubscriptionContext("ACTIVE")).toEqual({ status: "ACTIVE" });
    expect(toSubscriptionContext("PAYMENT_FAILED")).toEqual({ status: "PAYMENT_FAILED" });
  });

  it("throws on an unknown subscription status", () => {
    expect(() => toSubscriptionContext("REFUNDED")).toThrow(/Unknown subscription status/);
  });
});
