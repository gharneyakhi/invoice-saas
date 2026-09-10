import type { PaymentAmount, PaymentCurrency } from "./money";

/**
 * Normalized DTOs for the payment-provider boundary.
 *
 * These are the ONLY shapes the rest of the application is allowed to see.
 * A provider-specific payload (ZarinPal's `merchant_id` / `authority` /
 * `ref_id`, a sandbox record) never escapes its adapter, which is what makes
 * a provider swappable without touching business logic — the property
 * `README.md` promises for `src/server/payments/PaymentProvider.ts`.
 *
 * Conventions every DTO follows:
 *
 *   - JSON-serializable: money is a `PaymentAmount` (string amount + currency
 *     code), never a `Decimal`, so DTOs can cross the Server Action boundary
 *     untouched.
 *   - Provider references are opaque strings. `providerReference` is what the
 *     gateway gave us to continue the flow (ZarinPal `authority`);
 *     `referenceId` is the gateway's settlement/receipt id after success
 *     (ZarinPal `ref_id`). Both are stored verbatim and never parsed.
 *   - `orderId` is *our* identifier and is echoed by the caller, never
 *     trusted back from the gateway.
 */

/** Re-exported so a caller importing the DTOs gets the money vocabulary too. */
export type { PaymentAmount, PaymentCurrency };

export const PAYMENT_PROVIDER_IDS = ["zarinpal", "sandbox"] as const;

export type PaymentProviderId = (typeof PAYMENT_PROVIDER_IDS)[number];

export function isPaymentProviderId(value: unknown): value is PaymentProviderId {
  return (
    typeof value === "string" &&
    (PAYMENT_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/**
 * Normalized lifecycle state of a charge.
 *
 * Deliberately smaller than any provider's status table. `UNKNOWN` exists so
 * an adapter can say "I could not determine this" instead of guessing
 * `FAILED` — the difference matters because `FAILED` lets a caller stop
 * polling, while `UNKNOWN` must not.
 */
export const PAYMENT_STATUSES = [
  /** Created at the gateway; the payer has not been sent there yet. */
  "CREATED",
  /** Awaiting the payer at the gateway. */
  "PENDING",
  /** Verified as paid. Safe to mark an invoice paid on the strength of this. */
  "SUCCEEDED",
  /** Definitively not paid (payer cancelled, gateway refused). */
  "FAILED",
  /** Previously succeeded and then refunded. */
  "REFUNDED",
  /** Could not be determined. Never treat as terminal. */
  "UNKNOWN",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** What an adapter can actually do. Checked before calling, not after. */
export interface PaymentProviderCapabilities {
  /** `refundPayment` is implemented against a real provider API. */
  refund: boolean;
  /** `getPaymentStatus` is implemented against a real read-only API. */
  statusQuery: boolean;
}

/** Optional payer contact details a gateway may show on its receipt. */
export interface PaymentPayerContact {
  email?: string | null;
  mobile?: string | null;
}

export interface CreatePaymentRequest {
  /** Our order/invoice identifier, echoed into gateway metadata. */
  orderId: string;
  /** Amount to charge, in the application's own currency vocabulary. */
  amount: PaymentAmount;
  /** Human description shown on the gateway page (required by ZarinPal). */
  description: string;
  /** Absolute URL the payer returns to after paying. */
  callbackUrl: string;
  payer?: PaymentPayerContact | null;
  /** Free-form string map. Values must be strings — never nested objects. */
  metadata?: Record<string, string> | null;
}

export interface CreatePaymentResult {
  providerId: PaymentProviderId;
  /** Opaque gateway handle for this charge (ZarinPal `authority`). */
  providerReference: string;
  /** URL to send the payer's browser to. Never fetched server-side. */
  redirectUrl: string;
  /** The amount the gateway accepted, echoed back normalized. */
  amount: PaymentAmount;
  /** True when this charge was created against a sandbox/test endpoint. */
  sandbox: boolean;
}

export interface VerifyPaymentRequest {
  orderId: string;
  /** The `providerReference` returned by `createPayment`. */
  providerReference: string;
  /** The amount we originally asked for, used for the integrity check. */
  amount: PaymentAmount;
}

export interface VerifyPaymentResult {
  providerId: PaymentProviderId;
  providerReference: string;
  status: PaymentStatus;
  /** Gateway settlement/receipt id after success (ZarinPal `ref_id`). */
  referenceId: string | null;
  /** Amount as we requested it, echoed back normalized. */
  amount: PaymentAmount;
  /**
   * True when the gateway reports this charge was already verified by an
   * earlier call. Verification is idempotent, so a retry (a second callback,
   * a stuck worker) is a success rather than an error — but the caller must
   * not double-credit the invoice.
   */
  alreadyVerified: boolean;
  /** True when this verification happened against a sandbox endpoint. */
  sandbox: boolean;
}

export interface GetPaymentStatusRequest {
  orderId: string;
  providerReference: string;
}

export interface PaymentStatusResult {
  providerId: PaymentProviderId;
  providerReference: string;
  status: PaymentStatus;
  referenceId: string | null;
  /** Null when the provider's status API does not report an amount. */
  amount: PaymentAmount | null;
  sandbox: boolean;
}

export interface RefundPaymentRequest {
  orderId: string;
  providerReference: string;
  /** Omitted = refund the full charged amount. */
  amount?: PaymentAmount | null;
}

export interface RefundPaymentResult {
  providerId: PaymentProviderId;
  providerReference: string;
  status: "REFUNDED";
  /** The amount actually refunded (full amount when not specified). */
  refundedAmount: PaymentAmount;
  sandbox: boolean;
}
