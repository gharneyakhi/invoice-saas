import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import {
  NotFoundError,
  requireSession,
  type AuthenticatedContext,
} from "@/server/auth/requireSession";
import { SubscriptionAlreadyActiveError, ValidationError } from "@/server/errors";
import {
  SUBSCRIPTION_ORDER_BY,
  selectCurrentSubscription,
} from "@/server/entitlements/subscriptionSelection";
import type { SubscriptionSelectionRow } from "@/server/entitlements/subscriptionSelection";
import { getPaymentProvider } from "@/server/payments/factory";
import { createPaymentAmount } from "@/server/payments/money";
import {
  buildPaymentCallbackUrl,
  SUBSCRIPTION_PAYMENT_CALLBACK_KIND,
} from "@/server/payments/callbackUrl";
import type { PaymentProvider } from "@/server/payments/PaymentProvider";
import { parseCreateSubscriptionCheckoutInput } from "./schema";

/**
 * SaaS subscription checkout (server-side only) — the first half of the
 * purchase flow: open a PENDING `Subscription` + `SubscriptionPayment` pair,
 * ask the payment provider for a checkout session, and persist the gateway
 * authority. The second half (callback → verify → activate) is a later step
 * and deliberately not touched here.
 *
 * Authorization:
 *
 *   1. `requireSession()` runs first — the account is always the session's
 *      account. No function accepts an `accountId`, a plan price, a currency,
 *      a provider name, a callback URL or a redirect URL: none of those are
 *      client inputs. The only client input is `planKey`.
 *   2. The plan is resolved from the database by `planKey`, and the amount is
 *      ALWAYS the database price (`plans.price`/`plans.currency`) run through
 *      `createPaymentAmount()`. A client-supplied amount cannot exist
 *      structurally (the Zod contract is `.strict()`), and a tampered price
 *      cannot exist because the row is loaded server-side.
 *
 * Payability rules (`assertPlanPayable`):
 *
 *   3. FREE is not purchasable; a deactivated (`plans.isActive = false`) plan
 *      and a non-positive price are not purchasable either — the last guard
 *      also protects against a mispriced seed.
 *
 * Already-active subscriptions:
 *
 *   4. If the account already has a subscription that genuinely grants paid
 *      access on a PAID plan (the shared `selectCurrentSubscription()`
 *      verdict — same rule the entitlement resolver enforces with — plus a
 *      plan key other than FREE), the request is refused with
 *      `SubscriptionAlreadyActiveError` instead of creating a competing
 *      active subscription. A granting FREE subscription is NOT a purchase:
 *      `bootstrap.ts` gives every new account an ACTIVE, open-ended FREE
 *      subscription as its baseline, so that state must never block buying
 *      BASIC/PRO. The FREE row is left untouched here; retiring it once the
 *      paid subscription activates belongs to the verify step. Paid→paid
 *      upgrades/downgrades need proration and are out of scope.
 *
 * Concurrency (mirrors `paymentService.ts`):
 *
 *   5. The pending state is created inside `prisma.$transaction` with a
 *      `SELECT id FROM "accounts" WHERE id = $1 FOR UPDATE` row lock as the
 *      FIRST statement, so two simultaneous checkouts for one account
 *      serialize: the loser re-reads subscriptions after the winner commits
 *      and is rejected (or supersedes a now-CANCELLED pending row, never
 *      duplicating a live one).
 *   6. The gateway HTTP call happens OUTSIDE the transaction. A slow or hung
 *      gateway must never hold a DB transaction (and its row lock) open; the
 *      pending rows are the recovery state, not an open transaction.
 *
 * Failure handling / consistency:
 *
 *   7. If the gateway call fails, the pending rows are compensated atomically
 *      within this request (both terminal writes in one transaction):
 *      `SubscriptionPayment → FAILED` and `Subscription → PAYMENT_FAILED`.
 *      Both updates are guarded with `status: "PENDING"` so a concurrent
 *      transition can never be clobbered.
 *      The error is rethrown and mapped by the route to a generic gateway
 *      failure — the client is never told a checkout succeeded when it did
 *      not, and no gateway detail leaves the server.
 *   8. On success only the `authority` column is written onto the (still
 *      PENDING) payment row. Activation, `endDate`, receipts and
 *      `referenceId` all belong to the verify step.
 *
 * Superseding stale checkouts:
 *
 *   9. A new checkout cancels the account's previous PENDING subscription and
 *      PENDING payments (`→ CANCELLED`) inside the same transaction, so at
 *      most one live pending checkout exists per account. A user who abandons
 *      a checkout and retries never accumulates zombie PENDING rows, and an
 *      old authority can never be verified after a newer checkout exists.
 */

/** Structural mirror of the `plans` fields the checkout needs. */
export interface SubscriptionPlanRecord {
  id: string;
  key: "FREE" | "BASIC" | "PRO";
  name: string;
  price: Decimal;
  currency: string;
  isActive: boolean;
}

/** Safe, client-facing result of a checkout: where to pay, and what it is. */
export interface SubscriptionCheckoutResult {
  /** Opaque identifier of the created SubscriptionPayment row. */
  paymentId: string;
  /** Absolute gateway URL the client must be redirected to. */
  redirectUrl: string;
}

export interface SubscriptionCheckoutOptions {
  /**
   * Already-authenticated session context for internal server-to-server
   * callers, exactly like `ResolveEntitlementsOptions.session`. Produced only
   * by `requireSession()`, never from request input; external callers omit it.
   */
  session?: AuthenticatedContext;
  /**
   * Internal/test provider override. Server-to-server only: production code
   * paths omit it so the provider always comes from the factory, which is
   * what keeps the gateway a server decision.
   */
  provider?: PaymentProvider;
  /**
   * Time source for the "already active" evaluation. Server-side only —
   * never from request input.
   */
  now?: Date;
}

/** Pending state created by the transaction, consumed by the gateway call. */
interface PendingCheckout {
  paymentId: string;
  subscriptionId: string;
  /** The provider the pending payment was registered under. */
  provider: PaymentProvider;
}

/**
 * The minimal PostgreSQL row lock on the account, taken as the FIRST
 * statement of the checkout transaction — the same pattern as
 * `lockInvoiceRow()` in `paymentService.ts`, keyed on the account because
 * subscription checkout is an account-scoped operation.
 */
async function lockAccountRow(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "accounts" WHERE id = ${accountId} FOR UPDATE`;
}

/**
 * Loads the plan row as the checkout needs it. The select is narrow on
 * purpose: the checkout must not read (or look like it reads) entitlement
 * limits or features — that is the entitlement resolver's job.
 */
async function loadPlanByKey(planKey: string): Promise<SubscriptionPlanRecord | null> {
  const plan = await prisma.plan.findUnique({
    where: { key: planKey as "FREE" | "BASIC" | "PRO" },
    select: {
      id: true,
      key: true,
      name: true,
      price: true,
      currency: true,
      isActive: true,
    },
  });

  return plan as unknown as SubscriptionPlanRecord | null;
}

/**
 * Payability is decided against the DATABASE row, never the request: FREE is
 * never purchasable, a deactivated plan is not purchasable, and a non-
 * positive price is not purchasable (a free-of-charge plan change must not
 * run through the gateway).
 */
function assertPlanPayable(plan: SubscriptionPlanRecord): void {
  if (plan.key === "FREE") {
    throw new ValidationError("The FREE plan cannot be purchased");
  }
  if (!plan.isActive) {
    throw new ValidationError("This plan is not currently available for purchase");
  }
  if (!new Decimal(plan.price).greaterThan(0)) {
    throw new ValidationError("This plan is not available for purchase");
  }
}

/**
 * The subscription row shape the checkout guard reads: whatever
 * `selectCurrentSubscription()` needs plus the plan's key, so the guard can
 * distinguish the bootstrap FREE baseline from a paid plan. The checkout
 * query loads exactly `plan: { key, isActive }` for this.
 */
export interface CheckoutSubscriptionRow extends SubscriptionSelectionRow {
  plan?: { key?: string; isActive?: boolean } | null;
}

/**
 * True when the account already has a subscription that genuinely grants
 * paid access on a PAID plan right now — the only state a second checkout
 * would compete with.
 *
 * Uses the SHARED selection rule (`selectCurrentSubscription()`) so checkout,
 * the entitlement resolver and the usage-period service can never disagree
 * about what "currently in force" means, then applies the one purchase-
 * specific refinement: a granting FREE subscription is the account's signup
 * baseline (`bootstrap.ts` creates an ACTIVE, open-ended FREE row for every
 * new account), not a purchase, and must not block buying BASIC/PRO. The
 * newest-granting-row rule is reused as-is on purpose: the bootstrap FREE row
 * is always the account's oldest row, so a genuinely active paid
 * subscription is always the row this guard sees.
 *
 * A missing/unrecognized plan key is treated as PAID — pessimistically
 * refusing the purchase beats risking a competing paid subscription.
 */
function hasBlockingPaidSubscription(
  rows: ReadonlyArray<CheckoutSubscriptionRow>,
  now: Date,
): boolean {
  const { granting } = selectCurrentSubscription(rows, now);
  return granting !== null && granting.plan?.key !== "FREE";
}

/**
 * Creates the PENDING subscription + payment rows, superseding any stale
 * PENDING checkout of the same account. Runs entirely inside one transaction
 * guarded by the account row lock — no gateway I/O happens here.
 *
 * `resolveProvider` is invoked only after the already-active check passes:
 * provider resolution is a pure, in-memory configuration read (env → adapter
 * object, no I/O), and locating it after the refusal checks means a refused
 * checkout never depends on — or even constructs — gateway configuration.
 */
async function createPendingCheckout(
  session: AuthenticatedContext,
  plan: SubscriptionPlanRecord,
  resolveProvider: () => PaymentProvider,
  now: Date,
): Promise<PendingCheckout> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Serialize concurrent checkouts for this account.
    await lockAccountRow(tx, session.accountId);

    // 2. Authoritative subscription state under the lock. The plan key rides
    //    along so the guard can tell the bootstrap FREE baseline from a
    //    genuinely paid subscription.
    const rows = await tx.subscription.findMany({
      where: { accountId: session.accountId },
      orderBy: SUBSCRIPTION_ORDER_BY,
      include: { plan: { select: { key: true, isActive: true } } },
    });
    if (hasBlockingPaidSubscription(rows, now)) {
      throw new SubscriptionAlreadyActiveError();
    }

    // 3. Resolve the gateway from server configuration (in-memory only).
    const provider = resolveProvider();

    // 4. Supersede stale pending checkouts: an abandoned (unpaid, unverified)
    //    pending checkout must not survive alongside the new one.
    await tx.subscription.updateMany({
      where: { accountId: session.accountId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    await tx.subscriptionPayment.updateMany({
      where: { accountId: session.accountId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    // 5. Create the pending subscription. The schema default is ACTIVE — the
    //    checkout must override it explicitly: nothing is granted until the
    //    verify step activates the subscription.
    const subscription = await tx.subscription.create({
      data: {
        accountId: session.accountId,
        planId: plan.id,
        status: "PENDING",
        autoRenew: false,
      },
    });

    // 6. Create the pending payment from DATABASE price/currency only.
    const payment = await tx.subscriptionPayment.create({
      data: {
        accountId: session.accountId,
        subscriptionId: subscription.id,
        provider: provider.name,
        amount: plan.price,
        currency: plan.currency,
        status: "PENDING",
      },
    });

    return { paymentId: payment.id, subscriptionId: subscription.id, provider };
  });
}

/**
 * Compensation for a failed gateway call: move the pending rows to their
 * terminal failure states so the database never keeps a live checkout that
 * has no gateway session behind it. Both writes are `updateMany` guarded by
 * `status: "PENDING"` — if anything else already transitioned the rows, the
 * update is a no-op instead of a clobber.
 */
async function compensateFailedCheckout(pending: PendingCheckout): Promise<void> {
  // One transaction so the two terminal states are written together — a crash
  // between separate writes could leave payment=FAILED on a still-PENDING
  // subscription. Both writes stay guarded by `status: "PENDING"` so a
  // concurrent transition can never be clobbered.
  await prisma.$transaction([
    prisma.subscriptionPayment.updateMany({
      where: { id: pending.paymentId, status: "PENDING" },
      data: { status: "FAILED" },
    }),
    prisma.subscription.updateMany({
      where: { id: pending.subscriptionId, status: "PENDING" },
      data: { status: "PAYMENT_FAILED" },
    }),
  ]);
}

/**
 * Starts a subscription checkout for the authenticated account.
 *
 * @param input The request body. Only `{ planKey }` is accepted; everything
 *   else (amount, currency, provider, callback/redirect URLs) is decided
 *   server-side.
 * @returns `{ paymentId, redirectUrl }` — the only safe response payload. No
 *   merchant ID, authority secret material, gateway envelope or internal
 *   error detail is included; gateway errors are rethrown as typed errors for
 *   the route layer to map onto generic messages.
 *
 * @throws UnauthorizedError / ForbiddenError from `requireSession()`
 * @throws ValidationError for a malformed `planKey`, a non-purchasable plan
 * @throws NotFoundError when no plan row exists for the key
 * @throws SubscriptionAlreadyActiveError when an active subscription exists
 * @throws PaymentProviderNotConfiguredError / PaymentProviderError /
 *   PaymentProviderUnavailableError from the gateway layer
 */
export async function createSubscriptionCheckout(
  input: unknown,
  options: SubscriptionCheckoutOptions = {},
): Promise<SubscriptionCheckoutResult> {
  // 1. Who is calling — session only, never the payload.
  const session = options.session ?? (await requireSession());

  // 2. Shape validation. `.strict()` rejects any attempt to smuggle amount,
  //    currency, provider, callback or redirect URLs through the body.
  const parsed = parseCreateSubscriptionCheckoutInput(input);

  // 3. Server-side plan resolution and payability.
  const plan = await loadPlanByKey(parsed.planKey);
  if (!plan) {
    throw new NotFoundError("Plan not found");
  }
  assertPlanPayable(plan);

  const now = options.now ?? new Date();

  // 4. Validate the DB price for the gateway up front, so a mispriced seed
  //    fails before any rows are written.
  const gatewayAmount = createPaymentAmount(plan.price, plan.currency);

  // 5. Callback URL from the configured base, stamped as a subscription
  //    payment so the callback handler can never confuse it with a future
  //    invoice-payment callback.
  const callbackUrl = buildPaymentCallbackUrl(SUBSCRIPTION_PAYMENT_CALLBACK_KIND);

  // 6. Pending state, transactionally (see module doc — the transaction does
  //    NOT span the gateway call). The gateway itself is resolved inside,
  //    after the already-active check: server configuration decides it, and
  //    a refused checkout never builds a provider at all. `options.provider`
  //    is an internal/test-only injection point.
  const pending = await createPendingCheckout(
    session,
    plan,
    () => options.provider ?? getPaymentProvider(),
    now,
  );

  // 7. Ask the gateway (outside any DB transaction) and persist the authority.
  try {
    const gateway = await pending.provider.createPayment({
      amount: gatewayAmount,
      currency: plan.currency,
      description: `${plan.name} (${plan.key}) subscription`,
      callbackUrl,
      metadata: {
        order_id: pending.paymentId,
        plan_key: plan.key,
      },
    });

    await prisma.subscriptionPayment.update({
      where: { id: pending.paymentId },
      data: { authority: gateway.authority },
    });

    return { paymentId: pending.paymentId, redirectUrl: gateway.redirectUrl };
  } catch (error) {
    // Server-side only diagnostics: the typed gateway errors carry safe,
    // fixed messages by construction. Nothing here is returned to the client.
    console.error(
      "[subscriptionPaymentService] gateway createPayment failed — compensating pending checkout",
      error,
    );
    await compensateFailedCheckout(pending);
    throw error;
  }
}
