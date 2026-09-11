import { afterEach, describe, expect, it, vi } from "vitest";
import { createZarinpalProvider } from "./zarinpal";
import {
  InvalidPaymentAmountError,
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
} from "../paymentErrors";

/**
 * Unit tests for the ZarinPal v4 adapter. The HTTP layer is mocked so these
 * tests pin the adapter's contract only: envelope parsing, success/error
 * mapping, safe error messages, and the guarantee that the merchant id never
 * escapes in a return value or error.
 */
const postJson = vi.hoisted(() => vi.fn());

vi.mock("../http", () => ({
  postJson,
}));

const MERCHANT_ID = "11111111-2222-3333-4444-555555555555";

const ENV = {
  PAYMENT_MERCHANT_ID: MERCHANT_ID,
  PAYMENT_SANDBOX: "true",
};

const VALID_INPUT = {
  amount: 990000,
  currency: "IRR",
  callbackUrl: "https://app.example.com/api/payments/callback?kind=subscription",
  description: "PRO subscription",
};

function provider() {
  return createZarinpalProvider(ENV);
}

afterEach(() => {
  // postJson mock call arrays accumulate across tests; drop them so per-test
  // call assertions stay meaningful.
  postJson.mockClear();
});

describe("payments/providers/zarinpal — createPayment", () => {
  it("posts a v4 request payload to the sandbox host and returns authority + redirect URL", async () => {
    postJson.mockResolvedValue({
      status: 200,
      body: { data: [{ code: 100, authority: "A0000000000000000000000000000abc" }] },
    });

    const result = await provider().createPayment(VALID_INPUT);

    expect(result.authority).toBe("A0000000000000000000000000000abc");
    expect(result.redirectUrl).toBe(
      "https://sandbox.zarinpal.com/pg/StartPay/A0000000000000000000000000000abc",
    );

    const [url, payload] = postJson.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe("https://sandbox.zarinpal.com/api/v4/payment/request.json");
    expect(payload.merchant_id).toBe(MERCHANT_ID);
    expect(payload.amount).toBe(990000);
    expect(payload.currency).toBe("IRR");
    expect(payload.callback_url).toBe(VALID_INPUT.callbackUrl);
    expect(payload.description).toBe("PRO subscription");
  });

  it("uses the production host when PAYMENT_SANDBOX is not 'true'", async () => {
    postJson.mockResolvedValue({
      status: 200,
      body: { data: [{ code: 100, authority: "A1" }] },
    });

    const result = createZarinpalProvider({ PAYMENT_MERCHANT_ID: MERCHANT_ID }).createPayment(
      VALID_INPUT,
    );
    await result;
    const [url] = postJson.mock.calls[0] as unknown as [string];
    expect(url).toContain("https://payment.zarinpal.com/");
  });

  it("throws a typed, message-safe error when the gateway rejects with a data code", async () => {
    postJson.mockResolvedValue({
      status: 200,
      body: { data: [{ code: -10 }], errors: [] },
    });

    try {
      await provider().createPayment(VALID_INPUT);
      expect.unreachable("expected PaymentProviderError");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).providerCode).toBe("-10");
      expect((error as PaymentProviderError).message).toBe(
        "Online payment is not available for this merchant. Please contact support.",
      );
    }
  });

  it("uses the generic safe message for unknown codes and never leaks the gateway body", async () => {
    postJson.mockResolvedValue({
      status: 200,
      body: {
        data: [{ code: -77 }],
        errors: { code: -77, message: "merchant 11111111-2222-3333-4444-555555555555 is bankrupt" },
      },
    });

    try {
      await provider().createPayment(VALID_INPUT);
      expect.unreachable("expected PaymentProviderError");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).message).toBe(
        "The payment gateway rejected the request.",
      );
      // The raw gateway message (with the merchant id in it) must not appear.
      expect((error as PaymentProviderError).message).not.toContain(MERCHANT_ID);
    }
  });

  it("treats a missing/empty authority as a gateway rejection", async () => {
    postJson.mockResolvedValue({ status: 200, body: { data: [{ code: 100 }] } });
    await expect(provider().createPayment(VALID_INPUT)).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("refuses a misconfigured merchant before any request is sent", async () => {
    const broken = createZarinpalProvider({ PAYMENT_MERCHANT_ID: "not-a-uuid" });
    await expect(broken.createPayment(VALID_INPUT)).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
    expect(postJson).not.toHaveBeenCalled();
  });

  it.each([
    ["fractional amount", { ...VALID_INPUT, amount: 1000.5 }],
    ["zero amount", { ...VALID_INPUT, amount: 0 }],
    ["non-integer amount", { ...VALID_INPUT, amount: 990000.25 }],
  ])("rejects an unusable amount (%s) before the request", async (_label, input) => {
    await expect(provider().createPayment(input)).rejects.toBeInstanceOf(InvalidPaymentAmountError);
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("payments/providers/zarinpal — verifyPayment", () => {
  const VERIFY_INPUT = {
    amount: 990000,
    currency: "IRR",
    authority: "A0000000000000000000000000000abc",
  };

  it("maps code 100 to VERIFIED with the gateway reference id", async () => {
    postJson.mockResolvedValue({
      status: 200,
      body: { data: [{ code: 100, ref_id: 123456 }] },
    });

    const result = await provider().verifyPayment(VERIFY_INPUT);
    expect(result).toEqual({ status: "VERIFIED", referenceId: "123456", code: 100 });
  });

  it("maps code 101 (already verified) to VERIFIED too", async () => {
    postJson.mockResolvedValue({
      status: 200,
      body: { data: [{ code: 101, ref_id: 123456 }] },
    });

    const result = await provider().verifyPayment(VERIFY_INPUT);
    expect(result.status).toBe("VERIFIED");
    expect(result.code).toBe(101);
  });

  it("maps any other code to REJECTED", async () => {
    postJson.mockResolvedValue({ status: 200, body: { data: [{ code: -51 }] } });

    const result = await provider().verifyPayment(VERIFY_INPUT);
    expect(result).toEqual({ status: "REJECTED", referenceId: null, code: -51 });
  });

  it("throws the unavailable error when the envelope is unusable", async () => {
    postJson.mockResolvedValue({ status: 200, body: { errors: { invalid: true } } });
    await expect(provider().verifyPayment(VERIFY_INPUT)).rejects.toThrow(/unavailable/i);
  });
});
