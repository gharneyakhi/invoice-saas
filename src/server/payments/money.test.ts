import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  createPaymentAmount,
  MAX_PAYMENT_AMOUNT,
  SUPPORTED_PAYMENT_CURRENCIES,
} from "./money";
import { InvalidPaymentAmountError, UnsupportedCurrencyError } from "./paymentErrors";

/**
 * Unit tests for the gateway-layer money helpers. `createPaymentAmount()` is
 * the single validator every provider (and every checkout flow) must pass
 * amounts through, so these tests pin the whole contract: integer IRR only,
 * strictly positive, within `Decimal(14, 2)`, no unsafe coercions.
 */
describe("payments/money — createPaymentAmount", () => {
  describe("valid amounts", () => {
    it("accepts a whole IRR amount as a number", () => {
      expect(createPaymentAmount(990000, "IRR")).toBe(990000);
    });

    it("accepts a whole IRR amount as a string", () => {
      expect(createPaymentAmount("990000", "IRR")).toBe(990000);
    });

    it("accepts a Decimal price (the shape stored in plans.price)", () => {
      expect(createPaymentAmount(new Decimal("1490000"), "IRR")).toBe(1490000);
    });

    it("accepts the minimum positive amount", () => {
      expect(createPaymentAmount(1, "IRR")).toBe(1);
    });

    it("accepts the largest storable integer amount", () => {
      expect(createPaymentAmount("999999999999", "IRR")).toBe(999999999999);
    });

    it("is case-insensitive about the currency code", () => {
      expect(createPaymentAmount(1000, "irr")).toBe(1000);
    });
  });

  describe("invalid amounts", () => {
    it.each([
      ["zero", 0],
      ["negative", -1000],
      ["fractional IRR (number)", 1000.5],
      ["fractional IRR (string)", "1000.5"],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["empty string", ""],
      ["non-numeric text", "abc"],
      ["boolean", true],
      ["null", null],
      ["undefined", undefined],
      ["plain object", {}],
    ])("rejects %s with InvalidPaymentAmountError", (_label, value) => {
      expect(() => createPaymentAmount(value, "IRR")).toThrow(InvalidPaymentAmountError);
    });

    it("rejects an amount beyond the Decimal(14, 2) ceiling", () => {
      expect(() => createPaymentAmount(MAX_PAYMENT_AMOUNT.plus("0.01"), "IRR")).toThrow(
        InvalidPaymentAmountError,
      );
    });
  });

  describe("currencies", () => {
    it("rejects unsupported currencies", () => {
      expect(() => createPaymentAmount(1000, "USD")).toThrow(UnsupportedCurrencyError);
      expect(() => createPaymentAmount(1000, "EUR")).toThrow(UnsupportedCurrencyError);
    });

    it("rejects an empty currency", () => {
      expect(() => createPaymentAmount(1000, "")).toThrow(UnsupportedCurrencyError);
    });

    it("exposes IRR as the only supported currency (plans are priced in IRR)", () => {
      expect(SUPPORTED_PAYMENT_CURRENCIES).toEqual(["IRR"]);
    });
  });
});
