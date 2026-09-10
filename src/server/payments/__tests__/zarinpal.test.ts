import { describe, it, expect } from "vitest";
import {
  ZARINPAL_ALREADY_VERIFIED_CODE,
  ZARINPAL_LIVE_API_ORIGIN,
  ZARINPAL_LIVE_GATEWAY_ORIGIN,
  ZARINPAL_MIN_AMOUNT_RIAL,
  ZARINPAL_NOT_FOUND_CODE,
  ZARINPAL_REQUEST_PATH,
  ZARINPAL_SANDBOX_API_ORIGIN,
  ZARINPAL_SANDBOX_GATEWAY_ORIGIN,
  ZARINPAL_STARTPAY_PATH,
  ZARINPAL_SUCCESS_CODE,
  ZARINPAL_VERIFY_PATH,
  createZarinPalProvider,
} from "../providers/zarinpal";
import { createPaymentAmount } from "../money";
import {
  PaymentGatewayError,
  PaymentNetworkError,
  PaymentNotFoundError,
  PaymentUnsupportedOperationError,
  PaymentValidationError,
} from "../paymentErrors";
import type { PaymentHttpFetch, PaymentHttpRequestInit } from "../http";
import type { CreatePaymentRequest } from "../types";

/**
 * ZarinPal v4 adapter, driven entirely through an injected transport.
 *
 * **No test here touches the network.** Every case supplies its own stub
 * `fetch`, and the adapter has no other route out of the process — which is
 * the whole point of the HTTP dependency injection in `../http`. The stub
 * also captures the outgoing request so the tests assert the real v4 wire
 * shape (snake_case keys, integer amount, `metadata.order_id`) rather than
 * just the parsed result.
 */

/** A valid 36-character merchant UUID (a fixture, not a credential). */
const MERCHANT_ID = "11111111-2222-3333-4444-555555555555";

interface StubCall {
  url: string;
  init: PaymentHttpRequestInit;
  /** Parsed outgoing body, for wire-shape assertions. */
  body: Record<string, unknown>;
}

type StubResponse = { status?: number; body: string } | Error;

function createStubHttp(responses: StubResponse[]) {
  const calls: StubCall[] = [];
  const queue = [...responses];

  const fetch: PaymentHttpFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
    const next = queue.shift();
    if (!next) throw new Error("stub: no response queued for " + url);
    if (next instanceof Error) throw next;
    return { status: next.status ?? 200, text: async () => next.body };
  };

  return { calls, fetch };
}

const okEnvelope = (data: Record<string, unknown>) =>
  JSON.stringify({ data: { code: ZARINPAL_SUCCESS_CODE, message: "OK", ...data }, errors: null });

const errorEnvelope = (code: number, message = "خطا") =>
  JSON.stringify({ data: null, errors: { code, message, validations: [] } });

function createRequest(overrides: Partial<CreatePaymentRequest> = {}): CreatePaymentRequest {
  return {
    orderId: "INV-1001",
    amount: createPaymentAmount("25000", "IRR"),
    description: "فاکتور ۱۰۰۱",
    callbackUrl: "https://example.com/api/payments/callback",
    payer: { email: "buyer@example.com", mobile: "09120000000" },
    ...overrides,
  };
}

describe("ZarinPal v4 adapter", () => {
  it("posts the v4 request payload in the gateway's own wire shape", async () => {
    const http = createStubHttp([{ body: okEnvelope({ authority: "A00000000000000000000000000001" }) }]);
    const provider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: http.fetch } },
    );

    await provider.createPayment(createRequest());

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.url).toBe(`${ZARINPAL_LIVE_API_ORIGIN}${ZARINPAL_REQUEST_PATH}`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toEqual({
      merchant_id: MERCHANT_ID,
      amount: "25000",
      currency: "IRR",
      callback_url: "https://example.com/api/payments/callback",
      description: "فاکتور ۱۰۰۱",
      metadata: {
        order_id: "INV-1001",
        email: "buyer@example.com",
        mobile: "09120000000",
      },
    });
  });

  it("returns the authority and a StartPay redirect on success", async () => {
    const authority = "A0000000000000000000000000000wwOGYpd";
    const http = createStubHttp([{ body: okEnvelope({ authority, fee: 250, fee_type: "Payer" }) }]);
    const provider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: http.fetch } },
    );

    const result = await provider.createPayment(createRequest());

    expect(result).toEqual({
      providerId: "zarinpal",
      providerReference: authority,
      redirectUrl: `${ZARINPAL_LIVE_GATEWAY_ORIGIN}${ZARINPAL_STARTPAY_PATH}${authority}`,
      amount: { amount: "25000", currency: "IRR" },
      sandbox: false,
    });
    // The authority is echoed into the URL, never re-parsed by us.
    expect(result.redirectUrl.endsWith(authority)).toBe(true);
  });

  it("switches both the API and redirect hosts in sandbox mode", async () => {
    const http = createStubHttp([{ body: okEnvelope({ authority: "SBX-A1" }) }]);
    const provider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: true },
      { http: { fetch: http.fetch } },
    );

    const result = await provider.createPayment(
      createRequest({ callbackUrl: "http://localhost:3000/api/payments/callback" }),
    );

    expect(http.calls[0]!.url).toBe(`${ZARINPAL_SANDBOX_API_ORIGIN}${ZARINPAL_REQUEST_PATH}`);
    expect(result.redirectUrl).toBe(`${ZARINPAL_SANDBOX_GATEWAY_ORIGIN}${ZARINPAL_STARTPAY_PATH}SBX-A1`);
    expect(result.sandbox).toBe(true);
    expect(provider.sandbox).toBe(true);
  });

  it("maps an errors envelope to a typed gateway error carrying the provider code", async () => {
    const http = createStubHttp([{ body: errorEnvelope(-9, "خطای اعتبار سنجی") }]);
    const provider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: http.fetch } },
    );

    const error = await provider.createPayment(createRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentGatewayError);
    expect((error as PaymentGatewayError).providerCode).toBe("-9");
    expect((error as PaymentGatewayError).providerId).toBe("zarinpal");
    // The Persian gateway text is not surfaced as our message.
    expect((error as PaymentGatewayError).message).not.toContain("خطای اعتبار سنجی");

    // A non-2xx transport status is a gateway error too, with the status kept.
    const badStatus = createStubHttp([{ status: 502, body: "<html>bad gateway</html>" }]);
    const provider2 = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: badStatus.fetch } },
    );
    const statusError = await provider2.createPayment(createRequest()).catch((e: unknown) => e);
    expect(statusError).toBeInstanceOf(PaymentGatewayError);
    expect((statusError as PaymentGatewayError).httpStatus).toBe(502);
  });

  it("rejects a merchant id that is not a 36-character UUID", () => {
    expect(() => createZarinPalProvider({ merchantId: "", sandbox: false })).toThrow(
      PaymentValidationError,
    );
    expect(() => createZarinPalProvider({ merchantId: "not-a-uuid", sandbox: false })).toThrow(
      /36-character UUID/,
    );
    // A pasted secret is rejected without being echoed into the message.
    const error = (() => {
      try {
        createZarinPalProvider({ merchantId: "sk_live_abcdef123456", sandbox: false });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(error.message).not.toContain("sk_live_abcdef123456");
  });

  it("enforces the rial-quoted gateway minimum for both units", async () => {
    const http = createStubHttp([{ body: okEnvelope({ authority: "A1" }) }]);
    const provider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: http.fetch } },
    );

    expect(ZARINPAL_MIN_AMOUNT_RIAL).toBe(10000);

    // 9999 ریال is below the minimum.
    await expect(
      provider.createPayment(createRequest({ amount: createPaymentAmount("9999", "IRR") })),
    ).rejects.toThrow(/below the gateway minimum/);
    // 999 تومان == 9990 ریال, also below — proves the check is unit-correct.
    await expect(
      provider.createPayment(createRequest({ amount: createPaymentAmount("999", "IRT") })),
    ).rejects.toThrow(PaymentValidationError);
    // Nothing was sent for either rejected request.
    expect(http.calls).toHaveLength(0);
  });

  it("requires an https callback outside the sandbox and allows http inside it", async () => {
    const live = createStubHttp([{ body: okEnvelope({ authority: "A1" }) }]);
    const liveProvider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: live.fetch } },
    );
    await expect(
      liveProvider.createPayment(
        createRequest({ callbackUrl: "http://example.com/api/payments/callback" }),
      ),
    ).rejects.toThrow(/must use https/);

    const sandbox = createStubHttp([{ body: okEnvelope({ authority: "A1" }) }]);
    const sandboxProvider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: true },
      { http: { fetch: sandbox.fetch } },
    );
    await expect(
      sandboxProvider.createPayment(
        createRequest({ callbackUrl: "http://localhost:3000/callback" }),
      ),
    ).resolves.toMatchObject({ sandbox: true });

    // A relative or non-http URL is refused in both modes.
    await expect(
      sandboxProvider.createPayment(createRequest({ callbackUrl: "/callback" })),
    ).rejects.toThrow(/absolute URL/);
  });

  it("refuses a callback URL that is not on the configured origin", async () => {
    const http = createStubHttp([{ body: okEnvelope({ authority: "A1" }) }]);
    const provider = createZarinPalProvider(
      {
        merchantId: MERCHANT_ID,
        sandbox: false,
        allowedCallbackOrigin: "https://invoices.example.com",
      },
      { http: { fetch: http.fetch } },
    );

    await expect(
      provider.createPayment(
        createRequest({ callbackUrl: "https://evil.example.com/steal" }),
      ),
    ).rejects.toThrow(/not on the configured payment callback origin/);

    await expect(
      provider.createPayment(
        createRequest({ callbackUrl: "https://invoices.example.com/api/payments/callback" }),
      ),
    ).resolves.toMatchObject({ providerId: "zarinpal" });
    expect(http.calls).toHaveLength(1);
  });

  it("verifies a charge and reports an already-verified retry as idempotent success", async () => {
    const http = createStubHttp([
      { body: okEnvelope({ ref_id: 987654321, card_hash: "hash", card_pan: "****" }) },
      { body: okEnvelope({ code: ZARINPAL_ALREADY_VERIFIED_CODE, ref_id: 987654321 }) },
    ]);
    const provider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: http.fetch } },
    );

    const request = {
      orderId: "INV-1001",
      providerReference: "A00000000000000000000000000001",
      amount: createPaymentAmount("25000", "IRR"),
    };

    const first = await provider.verifyPayment(request);
    expect(first.status).toBe("SUCCEEDED");
    expect(first.alreadyVerified).toBe(false);
    expect(first.referenceId).toBe("987654321");
    expect(first.amount).toEqual({ amount: "25000", currency: "IRR" });

    const second = await provider.verifyPayment(request);
    expect(second.status).toBe("SUCCEEDED");
    expect(second.alreadyVerified).toBe(true);

    // Wire shape of verify: merchant_id + authority + integer amount.
    expect(http.calls[0]!.url).toBe(`${ZARINPAL_LIVE_API_ORIGIN}${ZARINPAL_VERIFY_PATH}`);
    expect(http.calls[0]!.body).toEqual({
      merchant_id: MERCHANT_ID,
      authority: "A00000000000000000000000000001",
      amount: "25000",
    });

    // An unsuccessful verification is FAILED, not a thrown error.
    const failed = createStubHttp([{ body: okEnvelope({ code: -22, message: "تراکنش نا موفق" }) }]);
    const failedProvider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: failed.fetch } },
    );
    await expect(failedProvider.verifyPayment(request)).resolves.toMatchObject({
      status: "FAILED",
      referenceId: null,
    });
  });

  it("maps an unknown authority to PaymentNotFoundError, not a generic gateway error", async () => {
    const http = createStubHttp([{ body: errorEnvelope(ZARINPAL_NOT_FOUND_CODE, "یافت نشد") }]);
    const provider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: http.fetch } },
    );

    await expect(
      provider.verifyPayment({
        orderId: "INV-1001",
        providerReference: "STALE",
        amount: createPaymentAmount("25000", "IRR"),
      }),
    ).rejects.toThrow(PaymentNotFoundError);

    // A transport failure is distinct and retriable.
    const down = createStubHttp([new TypeError("fetch failed")]);
    const downProvider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: down.fetch } },
    );
    const networkError = await downProvider
      .createPayment(createRequest())
      .catch((e: unknown) => e);
    expect(networkError).toBeInstanceOf(PaymentNetworkError);
  });

  it("declares and honestly reports the operations this API does not have", async () => {
    const http = createStubHttp([]);
    const provider = createZarinPalProvider(
      { merchantId: MERCHANT_ID, sandbox: false },
      { http: { fetch: http.fetch } },
    );

    // The v4 public gateway API has neither a read-only status endpoint nor a
    // refund endpoint, so both must refuse rather than invent a result.
    expect(provider.capabilities).toEqual({ refund: false, statusQuery: false });

    await expect(
      provider.getPaymentStatus({ orderId: "INV-1001", providerReference: "A1" }),
    ).rejects.toThrow(PaymentUnsupportedOperationError);
    await expect(
      provider.refundPayment({ orderId: "INV-1001", providerReference: "A1" }),
    ).rejects.toThrow(/merchant panel/);

    // No HTTP call was attempted for either unsupported operation.
    expect(http.calls).toHaveLength(0);
  });
});
