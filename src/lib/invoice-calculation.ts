/**
 * Authoritative server-side invoice calculation engine.
 *
 * NEVER trust totals sent from the client. This module is the single
 * source of truth for all money math in the application (section 13, 44, 59
 * of the Master Build Prompt). It is intentionally framework-agnostic and
 * pure so it can be unit tested in isolation and reused by the finalize
 * transaction, the live-preview API, PDF generation, and reports.
 */
import Decimal from "decimal.js";

// Round half-up to the nearest integer Rial (IRR has no subunits in practice).
// Centralizing rounding here means every caller applies the same rule.
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export interface InvoiceItemInput {
  unitPrice: Decimal.Value;
  quantity: Decimal.Value;
  discountPercent: Decimal.Value; // 0-100
}

export interface InvoiceItemResult {
  subtotal: Decimal;
  discountAmount: Decimal;
  total: Decimal;
}

export interface InvoiceCalculationInput {
  items: InvoiceItemInput[];
  globalDiscountPercent: Decimal.Value; // 0-100
  taxPercent: Decimal.Value; // 0-100 (VAT)
}

export interface InvoiceCalculationResult {
  items: InvoiceItemResult[];
  subtotal: Decimal; // sum of line subtotals (before any discount)
  itemDiscountAmount: Decimal; // sum of line-level discounts
  subtotalAfterLineDiscounts: Decimal;
  globalDiscountPercent: Decimal;
  globalDiscountAmount: Decimal;
  taxableAmount: Decimal;
  taxPercent: Decimal;
  taxAmount: Decimal;
  total: Decimal;
}

export class InvoiceCalculationError extends Error {}

function assertNonNegative(value: Decimal, field: string) {
  if (value.isNegative()) {
    throw new InvoiceCalculationError(`${field} must not be negative`);
  }
}

function assertPercent(value: Decimal, field: string) {
  assertNonNegative(value, field);
  if (value.greaterThan(100)) {
    throw new InvoiceCalculationError(`${field} must not exceed 100`);
  }
}

/**
 * Calculates a single invoice line: subtotal, discount, total.
 * Order (per spec section 13):
 *   subtotal = unitPrice * quantity
 *   lineDiscount = subtotal * discountPercent / 100
 *   lineTotal = subtotal - lineDiscount
 */
export function calculateLineItem(input: InvoiceItemInput): InvoiceItemResult {
  const unitPrice = new Decimal(input.unitPrice);
  const quantity = new Decimal(input.quantity);
  const discountPercent = new Decimal(input.discountPercent);

  assertNonNegative(unitPrice, "unitPrice");
  if (quantity.lessThanOrEqualTo(0)) {
    throw new InvoiceCalculationError("quantity must be greater than zero");
  }
  assertPercent(discountPercent, "discountPercent");

  const subtotal = unitPrice.times(quantity);
  const discountAmount = subtotal.times(discountPercent).dividedBy(100);
  const total = subtotal.minus(discountAmount);

  return {
    subtotal: subtotal.toDecimalPlaces(2),
    discountAmount: discountAmount.toDecimalPlaces(2),
    total: total.toDecimalPlaces(2),
  };
}

/**
 * Calculates the full invoice: all lines, global discount, VAT, final total.
 * This is the ONLY function that should ever produce an Invoice's stored
 * monetary fields. It must be called server-side, using data reloaded from
 * the database (not values trusted from the request body) for anything
 * that affects entitlement (e.g. product prices), per section 12 step 8-11.
 */
export function calculateInvoice(input: InvoiceCalculationInput): InvoiceCalculationResult {
  if (input.items.length === 0) {
    throw new InvoiceCalculationError("invoice must have at least one item");
  }

  const globalDiscountPercent = new Decimal(input.globalDiscountPercent);
  const taxPercent = new Decimal(input.taxPercent);
  assertPercent(globalDiscountPercent, "globalDiscountPercent");
  assertNonNegative(taxPercent, "taxPercent");

  const items = input.items.map(calculateLineItem);

  const subtotal = items.reduce((acc, i) => acc.plus(i.subtotal), new Decimal(0));
  const itemDiscountAmount = items.reduce((acc, i) => acc.plus(i.discountAmount), new Decimal(0));
  const subtotalAfterLineDiscounts = items.reduce((acc, i) => acc.plus(i.total), new Decimal(0));

  const globalDiscountAmount = subtotalAfterLineDiscounts
    .times(globalDiscountPercent)
    .dividedBy(100)
    .toDecimalPlaces(2);

  const taxableAmount = subtotalAfterLineDiscounts.minus(globalDiscountAmount).toDecimalPlaces(2);

  const taxAmount = taxableAmount.times(taxPercent).dividedBy(100).toDecimalPlaces(2);

  const total = taxableAmount.plus(taxAmount).toDecimalPlaces(2);

  return {
    items,
    subtotal: subtotal.toDecimalPlaces(2),
    itemDiscountAmount: itemDiscountAmount.toDecimalPlaces(2),
    subtotalAfterLineDiscounts: subtotalAfterLineDiscounts.toDecimalPlaces(2),
    globalDiscountPercent,
    globalDiscountAmount,
    taxableAmount,
    taxPercent,
    taxAmount,
    total,
  };
}

// ---------------------------------------------------------------------------
// Payment status derivation (section 17)
// ---------------------------------------------------------------------------

export type DerivedInvoiceStatus =
  | "PENDING_PAYMENT"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE";

export function derivePaymentStatus(params: {
  total: Decimal.Value;
  paidAmount: Decimal.Value;
  dueDate: Date | null;
  now?: Date;
}): DerivedInvoiceStatus {
  const total = new Decimal(params.total);
  const paidAmount = new Decimal(params.paidAmount);
  const now = params.now ?? new Date();

  if (paidAmount.lessThan(0)) {
    throw new InvoiceCalculationError("paidAmount must not be negative");
  }

  const remaining = total.minus(paidAmount);

  let status: DerivedInvoiceStatus;
  if (paidAmount.greaterThanOrEqualTo(total)) {
    status = "PAID";
  } else if (paidAmount.greaterThan(0)) {
    status = "PARTIALLY_PAID";
  } else {
    status = "PENDING_PAYMENT";
  }

  if (status !== "PAID" && remaining.greaterThan(0) && params.dueDate && params.dueDate.getTime() < now.getTime()) {
    status = "OVERDUE";
  }

  return status;
}

export function calculateRemainingAmount(total: Decimal.Value, paidAmount: Decimal.Value): Decimal {
  return new Decimal(total).minus(new Decimal(paidAmount)).toDecimalPlaces(2);
}
