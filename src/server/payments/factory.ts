import type { PaymentProvider } from "./PaymentProvider";
import { PAYMENT_PROVIDER_NAMES, type PaymentProviderEnv, type PaymentProviderName } from "./types";
import { PaymentProviderNotConfiguredError } from "./paymentErrors";
import { createZarinpalProvider } from "./providers/zarinpal";
import { createSandboxProvider } from "./providers/sandbox";

/**
 * The single place a `PaymentProvider` is resolved from server configuration.
 *
 * Contract with the rest of the system:
 *   - The provider is chosen from `PAYMENT_PROVIDER` (`"zarinpal" |
 *     "sandbox"`), never from request input. Callers pass NO argument; the
 *     optional `name` parameter exists for tests and internal tooling only.
 *     This is what makes "a client cannot select the provider" structural:
 *     no API surface reaches this parameter.
 *   - An unset/empty value is a hard error (`PaymentProviderNotConfiguredError`)
 *     rather than a silent default: moving money deserves explicit config.
 *   - Adapters are built per call from a fresh environment snapshot, so a
 *     config change or a test's `vi.stubEnv` takes effect immediately and no
 *     stale adapter is cached across requests.
 *
 * Related configuration (read by the adapters/helpers, not here):
 *   - `PAYMENT_MERCHANT_ID` — ZarinPal merchant UUID (zarinpal only).
 *   - `PAYMENT_SANDBOX`     — `"true"` routes ZarinPal to its sandbox host.
 *   - `PAYMENT_CALLBACK_URL`— gateway callback base; per-flow URLs are built
 *     from it via `buildPaymentCallbackUrl()`.
 */

export const PAYMENT_PROVIDER_ENV_VAR = "PAYMENT_PROVIDER";

/**
 * Reads and validates the configured provider name.
 *
 * @throws PaymentProviderNotConfiguredError when `PAYMENT_PROVIDER` is unset,
 *   empty, or not one of `PAYMENT_PROVIDER_NAMES`.
 */
export function configuredPaymentProviderName(env: PaymentProviderEnv = process.env): PaymentProviderName {
  const raw = env[PAYMENT_PROVIDER_ENV_VAR]?.trim();
  if (!raw || !(PAYMENT_PROVIDER_NAMES as readonly string[]).includes(raw)) {
    throw new PaymentProviderNotConfiguredError("Payment provider is not configured");
  }
  return raw as PaymentProviderName;
}

/**
 * Resolves a payment provider.
 *
 * @param name Internal/test override. Production callers omit it so the
 *   provider always comes from configuration.
 * @throws PaymentProviderNotConfiguredError when the name/config is invalid.
 */
export function getPaymentProvider(
  name?: PaymentProviderName,
  env: PaymentProviderEnv = process.env,
): PaymentProvider {
  const resolved = name ?? configuredPaymentProviderName(env);
  if (resolved === "zarinpal") {
    return createZarinpalProvider(env);
  }
  return createSandboxProvider(env);
}
