import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  MAX_PAYMENT_AMOUNT,
  assertGatewayMinimum,
  assertPaymentAmount,
  comparePaymentAmounts,
  createPaymentAmount,
  isPaymentAmount,
  paymentAmountEquals,
  paymentAmountToDecimal,
  rialValue,
  toProviderUnits,
} from "../money";
import { PaymentValidationError } from "../paymentErrors";

/**
 * Decimal-safe money for the payment boundary.
 *
 * The point of these tests is not "does decimal.js work" but that the gateway
 * layer can never (a) do float arithmetic on money, (b) invent a third
 * currency, (c) silently round a charge, or (d) compare تومان against ریال as
 * if they were the same unit.
 */
describe("payments money", () => {
  it("canonicalizes equivalent decimal strings to one form", () => {
    expect(createPaymentAmount("1500", "IRR")).toEqual({ amount: "1500", currency: "IRR" });
    expect(createPaymentAmount("1500.0", "IRR")).toEqual({ amount: "1500", currency: "IRR" });
    expect(createPaymentAmount("1500.00", "IRR")).toEqual({ amount: "1500", currency: "IRR" });
    expect(createPaymentAmount(new Decimal("1500.50"), "IRR")).toEqual({
      amount: "1500.5",
      currency: "IRR",
    });
    // A number is converted immediately, never kept as a float.
    expect(createPaymentAmount(1500, "IRR")).toEqual({ amount: "1500", currency: "IRR" });
  });

  it("normalizes currency aliases onto the application's own vocabulary", () => {
    expect(createPaymentAmount("1000", "toman").currency).toBe("IRT");
    expect(createPaymentAmount("1000", "TMN").currency).toBe("IRT");
    expect(createPaymentAmount("1000", "rial").currency).toBe("IRR");
    // Unknown values fall back to ریال rather than inventing a unit.
    expect(createPaymentAmount("1000", "USD").currency).toBe("IRR");
    expect(createPaymentAmount("1000").currency).toBe("IRR");
  });

  it("rejects zero, negative and non-finite amounts", () => {
    expect(() => createPaymentAmount("0", "IRR")).toThrow(PaymentValidationError);
    expect(() => createPaymentAmount("-500", "IRR")).toThrow(PaymentValidationError);
    expect(() => createPaymentAmount(Number.NaN, "IRR")).toThrow(PaymentValidationError);
    expect(() => createPaymentAmount(Number.POSITIVE_INFINITY, "IRR")).toThrow(
      PaymentValidationError,
    );
    expect(() => createPaymentAmount("not-a-number", "IRR")).toThrow(/not a number/);
  });

  it("rejects more than 2 decimal places", () => {
    expect(() => createPaymentAmount("1500.001", "IRR")).toThrow(/2 decimal places/);
    expect(() => createPaymentAmount("1500.555", "IRT")).toThrow(PaymentValidationError);
    expect(() => createPaymentAmount("1500.55", "IRT")).not.toThrow();
  });

  it("rejects amounts the schema cannot store", () => {
    const justUnder = MAX_PAYMENT_AMOUNT.toString();
    expect(() => createPaymentAmount(justUnder, "IRR")).not.toThrow();
    expect(() => createPaymentAmount("1000000000000", "IRR")).toThrow(/maximum/);
  });

  it("is strict about integer gateway units unless a rounding policy is given", () => {
    const fractional = createPaymentAmount("1500.50", "IRR");
    expect(() => toProviderUnits(fractional)).toThrow(/fractional part/);
    expect(toProviderUnits(fractional, { rounding: "half-up" })).toBe("1501");
    expect(toProviderUnits(createPaymentAmount("1500.4", "IRR"), { rounding: "half-up" })).toBe(
      "1500",
    );
    // Integral values need no policy and never change.
    expect(toProviderUnits(createPaymentAmount("25000", "IRT"))).toBe("25000");
  });

  it("compares amounts unit-correctly across ریال and تومان", () => {
    const toman = createPaymentAmount("500", "IRT");
    const rial = createPaymentAmount("5000", "IRR");
    expect(rialValue(toman).toString()).toBe("5000");
    expect(paymentAmountEquals(toman, rial)).toBe(true);
    expect(comparePaymentAmounts(toman, createPaymentAmount("4999", "IRR"))).toBe(1);
    expect(comparePaymentAmounts(toman, createPaymentAmount("5001", "IRR"))).toBe(-1);
    // Sanity: the stored decimal round-trips without drift.
    expect(paymentAmountToDecimal(toman).toString()).toBe("500");
  });

  it("enforces the rial-quoted gateway minimum for both units", () => {
    // ZarinPal's minimum is 10000 ریال == 1000 تومان.
    expect(() => assertGatewayMinimum(createPaymentAmount("9999", "IRR"), 10000)).toThrow(
      /below the gateway minimum/,
    );
    expect(() => assertGatewayMinimum(createPaymentAmount("999", "IRT"), 10000)).toThrow(
      PaymentValidationError,
    );
    expect(() => assertGatewayMinimum(createPaymentAmount("1000", "IRT"), 10000)).not.toThrow();
    expect(() => assertGatewayMinimum(createPaymentAmount("10000", "IRR"), 10000)).not.toThrow();
    // DTO shape guard used at trust boundaries.
    expect(isPaymentAmount({ amount: "1000", currency: "IRR" })).toBe(true);
    expect(isPaymentAmount({ amount: 1000, currency: "IRR" })).toBe(false);
    expect(() => assertPaymentAmount({ amount: "-1", currency: "IRR" })).toThrow(
      PaymentValidationError,
    );
  });
});
