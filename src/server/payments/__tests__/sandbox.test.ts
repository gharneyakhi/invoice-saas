import { describe, it, expect, beforeEach } from "vitest";
import {
  SANDBOX_AUTHORITY_PREFIX,
  SANDBOX_GATEWAY_ORIGIN,
  SANDBOX_PAY_PATH,
  SANDBOX_REFERENCE_PREFIX,
  SandboxPaymentProvider,
  createSandboxProvider,
} from "../providers/sandbox";
import { createPaymentAmount } from "../money";
import {
  PaymentAmountMismatchError,
  PaymentNotFoundError,
  PaymentValidationError,
} from "../paymentErrors";
import type { CreatePaymentRequest } from "../types";

/**
 * Sandbox provider — the deterministic stand-in used by local development and
 * by any future checkout-flow test.
 *
 * What is being pinned here is that the sandbox is *not* a no-op: it enforces
 * the same integrity rules as the real adapter (amount must match, authority
 * must exist, only a succeeded charge can be refunded), so a flow that passes
 * against it is genuinely wired, and a flow that is broken fails here too.
 */

function createRequest(overrides: Partial<CreatePaymentRequest> = {}): CreatePaymentRequest {
  return {
    orderId: "INV-2001",
    amount: createPaymentAmount("25000", "IRR"),
    description: "فاکتور ۲۰۰۱",
    callbackUrl: "http://localhost:3000/api/payments/callback",
    ...overrides,
  };
}

describe("sandbox payment provider", () => {
  let provider: SandboxPaymentProvider;

  beforeEach(() => {
    provider = new SandboxPaymentProvider();
  });

  it("creates deterministic authorities and a non-routable redirect URL", async () => {
    const first = await provider.createPayment(createRequest());
    const second = await provider.createPayment(createRequest({ orderId: "INV-2002" }));

    // Counter-based ids: reproducible, so assertions on them cannot flake.
    expect(first.providerReference).toBe(`${SANDBOX_AUTHORITY_PREFIX}1`);
    expect(second.providerReference).toBe(`${SANDBOX_AUTHORITY_PREFIX}2`);
    expect(first.redirectUrl).toBe(
      `${SANDBOX_GATEWAY_ORIGIN}${SANDBOX_PAY_PATH}${SANDBOX_AUTHORITY_PREFIX}1`,
    );
    // `.invalid` is reserved by RFC 2606: a mis-wired redirect cannot resolve.
    expect(SANDBOX_GATEWAY_ORIGIN).toContain(".invalid");
    expect(first.providerId).toBe("sandbox");
    expect(first.sandbox).toBe(true);
    expect(first.amount).toEqual({ amount: "25000", currency: "IRR" });
    expect(provider.size).toBe(2);

    // Same request-shape validation as the real adapter.
    await expect(
      provider.createPayment(createRequest({ description: "  " })),
    ).rejects.toThrow(PaymentValidationError);
    await expect(
      provider.createPayment(createRequest({ callbackUrl: "not-a-url" })),
    ).rejects.toThrow(/absolute URL/);
  });

  it("verifies once and reports a retry as an idempotent success", async () => {
    const created = await provider.createPayment(createRequest());
    const request = {
      orderId: created.providerReference,
      providerReference: created.providerReference,
      amount: createPaymentAmount("25000", "IRR"),
    };

    const first = await provider.verifyPayment(request);
    expect(first.status).toBe("SUCCEEDED");
    expect(first.alreadyVerified).toBe(false);
    // The id sequence is shared, so the reference id follows the authority:
    // `SBX-AUTH-1` was sequence 1, this is sequence 2.
    expect(first.referenceId).toBe(`${SANDBOX_REFERENCE_PREFIX}2`);

    const second = await provider.verifyPayment(request);
    expect(second.status).toBe("SUCCEEDED");
    expect(second.alreadyVerified).toBe(true);
    expect(second.referenceId).toBe(first.referenceId);
  });

  it("refuses an amount mismatch and an unknown authority", async () => {
    const created = await provider.createPayment(createRequest());

    // Charged 25000, "verified" for 24000 → integrity failure, not a success.
    await expect(
      provider.verifyPayment({
        orderId: "INV-2001",
        providerReference: created.providerReference,
        amount: createPaymentAmount("24000", "IRR"),
      }),
    ).rejects.toThrow(PaymentAmountMismatchError);

    // Same ریال value expressed in تومان is NOT a mismatch — unit-correct.
    await expect(
      provider.verifyPayment({
        orderId: "INV-2001",
        providerReference: created.providerReference,
        amount: createPaymentAmount("2500", "IRT"),
      }),
    ).resolves.toMatchObject({ status: "SUCCEEDED" });

    await expect(
      provider.verifyPayment({
        orderId: "INV-2001",
        providerReference: "SBX-AUTH-does-not-exist",
        amount: createPaymentAmount("25000", "IRR"),
      }),
    ).rejects.toThrow(PaymentNotFoundError);
    await expect(
      provider.getPaymentStatus({ orderId: "INV-2001", providerReference: "nope" }),
    ).rejects.toThrow(PaymentNotFoundError);
  });

  it("tracks the full status and refund lifecycle", async () => {
    expect(provider.capabilities).toEqual({ refund: true, statusQuery: true });

    const created = await provider.createPayment(createRequest());
    const authority = created.providerReference;

    await expect(provider.getPaymentStatus({ orderId: "INV-2001", providerReference: authority }))
      .resolves.toMatchObject({ status: "CREATED", referenceId: null });

    // A charge that was never paid cannot be refunded.
    await expect(
      provider.refundPayment({ orderId: "INV-2001", providerReference: authority }),
    ).rejects.toThrow(/Only a successful payment/);

    await provider.verifyPayment({
      orderId: "INV-2001",
      providerReference: authority,
      amount: createPaymentAmount("25000", "IRR"),
    });
    await expect(provider.getPaymentStatus({ orderId: "INV-2001", providerReference: authority }))
      .resolves.toMatchObject({ status: "SUCCEEDED" });

    const refunded = await provider.refundPayment({
      orderId: "INV-2001",
      providerReference: authority,
    });
    expect(refunded.status).toBe("REFUNDED");
    // No amount given → full charge refunded.
    expect(refunded.refundedAmount).toEqual({ amount: "25000", currency: "IRR" });

    await expect(provider.getPaymentStatus({ orderId: "INV-2001", providerReference: authority }))
      .resolves.toMatchObject({ status: "REFUNDED" });

    // reset() empties the ledger and rewinds the id sequence.
    provider.reset();
    expect(provider.size).toBe(0);
    const afterReset = await provider.createPayment(createRequest());
    expect(afterReset.providerReference).toBe(`${SANDBOX_AUTHORITY_PREFIX}1`);

    // The barrel helper pins the instance to the PaymentProvider interface.
    expect(createSandboxProvider().id).toBe("sandbox");
  });
});
