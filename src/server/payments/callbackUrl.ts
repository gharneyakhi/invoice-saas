import { PaymentProviderNotConfiguredError } from "./paymentErrors";
import type { PaymentProviderEnv } from "./types";

/**
 * Payment callback URL construction — the single place that turns the
 * configured `PAYMENT_CALLBACK_URL` into a per-flow callback URL.
 *
 * Why a `kind` query parameter instead of a second environment variable:
 *   - `.env.example` configures exactly ONE gateway callback base URL
 *     (`PAYMENT_CALLBACK_URL`). Gateways take one callback per payment, and
 *     the gateway does not care how we route internally.
 *   - Subscription payments (`SubscriptionPayment`) and future invoice
 *     gateway payments are different domains that will share the same
 *     physical callback endpoint. The callback handler must be able to tell
 *     them apart without ambiguity, so each flow stamps its callback URL
 *     with `kind=subscription` / (later) `kind=invoice`.
 *   - Adding a second env var would create two sources of truth for the same
 *     origin and invite them to drift; a discriminator on the shared base is
 *     the smallest honest design.
 *
 * The base URL must be absolute (gateways perform real redirects to it) and
 * any query parameters already present in the configured value are preserved
 * — `kind` is merged in, never clobbering unrelated parameters.
 */

export const PAYMENT_CALLBACK_URL_ENV_VAR = "PAYMENT_CALLBACK_URL";

/** `kind` value marking a callback as belonging to a SubscriptionPayment. */
export const SUBSCRIPTION_PAYMENT_CALLBACK_KIND = "subscription";

/**
 * Builds the absolute callback URL for one payment flow.
 *
 * @param kind Discriminator for the flow, e.g.
 *   `SUBSCRIPTION_PAYMENT_CALLBACK_KIND`.
 * @returns The absolute callback URL with `kind` merged into its query.
 * @throws PaymentProviderNotConfiguredError when `PAYMENT_CALLBACK_URL` is
 *   unset, empty, or not an absolute URL.
 */
export function buildPaymentCallbackUrl(kind: string, env: PaymentProviderEnv = process.env): string {
  if (typeof kind !== "string" || kind.trim() === "") {
    throw new PaymentProviderNotConfiguredError("Payment callback kind is required");
  }

  const raw = env[PAYMENT_CALLBACK_URL_ENV_VAR]?.trim();
  if (!raw) {
    throw new PaymentProviderNotConfiguredError("Payment callback URL is not configured");
  }

  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    // `new URL` throws on relative or malformed values; both mean the same
    // thing operationally: the gateway could never call this URL back.
    throw new PaymentProviderNotConfiguredError("Payment callback URL is not configured");
  }

  base.searchParams.set("kind", kind.trim());
  return base.toString();
}
