import type { Prisma } from "@prisma/client";
import type { PlanContext, SubscriptionContext, UsageContext } from "@/lib/entitlements";
import { canCreateBusiness, effectivePlan } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { requireBusinessOwnership } from "@/server/auth/requireBusinessOwnership";
import { requireSession } from "@/server/auth/requireSession";
import { BusinessLimitReachedError } from "@/server/errors";
import { toPlanContext, toSubscriptionContext } from "@/server/business/planContext";
import { parseCreateBusinessInput, parseUpdateBusinessInput } from "@/server/business/schema";

/**
 * Business CRUD domain layer (Phase 3, server-side only).
 *
 * Authorization rules applied by *every* function here (section 37 + the
 * isolation rule in the README):
 *
 *   1. `requireSession()` is the only source of truth for "who is calling";
 *      the resulting `accountId` is the only value ever written to
 *      `Business.accountId` or used in a `where` clause.
 *   2. `businessId` supplied by a caller is an *identifier*, never proof of
 *      ownership — `requireBusinessOwnership()` re-reads the row and compares
 *      it to the session account (404 when missing, 403 when it belongs to
 *      somebody else).
 *   3. No function in this module accepts an `accountId` argument. There is
 *      nothing for a client to spoof.
 *
 * Nothing is hard-deleted anywhere in this module: `Business` carries
 * `archivedAt`, so deletion is an archive stamp and every Customer, Product,
 * Invoice and File underneath the Business is preserved.
 */

/**
 * Row shape of the `businesses` table (mirrors `model Business` in
 * `prisma/schema.prisma`). Declared locally instead of importing the `Business`
 * *model* type from `@prisma/client`, which only exists after `prisma generate`
 * has run (importing it would add a compile error in any environment without a
 * generated client). `Prisma.TransactionClient`, used below for the `$transaction`
 * callbacks, is the exception: it is part of the client's shipped type surface,
 * so importing it is safe and precise everywhere.
 */
export interface BusinessRecord {
  id: string;
  accountId: string;
  name: string;
  isActive: boolean;
  isLocked: boolean;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ListBusinessesOptions {
  /** Archived businesses are hidden by default — archiving is a soft delete. */
  includeArchived?: boolean;
}

/**
 * Stable, meaningful order for business lists/switchers: the primary business
 * first, then oldest-first, with `id` as a final tie-breaker so pagination
 * never re-shuffles rows created in the same millisecond.
 */
export const BUSINESS_LIST_ORDER_BY = [
  { isPrimary: "desc" },
  { createdAt: "asc" },
  { id: "asc" },
];

/**
 * Lists the businesses of the *authenticated* account.
 *
 * There is no `accountId` parameter on purpose: the filter comes from the
 * session, so a client cannot ask for somebody else's list.
 */
export async function listBusinesses(options: ListBusinessesOptions = {}): Promise<BusinessRecord[]> {
  const { accountId } = await requireSession();

  return prisma.business.findMany({
    where: {
      accountId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: BUSINESS_LIST_ORDER_BY,
  });
}

/**
 * Returns a single business the caller owns, including an archived one
 * (ownership does not stop at the archive flag; list views filter instead).
 *
 * Delegates entirely to `requireBusinessOwnership()`, so a nonexistent
 * business propagates `NotFoundError` (404) and a business owned by another
 * account propagates `ForbiddenError` (403) — this function never widens or
 * narrows those semantics.
 */
export async function getBusiness(businessId: string): Promise<BusinessRecord> {
  return requireBusinessOwnership(businessId);
}

/**
 * Creates a Business for the authenticated account, gated by the centralized
 * entitlement system (section 45): FREE = 1, BASIC = 1, PRO = 3 businesses,
 * with an inactive subscription falling back to FREE limits.
 *
 * The whole write happens in one transaction so a failure partway through
 * cannot leave a Business without its BusinessProfile/InvoiceSettings.
 */
export async function createBusiness(input: unknown): Promise<BusinessRecord> {
  const { accountId } = await requireSession();
  const data = parseCreateBusinessInput(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // ---- Entitlement inputs, read from the DB, never from the request ----
    const subscriptionRow = await tx.subscription.findFirst({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      include: { plan: { include: { planFeatures: { include: { feature: true } } } } },
    });

    const freePlanRow = await tx.plan.findUnique({
      where: { key: "FREE" },
      include: { planFeatures: { include: { feature: true } } },
    });
    if (!freePlanRow) {
      // Same guard as bootstrap.ts: without the FREE row there is no fallback
      // limit to enforce, and refusing is safer than assuming an unlimited plan.
      throw new Error(
        "Cannot evaluate the business limit: the FREE plan is not seeded. Run `npm run prisma:seed` first.",
      );
    }

    const freePlan = toPlanContext(freePlanRow);
    // An account with no subscription row at all is treated exactly like a
    // non-ACTIVE subscription: `effectivePlan()` drops it to FREE limits.
    const plan: PlanContext = subscriptionRow ? toPlanContext(subscriptionRow.plan) : freePlan;
    const subscription: SubscriptionContext = subscriptionRow
      ? toSubscriptionContext(subscriptionRow.status)
      : { status: "EXPIRED" };

    // Only this account's live businesses count toward the limit. Archived
    // ones are excluded because archiving is how a Business is retired —
    // otherwise a FREE account that archives its single business could never
    // create another one.
    const existingBusinesses: Array<{ id: string; isPrimary: boolean }> = await tx.business.findMany({
      where: { accountId, archivedAt: null },
      select: { id: true, isPrimary: true },
    });

    const usage: UsageContext = {
      currentBusinessCount: existingBusinesses.length,
      // Invoice quota is irrelevant to this check; it is enforced at
      // finalization time (Phase 4) against the current UsagePeriod.
      currentPeriodInvoiceCount: 0,
    };

    if (!canCreateBusiness(plan, subscription, freePlan, usage)) {
      const effective = effectivePlan(plan, subscription, freePlan);
      throw new BusinessLimitReachedError(
        `Business limit reached: the ${effective.planKey} plan allows ${effective.businessLimit} active business(es).`,
      );
    }

    // Primary-business convention (see bootstrap.ts): one Business per Account
    // carries `isPrimary`, and it is assigned by the server, never requested
    // by the client.
    const isPrimary = !existingBusinesses.some((business) => business.isPrimary);

    const business: BusinessRecord = await tx.business.create({
      data: {
        accountId, // session-derived; the payload cannot override it (schema is strict)
        name: data.name,
        isPrimary,
      },
    });

    await tx.businessProfile.create({
      data: { businessId: business.id, businessName: data.name },
    });

    // Not strictly a "business" field, but bootstrap.ts establishes that a
    // Business is created together with its unique InvoiceSettings — invoice
    // numbering (section 14) assumes the row exists for every Business.
    await tx.invoiceSettings.create({
      data: { businessId: business.id, nextInvoiceNumber: 1 },
    });

    return business;
  });
}

/**
 * Updates a business the caller owns. `accountId`, `id`, `isPrimary`,
 * `isLocked` and `archivedAt` are not updatable here — the update schema is
 * strict, so attempting it raises `ValidationError` instead of being ignored.
 */
export async function updateBusiness(businessId: string, input: unknown): Promise<BusinessRecord> {
  // Ownership is proven before the payload is even looked at, so an
  // unauthorized caller learns nothing about validation rules.
  const owned = await requireBusinessOwnership(businessId);
  const data = parseUpdateBusinessInput(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated: BusinessRecord = await tx.business.update({
      where: { id: owned.id }, // the verified row's id, not the raw client value
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    // `BusinessProfile.businessName` mirrors `Business.name` (bootstrap.ts
    // writes both). Keeping them in sync in the same transaction means a
    // rename can never leave the invoice letterhead showing the old name.
    if (data.name !== undefined) {
      await tx.businessProfile.updateMany({
        where: { businessId: owned.id },
        data: { businessName: data.name },
      });
    }

    return updated;
  });
}

/**
 * Archives (soft-deletes) a business the caller owns.
 *
 * `Business.archivedAt` exists in the schema, so this is the delete path:
 * the row and everything hanging off it (Customers, Products, Invoices,
 * snapshots, Files) stay intact for historical/audit purposes. There is
 * deliberately no hard-delete function in this module.
 *
 * Idempotent — archiving an already archived business is a no-op that returns
 * the current row rather than moving the archive timestamp.
 */
export async function archiveBusiness(businessId: string): Promise<BusinessRecord> {
  const owned = await requireBusinessOwnership(businessId);

  if (owned.archivedAt) {
    return owned;
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const archived: BusinessRecord = await tx.business.update({
      where: { id: owned.id },
      data: { archivedAt: new Date() },
    });

    // Keep the primary-business convention intact: an account that still has
    // live businesses must keep exactly one primary (the oldest remaining).
    if (owned.isPrimary) {
      const nextPrimary: { id: string } | null = await tx.business.findFirst({
        where: { accountId: owned.accountId, archivedAt: null },
        orderBy: { createdAt: "asc" },
      });

      if (nextPrimary) {
        await tx.business.update({
          where: { id: nextPrimary.id },
          data: { isPrimary: true },
        });
      }
    }

    return archived;
  });
}
