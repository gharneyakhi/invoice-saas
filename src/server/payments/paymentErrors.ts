/**
 * Typed errors for the payment gateway layer (`src/server/payments/`).
 *
 * Same discipline as `src/server/errors.ts` and `FileStorageUploadFailedError`:
 * every error carries a stable machine `code`, a human message authored by
 * THIS module, and nothing else. Constructors never accept a raw gateway
 * response, a provider error body, or an underlying cause, so merchant IDs,
 * secrets and provider internals structurally cannot travel inside these
 * errors across a module or API boundary.
 *
 * Callers (route/service layers) map these onto safe client responses; the
 * messages here are the only text ever intended to be shown onwards.
 */

/** Thrown without arguments everywhere so the message stays fixed. */

/**
 * The gateway layer is not configured (unknown `PAYMENT_PROVIDER` value, a
 * missing/invalid `PAYMENT_MERCHANT_ID`, or a missing/invalid
 * `PAYMENT_CALLBACK_URL`). A misconfiguration must refuse to start a payment
 * rather than silently fall back to a different gateway.
 */
export class PaymentProviderNotConfiguredError extends Error {
  readonly code = "PAYMENT_PROVIDER_NOT_CONFIGURED" as const;

  constructor(message = "Online payment is not configured") {
    super(message);
    this.name = "PaymentProviderNotConfiguredError";
  }
}

/**
 * The gateway could not be reached or answered something unusable (network
 * failure, timeout, non-JSON response). Deliberately carries no URL, no
 * status detail and no cause: the message is a fixed, safe string.
 */
export class PaymentProviderUnavailableError extends Error {
  readonly code = "PAYMENT_PROVIDER_UNAVAILABLE" as const;

  constructor(message = "The payment gateway is unavailable. Please try again.") {
    super(message);
    this.name = "PaymentProviderUnavailableError";
  }
}

/**
 * The gateway was reachable but refused the request (validation error,
 * inactive merchant, below-minimum amount, ...). `providerCode` is the
 * gateway's numeric status code, kept for server-side diagnostics only;
 * `message` comes exclusively from this module's safe code map.
 */
export class PaymentProviderError extends Error {
  readonly code = "PAYMENT_PROVIDER_ERROR" as const;
  readonly providerCode: string | null;

  constructor(message = "The payment gateway rejected the request", providerCode: string | null = null) {
    super(message);
    this.name = "PaymentProviderError";
    this.providerCode = providerCode;
  }
}

/**
 * A monetary amount violates the gateway's amount rules (non-finite, non-
 * positive, fractional where the currency has no minor unit, or beyond the
 * storable range). Thrown by `createPaymentAmount()` in `money.ts`.
 */
export class InvalidPaymentAmountError extends Error {
  readonly code = "INVALID_PAYMENT_AMOUNT" as const;

  constructor(message = "Invalid payment amount") {
    super(message);
    this.name = "InvalidPaymentAmountError";
  }
}

/**
 * The plan/currency is not supported by the gateway layer (e.g. a currency
 * outside `SUPPORTED_PAYMENT_CURRENCIES`). Refusing is safer than sending an
 * amount the gateway would interpret in a different currency.
 */
export class UnsupportedCurrencyError extends Error {
  readonly code = "UNSUPPORTED_CURRENCY" as const;

  constructor(message = "The payment currency is not supported") {
    super(message);
    this.name = "UnsupportedCurrencyError";
  }
}
