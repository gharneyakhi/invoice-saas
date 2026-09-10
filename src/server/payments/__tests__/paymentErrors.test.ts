import { describe, it, expect } from "vitest";
import {
  PaymentAmountMismatchError,
  PaymentError,
  PaymentErrorCode,
  PaymentGatewayError,
  PaymentNetworkError,
  PaymentNotConfiguredError,
  PaymentNotFoundError,
  PaymentUnsupportedOperationError,
  PaymentValidationError,
  isPaymentError,
} from "../paymentErrors";

/**
 * Typed payment errors.
 *
 * These are the contract the Server Action error mapper relies on, so the
 * tests pin the machine `code`s (a caller may switch on them) and the
 * no-secrets rule: a merchant id or a raw gateway body must never reach a
 * user-visible message.
 */
describe("payment errors", () => {
  it("gives every failure a stable code and a name", () => {
    const cases: Array<[PaymentError, PaymentErrorCode]> = [
      [new PaymentNotConfiguredError(), PaymentErrorCode.NOT_CONFIGURED],
      [new PaymentValidationError(), PaymentErrorCode.VALIDATION],
      [new PaymentNetworkError(), PaymentErrorCode.NETWORK],
      [new PaymentGatewayError(), PaymentErrorCode.GATEWAY],
      [new PaymentNotFoundError(), PaymentErrorCode.NOT_FOUND],
      [new PaymentUnsupportedOperationError("refundPayment"), PaymentErrorCode.UNSUPPORTED_OPERATION],
      [
        new PaymentAmountMismatchError({ expectedAmount: "1000", actualAmount: "900" }),
        PaymentErrorCode.AMOUNT_MISMATCH,
      ],
    ];

    for (const [error, code] of cases) {
      expect(error.code).toBe(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).not.toBe("Error");
    }

    // Codes are the stable contract, so they are asserted literally.
    expect(PaymentErrorCode.GATEWAY).toBe("PAYMENT_GATEWAY_ERROR");
    expect(PaymentErrorCode.NOT_CONFIGURED).toBe("PAYMENT_NOT_CONFIGURED");
  });

  it("normalizes gateway detail without leaking it into the message", () => {
    const error = new PaymentGatewayError("The payment gateway refused the request", {
      providerId: "zarinpal",
      providerCode: -9,
      httpStatus: 422,
    });

    expect(error.providerCode).toBe("-9");
    expect(error.httpStatus).toBe(422);
    expect(error.providerId).toBe("zarinpal");
    // Detail stays on the fields; the message stays safe to show a user.
    expect(error.message).not.toContain("-9");

    const bare = new PaymentGatewayError();
    expect(bare.providerCode).toBeNull();
    expect(bare.httpStatus).toBeNull();
    expect(bare.providerId).toBeNull();
  });

  it("recognizes the family and rejects anything else", () => {
    expect(isPaymentError(new PaymentValidationError())).toBe(true);
    expect(isPaymentError(new PaymentNetworkError(undefined, { providerId: "zarinpal" }))).toBe(
      true,
    );
    expect(isPaymentError(new Error("plain"))).toBe(false);
    expect(isPaymentError(null)).toBe(false);
    expect(isPaymentError("PAYMENT_GATEWAY_ERROR")).toBe(false);
  });

  it("records the diagnostic fields the caller must act on", () => {
    const mismatch = new PaymentAmountMismatchError({
      expectedAmount: "25000",
      actualAmount: "24000",
      providerId: "zarinpal",
    });
    expect(mismatch.expectedAmount).toBe("25000");
    expect(mismatch.actualAmount).toBe("24000");
    expect(mismatch.message).toContain("24000");
    expect(mismatch.message).toContain("25000");

    const unsupported = new PaymentUnsupportedOperationError(
      "getPaymentStatus",
      "No read-only status endpoint",
      { providerId: "zarinpal" },
    );
    expect(unsupported.operation).toBe("getPaymentStatus");
    expect(unsupported.message).toBe("No read-only status endpoint");
    // Default message names the operation, so a bare throw is still readable.
    expect(new PaymentUnsupportedOperationError("refundPayment").message).toContain(
      "refundPayment",
    );
  });
});
