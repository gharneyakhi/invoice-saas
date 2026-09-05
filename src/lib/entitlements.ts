/**
 * Centralized entitlement system (section 45 of the Master Build Prompt).
 *
 * Every plan/feature check in the application — API routes, server actions,
 * and any UI gating — must go through these functions instead of comparing
 * `plan.key === "PRO"` inline. This keeps subscription rules in one place
 * and makes them independently testable.
 *
 * These are pure functions: callers are responsible for loading the
 * authoritative Account/Subscription/Plan/UsagePeriod/Business rows from
 * the database first. This module never trusts client-provided plan info.
 */

export interface PlanContext {
  planKey: "FREE" | "BASIC" | "PRO";
  businessLimit: number;
  invoiceLimit: number;
  features: Set<string>; // feature keys enabled for this plan
}

export interface UsageContext {
  currentBusinessCount: number;
  currentPeriodInvoiceCount: number;
}

export interface SubscriptionContext {
  status: "ACTIVE" | "PENDING" | "EXPIRED" | "CANCELLED" | "PAYMENT_FAILED";
}

/**
 * The date window of a stored `Subscription` row (`startDate` / `endDate` in
 * `prisma/schema.prisma`). Both are optional here on purpose: callers that
 * only know the status (or a test double that omits the columns) get exactly
 * the pre-existing status-only behaviour, because a missing date is treated as
 * "no constraint" rather than as a lapse.
 */
export interface SubscriptionWindow {
  startDate?: Date | null;
  endDate?: Date | null;
}

/** Why an `ACTIVE`-looking row was refused. `NONE` means nothing was refused. */
export type SubscriptionLapse =
  | "NONE"
  /** `startDate` is still in the future — paid access has not begun. */
  | "NOT_STARTED"
  /** `endDate` has passed — paid access is over even though the row says ACTIVE. */
  | "ENDED"
  /** `endDate <= startDate`, i.e. the window itself is impossible. */
  | "INCONSISTENT_WINDOW";

export interface SubscriptionEffectiveness {
  /**
   * The status entitlement enforcement must use. For a row that is `ACTIVE`
   * but lapsed by date this is the demoted status (`EXPIRED`/`PENDING`), which
   * makes `effectivePlan()` fall back to Free without any caller having to
   * re-implement that rule. For every other row it is the stored status,
   * unchanged.
   */
  status: SubscriptionContext["status"];
  /** The stored status, before any date-based demotion. Diagnostics only. */
  storedStatus: SubscriptionContext["status"];
  lapse: SubscriptionLapse;
  /** True only when this row genuinely grants paid access right now. */
  inForce: boolean;
}

/**
 * Decides whether a stored subscription row is *actually* in force right now.
 *
 * A row is not entitled to paid access merely because `status` says `ACTIVE`:
 * `endDate` is nullable and nothing in this codebase flips `status` when the
 * window closes (there is no billing cron yet), so the dates are the only
 * reliable signal. Rules, in order:
 *
 *   1. status !== ACTIVE  → not in force, status passed through untouched
 *      (PENDING / EXPIRED / CANCELLED / PAYMENT_FAILED all mean Free).
 *   2. endDate <= startDate → impossible window → demoted to EXPIRED.
 *   3. startDate in the future → not started → demoted to PENDING.
 *   4. endDate <= now → over → demoted to EXPIRED.
 *   5. otherwise → in force as ACTIVE.
 *
 * Deliberately one-sided: every ambiguous or inconsistent input resolves to
 * "no paid access". This function can only ever narrow an entitlement, never
 * widen one. Pure — no DB access, `now` injectable for tests.
 */
export function evaluateSubscription(
  status: SubscriptionContext["status"],
  window: SubscriptionWindow = {},
  now: Date = new Date(),
): SubscriptionEffectiveness {
  if (status !== "ACTIVE") {
    return { status, storedStatus: status, lapse: "NONE", inForce: false };
  }

  const { startDate, endDate } = window;
  const demote = (lapse: SubscriptionLapse, to: SubscriptionEffectiveness["status"]): SubscriptionEffectiveness => ({
    status: to,
    storedStatus: "ACTIVE",
    lapse,
    inForce: false,
  });

  if (startDate && endDate && endDate.getTime() <= startDate.getTime()) {
    return demote("INCONSISTENT_WINDOW", "EXPIRED");
  }
  if (startDate && startDate.getTime() > now.getTime()) {
    return demote("NOT_STARTED", "PENDING");
  }
  if (endDate && endDate.getTime() <= now.getTime()) {
    return demote("ENDED", "EXPIRED");
  }

  return { status: "ACTIVE", storedStatus: "ACTIVE", lapse: "NONE", inForce: true };
}

function isSubscriptionUsable(sub: SubscriptionContext): boolean {
  return sub.status === "ACTIVE";
}

/**
 * When a subscription is not ACTIVE (expired/cancelled/payment failed),
 * the account falls back to FREE-tier limits for enforcement purposes,
 * per business_rules.subscription: "Expired subscriptions fall back to
 * Free access rules." Callers should pass the FREE plan's limits/features
 * as `plan` in that case, or use `effectivePlan()` below.
 *
 * Date-based lapse ("the row says ACTIVE but `endDate` has passed") is handled
 * *before* this function, by `evaluateSubscription()`, which demotes such a row
 * to `EXPIRED`. Keeping the two concerns apart means this comparison stays the
 * single place where "is the subscription usable" is decided, and no caller can
 * accidentally bypass the date rule by comparing `status` itself.
 */
export function effectivePlan(plan: PlanContext, subscription: SubscriptionContext, freePlan: PlanContext): PlanContext {
  return isSubscriptionUsable(subscription) ? plan : freePlan;
}

export function canCreateBusiness(plan: PlanContext, subscription: SubscriptionContext, freePlan: PlanContext, usage: UsageContext): boolean {
  const effective = effectivePlan(plan, subscription, freePlan);
  return usage.currentBusinessCount < effective.businessLimit;
}

export function canFinalizeInvoice(
  plan: PlanContext,
  subscription: SubscriptionContext,
  freePlan: PlanContext,
  usage: UsageContext,
): boolean {
  const effective = effectivePlan(plan, subscription, freePlan);
  return usage.currentPeriodInvoiceCount < effective.invoiceLimit;
}

export function hasFeature(
  featureKey: string,
  plan: PlanContext,
  subscription: SubscriptionContext,
  freePlan: PlanContext,
): boolean {
  const effective = effectivePlan(plan, subscription, freePlan);
  return effective.features.has(featureKey);
}

export const canUseAdvancedReports = (p: PlanContext, s: SubscriptionContext, f: PlanContext) =>
  hasFeature("ADVANCED_REPORTS", p, s, f);

export const canSendEmail = (p: PlanContext, s: SubscriptionContext, f: PlanContext) =>
  hasFeature("EMAIL_SEND", p, s, f);

export const canUsePartialPayments = (p: PlanContext, s: SubscriptionContext, f: PlanContext) =>
  hasFeature("PARTIAL_PAYMENTS", p, s, f);

export const canExportExcel = (p: PlanContext, s: SubscriptionContext, f: PlanContext) =>
  hasFeature("EXCEL_EXPORT", p, s, f);

export const canDuplicateInvoice = (p: PlanContext, s: SubscriptionContext, f: PlanContext) =>
  hasFeature("INVOICE_DUPLICATION", p, s, f);

/**
 * Usage-quota warning thresholds for notifications (section 39 / 27).
 */
export function invoiceQuotaWarningLevel(usage: UsageContext, effective: PlanContext): "OK" | "WARNING_80" | "REACHED" {
  if (effective.invoiceLimit <= 0) return "OK";
  const ratio = usage.currentPeriodInvoiceCount / effective.invoiceLimit;
  if (usage.currentPeriodInvoiceCount >= effective.invoiceLimit) return "REACHED";
  if (ratio >= 0.8) return "WARNING_80";
  return "OK";
}
