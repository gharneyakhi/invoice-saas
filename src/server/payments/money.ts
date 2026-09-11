import Decimal from "decimal.js";
import { InvalidPaymentAmountError, UnsupportedCurrencyError } from "./paymentErrors";

/**
 * Decimal-safe money helpers for the gateway layer.
 *
 * All monetary arithmetic uses decimal.js — never JavaScript floating point —
 * the same rule as the invoice domain (`src/server/payment/schema.ts`,
 * `src/server/invoice/schema.ts`). This module is THE single place that turns
 * a database `Decimal` price into the integer amount a gateway expects, so
 * the subscription checkout and any future invoice-payment checkout can never
 * drift apart in how they compute gateway amounts.
 *
 * Currency model:
 *   - The SaaS plans are priced in IRR (Iranian Rial, `plans.currency`
 *     default and `prisma/seed.ts`), which has NO minor unit: gateways take
 *     whole Rials. A fractional IRR amount is therefore rejected outright
 *     instead of being rounded (rounding money silently is never acceptable).
 *   - `CURRENCY_DECIMAL_PLACES` records, per currency, how many decimal
 *     places its `Decimal(14, 2)` database column may legitimately carry.
 *     A currency missing from the map is unsupported → `UnsupportedCurrencyError`.
 */

/** Currencies this build's gateways accept. Keep in sync with `prisma/seed.ts`. */
export const SUPPORTED_PAYMENT_CURRENCIES = ["IRR"] as const;

export type SupportedPaymentCurrency = (typeof SUPPORTED_PAYMENT_CURRENCIES)[number];

/**
 * Decimal places each currency's amount may carry in the database. IRR has no
 * minor unit, so its stored price must be an integer.
 */
export const CURRENCY_DECIMAL_PLACES: Record<SupportedPaymentCurrency, number> = {
  IRR: 0,
};

/**
 * Largest value storable in the `Decimal(14, 2)` money columns
 * (12 integer digits + 2 decimals), the same cap
 * `src/server/payment/schema.ts` enforces for invoice payments. One shared
 * ceiling keeps every money column in the system mutually consistent.
 */
export const MAX_PAYMENT_AMOUNT = new Decimal("999999999999.99");

function isValidDecimal(value: unknown): value is Decimal.Value {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  if (typeof value === "boolean") return false;
  if (typeof value === "symbol") return false;
  if (typeof value === "object" && !(value instanceof Decimal)) return false;
  try {
    const d = new Decimal(value as Decimal.Value);
    return !d.isNaN() && d.isFinite();
  } catch {
    return false;
  }
}

/**
 * Validates a database price for gateway use and returns the amount in the
 * currency's gateway unit (for IRR: whole Rials, as a JS `number`).
 *
 * Every rule has its own failure so the server log says exactly why a price
 * was refused:
 *   - not a finite decimal            → `InvalidPaymentAmountError`
 *   - not strictly positive           → `InvalidPaymentAmountError`
 *   - more decimals than the currency allows (fractional IRR) → `InvalidPaymentAmountError`
 *   - beyond `MAX_PAYMENT_AMOUNT`     → `InvalidPaymentAmountError`
 *   - currency not supported          → `UnsupportedCurrencyError`
 *
 * The returned number is guaranteed to be a safe integer, so JSON
 * serialisation to the gateway can never distort it.
 *
 * @throws InvalidPaymentAmountError / UnsupportedCurrencyError
 */
export function createPaymentAmount(amount: unknown, currency: string): number {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!(SUPPORTED_PAYMENT_CURRENCIES as readonly string[]).includes(normalizedCurrency)) {
    throw new UnsupportedCurrencyError();
  }

  if (!isValidDecimal(amount)) {
    throw new InvalidPaymentAmountError("amount must be a finite decimal number");
  }

  const decimal = new Decimal(amount as Decimal.Value);
  if (!decimal.greaterThan(0)) {
    throw new InvalidPaymentAmountError("amount must be greater than zero");
  }

  const allowedDecimalPlaces = CURRENCY_DECIMAL_PLACES[normalizedCurrency as SupportedPaymentCurrency];
  if (decimal.decimalPlaces() > allowedDecimalPlaces) {
    throw new InvalidPaymentAmountError(
      `amount must not have more than ${allowedDecimalPlaces} decimal places for ${normalizedCurrency}`,
    );
  }

  if (decimal.greaterThan(MAX_PAYMENT_AMOUNT)) {
    throw new InvalidPaymentAmountError(`amount must not exceed ${MAX_PAYMENT_AMOUNT.toFixed(2)}`);
  }

  const gatewayAmount = decimal.toNumber();
  if (!Number.isSafeInteger(gatewayAmount)) {
    // Unreachable given the caps above, but guards a future currency whose
    // gateway unit could exceed Number.MAX_SAFE_INTEGER.
    throw new InvalidPaymentAmountError("amount exceeds the safe integer range");
  }

  return gatewayAmount;
}
