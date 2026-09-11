import { describe, expect, it } from "vitest";
import { createSandboxProvider } from "./sandbox";
import { InvalidPaymentAmountError, UnsupportedCurrencyError } from "../paymentErrors";

/**
 * Unit tests for the in-process sandbox gateway. The sandbox must obey the
 * exact same input rules as the real adapters (via `createPaymentAmount`)
 * and produce deterministic, prefix-distinguishable authorities.
 */
describe("payments/providers/sandbox", () => {
  const VALID_INPUT = {
    amount: 990000,
    currency: "IRR",
    callbackUrl: "http://localhost:3000/api/payments/callback?kind=subscription",
  };

  it("creates an SBX-prefixed authority and a local StartPay redirect URL", async () => {
    const provider = createSandboxProvider({ APP_URL: "http://localhost:3000" });
    const result = await provider.createPayment(VALID_INPUT);

    expect(result.authority).toMatch(/^SBX[0-9A-F]{32}$/);
    expect(result.redirectUrl).toBe(
      `http://localhost:3000/payments/sandbox/StartPay/${result.authority}`,
    );
  });

  it("honours APP_URL (without a trailing slash) for the redirect base", async () => {
    const provider = createSandboxProvider({ APP_URL: "https://app.example.com/" });
    const result = await provider.createPayment(VALID_INPUT);
    expect(result.redirectUrl.startsWith("https://app.example.com/payments/sandbox/StartPay/")).toBe(
      true,
    );
  });

  it("generates a fresh authority per payment", async () => {
    const provider = createSandboxProvider({});
    const a = await provider.createPayment(VALID_INPUT);
    const b = await provider.createPayment(VALID_INPUT);
    expect(a.authority).not.toBe(b.authority);
  });

  it("rejects amounts the real gateway would reject", async () => {
    const provider = createSandboxProvider({});
    await expect(provider.createPayment({ ...VALID_INPUT, amount: 1000.5 })).rejects.toBeInstanceOf(
      InvalidPaymentAmountError,
    );
    await expect(provider.createPayment({ ...VALID_INPUT, amount: 0 })).rejects.toBeInstanceOf(
      InvalidPaymentAmountError,
    );
    await expect(
      provider.createPayment({ ...VALID_INPUT, currency: "USD" }),
    ).rejects.toBeInstanceOf(UnsupportedCurrencyError);
  });

  describe("verifyPayment", () => {
    it("verifies an SBX authority deterministically", async () => {
      const provider = createSandboxProvider({});
      const { authority } = await provider.createPayment(VALID_INPUT);

      const result = await provider.verifyPayment({ amount: 990000, currency: "IRR", authority });
      expect(result.status).toBe("VERIFIED");
      expect(result.code).toBe(100);
      expect(result.referenceId).toBe(`SBXRF-${authority.slice(3, 15)}`);
      expect(result.referenceId?.startsWith("SBXRF-")).toBe(true);
    });

    it("rejects a foreign authority", async () => {
      const provider = createSandboxProvider({});
      const result = await provider.verifyPayment({ amount: 990000, currency: "IRR", authority: "A0000" });
      expect(result.status).toBe("REJECTED");
      expect(result.referenceId).toBeNull();
    });
  });
});
