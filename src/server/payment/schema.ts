import Decimal from "decimal.js";
import { z } from "zod";
import { ValidationError } from "@/server/errors";

/**
 * Zod contracts for the InvoicePayment domain layer.
 *
 * Every schema is `.strict()`, matching `src/server/business/schema.ts`,
 * `src/server/customer/schema.ts` and `src/server/invoice/schema.ts`: an
 * unrecognized key is *rejected* rather than silently dropped. That is what
 * keeps the server-owned columns of `model InvoicePayment` — `id`,
 * `invoiceId`, `createdAt` — out of reach of a client payload, along with
 * `accountId` / `businessId`, which are not InvoicePayment columns at all and
 * must never appear. A payload can therefore never re-parent a payment to
 * another invoice ("invoiceId re-parenting") or inject derived state such as
 * `status`, `paidAmount` or `remainingAmount`.
 *
 * Money (`amount`) is validated through decimal.js — never JavaScript
 * floating-point arithmetic:
 *   - strictly greater than zero,
 *   - at most 2 decimal places (the column is `Decimal(14, 2)`),
 *   - within the `Decimal(14, 2)` range (at most 12 integer digits, i.e.
 *     |amount| ≤ 999999999999.99),
 *   - with no unsafe coercion: booleans, objects, NaN/Infinity, empty strings
 *     and non-numeric text are all rejected before a Decimal is constructed.
 *
 * Parse failures are converted to `ValidationError` (src/server/errors.ts) so
 * callers deal with one domain error type instead of a leaking ZodError.
 */

const REFERENCE_NUMBER_MAX_LENGTH = 100;
const NOTES_MAX_LENGTH = 2000;

/**
 * Largest value storable in a `Decimal(14, 2)` column: 14 significant digits
 * with 2 of them after the point → 12 integer digits.
 */
export const MAX_PAYMENT_AMOUNT = new Decimal("999999999999.99");

/** The `PaymentMethod` enum values from `prisma/schema.prisma`, and nothing else. */
export const PAYMENT_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "ONLINE", "OTHER"] as const;

/**
 * Local copy of the Decimal-safe predicate used by the invoice and product
 * schemas (`src/server/invoice/schema.ts`, `src/server/product/schema.ts`).
 * It validates through decimal.js so `"1000000"`, `1000000` and
 * `new Decimal("1000000")` behave identically and no rounding artefact can
 * slip through. Non-numeric shapes are rejected instead of coerced.
 */
function isValidDecimal(value: unknown): value is Decimal.Value {
  if (value === null || value === undefined || value === "") {
    return false;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return false;
  }
  if (typeof value === "boolean") {
    return false;
  }
  if (typeof value === "symbol") {
    return false;
  }
  if (typeof value === "object" && !(value instanceof Decimal)) {
    return false;
  }
  try {
    const d = new Decimal(value as Decimal.Value);
    return !d.isNaN() && d.isFinite();
  } catch {
    return false;
  }
}

function toDecimal(value: unknown): Decimal {
  return new Decimal(value as Decimal.Value);
}

/**
 * A positive monetary amount that fits `Decimal(14, 2)` exactly.
 * Each rule has its own message so the caller learns *why* a value was
 * rejected instead of a single generic failure.
 */
const paymentAmount = z
  .custom<Decimal.Value>((val) => isValidDecimal(val), {
    message: "amount must be a finite decimal number",
  })
  .refine((val) => toDecimal(val).greaterThan(0), {
    message: "amount must be greater than zero",
  })
  .refine((val) => toDecimal(val).decimalPlaces() <= 2, {
    message: "amount must have at most 2 decimal places",
  })
  .refine((val) => toDecimal(val).lessThanOrEqualTo(MAX_PAYMENT_AMOUNT), {
    message: `amount must not exceed ${MAX_PAYMENT_AMOUNT.toFixed(2)}`,
  });

/**
 * A real calendar instant. Unlike a plain `z.date()`, an invalid `Date`
 * instance (`new Date("not-a-date")`) is rejected, and strings must parse via
 * `Date.parse`. Kept local to this module so the payment contract stays
 * explicit about rejecting invalid dates.
 */
const paymentDateInput = z.union([
  z.date().refine((value) => !Number.isNaN(value.getTime()), {
    message: "paymentDate must be a valid date",
  }),
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "paymentDate must be a valid date string",
  }),
]);

/**
 * A trimmed, length-capped optional column. An explicit `null` clears the
 * value and a string that is empty after trimming is normalized to `null`, so
 * `""` and "not set" cannot both end up in the database meaning the same
 * thing. (Same convention as `nullableText` in the customer schema.)
 */
const nullableText = (fieldName: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${fieldName} must be a string` })
    .trim()
    .max(maxLength, `${fieldName} must be at most ${maxLength} characters`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

/** The client-writable columns of `model InvoicePayment`, and nothing else. */
const paymentFields = {
  amount: paymentAmount,
  paymentDate: paymentDateInput.optional(),
  method: z.enum(PAYMENT_METHODS, {
    errorMap: () => ({
      message: `method must be one of: ${PAYMENT_METHODS.join(", ")}`,
    }),
  }),
  referenceNumber: nullableText("referenceNumber", REFERENCE_NUMBER_MAX_LENGTH),
  notes: nullableText("notes", NOTES_MAX_LENGTH),
};

export const createInvoicePaymentSchema = z.object(paymentFields).strict();

export type CreateInvoicePaymentInput = z.infer<typeof createInvoicePaymentSchema>;

export const updateInvoicePaymentSchema = z
  .object({
    amount: paymentAmount.optional(),
    paymentDate: paymentDateInput.optional(),
    method: z
      .enum(PAYMENT_METHODS, {
        errorMap: () => ({
          message: `method must be one of: ${PAYMENT_METHODS.join(", ")}`,
        }),
      })
      .optional(),
    referenceNumber: nullableText("referenceNumber", REFERENCE_NUMBER_MAX_LENGTH),
    notes: nullableText("notes", NOTES_MAX_LENGTH),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one payment field must be provided",
  });

export type UpdateInvoicePaymentInput = z.infer<typeof updateInvoicePaymentSchema>;

/** `"amount: amount must be greater than zero; method: ..." — field-scoped formatting. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

export function parseCreateInvoicePaymentInput(input: unknown): CreateInvoicePaymentInput {
  const result = createInvoicePaymentSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid payment input — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}

export function parseUpdateInvoicePaymentInput(input: unknown): UpdateInvoicePaymentInput {
  const result = updateInvoicePaymentSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid payment update — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}
