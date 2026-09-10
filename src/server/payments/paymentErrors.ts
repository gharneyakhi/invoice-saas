/**
 * Payment-provider error types — leaf module (no imports).
 *
 * Separated from the adapters and the factory so callers (Server Actions,
 * route handlers) can recognize payment failures with `instanceof` / a stable
 * `.code` without pulling HTTP clients, gateway SDKs or provider
 * configuration into the shared boundary module. Mirrors the
 * `src/server/export/gmailErrors.ts` convention.
 *
 * Two rules every error here obeys:
 *
 *   1. Every failure is a `PaymentError` subclass with a stable machine
 *      `code`, so the Server Action error mapper can translate gateway
 *      problems into the `{ code, message }` contract of `actionResult.ts`
 *      instead of string-matching Persian gateway text.
 *   2. No error ever carries credentials or raw provider bodies. A merchant
 *      id, an HTTP request body or a gateway stack is never interpolated into
 *      `message` — only a provider code and a safe sentence are. Raw detail
 *      stays server-side, logged by the adapter.
 */

export const PaymentErrorCode = {
  /** `PAYMENT_*` env contract is missing/incomplete, or a live-mode rule is broken. */
  NOT_CONFIGURED: "PAYMENT_NOT_CONFIGURED",
  /** `PAYMENT_PROVIDER` names a provider this build does not ship. */
  UNKNOWN_PROVIDER: "PAYMENT_UNKNOWN_PROVIDER",
  /** Our own request was invalid before it ever reached the gateway. */
  VALIDATION: "PAYMENT_VALIDATION_ERROR",
  /** Transport failure: DNS, TLS, timeout, connection reset. */
  NETWORK: "PAYMENT_NETWORK_ERROR",
  /** The gateway answered, but refused (business error, non-2xx, bad body). */
  GATEWAY: "PAYMENT_GATEWAY_ERROR",
  /** The gateway does not know this authority/reference. */
  NOT_FOUND: "PAYMENT_NOT_FOUND",
  /** The provider has no API for this operation (see `capabilities`). */
  UNSUPPORTED_OPERATION: "PAYMENT_UNSUPPORTED_OPERATION",
  /** The verified amount differs from the amount we asked the gateway to charge. */
  AMOUNT_MISMATCH: "PAYMENT_AMOUNT_MISMATCH",
} as const;

export type PaymentErrorCode = (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];

/**
 * Base class for every payment-provider failure.
 *
 * `providerId` is typed as `string` rather than `PaymentProviderId` on
 * purpose: importing that union would make this module depend on `types.ts`
 * and break the "leaf module" guarantee above. At runtime the value is
 * always a `PaymentProviderId`, or `null` for configuration-time failures
 * that happen before a provider is chosen.
 */
export abstract class PaymentError extends Error {
  abstract readonly code: PaymentErrorCode;

  /** Provider that raised the failure, or `null` for configuration errors. */
  readonly providerId: string | null;

  constructor(message: string, options?: { providerId?: string | null; cause?: unknown }) {
    super(message);
    this.providerId = options?.providerId ?? null;
    // The original failure is attached for server-side logs only. It is never
    // serialized across the Server Action boundary (see `actionResult.ts`).
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

/** Type guard for the whole family, including reconstructed test doubles. */
export function isPaymentError(error: unknown): error is PaymentError {
  return error instanceof PaymentError;
}

/** `PAYMENT_*` configuration is missing, incomplete, or violates a live-mode rule. */
export class PaymentNotConfiguredError extends PaymentError {
  readonly code = PaymentErrorCode.NOT_CONFIGURED;

  constructor(message = "Online payments are not configured", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PaymentNotConfiguredError";
  }
}

/** `PAYMENT_PROVIDER` is not one of the providers this build ships. */
export class PaymentProviderUnknownError extends PaymentError {
  readonly code = PaymentErrorCode.UNKNOWN_PROVIDER;

  constructor(message = "Unknown payment provider", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PaymentProviderUnknownError";
  }
}

/**
 * A payment request was invalid *before* reaching the gateway: non-positive
 * or malformed amount, unsupported currency, missing description, a callback
 * URL that is not absolute/HTTPS, or an amount below the gateway minimum.
 *
 * Distinct from `PaymentGatewayError` so a bug on our side is never reported
 * to the user as "the bank said no".
 */
export class PaymentValidationError extends PaymentError {
  readonly code = PaymentErrorCode.VALIDATION;

  constructor(message = "Invalid payment request", options?: { providerId?: string | null; cause?: unknown }) {
    super(message, options);
    this.name = "PaymentValidationError";
  }
}

/** Transport-level failure. Retriable by the caller; never a business answer. */
export class PaymentNetworkError extends PaymentError {
  readonly code = PaymentErrorCode.NETWORK;

  constructor(message = "Could not reach the payment gateway", options?: { providerId?: string | null; cause?: unknown }) {
    super(message, options);
    this.name = "PaymentNetworkError";
  }
}

/**
 * The gateway responded but refused the operation.
 *
 * `providerCode` is the provider's own numeric/string status (e.g. ZarinPal
 * `-9`), kept for server-side logs and support tickets. `httpStatus` is the
 * transport status when the refusal came as a non-2xx response. Neither is
 * ever rendered to the user as-is.
 */
export class PaymentGatewayError extends PaymentError {
  readonly code = PaymentErrorCode.GATEWAY;

  readonly providerCode: string | null;
  readonly httpStatus: number | null;

  constructor(
    message = "The payment gateway rejected the request",
    options?: {
      providerId?: string | null;
      providerCode?: string | number | null;
      httpStatus?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "PaymentGatewayError";
    this.providerCode =
      options?.providerCode === undefined || options.providerCode === null
        ? null
        : String(options.providerCode);
    this.httpStatus = options?.httpStatus ?? null;
  }
}

/** The gateway has no record of this authority/reference (expired or foreign). */
export class PaymentNotFoundError extends PaymentError {
  readonly code = PaymentErrorCode.NOT_FOUND;

  constructor(message = "Payment was not found at the gateway", options?: { providerId?: string | null; cause?: unknown }) {
    super(message, options);
    this.name = "PaymentNotFoundError";
  }
}

/**
 * The provider's public API has no endpoint for this operation.
 *
 * Thrown instead of faking a result: an adapter must never report a refund or
 * a status it cannot actually observe. Callers check `capabilities` first and
 * degrade to the manual flow (merchant panel) when `false`.
 */
export class PaymentUnsupportedOperationError extends PaymentError {
  readonly code = PaymentErrorCode.UNSUPPORTED_OPERATION;

  readonly operation: string;

  constructor(operation: string, message?: string, options?: { providerId?: string | null }) {
    super(
      message ?? `${operation} is not supported by this payment provider`,
      options,
    );
    this.name = "PaymentUnsupportedOperationError";
    this.operation = operation;
  }
}

/**
 * Verification returned a different amount than the one we requested.
 *
 * This is an integrity failure, not a user error: the invoice must NOT be
 * marked paid on the strength of it, and the discrepancy is logged
 * server-side for review.
 */
export class PaymentAmountMismatchError extends PaymentError {
  readonly code = PaymentErrorCode.AMOUNT_MISMATCH;

  readonly expectedAmount: string;
  readonly actualAmount: string;

  constructor(args: {
    expectedAmount: string;
    actualAmount: string;
    providerId?: string | null;
  }) {
    super(
      `Verified payment amount ${args.actualAmount} does not match the requested amount ${args.expectedAmount}`,
      { providerId: args.providerId },
    );
    this.name = "PaymentAmountMismatchError";
    this.expectedAmount = args.expectedAmount;
    this.actualAmount = args.actualAmount;
  }
}
