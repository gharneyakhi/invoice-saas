import type { PlanContext, SubscriptionContext } from "@/lib/entitlements";

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

export function toSubscriptionContext(status: string): SubscriptionContext {
  return { status: toSubscriptionStatus(status) };
}
