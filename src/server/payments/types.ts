/**
 * Provider-agnostic payment gateway contracts (the DTOs that cross the
 * `PaymentProvider` boundary).
 *
 * These types are deliberately gateway-neutral: neither ZarinPal field names
 * (`authority`, `ref_id`, `merchant_id`, ...) nor sandbox internals leak
 * through this module. Adapters translate between these shapes and their
 * gateway's wire format, and the subscription checkout service only ever sees
 * what is declared here.
 *
 * Security posture (mirrors `src/server/errors.ts`):
 *   - No raw gateway response is ever part of these DTOs. Adapters parse the
 *     gateway envelope and return only the fields declared below, so secrets
 *     and provider internals structurally cannot reach callers.
 *   - `authority` is the gateway's opaque payment reference. It is required
 *     to build the redirect URL and later to verify the payment; it is not a
 *     merchant credential and never contains one.
 */

/** The payment gateway adapters this build ships. Used by the factory only. */
export const PAYMENT_PROVIDER_NAMES = ["zarinpal", "sandbox"] as const;

export type PaymentProviderName = (typeof PAYMENT_PROVIDER_NAMES)[number];

/**
 * The environment shape the gateway layer reads configuration from.
 *
 * Declared locally instead of using `NodeJS.ProcessEnv` because Next.js
 * augments that type with a REQUIRED `NODE_ENV`, which would make it
 * impossible to pass a partial environment (as tests do) or to compose
 * configuration from a source other than `process.env`. Adapters/factories
 * default to `process.env`; everything they read must be a string.
 */
export type PaymentProviderEnv = Record<string, string | undefined>;

/**
 * Input for starting (creating) a gateway payment.
 *
 * `amount` is in the currency's smallest practical unit and must come from
 * `createPaymentAmount()` (`src/server/payments/money.ts`) — adapters re-check
 * it defensively, but the helper is the single validator. `callbackUrl` is the
 * absolute gateway callback URL, built by the caller (service layer) from
 * `PAYMENT_CALLBACK_URL` via `buildPaymentCallbackUrl()` — never from request
 * input.
 */
export interface CreatePaymentInput {
  /** Gateway-unit amount (e.g. integer IRR). Positive and pre-validated. */
  amount: number;
  /** ISO-style currency code, e.g. "IRR". Must be supported by `money.ts`. */
  currency: string;
  /** Human-readable purchase description shown on the gateway page. */
  description?: string;
  /** Absolute URL the gateway redirects back to after payment. Server-built. */
  callbackUrl: string;
  /** Small, non-sensitive key/value hints (e.g. `order_id`). Never secrets. */
  metadata?: Record<string, string>;
}

/** Result of a successful `createPayment()` — enough to redirect the payer. */
export interface CreatePaymentResult {
  /** Opaque gateway payment reference (ZarinPal calls this `authority`). */
  authority: string;
  /** Absolute URL the client must be redirected to in order to pay. */
  redirectUrl: string;
}

/** Input for verifying a previously created payment (callback/verify step). */
export interface VerifyPaymentInput {
  /** The gateway-unit amount that was originally requested. */
  amount: number;
  /** The currency of the original request (validated, not sent to verify). */
  currency: string;
  /** The authority returned by `createPayment()` for this payment. */
  authority: string;
}

/** Whether a payment was confirmed by the gateway. */
export type VerifyPaymentStatus = "VERIFIED" | "REJECTED";

/**
 * Result of `verifyPayment()`. `referenceId` is the gateway's transaction
 * reference on success (stored in `SubscriptionPayment.referenceId` later);
 * `code` is the provider's status code kept for server-side diagnostics only.
 */
export interface VerifyPaymentResult {
  status: VerifyPaymentStatus;
  referenceId: string | null;
  code: number | null;
}
