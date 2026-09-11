import { afterEach, describe, expect, it } from "vitest";
import { configuredPaymentProviderName, getPaymentProvider } from "./factory";
import { PaymentProviderNotConfiguredError } from "./paymentErrors";

/**
 * Unit tests for the provider factory — the ONLY place a gateway is chosen.
 * The configuration rules pinned here are what make "the client cannot
 * select the provider" true: production callers pass no name at all.
 */
describe("payments/factory", () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.PAYMENT_PROVIDER;
  delete cleanEnv.PAYMENT_MERCHANT_ID;
  delete cleanEnv.PAYMENT_SANDBOX;
  delete cleanEnv.APP_URL;

  afterEach(() => {
    process.env = { ...cleanEnv };
  });

  describe("configuredPaymentProviderName", () => {
    it("reads the provider from PAYMENT_PROVIDER", () => {
      expect(configuredPaymentProviderName({ PAYMENT_PROVIDER: "zarinpal" })).toBe("zarinpal");
      expect(configuredPaymentProviderName({ PAYMENT_PROVIDER: "sandbox" })).toBe("sandbox");
    });

    it("trims surrounding whitespace", () => {
      expect(configuredPaymentProviderName({ PAYMENT_PROVIDER: " sandbox " })).toBe("sandbox");
    });

    it.each([undefined, "", "   ", "paypal", "ZARINPAL"])(
      "refuses the unusable value %j instead of guessing",
      (value) => {
        expect(() => configuredPaymentProviderName({ PAYMENT_PROVIDER: value })).toThrow(
          PaymentProviderNotConfiguredError,
        );
      },
    );

    it("refuses a missing variable outright (explicit config required for money)", () => {
      expect(() => configuredPaymentProviderName({})).toThrow(PaymentProviderNotConfiguredError);
    });
  });

  describe("getPaymentProvider", () => {
    it("resolves the sandbox provider from configuration with no argument", () => {
      const provider = getPaymentProvider(undefined, { PAYMENT_PROVIDER: "sandbox" });
      expect(provider.name).toBe("sandbox");
    });

    it("resolves the zarinpal provider from configuration when a merchant id exists", () => {
      const provider = getPaymentProvider(undefined, {
        PAYMENT_PROVIDER: "zarinpal",
        PAYMENT_MERCHANT_ID: "11111111-2222-3333-4444-555555555555",
      });
      expect(provider.name).toBe("zarinpal");
    });

    it("propagates the not-configured error for an unusable configuration", () => {
      expect(() => getPaymentProvider(undefined, { PAYMENT_PROVIDER: "stripe" })).toThrow(
        PaymentProviderNotConfiguredError,
      );
      expect(() => getPaymentProvider(undefined, {})).toThrow(PaymentProviderNotConfiguredError);
    });

    it("builds a fresh adapter per call (no shared mutable state)", () => {
      const a = getPaymentProvider("sandbox", {});
      const b = getPaymentProvider("sandbox", {});
      expect(a).not.toBe(b);
      expect(a.name).toBe(b.name);
    });
  });
});
