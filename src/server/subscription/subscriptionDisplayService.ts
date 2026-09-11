import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/server/auth/requireSession";
import {
  resolveEntitlements,
  type SubscriptionRecord,
} from "@/server/entitlements/entitlementService";
import { getInvoiceQuotaStatus } from "@/server/entitlements/invoiceQuota";
import type { EntitlementFallbackReason } from "@/server/entitlements/subscriptionSelection";
import { EntitlementDataError } from "@/server/errors";

/**
 * Read-only assembly of the "پلن و اشتراک" dashboard page
 * (`/dashboard/subscription`).
 *
 * Trust model (same posture as every other service here):
 *   - `accountId` comes exclusively from `requireSession()`. No parameter can
 *     name an account, subscription or plan; the only inputs are a time
 *     source and a history cap, both server-owned.
 *   - The "which subscription is current / what does it grant" verdict is
 *     NEVER re-implemented: `resolveEntitlements()` (the single entitlement
 *     entry point, itself built on the pure `selectCurrentSubscription()`
 *     rule) produces it, and the finalized-invoice quota line reuses
 *     `getInvoiceQuotaStatus()` so the numbers shown here can never disagree
 *     with the sidebar or dashboard overview.
 *
 * Presentation rules:
 *   - Money is always a fixed 2dp string (Decimal-safe, never a JS float);
 *     dates are ISO strings. The UI formats them (Persian digits / Jalali).
 *   - Plans are the database's ACTIVE plans in FREE → BASIC → PRO display
 *     order, each pre-computed with `isCurrent` and a `purchasable` verdict
 *     that mirrors the checkout guard in `subscriptionPaymentService.ts`
 *     exactly (a genuinely in-force PAID plan blocks a new purchase; a
 *     granting FREE baseline never does). The UI renders what it is handed —
 *     it does not decide entitlements.
 */

export type SubscriptionStatusKey =
  | "ACTIVE"
  | "PENDING"
  | "EXPIRED"
  | "CANCELLED"
  | "PAYMENT_FAILED";

export type SubscriptionPaymentStatusKey =
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED";

export type PlanKeyDisplay = "FREE" | "BASIC" | "PRO";

/** Why a plan card shows no purchase button. */
export type PlanNotPurchasableReason =
  | "FREE_PLAN"
  | "ACTIVE_PAID_SUBSCRIPTION"
  | null;

export interface SubscriptionFeatureDTO {
  key: string;
  name: string;
  description: string;
}

/**
 * The subscription row entitlements currently resolve from — the same row the
 * resolver picked (`selectCurrentSubscription()`'s `selected`), with its
 * display data attached. `null` when the account has no subscription rows at
 * all (defensive: `bootstrap.ts` always creates the FREE baseline, so this is
 * an inconsistent-state guard, not an expected branch).
 */
export interface CurrentSubscriptionDTO {
  id: string;
  planKey: PlanKeyDisplay;
  planName: string;
  /** `plans.isActive` of the row's plan — a retired plan shows as inactive. */
  planActive: boolean;
  /** What the row says. Diagnostics — never render decisions from this alone. */
  storedStatus: SubscriptionStatusKey;
  /** After date/plan demotion — the status the UI presents and acts on. */
  enforcedStatus: SubscriptionStatusKey;
  /** True only when this row genuinely grants access right now. */
  inForce: boolean;
  /** Why the account is being enforced as Free (`NONE` when it is not). */
  fallbackReason: EntitlementFallbackReason;
  startDate: string | null;
  endDate: string | null;
  price: string;
  currency: string;
  businessLimit: number;
  invoiceLimit: number;
  features: SubscriptionFeatureDTO[];
}

/** One active plan as an upgrade offer. */
export interface SubscriptionPlanOfferDTO {
  key: PlanKeyDisplay;
  name: string;
  description: string;
  /** `plans.price`, fixed 2dp string. */
  price: string;
  currency: string;
  billingInterval: string;
  businessLimit: number;
  invoiceLimit: number;
  /** Enabled features only — a disabled PlanFeature grants nothing. */
  features: SubscriptionFeatureDTO[];
  /** True when this is the plan whose limits are enforced right now. */
  isCurrent: boolean;
  purchasable: boolean;
  notPurchasableReason: PlanNotPurchasableReason;
}

export interface SubscriptionPaymentHistoryDTO {
  id: string;
  planKey: PlanKeyDisplay | null;
  planName: string | null;
  /** `subscription_payments.provider` (e.g. `zarinpal` / `sandbox`). */
  provider: string;
  /** Fixed 2dp string. */
  amount: string;
  currency: string;
  status: SubscriptionPaymentStatusKey;
  createdAt: string;
  verifiedAt: string | null;
}

export interface SubscriptionDisplayQuotaDTO {
  usedInvoices: number;
  invoiceLimit: number;
  remainingInvoices: number;
  warningLevel: "OK" | "WARNING_80" | "REACHED";
  periodEnd: string;
}

export interface SubscriptionDisplayDTO {
  current: CurrentSubscriptionDTO | null;
  /** The plan key whose limits are enforced right now (FREE when lapsed). */
  effectivePlanKey: PlanKeyDisplay;
  /** Finalized-invoice quota — same source as the sidebar/dashboard. */
  quota: SubscriptionDisplayQuotaDTO;
  /** Active plans, FREE → BASIC → PRO. */
  plans: SubscriptionPlanOfferDTO[];
  /** Newest subscription payments first, capped. */
  paymentHistory: SubscriptionPaymentHistoryDTO[];
}

export interface SubscriptionDisplayOptions {
  /** Time source for the date-based lapse check; injectable for tests. */
  now?: Date;
  /** Cap on history rows (default 20, hard max 50). */
  paymentHistoryLimit?: number;
}

// ---------------------------------------------------------------------------
// Structural row mirrors (matching prisma/schema.prisma) — declared
// structurally rather than imported from @prisma/client so this module
// type-checks even where `prisma generate` has not run (same convention as
// PlanRow / SubscriptionRowWithPlan).
// ---------------------------------------------------------------------------

interface PlanFeatureRow {
  enabled: boolean;
  feature: { key: string; name: string; description: string };
}

interface PlanRow {
  id: string;
  key: string;
  name: string;
  description: string;
  price: { toString(): string };
  currency: string;
  billingInterval: string;
  businessLimit: number;
  invoiceLimit: number;
  isActive: boolean;
  planFeatures: ReadonlyArray<PlanFeatureRow>;
}

interface PaymentHistoryRow {
  id: string;
  provider: string;
  amount: { toString(): string };
  currency: string;
  status: string;
  createdAt: Date;
  verifiedAt: Date | null;
  subscription: { plan: { key: string; name: string } } | null;
}

const PLAN_KEY_ORDER: Record<string, number> = { FREE: 0, BASIC: 1, PRO: 2 };

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;

/**
 * Validates a stored plan key into the display type. Throws on an unknown key
 * rather than guessing — the same fail-loudly posture as `toPlanKey()` in
 * `planContext.ts` (an unknown key means the DB and the app disagree, and
 * silently mapping it could mis-price a plan card).
 */
function toDisplayPlanKey(key: string): PlanKeyDisplay {
  if (key === "FREE" || key === "BASIC" || key === "PRO") {
    return key;
  }
  throw new EntitlementDataError(`Unknown plan key in the database: ${key}`);
}

/** Fixed 2dp, Decimal-safe money string (same convention as dashboardService). */
function toMoneyString(value: { toString(): string } | string | null | undefined): string {
  if (value === null || value === undefined) return "0.00";
  const text = typeof value === "string" ? value : value.toString();
  return new Decimal(text).toFixed(2);
}

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toFeatureDTOs(
  rows: ReadonlyArray<PlanFeatureRow>,
): SubscriptionFeatureDTO[] {
  return rows.map((row) => ({
    key: row.feature.key,
    name: row.feature.name,
    description: row.feature.description,
  }));
}

function toMoneyPlanRow(row: PlanRow): {
  name: string;
  description: string;
  price: string;
  currency: string;
  billingInterval: string;
  businessLimit: number;
  invoiceLimit: number;
  features: SubscriptionFeatureDTO[];
  isActive: boolean;
} {
  return {
    name: row.name,
    description: row.description,
    price: toMoneyString(row.price),
    currency: row.currency,
    billingInterval: row.billingInterval,
    businessLimit: row.businessLimit,
    invoiceLimit: row.invoiceLimit,
    features: toFeatureDTOs(row.planFeatures),
    isActive: row.isActive,
  };
}

function clampHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit), MAX_HISTORY_LIMIT));
}

function toStoredStatus(status: string): SubscriptionStatusKey {
  if (
    status === "ACTIVE" ||
    status === "PENDING" ||
    status === "EXPIRED" ||
    status === "CANCELLED" ||
    status === "PAYMENT_FAILED"
  ) {
    return status;
  }
  throw new EntitlementDataError(`Unknown subscription status in the database: ${status}`);
}

function toPaymentStatus(status: string): SubscriptionPaymentStatusKey {
  if (
    status === "PENDING" ||
    status === "SUCCESS" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "REFUNDED"
  ) {
    return status;
  }
  throw new EntitlementDataError(`Unknown subscription payment status in the database: ${status}`);
}

/**
 * Loads the plan row behind the selected subscription when it is not among
 * the active plans (i.e. it was deactivated after the subscription was
 * created). Displaying the name as-is is correct: the card also reports
 * `planActive: false` and the resolver's `fallbackReason`.
 */
async function loadDeactivatedPlanRow(key: string): Promise<PlanRow> {
  const row = (await prisma.plan.findUnique({
    where: { key },
    include: { planFeatures: { where: { enabled: true }, include: { feature: true } } },
  })) as unknown as PlanRow | null;
  if (!row) {
    // The subscription row references a plan that no longer exists —
    // inconsistent data; refusing is safer than inventing a price.
    throw new EntitlementDataError(
      "The plan behind the current subscription no longer exists.",
    );
  }
  return row;
}

/**
 * Assembles the full subscription-page payload for the authenticated account.
 *
 * @throws UnauthorizedError / ForbiddenError from `requireSession()` when
 *   there is no valid, active session.
 * @throws EntitlementDataError when plan/subscription data is inconsistent
 *   (missing FREE baseline, unknown plan key, missing referenced plan row).
 */
export async function getSubscriptionDisplay(
  options: SubscriptionDisplayOptions = {},
): Promise<SubscriptionDisplayDTO> {
  const session = await requireSession();
  const now = options.now ?? new Date();

  // 1. The entitlement verdict — single source of truth for "current
  //    subscription", "effective plan" and "why Free". Runs its own queries;
  //    we never re-load subscriptions to second-guess it.
  const entitlements = await resolveEntitlements({ now, session });

  // 2. Quota line — same resolver the sidebar/dashboard use, so the numbers
  //    agree everywhere by construction.
  const quotaStatus = await getInvoiceQuotaStatus({ now, session });

  // 3. Active plans (the upgrade grid), deterministic display order.
  const activePlanRows = (await prisma.plan.findMany({
    where: { isActive: true },
    include: { planFeatures: { where: { enabled: true }, include: { feature: true } } },
  })) as unknown as PlanRow[];
  const orderedPlans = [...activePlanRows].sort(
    (a, b) => (PLAN_KEY_ORDER[a.key] ?? Number.MAX_SAFE_INTEGER) - (PLAN_KEY_ORDER[b.key] ?? Number.MAX_SAFE_INTEGER),
  );

  // The checkout guard, mirrored (see subscriptionPaymentService.ts): a
  // genuinely in-force PAID plan blocks new purchases; a granting FREE
  // baseline is the signup default and never does.
  const paidInForce =
    entitlements.hasEffectiveSubscription && entitlements.plan.planKey !== "FREE";

  const plans: SubscriptionPlanOfferDTO[] = orderedPlans.map((row) => {
    const key = toDisplayPlanKey(row.key);
    let purchasable = true;
    let notPurchasableReason: PlanNotPurchasableReason = null;
    if (key === "FREE") {
      // FREE is granted at signup, never bought (assertPlanPayable in the
      // checkout service enforces the same rule server-side).
      purchasable = false;
      notPurchasableReason = "FREE_PLAN";
    } else if (paidInForce) {
      purchasable = false;
      notPurchasableReason = "ACTIVE_PAID_SUBSCRIPTION";
    }
    return {
      key,
      ...toMoneyPlanRow(row),
      isCurrent: key === entitlements.plan.planKey,
      purchasable,
      notPurchasableReason,
    };
  });

  // 4. The current subscription row + its plan's display data.
  let current: CurrentSubscriptionDTO | null = null;
  const record: SubscriptionRecord | null = entitlements.subscriptionRecord;
  if (record) {
    const planKey = toDisplayPlanKey(record.planKey);
    const planRow =
      orderedPlans.find((row) => row.key === record.planKey) ??
      (await loadDeactivatedPlanRow(record.planKey));
    const planDisplay = toMoneyPlanRow(planRow);
    current = {
      id: record.id,
      planKey,
      planName: planDisplay.name,
      planActive: planDisplay.isActive,
      storedStatus: toStoredStatus(record.storedStatus),
      enforcedStatus: toStoredStatus(record.enforcedStatus),
      // selected === granting exactly when hasEffectiveSubscription (the
      // selection rule returns the granting row as `selected` whenever one
      // exists), so the resolver's verdict IS this row's in-force verdict.
      inForce: entitlements.hasEffectiveSubscription,
      fallbackReason: entitlements.fallbackReason,
      startDate: toIso(record.startDate),
      endDate: toIso(record.endDate),
      price: planDisplay.price,
      currency: planDisplay.currency,
      businessLimit: planDisplay.businessLimit,
      invoiceLimit: planDisplay.invoiceLimit,
      features: planDisplay.features,
    };
  }

  // 5. Payment history — newest first, bounded, plan name joined through the
  //    payment's subscription row.
  const historyRows = (await prisma.subscriptionPayment.findMany({
    where: { accountId: session.accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: clampHistoryLimit(options.paymentHistoryLimit),
    include: { subscription: { select: { plan: { select: { key: true, name: true } } } } },
  })) as unknown as PaymentHistoryRow[];

  const paymentHistory: SubscriptionPaymentHistoryDTO[] = historyRows.map((row) => ({
    id: row.id,
    planKey: row.subscription ? toDisplayPlanKey(row.subscription.plan.key) : null,
    planName: row.subscription?.plan.name ?? null,
    provider: row.provider,
    amount: toMoneyString(row.amount),
    currency: row.currency,
    status: toPaymentStatus(row.status),
    createdAt: toIso(row.createdAt) ?? "",
    verifiedAt: toIso(row.verifiedAt),
  }));

  return {
    current,
    effectivePlanKey: entitlements.plan.planKey,
    quota: {
      usedInvoices: quotaStatus.usedInvoices,
      invoiceLimit: quotaStatus.invoiceLimit,
      remainingInvoices: quotaStatus.remainingInvoices,
      warningLevel: quotaStatus.warningLevel,
      periodEnd: toIso(quotaStatus.periodEnd) ?? "",
    },
    plans,
    paymentHistory,
  };
}
