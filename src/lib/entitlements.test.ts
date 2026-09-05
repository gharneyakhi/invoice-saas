import { describe, it, expect } from "vitest";
import type { PlanContext, SubscriptionContext, UsageContext } from "./entitlements";
import {
  canCreateBusiness,
  canDuplicateInvoice,
  canExportExcel,
  canFinalizeInvoice,
  canSendEmail,
  canUseAdvancedReports,
  canUsePartialPayments,
  effectivePlan,
  evaluateSubscription,
  hasFeature,
  invoiceQuotaWarningLevel,
} from "./entitlements";

/**
 * Direct unit tests for the centralized entitlement system (section 45).
 *
 * The module is pure — no Prisma, no session, no env — so these import it
 * directly with no mocking at all.
 *
 * The plan fixtures mirror `prisma/seed.ts`, which is the single source of the
 * numbers (FREE 1 business / 3 invoices, BASIC 1 / 10, PRO 3 / 50). They are
 * restated here as *inputs*, not re-implemented as logic: every assertion below
 * still goes through the functions under test.
 */

const FREE: PlanContext = {
  planKey: "FREE",
  businessLimit: 1,
  invoiceLimit: 3,
  features: new Set(["PDF_EXPORT", "PRINT", "IMAGE_EXPORT", "PROFORMA", "DRAFT_INVOICES"]),
};

const BASIC: PlanContext = {
  planKey: "BASIC",
  businessLimit: 1,
  invoiceLimit: 10,
  features: new Set([
    "PDF_EXPORT",
    "PRINT",
    "IMAGE_EXPORT",
    "EXCEL_EXPORT",
    "EMAIL_SEND",
    "PROFORMA",
    "DRAFT_INVOICES",
    "INVOICE_DUPLICATION",
  ]),
};

const PRO: PlanContext = {
  planKey: "PRO",
  businessLimit: 3,
  invoiceLimit: 50,
  features: new Set([
    "PDF_EXPORT",
    "PRINT",
    "IMAGE_EXPORT",
    "EXCEL_EXPORT",
    "EMAIL_SEND",
    "PROFORMA",
    "DRAFT_INVOICES",
    "INVOICE_DUPLICATION",
    "MULTI_BUSINESS",
    "ADVANCED_REPORTS",
    "PARTIAL_PAYMENTS",
    "PAYMENT_REMINDERS",
    "RECURRING_INVOICES",
  ]),
};

const ACTIVE: SubscriptionContext = { status: "ACTIVE" };
const NON_ACTIVE_STATUSES = ["PENDING", "EXPIRED", "CANCELLED", "PAYMENT_FAILED"] as const;

const usage = (currentBusinessCount: number, currentPeriodInvoiceCount: number): UsageContext => ({
  currentBusinessCount,
  currentPeriodInvoiceCount,
});

describe("effectivePlan", () => {
  it("returns the account's own plan when the subscription is ACTIVE", () => {
    expect(effectivePlan(PRO, ACTIVE, FREE)).toBe(PRO);
    expect(effectivePlan(BASIC, ACTIVE, FREE)).toBe(BASIC);
  });

  it.each(NON_ACTIVE_STATUSES)("falls back to Free when the subscription is %s", (status) => {
    expect(effectivePlan(PRO, { status }, FREE)).toBe(FREE);
  });

  it("returns Free when the stored plan is already Free (fallback is a no-op, not an error)", () => {
    expect(effectivePlan(FREE, ACTIVE, FREE)).toBe(FREE);
    expect(effectivePlan(FREE, { status: "CANCELLED" }, FREE)).toBe(FREE);
  });

  it("never widens a lapsed subscription to the paid plan's limits", () => {
    const effective = effectivePlan(PRO, { status: "PAYMENT_FAILED" }, FREE);
    expect(effective.invoiceLimit).toBe(FREE.invoiceLimit);
    expect(effective.businessLimit).toBe(FREE.businessLimit);
    expect(effective.features.has("ADVANCED_REPORTS")).toBe(false);
  });
});

describe("canCreateBusiness", () => {
  it("allows creation while below the plan's business limit", () => {
    expect(canCreateBusiness(FREE, ACTIVE, FREE, usage(0, 0))).toBe(true);
    expect(canCreateBusiness(PRO, ACTIVE, FREE, usage(0, 0))).toBe(true);
    expect(canCreateBusiness(PRO, ACTIVE, FREE, usage(2, 0))).toBe(true);
  });

  it.each([
    ["FREE", FREE, 1],
    ["BASIC", BASIC, 1],
    ["PRO", PRO, 3],
  ])("rejects the %s plan at its seeded limit of %i business(es)", (_key, plan, limit) => {
    expect(canCreateBusiness(plan, ACTIVE, FREE, usage(limit, 0))).toBe(false);
    expect(canCreateBusiness(plan, ACTIVE, FREE, usage(limit + 1, 0))).toBe(false);
  });

  it("applies the FREE limit to a PRO subscription that is not ACTIVE", () => {
    expect(canCreateBusiness(PRO, { status: "EXPIRED" }, FREE, usage(1, 0))).toBe(false);
    expect(canCreateBusiness(PRO, { status: "CANCELLED" }, FREE, usage(0, 0))).toBe(true);
  });

  it("is unaffected by the invoice counter", () => {
    expect(canCreateBusiness(PRO, ACTIVE, FREE, usage(0, 999))).toBe(true);
  });
});

describe("canFinalizeInvoice", () => {
  it("allows finalizing while below the plan's monthly invoice limit", () => {
    expect(canFinalizeInvoice(FREE, ACTIVE, FREE, usage(0, 0))).toBe(true);
    expect(canFinalizeInvoice(FREE, ACTIVE, FREE, usage(0, 2))).toBe(true);
    expect(canFinalizeInvoice(PRO, ACTIVE, FREE, usage(0, 49))).toBe(true);
  });

  it.each([
    ["FREE", FREE, 3],
    ["BASIC", BASIC, 10],
    ["PRO", PRO, 50],
  ])("rejects the %s plan at its seeded limit of %i finalized invoice(s)", (_key, plan, limit) => {
    expect(canFinalizeInvoice(plan, ACTIVE, FREE, usage(0, limit))).toBe(false);
    expect(canFinalizeInvoice(plan, ACTIVE, FREE, usage(0, limit + 1))).toBe(false);
  });

  it("applies the FREE limit to a PRO subscription that is not ACTIVE", () => {
    expect(canFinalizeInvoice(PRO, { status: "EXPIRED" }, FREE, usage(0, 3))).toBe(false);
    expect(canFinalizeInvoice(PRO, { status: "PAYMENT_FAILED" }, FREE, usage(0, 4))).toBe(false);
  });

  it("is unaffected by the business counter", () => {
    expect(canFinalizeInvoice(FREE, ACTIVE, FREE, usage(99, 0))).toBe(true);
  });
});

describe("hasFeature", () => {
  it("grants a feature the effective plan has", () => {
    expect(hasFeature("EMAIL_SEND", BASIC, ACTIVE, FREE)).toBe(true);
    expect(hasFeature("ADVANCED_REPORTS", PRO, ACTIVE, FREE)).toBe(true);
    expect(hasFeature("PDF_EXPORT", FREE, ACTIVE, FREE)).toBe(true);
  });

  it("refuses a feature the effective plan does not have", () => {
    expect(hasFeature("EMAIL_SEND", FREE, ACTIVE, FREE)).toBe(false);
    expect(hasFeature("ADVANCED_REPORTS", BASIC, ACTIVE, FREE)).toBe(false);
    expect(hasFeature("MULTI_BUSINESS", BASIC, ACTIVE, FREE)).toBe(false);
  });

  it("refuses an unknown feature key on every plan", () => {
    expect(hasFeature("NOT_A_REAL_FEATURE", PRO, ACTIVE, FREE)).toBe(false);
    expect(hasFeature("", PRO, ACTIVE, FREE)).toBe(false);
  });

  it("falls back to the FREE feature set when the subscription is not ACTIVE", () => {
    expect(hasFeature("ADVANCED_REPORTS", PRO, { status: "CANCELLED" }, FREE)).toBe(false);
    expect(hasFeature("EMAIL_SEND", BASIC, { status: "EXPIRED" }, FREE)).toBe(false);
    expect(hasFeature("PDF_EXPORT", PRO, { status: "EXPIRED" }, FREE)).toBe(true);
  });
});

describe("named feature wrappers", () => {
  it("canUseAdvancedReports follows ADVANCED_REPORTS (PRO only)", () => {
    expect(canUseAdvancedReports(PRO, ACTIVE, FREE)).toBe(true);
    expect(canUseAdvancedReports(BASIC, ACTIVE, FREE)).toBe(false);
    expect(canUseAdvancedReports(FREE, ACTIVE, FREE)).toBe(false);
    expect(canUseAdvancedReports(PRO, { status: "EXPIRED" }, FREE)).toBe(false);
  });

  it("canSendEmail follows EMAIL_SEND (BASIC and PRO)", () => {
    expect(canSendEmail(BASIC, ACTIVE, FREE)).toBe(true);
    expect(canSendEmail(PRO, ACTIVE, FREE)).toBe(true);
    expect(canSendEmail(FREE, ACTIVE, FREE)).toBe(false);
    expect(canSendEmail(PRO, { status: "PAYMENT_FAILED" }, FREE)).toBe(false);
  });

  it("canUsePartialPayments follows PARTIAL_PAYMENTS (PRO only)", () => {
    expect(canUsePartialPayments(PRO, ACTIVE, FREE)).toBe(true);
    expect(canUsePartialPayments(BASIC, ACTIVE, FREE)).toBe(false);
    expect(canUsePartialPayments(PRO, { status: "CANCELLED" }, FREE)).toBe(false);
  });

  it("canExportExcel follows EXCEL_EXPORT (BASIC and PRO)", () => {
    expect(canExportExcel(BASIC, ACTIVE, FREE)).toBe(true);
    expect(canExportExcel(PRO, ACTIVE, FREE)).toBe(true);
    expect(canExportExcel(FREE, ACTIVE, FREE)).toBe(false);
    expect(canExportExcel(BASIC, { status: "PENDING" }, FREE)).toBe(false);
  });

  it("canDuplicateInvoice follows INVOICE_DUPLICATION (BASIC and PRO)", () => {
    expect(canDuplicateInvoice(BASIC, ACTIVE, FREE)).toBe(true);
    expect(canDuplicateInvoice(PRO, ACTIVE, FREE)).toBe(true);
    expect(canDuplicateInvoice(FREE, ACTIVE, FREE)).toBe(false);
    expect(canDuplicateInvoice(PRO, { status: "EXPIRED" }, FREE)).toBe(false);
  });
});

describe("invoiceQuotaWarningLevel", () => {
  it("is OK at 0% usage", () => {
    expect(invoiceQuotaWarningLevel(usage(0, 0), FREE)).toBe("OK");
    expect(invoiceQuotaWarningLevel(usage(0, 0), PRO)).toBe("OK");
  });

  it("is OK below the 80% threshold", () => {
    expect(invoiceQuotaWarningLevel(usage(0, 2), BASIC)).toBe("OK"); // 20%
    expect(invoiceQuotaWarningLevel(usage(0, 7), BASIC)).toBe("OK"); // 70%
    expect(invoiceQuotaWarningLevel(usage(0, 79), { ...PRO, invoiceLimit: 100 })).toBe("OK"); // 79%
    expect(invoiceQuotaWarningLevel(usage(0, 2), FREE)).toBe("OK"); // 66%
  });

  it("is WARNING_80 at exactly 80%", () => {
    expect(invoiceQuotaWarningLevel(usage(0, 8), BASIC)).toBe("WARNING_80"); // 8/10
    expect(invoiceQuotaWarningLevel(usage(0, 4), { ...FREE, invoiceLimit: 5 })).toBe("WARNING_80"); // 4/5
    expect(invoiceQuotaWarningLevel(usage(0, 40), PRO)).toBe("WARNING_80"); // 40/50
  });

  it("is WARNING_80 between 80% and the limit", () => {
    expect(invoiceQuotaWarningLevel(usage(0, 9), BASIC)).toBe("WARNING_80");
    expect(invoiceQuotaWarningLevel(usage(0, 49), PRO)).toBe("WARNING_80");
  });

  it("is REACHED at the limit and beyond it", () => {
    expect(invoiceQuotaWarningLevel(usage(0, 3), FREE)).toBe("REACHED");
    expect(invoiceQuotaWarningLevel(usage(0, 10), BASIC)).toBe("REACHED");
    expect(invoiceQuotaWarningLevel(usage(0, 11), BASIC)).toBe("REACHED");
    expect(invoiceQuotaWarningLevel(usage(0, 50), PRO)).toBe("REACHED");
  });

  it("takes REACHED precedence over the ratio when both apply", () => {
    // 3/3 is 100%, which is also >= 80%: the limit must win.
    expect(invoiceQuotaWarningLevel(usage(0, 3), FREE)).toBe("REACHED");
  });

  it("is OK for a zero limit rather than dividing by zero", () => {
    expect(invoiceQuotaWarningLevel(usage(0, 0), { ...FREE, invoiceLimit: 0 })).toBe("OK");
    expect(invoiceQuotaWarningLevel(usage(0, 5), { ...FREE, invoiceLimit: 0 })).toBe("OK");
  });
});

describe("evaluateSubscription", () => {
  const now = new Date("2026-03-15T12:00:00.000Z");

  it("keeps an ACTIVE row with an open window in force", () => {
    const result = evaluateSubscription(
      "ACTIVE",
      { startDate: new Date("2026-03-01T00:00:00.000Z"), endDate: new Date("2026-04-01T00:00:00.000Z") },
      now,
    );
    expect(result).toEqual({ status: "ACTIVE", storedStatus: "ACTIVE", lapse: "NONE", inForce: true });
  });

  it("treats missing dates as no constraint, preserving the status-only behaviour", () => {
    expect(evaluateSubscription("ACTIVE", {}, now).inForce).toBe(true);
    expect(evaluateSubscription("ACTIVE", { startDate: null, endDate: null }, now).inForce).toBe(true);
    expect(evaluateSubscription("ACTIVE", undefined, now).inForce).toBe(true);
    expect(evaluateSubscription("ACTIVE").inForce).toBe(true); // defaults to the real clock
  });

  it("demotes an ACTIVE row whose endDate has passed to EXPIRED", () => {
    const result = evaluateSubscription(
      "ACTIVE",
      { startDate: new Date("2026-02-01T00:00:00.000Z"), endDate: new Date("2026-03-01T00:00:00.000Z") },
      now,
    );
    expect(result).toEqual({ status: "EXPIRED", storedStatus: "ACTIVE", lapse: "ENDED", inForce: false });
  });

  it("demotes at the exact endDate instant (the boundary is exclusive)", () => {
    const result = evaluateSubscription("ACTIVE", { endDate: now }, now);
    expect(result.inForce).toBe(false);
    expect(result.lapse).toBe("ENDED");
    expect(result.status).toBe("EXPIRED");
  });

  it("keeps a row in force one millisecond before its endDate", () => {
    const result = evaluateSubscription("ACTIVE", { endDate: new Date(now.getTime() + 1) }, now);
    expect(result.inForce).toBe(true);
  });

  it("demotes an ACTIVE row whose startDate is in the future to PENDING", () => {
    const result = evaluateSubscription(
      "ACTIVE",
      { startDate: new Date("2026-04-01T00:00:00.000Z"), endDate: new Date("2026-05-01T00:00:00.000Z") },
      now,
    );
    expect(result).toEqual({ status: "PENDING", storedStatus: "ACTIVE", lapse: "NOT_STARTED", inForce: false });
  });

  it("demotes an impossible window (endDate <= startDate) instead of granting access", () => {
    const future = new Date("2026-06-01T00:00:00.000Z");
    const result = evaluateSubscription(
      "ACTIVE",
      { startDate: future, endDate: new Date("2026-05-01T00:00:00.000Z") },
      now,
    );
    expect(result.inForce).toBe(false);
    expect(result.lapse).toBe("INCONSISTENT_WINDOW");
    expect(result.status).toBe("EXPIRED");
  });

  it("demotes a zero-length window", () => {
    const result = evaluateSubscription("ACTIVE", { startDate: now, endDate: now }, now);
    expect(result.lapse).toBe("INCONSISTENT_WINDOW");
    expect(result.inForce).toBe(false);
  });

  it.each(NON_ACTIVE_STATUSES)("passes a non-ACTIVE %s status through unchanged and not in force", (status) => {
    const result = evaluateSubscription(
      status,
      { startDate: new Date("2026-03-01T00:00:00.000Z"), endDate: new Date("2026-04-01T00:00:00.000Z") },
      now,
    );
    expect(result).toEqual({ status, storedStatus: status, lapse: "NONE", inForce: false });
  });

  it("never lets dates revive a non-ACTIVE row", () => {
    const result = evaluateSubscription(
      "CANCELLED",
      { startDate: new Date("2026-03-01T00:00:00.000Z"), endDate: new Date("2027-03-01T00:00:00.000Z") },
      now,
    );
    expect(result.inForce).toBe(false);
    expect(result.status).toBe("CANCELLED");
  });

  it("feeds effectivePlan correctly: a date-lapsed PRO row yields Free", () => {
    const lapse = evaluateSubscription(
      "ACTIVE",
      { startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-02-01T00:00:00.000Z") },
      now,
    );
    expect(effectivePlan(PRO, { status: lapse.status }, FREE)).toBe(FREE);
    expect(canFinalizeInvoice(PRO, { status: lapse.status }, FREE, usage(0, 3))).toBe(false);
  });
});
