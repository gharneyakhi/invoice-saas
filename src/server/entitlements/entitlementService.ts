import type { Prisma } from "@prisma/client";
import type { PlanContext, SubscriptionContext, UsageContext } from "@/lib/entitlements";
import { canCreateBusiness, effectivePlan, hasFeature } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/server/auth/requireSession";
import { toPlanContext } from "@/server/business/planContext";
import { EntitlementDataError } from "@/server/errors";
import {
  SUBSCRIPTION_ORDER_BY,
  enforcedSubscriptionContext,
  selectCurrentSubscription,
} from "@/server/entitlements/subscriptionSelection";
import type {
  EntitlementFallbackReason,
  SubscriptionRowWithPlan,
} from "@/server/entitlements/subscriptionSelection";

/**
 * Server-side entitlement resolver (Phase 3).
 *
 * The single entry point every future service must use to answer "what is this
 * account allowed to do?". It owns the DB side of section 45, while all the
 * *comparisons* stay in the pure `src/lib/entitlements.ts` — nothing here
 * re-implements a limit, and no plan number appears in this file.
 *
 * Trust model:
 *   - `accountId` comes exclusively from `requireSession()`. There is no
 *     parameter — and no code path — by which a caller can name an account, a
 *     subscription, or a plan. The only inputs are a time source and an
 *     optional transaction client, both server-owned.
 *   - Subscription/plan rows are read from the database on every call, so a
 *     downgrade or a lapse takes effect immediately rather than at next login.
 *   - Anything ambiguous resolves downwards: no subscription, lapsed by date,
 *     not started, cancelled, payment failed, or a deactivated `Plan` row all
 *     yield the seeded FREE plan.
 */

export interface ResolveEntitlementsOptions {
  /**
   * Time source for the date-based lapse check. Server-side only: it must never
   * be taken from request input, or a caller could rewind the clock and keep a
   * lapsed subscription alive.
   */
  now?: Date;
  /**
   * Optional transaction client, so a caller that is already inside a
   * `$transaction` (invoice finalization, for example) resolves entitlements on
   * the same connection and snapshot instead of opening a second one.
   */
  client?: Prisma.TransactionClient;
}

/** Diagnostics-safe view of the subscription behind a resolved entitlement. */
export interface SubscriptionRecord {
  id: string;
  planKey: PlanContext["planKey"];
  /** What the row says. Never enforce from this. */
  storedStatus: SubscriptionContext["status"];
  /** What enforcement actually used, after any date/plan demotion. */
  enforcedStatus: SubscriptionContext["status"];
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * The typed entitlement context handed to future services.
 *
 * `plan` is already the *effective* plan, so a caller enforcing a limit reads
 * `plan.invoiceLimit` / `plan.businessLimit` / `plan.features` and cannot
 * accidentally use the paid plan of a lapsed subscription. `freePlan` and
 * `subscription` are exposed alongside it because the pure helpers in
 * `src/lib/entitlements.ts` take all three; passing this context straight into
 * them keeps the Free-fallback rule centralized.
 */
export interface EntitlementContext {
  userId: string;
  accountId: string;
  /** The plan whose limits/features are enforced right now. */
  plan: PlanContext;
  /** The seeded FREE baseline used for the fallback. */
  freePlan: PlanContext;
  /** Status handed to the pure helpers — already demoted when lapsed. */
  subscription: SubscriptionContext;
  /** The stored row behind `subscription`, or null when the account has none. */
  subscriptionRecord: SubscriptionRecord | null;
  /** True only when a subscription is genuinely in force on an active plan. */
  hasEffectiveSubscription: boolean;
  /** Why the account is on Free. `NONE` when it is not. */
  fallbackReason: EntitlementFallbackReason;
  businessLimit: number;
  invoiceLimit: number;
  features: ReadonlySet<string>;
  resolvedAt: Date;
}

/**
 * Resolves the authenticated account's entitlements.
 *
 * @throws UnauthorizedError / ForbiddenError from `requireSession()` when there
 *   is no valid, active session.
 * @throws EntitlementDataError when the FREE plan row is missing — without it
 *   there is no fallback baseline to enforce, and refusing is safer than
 *   assuming an unlimited plan (same guard as `bootstrap.ts` and
 *   `businessService.createBusiness`).
 */
export async function resolveEntitlements(
  options: ResolveEntitlementsOptions = {},
): Promise<EntitlementContext> {
  const { userId, accountId } = await requireSession();
  const db: Prisma.TransactionClient = options.client ?? prisma;
  const now = options.now ?? new Date();

  const freePlanRow = await db.plan.findUnique({
    where: { key: "FREE" },
    include: { planFeatures: { include: { feature: true } } },
  });
  if (!freePlanRow) {
    throw new EntitlementDataError(
      "Cannot resolve entitlements: the FREE plan is not seeded. Run `npm run prisma:seed` first.",
    );
  }
  const freePlan = toPlanContext(freePlanRow);

  // Scoped by the session-derived accountId and nothing else: no argument to
  // this function can widen the filter to another account's subscriptions.
  //
  // The rows are annotated as `SubscriptionRowWithPlan[]` rather than left to
  // inference: the generated Prisma type for this exact `include` is
  // structurally assignable to it (same mapping `toPlanContext` already relies
  // on in businessService.ts), and the annotation keeps `selected.plan` a full
  // `PlanRow` for the mapper below instead of degrading to the light selection
  // shape.
  const subscriptionRows: SubscriptionRowWithPlan[] = await db.subscription.findMany({
    where: { accountId },
    orderBy: SUBSCRIPTION_ORDER_BY,
    include: { plan: { include: { planFeatures: { include: { feature: true } } } } },
  });

  const selection = selectCurrentSubscription(subscriptionRows, now);
  const subscription = enforcedSubscriptionContext(selection);
  const selectedPlan = selection.selected ? toPlanContext(selection.selected.plan) : null;

  // The existing pure fallback rule: anything not genuinely ACTIVE yields Free.
  const plan = effectivePlan(selectedPlan ?? freePlan, subscription, freePlan);

  const { selected, granting, evaluation, reason } = selection;
  const subscriptionRecord: SubscriptionRecord | null =
    selected && evaluation
      ? {
          id: selected.id,
          planKey: selectedPlan?.planKey ?? freePlan.planKey,
          storedStatus: evaluation.storedStatus,
          enforcedStatus: subscription.status,
          startDate: selected.startDate ?? null,
          endDate: selected.endDate ?? null,
        }
      : null;

  return {
    userId,
    accountId,
    plan,
    freePlan,
    subscription,
    subscriptionRecord,
    hasEffectiveSubscription: granting !== null,
    fallbackReason: reason,
    businessLimit: plan.businessLimit,
    invoiceLimit: plan.invoiceLimit,
    features: plan.features,
    resolvedAt: now,
  };
}

/**
 * Business-limit gate for future callers, routed through the existing pure
 * `canCreateBusiness()` so the comparison is never duplicated.
 * (`businessService.createBusiness` keeps its own transactional check; this is
 * for anything that already holds an `EntitlementContext`.)
 */
export function entitlementCanCreateBusiness(context: EntitlementContext, usage: UsageContext): boolean {
  return canCreateBusiness(context.plan, context.subscription, context.freePlan, usage);
}

/** Feature gate routed through the existing pure `hasFeature()`. */
export function entitlementHasFeature(context: EntitlementContext, featureKey: string): boolean {
  return hasFeature(featureKey, context.plan, context.subscription, context.freePlan);
}
