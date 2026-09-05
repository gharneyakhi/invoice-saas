import type { PlanContext, SubscriptionContext, SubscriptionWindow } from "@/lib/entitlements";
import { evaluateSubscription } from "@/lib/entitlements";

/**
 * Bridge between the authoritative Plan/Subscription rows and the *pure*
 * entitlement functions in `src/lib/entitlements.ts` (section 45).
 *
 * `entitlements.ts` deliberately never touches the database — callers load
 * the rows and hand them over. These mappers are that hand-over, kept free of
 * DB access so they are trivially unit-testable.
 *
 * The row types are declared structurally (matching `prisma/schema.prisma`)
 * rather than imported from `@prisma/client`, so this module type-checks even
 * where `prisma generate` has not run. Generated rows are structurally
 * assignable to them.
 */

/** A `plans` row together with its `plan_features` (each with its `feature`). */
export interface PlanRow {
  key: string;
  businessLimit: number;
  invoiceLimit: number;
  planFeatures: ReadonlyArray<{
    enabled: boolean;
    feature: { key: string };
  }>;
}

function toPlanKey(key: string): PlanContext["planKey"] {
  if (key === "FREE" || key === "BASIC" || key === "PRO") {
    return key;
  }
  // Fail loudly rather than guessing a limit: an unknown PlanKey means the
  // schema/seed and this module disagree, which must not silently widen a
  // paid entitlement.
  throw new Error(`Unknown plan key in the database: ${key}`);
}

function toSubscriptionStatus(status: string): SubscriptionContext["status"] {
  switch (status) {
    case "ACTIVE":
    case "PENDING":
    case "EXPIRED":
    case "CANCELLED":
    case "PAYMENT_FAILED":
      return status;
    default:
      throw new Error(`Unknown subscription status in the database: ${status}`);
  }
}

/**
 * Validates a stored `subscriptions.status` string into the enum the
 * entitlement system understands. Exported so the server-side resolver can
 * report the *stored* status for diagnostics while enforcing a different,
 * date-adjusted one. Throws on an unknown value rather than defaulting to
 * something permissive.
 */
export function toStoredSubscriptionStatus(status: string): SubscriptionContext["status"] {
  return toSubscriptionStatus(status);
}

/**
 * Only `enabled` PlanFeatures become usable feature keys — a row kept for
 * history with `enabled = false` must not grant anything.
 */
export function toPlanContext(row: PlanRow): PlanContext {
  return {
    planKey: toPlanKey(row.key),
    businessLimit: row.businessLimit,
    invoiceLimit: row.invoiceLimit,
    features: new Set(
      row.planFeatures.filter((planFeature) => planFeature.enabled).map((planFeature) => planFeature.feature.key),
    ),
  };
}

/**
 * Maps a stored subscription row onto the `SubscriptionContext` the pure
 * entitlement functions consume.
 *
 * `window` is optional and purely additive: with no dates supplied this behaves
 * exactly as it did before (the stored status alone decides), so existing
 * callers and tests are unaffected. When the row's `startDate`/`endDate` are
 * supplied, an `ACTIVE` row whose paid window has not started yet — or has
 * already closed — is demoted to `PENDING`/`EXPIRED`, which makes
 * `effectivePlan()` fall back to Free. The rule itself lives in
 * `evaluateSubscription()` (src/lib/entitlements.ts), never here.
 */
export function toSubscriptionContext(
  status: string,
  window?: SubscriptionWindow,
  now?: Date,
): SubscriptionContext {
  const storedStatus = toSubscriptionStatus(status);
  return { status: evaluateSubscription(storedStatus, window ?? {}, now).status };
}
