import type { PaymentProvider } from "../PaymentProvider";
import {
  InvalidPaymentAmountError,
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  PaymentProviderUnavailableError,
} from "../paymentErrors";
import { createPaymentAmount } from "../money";
import { postJson } from "../http";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderEnv,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from "../types";

/**
 * ZarinPal v4 REST adapter (`payment.zarinpal.com`, sandbox:
 * `sandbox.zarinpal.com`).
 *
 * Wire format (v4, per the official docs at zarinpal.com/docs):
 *   - create: POST {base}/pg/v4/payment/request.json
 *       { merchant_id, amount, currency, description?, callback_url, metadata? }
 *     → { data: { code, message?, authority?, fee? }, errors: [] }
 *     `data` is an OBJECT in the documented v4 shape (older examples show an
 *     array form — both are tolerated, see `firstDataRecord`).
 *     `code: 100` means the checkout was created; the payer is then sent to
 *     {base}/pg/StartPay/{authority}.
 *   - verify: POST {base}/pg/v4/payment/verify.json
 *       { merchant_id, amount, authority }
 *     → { data: { code, ref_id?, card_pan?, fee? }, errors: [] }
 *     `code: 100` = verified now, `code: 101` = already verified (both are
 *     success), anything else is not.
 *
 * Security rules implemented here:
 *   - `PAYMENT_MERCHANT_ID` is read from server env ONLY, validated as a UUID
 *     (v4 requirement) and sent only inside request bodies — it never appears
 *     in any return value, log or error.
 *   - Gateway responses are reduced to the neutral DTOs in `../types.ts`. The
 *     `errors` envelope and any `message` text from the gateway are discarded:
 *     error messages come exclusively from the local safe code map below.
 *   - The sandbox host is selected via the existing `PAYMENT_SANDBOX=true`
 *     flag — there is deliberately no second provider entry for "zarinpal
 *     sandbox".
 */

const ZARINPAL_PRODUCTION_BASE_URL = "https://payment.zarinpal.com";
const ZARINPAL_SANDBOX_BASE_URL = "https://sandbox.zarinpal.com";

const PAYMENT_REQUEST_PATH = "/pg/v4/payment/request.json";
const PAYMENT_VERIFY_PATH = "/pg/v4/payment/verify.json";
const START_PAY_PATH = "/pg/StartPay";

const PAYMENT_MERCHANT_ID_ENV_VAR = "PAYMENT_MERCHANT_ID";
const PAYMENT_SANDBOX_ENV_VAR = "PAYMENT_SANDBOX";

/** Codes this adapter maps to a fixed, safe, human-readable message. */
const SAFE_ERROR_MESSAGES: Record<string, string> = {
  "-9": "The payment request was invalid. Please try again.",
  "-10": "Online payment is not available for this merchant. Please contact support.",
  "-11": "Online payment is not available for this merchant. Please contact support.",
  "-12": "Online payment is not available for this merchant. Please contact support.",
  "-15": "Online payment is temporarily unavailable. Please try again later.",
  "-50": "The payment amount is outside the accepted range for the gateway.",
  "-51": "The payment was not completed successfully.",
  "-53": "The payment was not completed successfully.",
  "-54": "The payment reference is invalid or expired.",
  "101": "The payment was already verified.",
};

/**
 * One v4 `data` record. The documented v4 shape is an OBJECT
 * (`{ data: { code, authority, ... }, errors: [] }`); older SDK examples show
 * an array form — both are accepted defensively.
 */
interface ZarinpalDataRecord {
  code?: number;
  authority?: string;
  message?: string;
  ref_id?: number;
}

interface ZarinpalEnvelope {
  data?: ZarinpalDataRecord | ZarinpalDataRecord[] | null;
  errors?: unknown;
}

interface ZarinpalRequestPayload {
  merchant_id: string;
  amount: number;
  currency: string;
  callback_url: string;
  description?: string;
  metadata?: Record<string, string>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function baseUrlFor(env: PaymentProviderEnv): string {
  return env[PAYMENT_SANDBOX_ENV_VAR] === "true" ? ZARINPAL_SANDBOX_BASE_URL : ZARINPAL_PRODUCTION_BASE_URL;
}

/**
 * The v4 envelope's `data` record, tolerantly: the documented shape is an
 * object; an array form (legacy examples) yields its first element; anything
 * else (absent, null, scalar) yields null and the caller treats the response
 * as a failure. Never throws on a hostile/unexpected body shape.
 */
function firstDataRecord(envelope: ZarinpalEnvelope | null): ZarinpalDataRecord | null {
  const data = envelope?.data;
  if (Array.isArray(data)) {
    const first = data[0];
    return typeof first === "object" && first !== null ? first : null;
  }
  if (typeof data === "object" && data !== null) {
    return data;
  }
  return null;
}

/**
 * Extracts the first numeric failure code from either the data record or the
 * errors envelope (object or array form), for diagnostics only.
 */
function extractProviderCode(envelope: ZarinpalEnvelope | null): string | null {
  const record = firstDataRecord(envelope);
  if (typeof record?.code === "number") return String(record.code);

  const errors: unknown = envelope?.errors;
  if (Array.isArray(errors)) {
    const first = errors[0];
    if (typeof first === "object" && first !== null) {
      const code = (first as { code?: unknown }).code;
      if (typeof code === "number") return String(code);
      if (typeof code === "string") return code;
    }
    return null;
  }
  if (typeof errors === "object" && errors !== null) {
    const code = (errors as { code?: unknown }).code;
    if (typeof code === "number") return String(code);
    if (typeof code === "string") return code;
  }
  return null;
}

function safeMessageFor(providerCode: string | null): string {
  if (providerCode !== null && SAFE_ERROR_MESSAGES[providerCode] !== undefined) {
    return SAFE_ERROR_MESSAGES[providerCode];
  }
  return "The payment gateway rejected the request.";
}

function assertGatewayAmount(input: { amount: number; currency: string }): number {
  // The caller validates through `createPaymentAmount()` already; adapters
  // re-validate so a misused provider object can never send a malformed
  // amount to the gateway.
  if (typeof input.amount !== "number" || !Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new InvalidPaymentAmountError();
  }
  return createPaymentAmount(input.amount, input.currency);
}

/**
 * Builds the ZarinPal v4 adapter from server configuration.
 *
 * @throws PaymentProviderNotConfiguredError when `PAYMENT_MERCHANT_ID` is
 *   missing or not a UUID (checked again per request, so an adapter built
 *   from one env snapshot never sends a request with another env's merchant).
 */
export function createZarinpalProvider(env: PaymentProviderEnv = process.env): PaymentProvider {
  const baseUrl = baseUrlFor(env);

  function merchantIdFrom(environment: PaymentProviderEnv = env): string {
    const merchantId = environment[PAYMENT_MERCHANT_ID_ENV_VAR]?.trim() ?? "";
    if (!isUuid(merchantId)) {
      throw new PaymentProviderNotConfiguredError("Payment merchant is not configured");
    }
    return merchantId;
  }

  return {
    name: "zarinpal",

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      const merchantId = merchantIdFrom();
      const amount = assertGatewayAmount(input);

      const payload: ZarinpalRequestPayload = {
        merchant_id: merchantId,
        amount,
        currency: input.currency.trim().toUpperCase(),
        callback_url: input.callbackUrl,
        ...(input.description ? { description: input.description } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };

      const response = await postJson<ZarinpalEnvelope>(`${baseUrl}${PAYMENT_REQUEST_PATH}`, payload);

      const record = firstDataRecord(response.body ?? null);
      if (!record || record.code !== 100 || typeof record.authority !== "string" || record.authority === "") {
        const providerCode = extractProviderCode(response.body ?? null);
        throw new PaymentProviderError(safeMessageFor(providerCode), providerCode);
      }

      return {
        authority: record.authority,
        redirectUrl: `${baseUrl}${START_PAY_PATH}/${encodeURIComponent(record.authority)}`,
      };
    },

    async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
      const merchantId = merchantIdFrom();
      const amount = assertGatewayAmount(input);

      // v4 verify takes only merchant_id + amount + authority (no currency).
      const response = await postJson<ZarinpalEnvelope>(`${baseUrl}${PAYMENT_VERIFY_PATH}`, {
        merchant_id: merchantId,
        amount,
        authority: input.authority,
      });

      const record = firstDataRecord(response.body ?? null);
      if (!record || typeof record.code !== "number") {
        throw new PaymentProviderUnavailableError();
      }

      if (record.code === 100 || record.code === 101) {
        return {
          status: "VERIFIED",
          referenceId: typeof record.ref_id === "number" ? String(record.ref_id) : null,
          code: record.code,
        };
      }

      return { status: "REJECTED", referenceId: null, code: record.code };
    },
  };
}
