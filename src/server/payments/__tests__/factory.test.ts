import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_PAYMENT_PROVIDER_ID,
  createPaymentProvider,
  getPaymentProvider,
  isPaymentProviderConfigured,
  parseSandboxFlag,
  readPaymentProviderConfig,
  resetPaymentProviderCache,
} from "../factory";
import {
  PaymentNotConfiguredError,
  PaymentProviderUnknownError,
  PaymentValidationError,
} from "../paymentErrors";
import { createPaymentAmount } from "../money";

/**
 * Provider factory — the production-safety layer.
 *
 * The failure mode these tests exist to prevent is a deployment silently
 * taking fake payments: a lost `PAYMENT_SANDBOX=false`, a merchant id pasted
 * from the wrong environment, or an `http` callback that leaks payer return
 * data. Each must fail loudly at the first payment instead of reporting
 * success that no gateway ever saw.
 */

const MERCHANT_ID = "11111111-2222-3333-4444-555555555555";
const PAYMENT_KEYS = [
  "NODE_ENV",
  "PAYMENT_PROVIDER",
  "PAYMENT_MERCHANT_ID",
  "PAYMENT_CALLBACK_URL",
  "PAYMENT_SANDBOX",
] as const;

/**
 * `process.env` typed as writable.
 *
 * Next.js types `NODE_ENV` as a read-only literal union, which is correct for
 * application code but blocks these tests from simulating a production
 * deployment. The alias is confined to this file; the factory itself only
 * ever *reads* the environment.
 */
const env = process.env as Record<string, string | undefined>;

describe("payment provider factory", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of PAYMENT_KEYS) {
      saved[key] = env[key];
      delete env[key];
    }
    resetPaymentProviderCache();
  });

  afterEach(() => {
    for (const key of PAYMENT_KEYS) {
      if (saved[key] === undefined) delete env[key];
      else env[key] = saved[key];
    }
    resetPaymentProviderCache();
  });

  it("resolves ZarinPal from the environment and pins the callback origin", async () => {
    env.NODE_ENV = "test";
    env.PAYMENT_PROVIDER = "zarinpal";
    env.PAYMENT_MERCHANT_ID = MERCHANT_ID;
    env.PAYMENT_CALLBACK_URL = "http://localhost:3000/api/payments/callback";
    env.PAYMENT_SANDBOX = "true";

    expect(DEFAULT_PAYMENT_PROVIDER_ID).toBe("zarinpal");
    expect(readPaymentProviderConfig()).toEqual({
      id: "zarinpal",
      merchantId: MERCHANT_ID,
      callbackUrl: "http://localhost:3000/api/payments/callback",
      sandbox: true,
      isProduction: false,
    });

    const provider = createPaymentProvider();
    expect(provider.id).toBe("zarinpal");
    expect(provider.sandbox).toBe(true);

    // PAYMENT_CALLBACK_URL becomes an origin allowlist in the adapter, so a
    // caller-supplied callback cannot redirect payers elsewhere.
    await expect(
      provider.createPayment({
        orderId: "INV-3001",
        amount: createPaymentAmount("25000", "IRR"),
        description: "test",
        callbackUrl: "https://evil.example.com/steal",
      }),
    ).rejects.toThrow(/not on the configured payment callback origin/);

    // Cached per configuration; reset clears it.
    expect(getPaymentProvider()).toBe(getPaymentProvider());
    resetPaymentProviderCache();
    expect(isPaymentProviderConfigured()).toBe(true);
  });

  it("refuses sandbox payments when NODE_ENV is production", () => {
    env.NODE_ENV = "production";
    env.PAYMENT_PROVIDER = "zarinpal";
    env.PAYMENT_MERCHANT_ID = MERCHANT_ID;
    env.PAYMENT_CALLBACK_URL = "https://invoices.example.com/api/payments/callback";

    // A stray/lost "true" must not quietly fake payments in production.
    env.PAYMENT_SANDBOX = "true";
    expect(() => createPaymentProvider()).toThrow(PaymentNotConfiguredError);
    expect(() => createPaymentProvider()).toThrow(/NODE_ENV is production/);
    expect(isPaymentProviderConfigured()).toBe(false);

    // The sandbox provider itself is refused in production for the same reason.
    env.PAYMENT_PROVIDER = "sandbox";
    delete env.PAYMENT_SANDBOX;
    expect(() => createPaymentProvider()).toThrow(/cannot be used while NODE_ENV is production/);

    // Unset in production defaults to live, not sandbox.
    env.PAYMENT_PROVIDER = "zarinpal";
    expect(readPaymentProviderConfig().sandbox).toBe(false);
    expect(isPaymentProviderConfigured()).toBe(true);

    // An unrecognized flag value is never read as "off".
    expect(parseSandboxFlag("TRUE")).toBe(true);
    expect(parseSandboxFlag(" off ")).toBe(false);
    expect(parseSandboxFlag("maybe")).toBeNull();
    expect(parseSandboxFlag("")).toBeNull();
    expect(parseSandboxFlag(undefined)).toBeNull();
  });

  it("requires a merchant id and an https callback in live mode", () => {
    env.NODE_ENV = "test";
    env.PAYMENT_SANDBOX = "false";

    // No merchant id at all.
    expect(() => createPaymentProvider()).toThrow(/PAYMENT_MERCHANT_ID is required/);

    env.PAYMENT_PROVIDER = "zarinpal";
    env.PAYMENT_MERCHANT_ID = MERCHANT_ID;

    // Live mode with no callback URL registered.
    expect(() => createPaymentProvider()).toThrow(/PAYMENT_CALLBACK_URL is required/);

    // Live mode over clear-text http.
    env.PAYMENT_CALLBACK_URL = "http://invoices.example.com/api/payments/callback";
    expect(() => createPaymentProvider()).toThrow(/must use https/);
    expect(() => createPaymentProvider()).toThrow(PaymentValidationError);

    // A relative URL is not a callback URL.
    env.PAYMENT_CALLBACK_URL = "/api/payments/callback";
    expect(() => createPaymentProvider()).toThrow(/absolute URL/);

    env.PAYMENT_CALLBACK_URL = "https://invoices.example.com/api/payments/callback";
    expect(createPaymentProvider().sandbox).toBe(false);
    expect(isPaymentProviderConfigured()).toBe(true);
  });

  it("rejects an unknown provider name instead of falling back to a default", () => {
    env.NODE_ENV = "test";
    env.PAYMENT_MERCHANT_ID = MERCHANT_ID;
    env.PAYMENT_SANDBOX = "true";

    // A typo in PAYMENT_PROVIDER would otherwise silently change which
    // gateway takes the money, so it is an error, not a default.
    env.PAYMENT_PROVIDER = "paypal";
    expect(() => createPaymentProvider()).toThrow(PaymentProviderUnknownError);
    expect(() => createPaymentProvider()).toThrow(/Supported providers: zarinpal, sandbox/);
    expect(isPaymentProviderConfigured()).toBe(false);

    // Unset is the documented default (ZarinPal), which is different from
    // "unrecognized" and is allowed.
    delete env.PAYMENT_PROVIDER;
    expect(readPaymentProviderConfig().id).toBe("zarinpal");
    expect(createPaymentProvider().id).toBe("zarinpal");

    // The sandbox provider is selectable by name outside production.
    env.PAYMENT_PROVIDER = "sandbox";
    expect(createPaymentProvider().id).toBe("sandbox");
  });
});
