import type { Prisma } from "@prisma/client";
import type { PlanContext, UsageContext } from "@/lib/entitlements";
import { canFinalizeInvoice, invoiceQuotaWarningLevel } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { getUsagePeriodBounds } from "@/lib/usage-period";
import { resolveEntitlements } from "@/server/entitlements/entitlementService";
import type {
  EntitlementContext,
  ResolveEntitlementsOptions,
} from "@/server/entitlements/entitlementService";
import { currentUsagePeriodWhere } from "@/server/entitlements/usagePeriodService";

/**
 * Finalized-invoice quota check (Phase 3).
 *
 * Answers "may this account finalize one more invoice this month?" — nothing
 * more. It creates no invoice, writes no row, and increments nothing: the
 * atomic increment belongs to the finalize transaction (Phase 4), which will
 * call `ensureCurrentUsagePeriod()` and bump `invoiceCount` in the same
 * transaction that flips the invoice to FINAL.
 *
 * Deliberately read-only. A month whose bucket does not exist yet has simply
 * had zero invoices finalized, so `usedInvoices` is 0 and the check can still
 * answer correctly without a write. Keeping the check side-effect free means it
 * is safe to call from a read path (a pricing banner, a disabled button's
 * reason, a report) as often as needed.
 *
 * The comparison itself is never re-implemented here: `canFinalizeInvoice()` and
 * `invoiceQuotaWarningLevel()` from `src/lib/entitlements.ts` do the work, and
 * the limits come from the seeded `Plan` rows via `resolveEntitlements()`.
 */

export interface InvoiceQuotaStatus {
  /** The effective plan — already Free when the subscription lapsed. */
  planKey: PlanContext["planKey"];
  /** `plans.invoiceLimit` of the effective plan, read from the database. */
  invoiceLimit: number;
  /** Finalized invoices recorded in the current calendar-month period. */
  usedInvoices: number;
  /** Never negative, even if `invoiceCount` somehow exceeds the limit. */
  remainingInvoices: number;
  /** From `canFinalizeInvoice()` — the single source of that comparison. */
  canFinalize: boolean;
  /** From `invoiceQuotaWarningLevel()`: OK / WARNING_80 / REACHED. */
  warningLevel: ReturnType<typeof invoiceQuotaWarningLevel>;
  periodStart: Date;
  periodEnd: Date;
  /** Null when this month's bucket has not been created yet. */
  usagePeriodId: string | null;
  /** Why the account is on Free, or `NONE`. Diagnostics for messages/UI. */
  fallbackReason: EntitlementContext["fallbackReason"];
}

/**
 * @throws UnauthorizedError / ForbiddenError from `requireSession()` (via
 *   `resolveEntitlements()`).
 * @throws EntitlementDataError when the FREE plan row is missing.
 */
export async function getInvoiceQuotaStatus(
  options: ResolveEntitlementsOptions = {},
): Promise<InvoiceQuotaStatus> {
  // One instant for the whole check, so the plan's lapse evaluation and the
  // month bucket it is measured against can never straddle a boundary.
  const now = options.now ?? new Date();
  const entitlements = await resolveEntitlements({ ...options, now });
  const db: Prisma.TransactionClient = options.client ?? prisma;
  const bounds = getUsagePeriodBounds(now);

  // Same account scoping as the resolver: `entitlements.accountId` was derived
  // from the session, so no caller input can read another account's counter.
  const period = await db.usagePeriod.findUnique({
    where: currentUsagePeriodWhere(entitlements.accountId, bounds),
  });

  const usedInvoices: number = period?.invoiceCount ?? 0;

  const usage: UsageContext = {
    // Not an input to the invoice-quota comparison — `canFinalizeInvoice()`
    // reads only `currentPeriodInvoiceCount`. businessService.createBusiness
    // mirrors this field the same way, so neither check pays for the other's
    // query.
    currentBusinessCount: 0,
    currentPeriodInvoiceCount: usedInvoices,
  };

  return {
    planKey: entitlements.plan.planKey,
    invoiceLimit: entitlements.invoiceLimit,
    usedInvoices,
    remainingInvoices: Math.max(0, entitlements.invoiceLimit - usedInvoices),
    canFinalize: canFinalizeInvoice(
      entitlements.plan,
      entitlements.subscription,
      entitlements.freePlan,
      usage,
    ),
    warningLevel: invoiceQuotaWarningLevel(usage, entitlements.plan),
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    usagePeriodId: period?.id ?? null,
    fallbackReason: entitlements.fallbackReason,
  };
}
