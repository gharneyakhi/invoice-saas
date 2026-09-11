import { randomUUID } from "node:crypto";
import type { PaymentProvider } from "../PaymentProvider";
import { createPaymentAmount } from "../money";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderEnv,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from "../types";

/**
 * In-process sandbox gateway — a deterministic, network-free stand-in for a
 * real provider, used in development (`PAYMENT_PROVIDER=sandbox`) and tests.
 *
 * Behaviour mirrors the real gateway's contract so the checkout service and
 * the future callback step can be exercised end-to-end without credentials:
 *   - `createPayment` accepts the same input rules (validated through the
 *     shared `createPaymentAmount()` helper, exactly like the real adapter)
 *     and returns an `SBX…` authority plus a redirect URL that points at the
 *     local sandbox start-pay page (`{APP_URL}/payments/sandbox/StartPay/…`).
 *     That local page is part of the callback/verify flow and is NOT part of
 *     this step — the URL is still produced now so redirect handling is
 *     identical for every provider.
 *   - `verifyPayment` verifies any `SBX…` authority and rejects anything
 *     else, deterministically deriving a reference id from the authority.
 *
 * Nothing here is a secret: no credentials exist, and the authority is a
 * locally generated random identifier.
 */

const SANDBOX_AUTHORITY_PREFIX = "SBX";
const SANDBOX_REFERENCE_PREFIX = "SBXRF";

const SANDBOX_START_PAY_PATH = "/payments/sandbox/StartPay";

const APP_URL_ENV_VAR = "APP_URL";
const DEFAULT_APP_URL = "http://localhost:3000";

function appBaseUrl(env: PaymentProviderEnv): string {
  const raw = env[APP_URL_ENV_VAR]?.trim();
  if (!raw) return DEFAULT_APP_URL;
  return raw.replace(/\/+$/, "");
}

function isValidSandboxAuthority(authority: string): boolean {
  return authority.startsWith(SANDBOX_AUTHORITY_PREFIX) && authority.length > SANDBOX_AUTHORITY_PREFIX.length;
}

/**
 * Builds the sandbox adapter. Like the real adapters it takes the environment
 * snapshot explicitly, so tests can pin `APP_URL` without mutating globals.
 */
export function createSandboxProvider(env: PaymentProviderEnv = process.env): PaymentProvider {
  const baseUrl = appBaseUrl(env);

  return {
    name: "sandbox",

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      // Same amount discipline as the real gateways: the sandbox must reject
      // what the real gateway would reject, so tests exercise identical rules.
      createPaymentAmount(input.amount, input.currency);

      const authority = `${SANDBOX_AUTHORITY_PREFIX}${randomUUID().replace(/-/g, "").toUpperCase()}`;

      return {
        authority,
        redirectUrl: `${baseUrl}${SANDBOX_START_PAY_PATH}/${authority}`,
      };
    },

    async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
      // Re-validate the amount (throws on a malformed value, exactly like the
      // real adapter) and only ever verify sandbox authorities.
      createPaymentAmount(input.amount, input.currency);
      if (!isValidSandboxAuthority(input.authority)) {
        return { status: "REJECTED", referenceId: null, code: -54 };
      }

      // Deterministic reference derived from the authority: same authority →
      // same reference, so tests can assert exact values.
      return {
        status: "VERIFIED",
        referenceId: `${SANDBOX_REFERENCE_PREFIX}-${input.authority.slice(
          SANDBOX_AUTHORITY_PREFIX.length,
          SANDBOX_AUTHORITY_PREFIX.length + 12,
        )}`,
        code: 100,
      };
    },
  };
}
