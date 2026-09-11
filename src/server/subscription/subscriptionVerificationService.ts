import { addMonths } from "date-fns";
import type { Prisma } from "@prisma/client";
import type { Decimal } from "decimal.js";
import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/server/auth/requireSession";
import { EntitlementDataError } from "@/server/errors";
import { getPaymentProvider } from "@/server/payments/factory";
import { createPaymentAmount } from "@/server/payments/money";
import { PaymentProviderNotConfiguredError } from "@/server/payments/paymentErrors";
import { PAYMENT_PROVIDER_NAMES, type PaymentProviderName } from "@/server/payments/types";
import type { PaymentProvider } from "@/server/payments/PaymentProvider";

/**
 * Subscription payment callback → verify → activation (the second half of
 * the purchase flow started by `subscriptionPaymentService.ts`).
 *
 * The gateway redirects the payer's browser to the configured
 * `PAYMENT_CALLBACK_URL` with `kind=subscription` stamped by
 * `buildPaymentCallbackUrl()` plus the gateway's own query parameters
 * (ZarinPal: `Authority`, `Status=OK|NOK`). The route layer parses those and
 * hands them here; this module owns every state transition.
 *
 * Trust model:
 *   - The callback is UNAUTHENTICATED (it is the payer's browser arriving
 *     from the gateway). Nothing in the query is trusted except as a lookup
 *     hint: the `authority` is a capability that names one SubscriptionPayment
 *     row, and every money-relevant value (amount, currency, plan) is read
 *     back from the DATABASE row, never from the request.
 *   - The provider used to verify is resolved from the row's OWN
 *     `provider` column (written by the checkout from the factory), so a
 *     callback can never cause a verification against a different gateway
 *     than the one that created the payment. The name is server data, not
 *     client input.
 *
 * State machine (all transitions guarded, see below):
 *
 *   PENDING  + gateway NOK/abandoned          → payment FAILED, subscription PAYMENT_FAILED
 *   PENDING  + provider REJECTED              → payment FAILED, subscription PAYMENT_FAILED
 *   PENDING  + plan deactivated before verify → payment FAILED, subscription PAYMENT_FAILED
 *                                                (money moved but nothing is granted: same
 *                                                reconciliation/refund path, never activation)
 *   PENDING  + provider VERIFIED              → payment SUCCESS (referenceId, verifiedAt),
 *                                                subscription ACTIVE (startDate/endDate window),
 *                                                bootstrap FREE baseline → EXPIRED
 *   SUCCESS  + any callback                   → ALREADY_VERIFIED (idempotent, no provider call)
 *   FAILED/CANCELLED/REFUNDED + any callback  → REJECTED, never re-verified and never activated
 *                                                (a superseded checkout's authority that was
 *                                                still paid needs a refund path, not activation)
 *   provider unavailable/error                → rows stay PENDING (retryable); money may have
 *                                                moved, so failure states are only written on a
 *                                                definitive gateway answer
 *
 * Concurrency (mirrors `subscriptionPaymentService.ts`):
 *   - The verify HTTP call happens OUTSIDE any DB transaction.
 *   - Activation runs inside one `prisma.$transaction` whose FIRST statement
 *     is `SELECT id FROM "subscription_payments" WHERE id = $1 FOR UPDATE`,
 *     so two simultaneous callbacks (user refresh / gateway retry) serialize:
 *     the loser re-reads the row under the lock, sees the winner's SUCCESS,
 *     and returns ALREADY_VERIFIED without double-activating or creating a
 *     second subscription window.
 *   - Every terminal write is additionally guarded with `status: "PENDING"`
 *     in its WHERE so it can never clobber a concurrent transition.
 *
 * Idempotency & recovery:
 *   - If activation's transaction rolled back after a successful gateway
 *     verify (crash, DB outage), the row is still PENDING, so a retried
 *     callback re-verifies (ZarinPal answers code 101 "already verified",
 *     which maps to VERIFIED) and activates then.
 */

/** The safe, client-facing outcomes of a callback. */
export type SubscriptionCallbackOutcome = "VERIFIED" | "ALREADY_VERIFIED" | "REJECTED";

export interface SubscriptionCallbackResult {
  status: SubscriptionCallbackOutcome;
  /** Opaque identifier of the SubscriptionPayment row. */
  paymentId: string;
  /** The purchased plan's key (null when the row could not be resolved). */
  planKey: "FREE" | "BASIC" | "PRO" | null;
}

export interface SubscriptionCallbackInput {
  /** The gateway authority identifying the payment. */
  authority: string;
  /** The gateway's redirect status hint (ZarinPal: "OK" | "NOK"), if sent. */
  gatewayStatus?: string | null;
}

export interface SubscriptionCallbackOptions {
  /** Time source for the subscription window. Server-side only. */
  now?: Date;
  /** Internal/test provider override (server-to-server only, like checkout). */
  provider?: PaymentProvider;
}

/** Structural mirror of the `subscription_payments` fields this module reads. */
interface CallbackPaymentRow {
  id: string;
  accountId: string;
  subscriptionId: string;
  provider: string;
  amount: Decimal;
  currency: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "CANCELLED" | "REFUNDED";
  authority: string | null;
}

/** Structural mirror of the `subscriptions` fields activation reads/writes. */
interface ActivationSubscriptionRow {
  id: string;
  accountId: string;
  status: "ACTIVE" | "PENDING" | "EXPIRED" | "CANCELLED" | "PAYMENT_FAILED";
  plan: {
    key: "FREE" | "BASIC" | "PRO";
    billingInterval: "MONTHLY";
    isActive: boolean;
  } | null;
}

/**
 * Normalizes the gateway's redirect status hint. ZarinPal sends `Status=OK`
 * (payer completed the form) or `Status=NOK` (payer abandoned/failed) —
 * case-insensitively. Absent/unknown values return null, which means "let the
 * provider verify decide" (some gateways send no status at all).
 */
export function normalizeGatewayStatus(raw: string | null | undefined): "OK" | "NOK" | null {
  if (raw === null || raw === undefined) return null;
  const normalized = raw.trim().toUpperCase();
  if (normalized === "OK") return "OK";
  if (normalized === "NOK") return "NOK";
  return null;
}

/**
 * The paid window's end for a subscription starting `start`.
 *
 * The interval comes from the plan's `billingInterval` (currently only
 * MONTHLY in the schema). Calendar-aware via the shared `date-fns`
 * `addMonths` (same library `usage-period.ts` uses), so Jan 31 + 1 month is
 * Feb 28/29, not Mar 2/3. An unknown interval means schema/module
 * disagreement — refused instead of guessed, like every other entitlement
 * datum.
 *
 * @throws EntitlementDataError for an interval this build does not know.
 */
export function computeSubscriptionWindowEnd(start: Date, interval: string): Date {
  switch (interval) {
    case "MONTHLY":
      return addMonths(start, 1);
    default:
      throw new EntitlementDataError(`Unknown billing interval in the database: ${interval}`);
  }
}

/**
 * Loads a subscription payment by authority. `authority` is not UNIQUE in
 * the schema, so the newest matching row wins (checkouts supersede stale
 * pending rows, so at most one live row per authority exists in practice).
 */
async function loadPaymentByAuthority(authority: string): Promise<CallbackPaymentRow | null> {
  const payment = await prisma.subscriptionPayment.findFirst({
    where: { authority },
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  });
  return payment as unknown as CallbackPaymentRow | null;
}

/**
 * The definitive failure write (gateway NOK or an explicit provider
 * REJECTED): both terminal states in ONE transaction, guarded by
 * `status: "PENDING"` — identical discipline to the checkout's compensation.
 */
async function markCallbackFailure(payment: CallbackPaymentRow): Promise<void> {
  await prisma.$transaction([
    prisma.subscriptionPayment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "FAILED" },
    }),
    prisma.subscription.updateMany({
      where: { id: payment.subscriptionId, status: "PENDING" },
      data: { status: "PAYMENT_FAILED" },
    }),
  ]);
}

/**
 * Activates a verified payment inside one lock-guarded transaction:
 *
 *   1. `SELECT ... FOR UPDATE` on the payment row (first statement) so
 *      concurrent callbacks serialize;
 *   2. re-read under the lock — if a racing callback already won, report
 *      that instead of double-activating;
 *   3. payment  → SUCCESS with `referenceId` + `verifiedAt` (guarded PENDING);
 *      subscription → ACTIVE with a fresh MONTHLY window (guarded PENDING);
 *   4. the account's ACTIVE FREE baseline rows (bootstrap) → EXPIRED with
 *      `endDate = now`, never touching the newly activated subscription —
 *      the checkout deliberately left them alone; retiring them is this
 *      step's job.
 *
 * A plan deactivated between checkout and payment is NEVER activated: the
 * transaction detects it and returns WITHOUT writing, so no partial
 * activation can exist; the caller routes the outcome to the same
 * reconciliation/refund-safe failure path as paid-but-superseded/failed
 * authorities (`markCallbackFailure()`).
 *
 * @returns The activation outcome — `VERIFIED`; `ALREADY_VERIFIED` when a
 *   racing callback won the lock; `REJECTED` when a racing definitive
 *   failure won; `PLAN_INACTIVE` when the purchased plan was deactivated
 *   before payment (no writes performed here) — plus the purchased plan key
 *   when it is known.
 */
async function activateVerifiedPayment(
  payment: CallbackPaymentRow,
  referenceId: string | null,
  now: Date,
): Promise<{
  outcome: "VERIFIED" | "ALREADY_VERIFIED" | "REJECTED" | "PLAN_INACTIVE";
  planKey: "FREE" | "BASIC" | "PRO" | null;
}> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Serialize concurrent callbacks for this payment.
    await tx.$queryRaw`SELECT id FROM "subscription_payments" WHERE id = ${payment.id} FOR UPDATE`;

    // 2. Authoritative state under the lock.
    const current = await tx.subscriptionPayment.findUnique({ where: { id: payment.id } });
    if (!current) {
      // Unreachable (FK-guaranteed row, no deletes in this domain), but a
      // missing row must never be "activated".
      throw new NotFoundError("Subscription payment not found");
    }
    if (current.status === "SUCCESS") {
      return { outcome: "ALREADY_VERIFIED" as const, planKey: null };
    }
    if (current.status !== "PENDING") {
      // A concurrent definitive failure won the race; nothing to activate.
      return { outcome: "REJECTED" as const, planKey: null };
    }

    // 3. Load the pending subscription with its plan (authoritative source of
    //    the purchased plan key and the billing interval for the window).
    const subscription = (await tx.subscription.findUnique({
      where: { id: payment.subscriptionId },
      include: { plan: { select: { key: true, billingInterval: true, isActive: true } } },
    })) as unknown as ActivationSubscriptionRow | null;

    if (!subscription || !subscription.plan) {
      throw new EntitlementDataError("Subscription payment has no resolvable subscription/plan");
    }

    // A deactivated plan must never become ACTIVE: entitlements would enforce
    // Free anyway, and the payer would have paid for an unusable plan. Return
    // WITHOUT writing — everything so far in this transaction is reads only,
    // so "no writes here" means no partial activation can exist. The caller
    // routes this outcome to the documented reconciliation/refund path.
    // Pessimistic on a missing flag: withholding activation is recoverable
    // (rows stay PENDING, a retried callback re-checks), activating a retired
    // plan is not.
    if (subscription.plan.isActive !== true) {
      return { outcome: "PLAN_INACTIVE" as const, planKey: null };
    }

    const windowEnd = computeSubscriptionWindowEnd(now, subscription.plan.billingInterval);

    await tx.subscriptionPayment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: {
        status: "SUCCESS",
        verifiedAt: now,
        ...(referenceId !== null ? { referenceId } : {}),
      },
    });

    await tx.subscription.updateMany({
      where: { id: subscription.id, status: "PENDING" },
      data: {
        status: "ACTIVE",
        startDate: now,
        endDate: windowEnd,
      },
    });

    // 4. Retire the bootstrap FREE baseline(s): any OTHER still-ACTIVE FREE
    //    subscription of this account is superseded by the paid one. Scoped
    //    to the payment's account and the FREE plan key only.
    await tx.subscription.updateMany({
      where: {
        accountId: payment.accountId,
        status: "ACTIVE",
        id: { not: subscription.id },
        plan: { key: "FREE" },
      },
      data: { status: "EXPIRED", endDate: now },
    });

    return { outcome: "VERIFIED" as const, planKey: subscription.plan.key };
  });
}

/**
 * Processes a subscription payment callback: verifies the payment with the
 * gateway that created it and, on success, activates the subscription.
 *
 * @returns The safe result payload (`status`, `paymentId`, `planKey`).
 *   No authority echo, merchant IDs, gateway envelopes or internal errors.
 *
 * @throws ValidationError for a missing authority
 * @throws NotFoundError when no SubscriptionPayment row has the authority
 * @throws PaymentProviderNotConfiguredError when the row names an unknown
 *   provider or the stored provider is not configured
 * @throws PaymentProviderUnavailableError / PaymentProviderError when the
 *   gateway cannot be reached or the verify request fails transport-level —
 *   the rows intentionally stay PENDING so the callback can be retried.
 */
export async function verifySubscriptionCallback(
  input: SubscriptionCallbackInput,
  options: SubscriptionCallbackOptions = {},
): Promise<SubscriptionCallbackResult> {
  const authority = typeof input?.authority === "string" ? input.authority.trim() : "";
  if (authority === "") {
    throw new NotFoundError("Subscription payment not found");
  }

  // 1. Resolve the row (also the only source of amount/currency/provider).
  const payment = await loadPaymentByAuthority(authority);
  if (!payment) {
    throw new NotFoundError("Subscription payment not found");
  }

  // 2. Rows that are not PENDING are terminal: never re-verified, never
  //    activated. SUCCESS is idempotent; FAILED/CANCELLED/REFUNDED authorities
  //    that were still paid at the gateway need an ops/refund path, which is
  //    deliberately NOT activation.
  if (payment.status !== "PENDING") {
    return {
      status: payment.status === "SUCCESS" ? "ALREADY_VERIFIED" : "REJECTED",
      paymentId: payment.id,
      planKey: null,
    };
  }

  const now = options.now ?? new Date();

  // 3. Gateway says the payer abandoned the checkout — no verify call needed.
  if (normalizeGatewayStatus(input.gatewayStatus) === "NOK") {
    await markCallbackFailure(payment);
    return { status: "REJECTED", paymentId: payment.id, planKey: null };
  }

  // 4. Verify against the gateway that created the payment (row data only).
  if (!(PAYMENT_PROVIDER_NAMES as readonly string[]).includes(payment.provider)) {
    // The checkout only ever writes factory names; anything else means the
    // data was tampered with or a new provider was misconfigured out.
    throw new PaymentProviderNotConfiguredError("Payment provider is not configured");
  }
  const provider = options.provider ?? getPaymentProvider(payment.provider as PaymentProviderName);
  const gatewayAmount = createPaymentAmount(payment.amount, payment.currency);

  const verification = await provider.verifyPayment({
    amount: gatewayAmount,
    currency: payment.currency,
    authority: payment.authority ?? authority,
  });

  // 5. Definitive gateway answers drive the transitions; transport failures
  //    propagate and leave everything PENDING (retryable).
  if (verification.status === "VERIFIED") {
    const activation = await activateVerifiedPayment(payment, verification.referenceId, now);
    if (activation.outcome === "PLAN_INACTIVE") {
      // The gateway verified (money moved), but the purchased plan was
      // deactivated before activation. The transaction above wrote nothing;
      // the SAME guarded reconciliation/refund path used for paid-but-
      // superseded/failed authorities provides the terminal states here.
      await markCallbackFailure(payment);
      return { status: "REJECTED", paymentId: payment.id, planKey: null };
    }
    return {
      status: activation.outcome,
      paymentId: payment.id,
      planKey: activation.planKey,
    };
  }

  await markCallbackFailure(payment);
  return { status: "REJECTED", paymentId: payment.id, planKey: null };
}
