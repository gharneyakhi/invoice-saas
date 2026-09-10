import Decimal from "decimal.js";
import {
  INVOICE_CURRENCIES,
  normalizeInvoiceCurrency,
  type InvoiceCurrency,
} from "@/lib/currency";
import { PaymentValidationError } from "./paymentErrors";

/**
 * Decimal-safe money for the payment-provider boundary.
 *
 * Invariants this module is the single owner of:
 *
 *   1. **No floating point.** Every monetary value crosses this boundary as a
 *      `decimal.js` value or a canonical decimal *string*. A JavaScript
 *      `number` is accepted as input only to be converted immediately, and is
 *      rejected when it is not finite. Nothing here ever adds, multiplies or
 *      compares money with `+`, `*` or `<`.
 *   2. **Canonical string form.** `PaymentAmount.amount` is always
 *      `Decimal#toString()` of a validated value, so `"1500"`, `"1500.0"` and
 *      `"1500.00"` all canonicalize to `"1500"`. Two amounts are equal exactly
 *      when their canonical strings and currencies match, which makes
 *      idempotency keys and "did the gateway charge what we asked?" checks
 *      exact rather than epsilon-based.
 *   3. **Currency is the application's own vocabulary.** ریال (`IRR`) and
 *      تومان (`IRT`) only, reusing `@/lib/currency` so the gateway layer can
 *      never invent a third unit or disagree with what an invoice displays.
 *   4. **Rounding is explicit.** Both currencies are integral for payment
 *      purposes, but invoice totals are stored with 2 decimal places
 *      (`Decimal(14, 2)`). Converting to the integer units a gateway wants
 *      therefore needs a rounding decision, and this module refuses to make
 *      one silently: `toProviderUnits()` throws unless the caller passes an
 *      explicit `rounding` policy.
 *   5. **Cross-currency comparisons are unit-correct.** Comparison and
 *      gateway-minimum checks go through `rialValue()`, so `500 IRT` (تومان)
 *      is compared as `5000 IRR` and never as `500`.
 */

export type PaymentCurrency = InvoiceCurrency;

/** The two supported units, re-exported so callers need one import. */
export const PAYMENT_CURRENCIES: readonly PaymentCurrency[] = INVOICE_CURRENCIES;

/**
 * Minor-unit exponent per currency. Both ریال and تومان are integral for
 * payment purposes, so neither scales — the table exists so a future
 * fractional currency is a data change, not a rewrite of every adapter.
 */
export const PAYMENT_CURRENCY_EXPONENTS: Record<PaymentCurrency, number> = {
  IRR: 0,
  IRT: 0,
};

/** ریال per تومان, used by every cross-currency comparison. */
export const RIAL_PER_TOMAN = 10;

/**
 * Upper bound, matching the `Decimal(14, 2)` invoice money columns: at most
 * 12 integer digits and 2 decimals. A larger value cannot be represented by
 * the schema, so accepting it here would only fail later at the database.
 */
export const MAX_PAYMENT_AMOUNT = new Decimal("999999999999.99");

/** Invoice money columns keep at most 2 decimal places. */
export const MAX_PAYMENT_DECIMAL_PLACES = 2;

/** Explicit rounding policy for the integer-unit conversion. */
export type PaymentRoundingPolicy = "strict" | "half-up";

/**
 * A normalized, provider-agnostic monetary value.
 *
 * `amount` is a canonical decimal string (see invariant 2) — never a float
 * and never provider-formatted. DTOs crossing the Server Action boundary stay
 * JSON-serializable exactly because the amount is a string.
 */
export interface PaymentAmount {
  amount: string;
  currency: PaymentCurrency;
}

function describeAmount(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value instanceof Decimal) return value.toString();
  return typeof value === "object" && value !== null ? "object" : String(value);
}

function invalidAmount(value: unknown, reason: string): PaymentValidationError {
  return new PaymentValidationError(`Invalid payment amount (${reason}): ${describeAmount(value)}`);
}

/** True when `value` is a structurally valid `PaymentAmount` DTO. */
export function isPaymentAmount(value: unknown): value is PaymentAmount {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { amount?: unknown; currency?: unknown };
  return typeof candidate.amount === "string" && typeof candidate.currency === "string";
}

/**
 * Builds a validated, canonical `PaymentAmount`.
 *
 * Accepts `Decimal`, a decimal string, or a finite number (converted
 * immediately — see invariant 1) and rejects: non-finite values, zero and
 * negative amounts, more than 2 decimal places, and values above
 * `MAX_PAYMENT_AMOUNT`. The currency is normalized through
 * `normalizeInvoiceCurrency`, so `"toman"` and `"IRT"` both become `IRT`.
 *
 * @throws PaymentValidationError
 */
export function createPaymentAmount(
  amount: Decimal.Value,
  currency?: string | null,
): PaymentAmount {
  let value: Decimal;
  try {
    value = new Decimal(amount);
  } catch {
    throw invalidAmount(amount, "not a number");
  }

  if (!value.isFinite()) throw invalidAmount(amount, "not finite");
  if (value.lte(0)) throw invalidAmount(amount, "must be greater than zero");

  const decimals = value.decimalPlaces();
  if (decimals > MAX_PAYMENT_DECIMAL_PLACES) {
    throw invalidAmount(amount, `more than ${MAX_PAYMENT_DECIMAL_PLACES} decimal places`);
  }
  if (value.gt(MAX_PAYMENT_AMOUNT)) {
    throw invalidAmount(amount, `exceeds the maximum of ${MAX_PAYMENT_AMOUNT.toString()}`);
  }

  return { amount: value.toString(), currency: normalizeInvoiceCurrency(currency) };
}

/**
 * Re-validates an `PaymentAmount` that arrived from outside the module
 * (a request payload, a stored row, another service) and returns it in
 * canonical form. Cheap, and it means adapters never have to trust a DTO.
 *
 * @throws PaymentValidationError
 */
export function assertPaymentAmount(value: unknown): PaymentAmount {
  if (!isPaymentAmount(value)) {
    throw new PaymentValidationError("Payment amount must be an { amount, currency } object");
  }
  return createPaymentAmount(value.amount, value.currency);
}

/** The value as a `Decimal` for arithmetic. Never mutate the result in place. */
export function paymentAmountToDecimal(value: PaymentAmount): Decimal {
  return new Decimal(value.amount);
}

/**
 * Converts to the integer minor units a gateway expects, as a decimal string.
 *
 * Both supported currencies have exponent 0, so this is an integrality check
 * rather than a multiplication for them. When the value is not integral the
 * caller must choose a policy:
 *
 *   - `"strict"` (default) → throws. This is the safe default: silently
 *     rounding a charge is how an invoice ends up marked paid for less than
 *     its total.
 *   - `"half-up"` → rounds half away from zero, for callers that have already
 *     decided rounding is correct (e.g. a documented "gateway amount" rule).
 *
 * @throws PaymentValidationError
 */
export function toProviderUnits(
  value: PaymentAmount,
  options?: { rounding?: PaymentRoundingPolicy },
): string {
  const exponent = PAYMENT_CURRENCY_EXPONENTS[value.currency] ?? 0;
  const scaled = paymentAmountToDecimal(value).mul(new Decimal(10).pow(exponent));

  if (scaled.isInteger()) return scaled.toFixed(0);

  const rounding = options?.rounding ?? "strict";
  if (rounding === "strict") {
    throw new PaymentValidationError(
      `Payment amount ${value.amount} ${value.currency} has a fractional part and cannot be charged as an integer gateway amount; pass an explicit rounding policy`,
    );
  }
  return scaled.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

/**
 * The value expressed in ریال, the unit gateway minimums are quoted in.
 * تومان amounts are multiplied by `RIAL_PER_TOMAN`.
 */
export function rialValue(value: PaymentAmount): Decimal {
  return paymentAmountToDecimal(value).mul(value.currency === "IRT" ? RIAL_PER_TOMAN : 1);
}

/**
 * Unit-correct comparison: `-1` / `0` / `1` like `Decimal#cmp`, but across
 * currencies by comparing ریال values.
 */
export function comparePaymentAmounts(a: PaymentAmount, b: PaymentAmount): number {
  return rialValue(a).cmp(rialValue(b));
}

/** Equal money (same ریال value), regardless of which unit expresses it. */
export function paymentAmountEquals(a: PaymentAmount, b: PaymentAmount): boolean {
  return comparePaymentAmounts(a, b) === 0;
}

/**
 * Enforces a gateway minimum, quoted in ریال (ZarinPal documents its minimum
 * as 10000 ریال regardless of the `currency` field sent).
 *
 * @throws PaymentValidationError
 */
export function assertGatewayMinimum(value: PaymentAmount, minimumInRial: Decimal.Value): void {
  const minimum = new Decimal(minimumInRial);
  if (rialValue(value).lt(minimum)) {
    throw new PaymentValidationError(
      `Payment amount ${value.amount} ${value.currency} is below the gateway minimum of ${minimum.toString()} IRR`,
    );
  }
}

/**
 * Renders an amount for logs and error messages. Deliberately NOT a
 * user-facing formatter — Persian display formatting belongs to
 * `@/lib/formatters` (`formatCurrency`), which owns numerals and unit labels.
 */
export function formatPaymentAmountForLog(value: PaymentAmount): string {
  return `${value.amount} ${value.currency}`;
}
