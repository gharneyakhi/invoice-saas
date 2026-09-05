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

function isSubscriptionUsable(sub: SubscriptionContext): boolean {
  return sub.status === "ACTIVE";
}

/**
 * When a subscription is not ACTIVE (expired/cancelled/payment failed),
 * the account falls back to FREE-tier limits for enforcement purposes,
 * per business_rules.subscription: "Expired subscriptions fall back to
 * Free access rules." Callers should pass the FREE plan's limits/features
 * as `plan` in that case, or use `effectivePlan()` below.
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
