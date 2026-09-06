import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getUsagePeriodBounds } from "@/lib/usage-period";
import { requireSession, type AuthenticatedContext } from "@/server/auth/requireSession";
import { EntitlementDataError } from "@/server/errors";
import { SUBSCRIPTION_ORDER_BY, selectCurrentSubscription } from "@/server/entitlements/subscriptionSelection";

/**
 * Usage-period resolution (Phase 3).
 *
 * `bootstrap.ts` creates the *first* `UsagePeriod` at sign-up and then nothing
 * ever looked at the table again: the monthly quota counter was never rolled
 * forward. This module is the missing "which bucket does this account's usage
 * belong to this month?" step, and the only place that writes to it.
 *
 * Invariants enforced here:
 *   - **Account-scoped.** `accountId` comes from `requireSession()` alone; there
 *     is no parameter that can point the lookup at another account.
 *   - **Calendar month, per the existing convention.** Bounds always come from
 *     `getUsagePeriodBounds()` — the same helper `bootstrap.ts` used — so the
 *     rows this module writes line up exactly with the rows bootstrap wrote
 *     (`@@unique([accountId, periodStart, periodEnd])`).
 *   - **Existing rows are never modified.** No `update`, no `delete`, no
 *     re-stamping of `periodStart`/`periodEnd`, so `invoiceCount` can never be
 *     reset and no historical period is ever touched. An existing current
 *     period is returned as-is.
 *   - **No duplicates, even concurrently.** Creation is a plain insert that
 *     relies on the existing composite unique constraint as the arbiter; the
 *     loser of a race catches the violation and re-reads the winner's row
 *     instead of retrying the insert.
 *
 * ### Which subscription a period is attached to
 *
 * `UsagePeriod.subscriptionId` is NOT NULL in the schema, so a bucket cannot be
 * created without naming a subscription. The rule, decided in one place
 * (`subscriptionSelection.ts`) and shared with the entitlement resolver:
 *
 *   1. the account's newest subscription that is genuinely in force, if any;
 *   2. otherwise the account's newest subscription row of any status — a lapsed
 *      or pending account still needs a counter bucket, and failing hard here
 *      would break quota checks for every Free-fallback user.
 *
 * Both are always rows **of this account** (the query is filtered by the
 * session `accountId`), so the foreign key can never cross an account boundary.
 *
 * The attachment is bookkeeping only: it records which subscription was current
 * when the bucket was opened. **Entitlements are never derived from
 * `UsagePeriod.subscriptionId`** — a period that still points at a PRO
 * subscription which has since lapsed grants nothing, because enforcement goes
 * through `resolveEntitlements()`, which re-reads the subscription rows.
 */

/** Row shape of `usage_periods` (mirrors `model UsagePeriod`). */
export interface UsagePeriodRecord {
  id: string;
  accountId: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  invoiceCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsagePeriodOptions {
  /**
   * Reference instant for "this month". Server-side only — must never come from
   * request input, or a caller could pick a different (emptier) bucket.
   */
  now?: Date;
  /** Optional transaction client, for callers already inside a `$transaction`. */
  client?: Prisma.TransactionClient;
  /**
   * Already-authenticated session context for internal server-to-server calls.
   *
   * A caller that has already run `requireSession()` (invoice finalization, for
   * example) passes its session here so the period lookup does not execute a
   * second redundant session round-trip. Server-to-server only: the value is
   * produced exclusively by `requireSession()` and never taken from request
   * input, so every external caller keeps authenticating exactly as before.
   */
  session?: AuthenticatedContext;
}

/**
 * The composite unique key Prisma derives from
 * `@@unique([accountId, periodStart, periodEnd])`. Exported so every reader of
 * the table (the quota check, later reports) addresses a period the same way
 * instead of re-spelling the key — and so the account scoping is visible at
 * each call site.
 *
 * This builds a key; it authorizes nothing. `accountId` must always be the
 * session-derived one (`requireSession()` / an `EntitlementContext`), never a
 * value that reached the server from a request.
 */
export function currentUsagePeriodWhere(accountId: string, bounds: { periodStart: Date; periodEnd: Date }) {
  return {
    accountId_periodStart_periodEnd: {
      accountId,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
    },
  };
}

/**
 * Prisma reports a unique-constraint violation as a
 * `PrismaClientKnownRequestError` carrying `code === "P2002"`. Detected
 * structurally rather than with `instanceof` so it behaves identically whether
 * or not a generated client is present, and without importing Prisma error
 * classes into the domain layer.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "P2002";
}

/**
 * Read-only lookup of the authenticated account's current calendar-month
 * period. Returns null when this month's bucket does not exist yet — callers
 * that need it to exist must use `ensureCurrentUsagePeriod()`.
 */
export async function getCurrentUsagePeriod(
  options: UsagePeriodOptions = {},
): Promise<UsagePeriodRecord | null> {
  const { accountId } = options.session ?? (await requireSession());
  const db: Prisma.TransactionClient = options.client ?? prisma;
  const bounds = getUsagePeriodBounds(options.now ?? new Date());

  const period = await db.usagePeriod.findUnique({ where: currentUsagePeriodWhere(accountId, bounds) });
  return period ?? null;
}

/**
 * Returns the authenticated account's current calendar-month period, creating
 * it if — and only if — it does not exist yet.
 *
 * Idempotent: repeated calls return the same row and never create a second one,
 * whether they arrive sequentially or concurrently. An existing row is returned
 * untouched, so its `invoiceCount` survives.
 *
 * @throws UnauthorizedError / ForbiddenError from `requireSession()`.
 * @throws EntitlementDataError when the account has no subscription row at all
 *   (`subscriptionId` is NOT NULL, so a bucket cannot be created honestly), or
 *   when a concurrent writer's row cannot be read back.
 */
export async function ensureCurrentUsagePeriod(
  options: UsagePeriodOptions = {},
): Promise<UsagePeriodRecord> {
  const { accountId } = options.session ?? (await requireSession());
  const db: Prisma.TransactionClient = options.client ?? prisma;
  // One instant for the whole call, so the month boundaries and the choice of
  // subscription can never straddle a boundary and disagree with each other.
  const now = options.now ?? new Date();
  const bounds = getUsagePeriodBounds(now);
  const where = currentUsagePeriodWhere(accountId, bounds);

  // 1. Fast path — the bucket already exists. Returned as found: this function
  //    never writes to an existing row.
  const existing = await db.usagePeriod.findUnique({ where });
  if (existing) {
    return existing;
  }

  // 2. Missing — open this month's bucket against one of *this* account's
  //    subscriptions.
  const subscriptionId = await findSubscriptionIdForPeriod(db, accountId, now);

  try {
    return await db.usagePeriod.create({
      data: {
        accountId, // session-derived; no caller input can override it
        subscriptionId,
        periodStart: bounds.periodStart,
        periodEnd: bounds.periodEnd,
        invoiceCount: 0,
      },
    });
  } catch (error) {
    // 3. Lost the create race. The unique constraint already picked a winner,
    //    so re-read that row rather than retrying the insert (which would just
    //    violate again) and rather than surfacing the raw Prisma error.
    if (!isUniqueConstraintViolation(error)) {
      // Anything else is an infrastructure failure, not a domain condition:
      // propagate it unchanged instead of mislabelling it (the eventual API
      // layer maps unknown errors to a generic 500 without echoing details).
      throw error;
    }

    const winner = await db.usagePeriod.findUnique({ where });
    if (winner) {
      return winner;
    }

    throw new EntitlementDataError(
      "A concurrent writer created this account's usage period, but it could not be read back.",
    );
  }
}

/**
 * Picks the subscription a newly created period should point at. See the module
 * docstring for the rule and for why the attachment grants nothing.
 */
async function findSubscriptionIdForPeriod(
  db: Prisma.TransactionClient,
  accountId: string,
  now: Date,
): Promise<string> {
  const rows = await db.subscription.findMany({
    where: { accountId }, // never another account's subscription
    orderBy: SUBSCRIPTION_ORDER_BY,
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      createdAt: true,
      plan: { select: { isActive: true } },
    },
  });

  const { selected } = selectCurrentSubscription(rows, now);
  if (!selected) {
    throw new EntitlementDataError(
      "Cannot create a usage period: this account has no subscription row. Bootstrap creates one on first login, so this indicates inconsistent data rather than a normal Free account.",
    );
  }

  return selected.id;
}
