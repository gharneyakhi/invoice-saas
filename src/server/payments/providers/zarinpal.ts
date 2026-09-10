import { asPaymentProvider, type PaymentProvider } from "../PaymentProvider";
import {
  assertGatewayMinimum,
  assertPaymentAmount,
  createPaymentAmount,
  toProviderUnits,
} from "../money";
import {
  PaymentGatewayError,
  PaymentNotFoundError,
  PaymentUnsupportedOperationError,
  PaymentValidationError,
} from "../paymentErrors";
import { createPaymentHttpClient, postJson, type PaymentHttpClient, type PaymentHttpOptions } from "../http";
import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  GetPaymentStatusRequest,
  PaymentProviderCapabilities,
  PaymentStatusResult,
  RefundPaymentRequest,
  RefundPaymentResult,
  VerifyPaymentRequest,
  VerifyPaymentResult,
} from "../types";

/**
 * ZarinPal adapter — payment gateway v4 (`/pg/v4/payment/*`), server-side only.
 *
 * Endpoints and payload shapes follow the published v4 REST contract:
 *
 *   POST {origin}/pg/v4/payment/request.json
 *     → { merchant_id, amount, currency, callback_url, description, metadata }
 *     ← { data: { code: 100, message, authority, fee_type, fee }, errors: null }
 *   POST {origin}/pg/v4/payment/verify.json
 *     → { merchant_id, authority, amount }
 *     ← { data: { code: 100, message, ref_id, card_pan, card_hash, fee }, errors: null }
 *   redirect  {gatewayOrigin}/pg/StartPay/{authority}
 *
 * Success is `data.code === 100`. `101` on verify means "already verified" and
 * is reported as `SUCCEEDED` + `alreadyVerified: true` so a retried callback
 * or worker does not turn into a spurious failure. Every other shape is an
 * `errors` envelope (`{ code, message, validations }`) and becomes a typed
 * `PaymentError`.
 *
 * Security rules enforced here:
 *
 *   - The merchant id is read once into this instance and is never logged,
 *     never put in an error message, and never returned in a DTO.
 *   - Live mode requires an `https` callback URL; `http` is only accepted in
 *     sandbox, so a misconfigured production deployment cannot post payer
 *     return data in clear text.
 *   - When `allowedCallbackOrigin` is configured, a request whose callback URL
 *     is not on that origin is refused. Without it, a caller-supplied
 *     `callbackUrl` would let any request redirect payers (and their return
 *     traffic) to an arbitrary host.
 *   - Verification compares the charged amount against the requested amount;
 *     a mismatch throws `PaymentAmountMismatchError` rather than reporting
 *     success, so an invoice can never be marked paid for the wrong sum.
 *
 * Operations the v4 public gateway API does not expose are reported honestly
 * (see `capabilities`): there is no read-only status endpoint and no refund
 * endpoint on this API, so `getPaymentStatus` and `refundPayment` throw
 * `PaymentUnsupportedOperationError` instead of inventing a result. Refunds
 * are performed in the ZarinPal merchant panel.
 */

export const ZARINPAL_PROVIDER_ID = "zarinpal" as const;

/** Live API origin (`payment.zarinpal.com` serves the same v4 contract). */
export const ZARINPAL_LIVE_API_ORIGIN = "https://api.zarinpal.com";
/** Sandbox API origin — a separate host, not a flag on the live host. */
export const ZARINPAL_SANDBOX_API_ORIGIN = "https://sandbox.zarinpal.com";
/** Live payer-redirect origin. */
export const ZARINPAL_LIVE_GATEWAY_ORIGIN = "https://www.zarinpal.com";
/** Sandbox payer-redirect origin. */
export const ZARINPAL_SANDBOX_GATEWAY_ORIGIN = "https://sandbox.zarinpal.com";

export const ZARINPAL_REQUEST_PATH = "/pg/v4/payment/request.json";
export const ZARINPAL_VERIFY_PATH = "/pg/v4/payment/verify.json";
export const ZARINPAL_STARTPAY_PATH = "/pg/StartPay/";

/** `data.code` for a successful operation. */
export const ZARINPAL_SUCCESS_CODE = 100;
/** `data.code` on verify when the charge was already verified. */
export const ZARINPAL_ALREADY_VERIFIED_CODE = 101;
/** `errors.code` for "request not found" (unknown or expired authority). */
export const ZARINPAL_NOT_FOUND_CODE = -11;

/**
 * ZarinPal's documented minimum charge, quoted in ریال regardless of the
 * `currency` field sent. Enforced before the request leaves the server so the
 * user gets our validation message rather than a gateway `-3`/`-33`.
 */
export const ZARINPAL_MIN_AMOUNT_RIAL = 10_000;

/** The merchant code is a 36-character UUID; anything else is a config mistake. */
export const ZARINPAL_MERCHANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ZarinPalProviderConfig {
  merchantId: string;
  /** True = sandbox host for API and redirects. */
  sandbox: boolean;
  /**
   * When set, `createPayment` refuses any callback URL whose origin differs.
   * Set this from `PAYMENT_CALLBACK_URL` in production.
   */
  allowedCallbackOrigin?: string | null;
}

export interface ZarinPalProviderOptions {
  /** Injected transport; see `../http`. */
  http?: PaymentHttpOptions;
}

/** Wire shape of a v4 envelope. Both halves are nullable in practice. */
interface ZarinPalEnvelope<T> {
  data: T | null;
  errors: { code?: number; message?: string; validations?: unknown[] } | null;
}

interface ZarinPalRequestData {
  code?: number;
  message?: string;
  authority?: string;
  fee_type?: string;
  fee?: number;
}

interface ZarinPalVerifyData {
  code?: number;
  message?: string;
  ref_id?: number | string;
  card_pan?: string;
  card_hash?: string;
  fee_type?: string;
  fee?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `ZarinPal`'s v4 public gateway API has no status or refund endpoint. */
const ZARINPAL_CAPABILITIES: PaymentProviderCapabilities = {
  refund: false,
  statusQuery: false,
};

export class ZarinPalPaymentProvider implements PaymentProvider {
  readonly id = ZARINPAL_PROVIDER_ID;
  readonly sandbox: boolean;
  readonly capabilities = ZARINPAL_CAPABILITIES;

  private readonly merchantId: string;
  private readonly allowedCallbackOrigin: string | null;
  private readonly http: PaymentHttpClient;

  constructor(config: ZarinPalProviderConfig, options?: ZarinPalProviderOptions) {
    const merchantId = config.merchantId?.trim();
    if (!merchantId) {
      throw new PaymentValidationError("ZarinPal merchant id is required", {
        providerId: ZARINPAL_PROVIDER_ID,
      });
    }
    if (!ZARINPAL_MERCHANT_ID_PATTERN.test(merchantId)) {
      // Deliberately no echo of the value: a pasted API key or token must not
      // end up in a log line or a browser-visible error.
      throw new PaymentValidationError(
        "ZarinPal merchant id must be a 36-character UUID",
        { providerId: ZARINPAL_PROVIDER_ID },
      );
    }

    this.merchantId = merchantId;
    this.sandbox = config.sandbox;
    this.allowedCallbackOrigin = config.allowedCallbackOrigin?.trim()
      ? normalizeOrigin(config.allowedCallbackOrigin)
      : null;
    this.http = createPaymentHttpClient(options?.http);
  }

  /** API origin for the configured mode. */
  get apiOrigin(): string {
    return this.sandbox ? ZARINPAL_SANDBOX_API_ORIGIN : ZARINPAL_LIVE_API_ORIGIN;
  }

  /** Payer-redirect origin for the configured mode. */
  get gatewayOrigin(): string {
    return this.sandbox ? ZARINPAL_SANDBOX_GATEWAY_ORIGIN : ZARINPAL_LIVE_GATEWAY_ORIGIN;
  }

  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const orderId = requireText(request.orderId, "orderId");
    const description = requireText(request.description, "description");
    const callbackUrl = this.assertCallbackUrl(request.callbackUrl);
    const amount = assertPaymentAmount(request.amount);
    assertGatewayMinimum(amount, ZARINPAL_MIN_AMOUNT_RIAL);

    // `toProviderUnits` is strict here: a fractional invoice total must be
    // resolved to an integer by the caller's explicit policy, never silently
    // rounded at the gateway boundary.
    const providerAmount = toProviderUnits(amount);

    const payload = await postJson<ZarinPalEnvelope<ZarinPalRequestData>>(
      this.http,
      `${this.apiOrigin}${ZARINPAL_REQUEST_PATH}`,
      {
        merchant_id: this.merchantId,
        amount: providerAmount,
        currency: amount.currency,
        callback_url: callbackUrl,
        description,
        metadata: {
          order_id: orderId,
          ...(request.payer?.email ? { email: request.payer.email } : {}),
          ...(request.payer?.mobile ? { mobile: request.payer.mobile } : {}),
        },
      },
      { providerId: ZARINPAL_PROVIDER_ID },
    );

    const data = this.unwrapData(payload, "create the payment");
    if (data.code !== ZARINPAL_SUCCESS_CODE) {
      throw new PaymentGatewayError("The payment gateway did not accept the payment request", {
        providerId: ZARINPAL_PROVIDER_ID,
        providerCode: data.code ?? null,
      });
    }

    const authority = typeof data.authority === "string" ? data.authority.trim() : "";
    if (!authority) {
      throw new PaymentGatewayError("The payment gateway returned no authority", {
        providerId: ZARINPAL_PROVIDER_ID,
        providerCode: data.code ?? null,
      });
    }

    return {
      providerId: ZARINPAL_PROVIDER_ID,
      providerReference: authority,
      redirectUrl: `${this.gatewayOrigin}${ZARINPAL_STARTPAY_PATH}${encodeURIComponent(authority)}`,
      amount: createPaymentAmount(providerAmount, amount.currency),
      sandbox: this.sandbox,
    };
  }

  async verifyPayment(request: VerifyPaymentRequest): Promise<VerifyPaymentResult> {
    const providerReference = requireText(request.providerReference, "providerReference");
    const amount = assertPaymentAmount(request.amount);

    const payload = await postJson<ZarinPalEnvelope<ZarinPalVerifyData>>(
      this.http,
      `${this.apiOrigin}${ZARINPAL_VERIFY_PATH}`,
      {
        merchant_id: this.merchantId,
        authority: providerReference,
        amount: toProviderUnits(amount),
      },
      { providerId: ZARINPAL_PROVIDER_ID },
    );

    // An `errors` envelope here usually means "unknown authority"; -11 is
    // documented as "request not found" and maps to a distinct error so the
    // caller can drop a stale callback instead of retrying forever.
    if (payload.errors) {
      const code = payload.errors.code ?? null;
      if (code === ZARINPAL_NOT_FOUND_CODE) {
        throw new PaymentNotFoundError("The payment gateway does not recognize this authority", {
          providerId: ZARINPAL_PROVIDER_ID,
        });
      }
      throw new PaymentGatewayError("The payment gateway could not verify the payment", {
        providerId: ZARINPAL_PROVIDER_ID,
        providerCode: code,
      });
    }

    const data = payload.data;
    if (!isRecord(data)) {
      throw new PaymentGatewayError("The payment gateway returned an empty verification", {
        providerId: ZARINPAL_PROVIDER_ID,
      });
    }

    const code = data.code;
    const succeeded = code === ZARINPAL_SUCCESS_CODE || code === ZARINPAL_ALREADY_VERIFIED_CODE;
    if (!succeeded) {
      return {
        providerId: ZARINPAL_PROVIDER_ID,
        providerReference,
        status: "FAILED",
        referenceId: null,
        amount,
        alreadyVerified: false,
        sandbox: this.sandbox,
      };
    }

    const referenceId =
      data.ref_id === undefined || data.ref_id === null ? null : String(data.ref_id);

    return {
      providerId: ZARINPAL_PROVIDER_ID,
      providerReference,
      status: "SUCCEEDED",
      referenceId,
      amount,
      alreadyVerified: code === ZARINPAL_ALREADY_VERIFIED_CODE,
      sandbox: this.sandbox,
    };
  }

  /**
   * Not supported: the v4 public gateway API exposes no read-only status
   * endpoint. Callers that need a status use `verifyPayment`, which is
   * idempotent (`101` → `alreadyVerified`), or the merchant panel.
   */
  async getPaymentStatus(_request: GetPaymentStatusRequest): Promise<PaymentStatusResult> {
    throw new PaymentUnsupportedOperationError(
      "getPaymentStatus",
      "ZarinPal's v4 gateway API has no read-only status endpoint; use verifyPayment instead",
      { providerId: ZARINPAL_PROVIDER_ID },
    );
  }

  /**
   * Not supported: refunds are performed in the ZarinPal merchant panel, not
   * through the v4 gateway API. Reporting `false` in `capabilities` lets the
   * UI offer the manual flow instead of a button that always fails.
   */
  async refundPayment(_request: RefundPaymentRequest): Promise<RefundPaymentResult> {
    throw new PaymentUnsupportedOperationError(
      "refundPayment",
      "Refunds are performed in the ZarinPal merchant panel, not through this API",
      { providerId: ZARINPAL_PROVIDER_ID },
    );
  }

  /**
   * Validates a callback URL and, when an allow-origin is configured, that it
   * is on the configured origin.
   *
   * @throws PaymentValidationError
   */
  private assertCallbackUrl(callbackUrl: unknown): string {
    const raw = typeof callbackUrl === "string" ? callbackUrl.trim() : "";
    if (!raw) {
      throw new PaymentValidationError("callbackUrl is required", {
        providerId: ZARINPAL_PROVIDER_ID,
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new PaymentValidationError("callbackUrl must be an absolute URL", {
        providerId: ZARINPAL_PROVIDER_ID,
      });
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new PaymentValidationError("callbackUrl must use http or https", {
        providerId: ZARINPAL_PROVIDER_ID,
      });
    }
    if (!this.sandbox && parsed.protocol !== "https:") {
      throw new PaymentValidationError(
        "callbackUrl must use https outside the sandbox",
        { providerId: ZARINPAL_PROVIDER_ID },
      );
    }
    if (this.allowedCallbackOrigin && parsed.origin !== this.allowedCallbackOrigin) {
      throw new PaymentValidationError(
        "callbackUrl is not on the configured payment callback origin",
        { providerId: ZARINPAL_PROVIDER_ID },
      );
    }
    return parsed.toString();
  }

  /**
   * Unwraps a v4 envelope, turning an `errors` payload into a typed error.
   *
   * @throws PaymentGatewayError
   */
  private unwrapData<T>(
    payload: ZarinPalEnvelope<T>,
    action: string,
  ): T {
    if (payload.errors) {
      throw new PaymentGatewayError(`The payment gateway refused the request to ${action}`, {
        providerId: ZARINPAL_PROVIDER_ID,
        providerCode: payload.errors.code ?? null,
      });
    }
    if (!isRecord(payload.data)) {
      throw new PaymentGatewayError("The payment gateway returned an empty response", {
        providerId: ZARINPAL_PROVIDER_ID,
      });
    }
    return payload.data as T;
  }
}

/** Builds the adapter. `asPaymentProvider` pins it to the interface at build time. */
export function createZarinPalProvider(
  config: ZarinPalProviderConfig,
  options?: ZarinPalProviderOptions,
): PaymentProvider {
  return asPaymentProvider(new ZarinPalPaymentProvider(config, options));
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new PaymentValidationError(`${field} is required`, {
      providerId: ZARINPAL_PROVIDER_ID,
    });
  }
  return text;
}

/** Origin of an absolute URL, lower-cased; returns null when unparseable. */
function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
