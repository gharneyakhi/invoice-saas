import { afterEach, describe, expect, it } from "vitest";
import {
  buildPaymentCallbackUrl,
  PAYMENT_CALLBACK_URL_ENV_VAR,
  SUBSCRIPTION_PAYMENT_CALLBACK_KIND,
} from "./callbackUrl";
import { PaymentProviderNotConfiguredError } from "./paymentErrors";

/**
 * Unit tests for callback URL construction. The discriminator (`kind`) is
 * what keeps a SubscriptionPayment callback from ever being confused with a
 * future invoice-payment callback while sharing the ONE configured base URL.
 */
describe("payments/callbackUrl — buildPaymentCallbackUrl", () => {
  afterEach(() => {
    delete process.env[PAYMENT_CALLBACK_URL_ENV_VAR];
  });

  it("appends kind=subscription to the configured callback URL", () => {
    const url = buildPaymentCallbackUrl(
      SUBSCRIPTION_PAYMENT_CALLBACK_KIND,
      { PAYMENT_CALLBACK_URL: "http://localhost:3000/api/payments/callback" },
    );
    expect(url).toBe("http://localhost:3000/api/payments/callback?kind=subscription");
  });

  it("merges kind into an existing query string without clobbering it", () => {
    const url = buildPaymentCallbackUrl("invoice", {
      PAYMENT_CALLBACK_URL: "https://pay.example.com/callback?env=production",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("env")).toBe("production");
    expect(parsed.searchParams.get("kind")).toBe("invoice");
  });

  it("marks subscription callbacks distinctly from any other kind", () => {
    const subscription = buildPaymentCallbackUrl(SUBSCRIPTION_PAYMENT_CALLBACK_KIND, {
      PAYMENT_CALLBACK_URL: "https://pay.example.com/callback",
    });
    const invoice = buildPaymentCallbackUrl("invoice", {
      PAYMENT_CALLBACK_URL: "https://pay.example.com/callback",
    });
    expect(new URL(subscription).searchParams.get("kind")).toBe("subscription");
    expect(subscription).not.toBe(invoice);
  });

  it.each([undefined, "", "   "])("refuses an unset/empty configured URL (%j)", (value) => {
    expect(() =>
      buildPaymentCallbackUrl("subscription", { PAYMENT_CALLBACK_URL: value as string }),
    ).toThrow(PaymentProviderNotConfiguredError);
  });

  it("refuses a relative configured URL (gateways need an absolute callback)", () => {
    expect(() =>
      buildPaymentCallbackUrl("subscription", { PAYMENT_CALLBACK_URL: "/api/payments/callback" }),
    ).toThrow(PaymentProviderNotConfiguredError);
  });

  it("refuses an empty kind", () => {
    expect(() =>
      buildPaymentCallbackUrl("  ", { PAYMENT_CALLBACK_URL: "https://pay.example.com/callback" }),
    ).toThrow(PaymentProviderNotConfiguredError);
  });
});
