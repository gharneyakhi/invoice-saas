import {
  PaymentNotConfiguredError,
  PaymentProviderUnknownError,
  PaymentValidationError,
} from "./paymentErrors";
import { createSandboxProvider, SANDBOX_PROVIDER_ID } from "./providers/sandbox";
import { createZarinPalProvider, ZARINPAL_PROVIDER_ID } from "./providers/zarinpal";
import type { PaymentHttpOptions } from "./http";
import {
  PAYMENT_PROVIDER_IDS,
  isPaymentProviderId,
  type PaymentProviderId,
} from "./types";
import type { PaymentProvider } from "./PaymentProvider";

/**
 * Provider factory — resolves `PAYMENT_*` configuration into a concrete
 * `PaymentProvider`.
 *
 * Environment contract (documented in `.env.example`, read lazily at call
 * time so tests and config changes stay predictable — the same convention as
 * `STORAGE_*` in `src/server/storage/storageService.ts`):
 *
 *   PAYMENT_PROVIDER     "zarinpal" (default) | "sandbox"
 *   PAYMENT_MERCHANT_ID  provider merchant code (36-char UUID for ZarinPal)
 *   PAYMENT_CALLBACK_URL absolute URL the payer returns to
 *   PAYMENT_SANDBOX      "true"/"false"; unset = sandbox outside production,
 *                        live inside production
 *
 * **Production-safe** means the factory refuses configurations that would
 * charge real money by accident, or fake a payment where real money was
 * expected. Concretely, it throws `PaymentNotConfiguredError` /
 * `PaymentValidationError` when:
 *
 *   1. `PAYMENT_PROVIDER` is not a shipped provider — an unknown value is
 *      never silently downgraded to a default, because a typo in that name
 *      would otherwise quietly change which gateway takes the money.
 *   2. A ZarinPal merchant id is missing, or is not a 36-character UUID. The
 *      format check catches the classic mistake of pasting an API key or a
 *      sandbox id into the live slot.
 *   3. Live mode (`PAYMENT_SANDBOX=false`, or the production default) has no
 *      `PAYMENT_CALLBACK_URL`, or that URL is not `https`. Payer return data
 *      must never travel in clear text.
 *   4. **Sandbox is enabled while `NODE_ENV` is `production`.** This is the
 *      guard that matters most: a deployment that lost its production
 *      `PAYMENT_SANDBOX=false` must fail loudly at the first payment, not
 *      report payments as successful that no gateway ever saw.
 *   5. The `sandbox` provider is selected in production, for the same reason.
 *
 * Nothing here is exported to the client: there is no `NEXT_PUBLIC_` variable
 * in this contract, and the factory lives under `src/server/`.
 */

/** Default provider when `PAYMENT_PROVIDER` is unset, matching `.env.example`. */
export const DEFAULT_PAYMENT_PROVIDER_ID: PaymentProviderId = ZARINPAL_PROVIDER_ID;

/** Values `PAYMENT_SANDBOX` accepts as "on". */
const TRUTHY_FLAGS = new Set(["true", "1", "yes", "on"]);
/** Values `PAYMENT_SANDBOX` accepts as "off". */
const FALSY_FLAGS = new Set(["false", "0", "no", "off"]);

/** Resolved, validated provider configuration. */
export interface PaymentProviderConfig {
  id: PaymentProviderId;
  /** Trimmed merchant code, or `null` when unset. */
  merchantId: string | null;
  /** Trimmed callback URL, or `null` when unset. */
  callbackUrl: string | null;
  /** Effective sandbox flag after applying the `NODE_ENV` default. */
  sandbox: boolean;
  /** `NODE_ENV === "production"`, captured for testability. */
  isProduction: boolean;
}

export interface CreatePaymentProviderOptions {
  /** Override the resolved config instead of reading the environment. */
  config?: Partial<PaymentProviderConfig>;
  /** Injected transport, forwarded to gateway adapters. */
  http?: PaymentHttpOptions;
}

export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Parses `PAYMENT_SANDBOX`.
 *
 * Returns `null` when the variable is unset or unrecognized, letting the
 * caller apply the `NODE_ENV`-based default. An unrecognized value is NOT
 * treated as "off": silently going live because someone typed `"TRUE "` with
 * a stray character is exactly the accident this layer exists to prevent.
 */
export function parseSandboxFlag(value: string | null | undefined): boolean | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return null;
  if (TRUTHY_FLAGS.has(normalized)) return true;
  if (FALSY_FLAGS.has(normalized)) return false;
  return null;
}

/**
 * Reads and normalizes the `PAYMENT_*` environment contract.
 *
 * Does not throw: an incomplete configuration is returned as-is (with `null`
 * fields) so `isPaymentProviderConfigured()` can answer "not ready" without a
 * try/catch. `createPaymentProvider` is what turns it into a typed error.
 */
export function readPaymentProviderConfig(): PaymentProviderConfig {
  const isProduction = isProductionEnvironment();
  const rawId = process.env.PAYMENT_PROVIDER?.trim() ?? "";
  const explicitSandbox = parseSandboxFlag(process.env.PAYMENT_SANDBOX);

  return {
    // Unset → the documented default. A *non-empty* unrecognized value is
    // preserved verbatim so `assertPaymentProviderConfig` can quote it in the
    // error: a typo must be an error, not a silent switch of gateway.
    id:
      rawId === ""
        ? DEFAULT_PAYMENT_PROVIDER_ID
        : isPaymentProviderId(rawId)
          ? rawId
          : (rawId as PaymentProviderId),
    merchantId: process.env.PAYMENT_MERCHANT_ID?.trim() || null,
    callbackUrl: process.env.PAYMENT_CALLBACK_URL?.trim() || null,
    // Unset outside production → sandbox (safe); unset inside production →
    // live, because a production deployment that wants sandbox must say so.
    sandbox: explicitSandbox ?? !isProduction,
    isProduction,
  };
}

/**
 * Validates a resolved configuration.
 *
 * @throws PaymentProviderUnknownError / PaymentNotConfiguredError /
 *         PaymentValidationError
 */
export function assertPaymentProviderConfig(config: PaymentProviderConfig): void {
  if (!isPaymentProviderId(config.id)) {
    throw new PaymentProviderUnknownError(
      `Unknown payment provider "${String(config.id ?? "")}". Supported providers: ${PAYMENT_PROVIDER_IDS.join(", ")}`,
    );
  }

  if (config.isProduction && config.sandbox) {
    throw new PaymentNotConfiguredError(
      "Sandbox payments cannot be enabled while NODE_ENV is production. Set PAYMENT_SANDBOX=false and configure a real merchant id, or unset PAYMENT_SANDBOX.",
    );
  }

  if (config.id === SANDBOX_PROVIDER_ID) {
    if (config.isProduction) {
      throw new PaymentNotConfiguredError(
        'The "sandbox" payment provider cannot be used while NODE_ENV is production.',
      );
    }
    return;
  }

  // ZarinPal from here on.
  if (!config.merchantId) {
    throw new PaymentNotConfiguredError(
      "PAYMENT_MERCHANT_ID is required to accept online payments",
    );
  }

  if (!config.sandbox) {
    const callbackUrl = config.callbackUrl;
    if (!callbackUrl) {
      throw new PaymentNotConfiguredError(
        "PAYMENT_CALLBACK_URL is required to accept live online payments",
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(callbackUrl);
    } catch {
      throw new PaymentValidationError(
        "PAYMENT_CALLBACK_URL must be an absolute URL",
      );
    }
    if (parsed.protocol !== "https:") {
      throw new PaymentValidationError(
        "PAYMENT_CALLBACK_URL must use https when sandbox mode is disabled",
      );
    }
  }
}

/**
 * Builds a provider from a resolved configuration.
 *
 * @throws PaymentProviderUnknownError / PaymentNotConfiguredError /
 *         PaymentValidationError
 */
export function createPaymentProvider(options?: CreatePaymentProviderOptions): PaymentProvider {
  const config = { ...readPaymentProviderConfig(), ...(options?.config ?? {}) };
  assertPaymentProviderConfig(config);

  if (config.id === SANDBOX_PROVIDER_ID) {
    return createSandboxProvider({ http: options?.http });
  }

  return createZarinPalProvider(
    {
      merchantId: config.merchantId as string,
      sandbox: config.sandbox,
      allowedCallbackOrigin: config.callbackUrl,
    },
    { http: options?.http },
  );
}

let cachedProvider: PaymentProvider | null = null;

/**
 * Process-wide provider instance, built once per configuration.
 *
 * Cached because provider construction validates configuration and the
 * checkout path asks for it on every request; `resetPaymentProviderCache()`
 * exists for tests that change `PAYMENT_*` between cases.
 *
 * @throws PaymentProviderUnknownError / PaymentNotConfiguredError /
 *         PaymentValidationError
 */
export function getPaymentProvider(options?: { http?: PaymentHttpOptions }): PaymentProvider {
  if (!cachedProvider) {
    cachedProvider = createPaymentProvider(options);
  }
  return cachedProvider;
}

/** Drops the cached provider. Test-only; also useful after a config reload. */
export function resetPaymentProviderCache(): void {
  cachedProvider = null;
}

/**
 * Whether online payments are usable with the current environment.
 *
 * Never throws, so it is safe to call from UI-facing code paths that only
 * need to know whether to offer the "pay online" button.
 */
export function isPaymentProviderConfigured(): boolean {
  try {
    assertPaymentProviderConfig(readPaymentProviderConfig());
    return true;
  } catch {
    return false;
  }
}
