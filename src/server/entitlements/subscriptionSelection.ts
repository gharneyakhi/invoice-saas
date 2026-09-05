import type {
  SubscriptionContext,
  SubscriptionEffectiveness,
  SubscriptionLapse,
} from "@/lib/entitlements";
import { evaluateSubscription } from "@/lib/entitlements";
import type { PlanRow } from "@/server/business/planContext";
import { toStoredSubscriptionStatus } from "@/server/business/planContext";

/**
 * "Which of this account's subscription rows is the current one, and does it
 * actually grant anything right now?" — decided in exactly one place.
 *
 * Pure and DB-free, like `src/lib/entitlements.ts`: callers load the rows and
 * hand them over. Both the entitlement resolver
 * (`src/server/entitlements/entitlementService.ts`) and the usage-period
 * service (`src/server/entitlements/usagePeriodService.ts`) go through this
 * module, so they can never disagree about which subscription is current.
 *
 * The rule is deliberately pessimistic (section 45 + the business rule
 * "Expired subscriptions fall back to Free access rules"): a row only counts as
 * granting paid access when its status is `ACTIVE`, its `startDate`/`endDate`
 * window genuinely covers `now`, and its `Plan` row is still active. Anything
 * else — lapsed by date, not started, cancelled, payment failed, retired plan —
 * falls back to Free. Inconsistent data therefore never grants elevated access.
 */

/**
 * Structural mirror of a `plans` row as the selection rule needs it.
 *
 * Declared structurally (matching `prisma/schema.prisma`) rather than imported
 * from `@prisma/client`, for the same reason as `PlanRow` in
 * `src/server/business/planContext.ts`: this module type-checks even where
 * `prisma generate` has not run.
 */
export interface SubscriptionPlanRow extends PlanRow {
  id: string;
  /** `plans.isActive`. A deactivated (retired) plan grants nothing. */
  isActive?: boolean;
}

/**
 * The fields the selection rule reads. Everything is optional except `id` and
 * `status` so a light `select` (as used by the usage-period service, which only
 * needs an id) and a full `include` (as used by the resolver, which needs the
 * plan's limits and features) both satisfy it.
 */
export interface SubscriptionSelectionRow {
  id: string;
  /** Raw `subscriptions.status` string; validated before use. */
  status: string;
  startDate?: Date | null;
  endDate?: Date | null;
  createdAt?: Date;
  plan?: { isActive?: boolean } | null;
}

/** A `subscriptions` row with its `plans` row fully loaded. */
export interface SubscriptionRowWithPlan {
  id: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  plan: SubscriptionPlanRow;
}

/**
 * Why the account is being enforced as Free. `NONE` means a subscription is
 * genuinely in force and its own plan is being enforced.
 */
export type EntitlementFallbackReason =
  | "NONE"
  | "NO_SUBSCRIPTION"
  | "NOT_STARTED"
  | "ENDED"
  | "INCONSISTENT_WINDOW"
  | "PLAN_INACTIVE"
  | "STATUS_PENDING"
  | "STATUS_EXPIRED"
  | "STATUS_CANCELLED"
  | "STATUS_PAYMENT_FAILED";

export interface SubscriptionEvaluation<T extends SubscriptionSelectionRow> {
  row: T;
  /** What the row says. Diagnostics only — never enforce from this. */
  storedStatus: SubscriptionContext["status"];
  /** The date-adjusted verdict from the pure `evaluateSubscription()`. */
  effectiveness: SubscriptionEffectiveness;
  planActive: boolean;
  /** True only when the row is in force AND its plan has not been deactivated. */
  grantsPaidAccess: boolean;
}

export interface SubscriptionSelection<T extends SubscriptionSelectionRow> {
  /** The row entitlements are resolved from, or null when the account has none. */
  selected: T | null;
  /** The newest row that genuinely grants paid access, or null. */
  granting: T | null;
  /** Evaluation of `selected`; null exactly when `selected` is null. */
  evaluation: SubscriptionEvaluation<T> | null;
  reason: EntitlementFallbackReason;
}

/**
 * Newest-first, with deterministic tie-breakers, so "the current subscription"
 * is stable across calls even when several rows share a `startDate`.
 */
export const SUBSCRIPTION_ORDER_BY = [
  { startDate: "desc" },
  { createdAt: "desc" },
  { id: "desc" },
];

export function evaluateSubscriptionRow<T extends SubscriptionSelectionRow>(
  row: T,
  now: Date = new Date(),
): SubscriptionEvaluation<T> {
  // Throws on a status this build does not know, rather than treating it as
  // permissive (same convention as `toPlanContext`).
  const storedStatus = toStoredSubscriptionStatus(row.status);
  const effectiveness = evaluateSubscription(
    storedStatus,
    { startDate: row.startDate, endDate: row.endDate },
    now,
  );
  // `plans.isActive` is NOT NULL in the schema, so a missing value can only come
  // from a partial select or a test double; it is read as "not deactivated".
  const planActive = row.plan?.isActive !== false;

  return {
    row,
    storedStatus,
    effectiveness,
    planActive,
    grantsPaidAccess: effectiveness.inForce && planActive,
  };
}

/**
 * Picks the subscription the account is currently entitled through.
 *
 * `rows` must already be ordered newest-first (`SUBSCRIPTION_ORDER_BY`); the
 * first match is then the most recent candidate. Preference order:
 *
 *   1. the newest row that genuinely grants paid access — so an account whose
 *      most recent subscription has lapsed still keeps the older one that is
 *      genuinely in force, instead of being dropped to Free by an unlucky sort;
 *   2. otherwise the newest row of any status, which `effectivePlan()` will
 *      demote to Free. It is still returned because callers need it for
 *      diagnostics and for `UsagePeriod.subscriptionId` (a NOT NULL column).
 */
export function selectCurrentSubscription<T extends SubscriptionSelectionRow>(
  rows: readonly T[],
  now: Date = new Date(),
): SubscriptionSelection<T> {
  // One pass: each row is evaluated exactly once, so the row chosen and the
  // evaluation reported about it can never disagree.
  const evaluations = rows.map((row) => evaluateSubscriptionRow(row, now));

  const granting = evaluations.find((evaluation) => evaluation.grantsPaidAccess);
  if (granting) {
    return { selected: granting.row, granting: granting.row, evaluation: granting, reason: "NONE" };
  }

  const newest = evaluations[0];
  if (!newest) {
    return { selected: null, granting: null, evaluation: null, reason: "NO_SUBSCRIPTION" };
  }

  return { selected: newest.row, granting: null, evaluation: newest, reason: fallbackReasonFor(newest) };
}

/**
 * The status enforcement must use.
 *
 * Everything that is not a genuinely granting subscription is demoted to a
 * non-`ACTIVE` status so the existing pure `effectivePlan()` returns the FREE
 * baseline. The `status === "ACTIVE"` guard covers the one case the stored
 * status cannot express on its own: a row that is in force but points at a
 * deactivated `Plan`, which must not grant a retired plan's limits.
 */
export function enforcedSubscriptionContext<T extends SubscriptionSelectionRow>(
  selection: SubscriptionSelection<T>,
): SubscriptionContext {
  if (selection.granting) {
    return { status: "ACTIVE" };
  }

  const status = selection.evaluation?.effectiveness.status ?? "EXPIRED";
  return { status: status === "ACTIVE" ? "EXPIRED" : status };
}

function fallbackReasonFor<T extends SubscriptionSelectionRow>(
  evaluation: SubscriptionEvaluation<T>,
): EntitlementFallbackReason {
  if (evaluation.effectiveness.inForce && !evaluation.planActive) {
    return "PLAN_INACTIVE";
  }

  const lapse: SubscriptionLapse = evaluation.effectiveness.lapse;
  if (lapse === "NOT_STARTED") return "NOT_STARTED";
  if (lapse === "ENDED") return "ENDED";
  if (lapse === "INCONSISTENT_WINDOW") return "INCONSISTENT_WINDOW";

  return storedStatusReason(evaluation.storedStatus);
}

function storedStatusReason(status: SubscriptionContext["status"]): EntitlementFallbackReason {
  switch (status) {
    case "PENDING":
      return "STATUS_PENDING";
    case "EXPIRED":
      return "STATUS_EXPIRED";
    case "CANCELLED":
      return "STATUS_CANCELLED";
    case "PAYMENT_FAILED":
      return "STATUS_PAYMENT_FAILED";
    case "ACTIVE":
      // Unreachable: an in-force ACTIVE row with an active plan is `granting`,
      // and an in-force ACTIVE row with a deactivated plan is PLAN_INACTIVE.
      // Kept for exhaustiveness so a future status cannot fall through to a
      // permissive default.
      return "NONE";
  }
}
