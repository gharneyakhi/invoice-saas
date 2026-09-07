import crypto from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import { ValidationError } from "@/server/errors";

/**
 * Zod contracts for the Invoice domain layer (Phase 4 — Draft & Finalized Invoices).
 *
 * All schemas are `.strict()`. Any client-supplied unrecognized or server-owned
 * fields (e.g. `accountId`, `status`, `invoiceNumber`, `subtotal`, `total`,
 * `paidAmount`, `remainingAmount`, `finalizedAt`) are rejected with a
 * `ValidationError` rather than silently ignored.
 *
 * Money and decimal fields are validated using Decimal-safe checks to ensure
 * no JavaScript floating-point errors occur.
 */

export const DRAFT_INVOICE_PREFIX = "DRAFT-";

export function generateDraftInvoiceNumber(): string {
  return `${DRAFT_INVOICE_PREFIX}${crypto.randomUUID()}`;
}

export function isDraftInvoiceNumber(invoiceNumber: string): boolean {
  return typeof invoiceNumber === "string" && invoiceNumber.startsWith(DRAFT_INVOICE_PREFIX);
}

export function formatOfficialInvoiceNumber(
  prefix: string | null | undefined,
  sequenceNumber: number,
): string {
  return `${prefix ?? ""}${sequenceNumber}`;
}

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

const nonNegativeDecimal = (fieldName: string) =>
  z.custom<Decimal.Value>(
    (val) => {
      if (!isValidDecimal(val)) return false;
      return toDecimal(val).greaterThanOrEqualTo(0);
    },
    { message: `${fieldName} must be a non-negative number` },
  );

const positiveDecimal = (fieldName: string) =>
  z.custom<Decimal.Value>(
    (val) => {
      if (!isValidDecimal(val)) return false;
      return toDecimal(val).greaterThan(0);
    },
    { message: `${fieldName} must be greater than zero` },
  );

const percentageDecimal = (fieldName: string) =>
  z.custom<Decimal.Value>(
    (val) => {
      if (!isValidDecimal(val)) return false;
      const d = toDecimal(val);
      return d.greaterThanOrEqualTo(0) && d.lessThanOrEqualTo(100);
    },
    { message: `${fieldName} must be between 0 and 100` },
  );

const dateInputSchema = z.union([
  z.date(),
  z.string().refine(
    (str) => {
      const parsed = Date.parse(str);
      return !isNaN(parsed);
    },
    { message: "Invalid date format" },
  ),
]);

export const draftInvoiceItemSchema = z
  .object({
    productId: z.string().trim().min(1, "Product ID cannot be empty").nullable().optional(),
    title: z
      .string({
        required_error: "Item title is required",
        invalid_type_error: "Item title must be a string",
      })
      .trim()
      .min(1, "Item title is required")
      .max(300, "Item title must be at most 300 characters"),
    description: z
      .string()
      .trim()
      .max(1000, "Description must be at most 1000 characters")
      .nullable()
      .optional(),
    itemDate: dateInputSchema.nullable().optional(),
    unitPrice: nonNegativeDecimal("unitPrice"),
    quantity: positiveDecimal("quantity"),
    unit: z.string().trim().max(50, "Unit must be at most 50 characters").nullable().optional(),
    discountPercent: percentageDecimal("discountPercent").optional().default(0),
    sortOrder: z
      .number({ invalid_type_error: "sortOrder must be a number" })
      .int("sortOrder must be an integer")
      .min(0, "sortOrder must be non-negative")
      .optional(),
  })
  .strict();

export type DraftInvoiceItemInput = z.infer<typeof draftInvoiceItemSchema>;

export const createDraftInvoiceSchema = z
  .object({
    businessId: z
      .string({
        required_error: "businessId is required",
        invalid_type_error: "businessId must be a string",
      })
      .trim()
      .min(1, "businessId is required"),
    customerId: z.string().trim().min(1, "Customer ID cannot be empty").nullable().optional(),
    invoiceType: z
      .enum(["PROFORMA", "FINAL"], {
        invalid_type_error: "invoiceType must be either PROFORMA or FINAL",
      })
      .optional()
      .default("FINAL"),
    issueDate: dateInputSchema.optional(),
    dueDate: dateInputSchema.nullable().optional(),
    globalDiscountPercent: percentageDecimal("globalDiscountPercent").optional().default(0),
    taxPercent: percentageDecimal("taxPercent").optional(),
    notes: z.string().trim().max(2000, "Notes must be at most 2000 characters").nullable().optional(),
    items: z
      .array(draftInvoiceItemSchema, {
        required_error: "items is required",
        invalid_type_error: "items must be an array",
      })
      .min(1, "Invoice must have at least one item"),
  })
  .strict();

export type CreateDraftInvoiceInput = z.infer<typeof createDraftInvoiceSchema>;

/**
 * Contract for editing an existing DRAFT invoice. Identical editable surface
 * to `createDraftInvoiceSchema` (still `.strict()`, so server-owned fields
 * such as `status`, `invoiceNumber`, `subtotal`, `total`, `paidAmount`,
 * `remainingAmount` or `finalizedAt` are rejected), plus the invoice the edit
 * targets. The lifecycle rule ("only DRAFT rows may be edited") is enforced
 * by `invoiceService.updateDraftInvoice`, not here.
 */
export const updateDraftInvoiceSchema = createDraftInvoiceSchema.extend({
  invoiceId: z
    .string({
      required_error: "invoiceId is required",
      invalid_type_error: "invoiceId must be a string",
    })
    .trim()
    .min(1, "invoiceId is required"),
});

export type UpdateDraftInvoiceInput = z.infer<typeof updateDraftInvoiceSchema>;

/** `"title: Item title is required; items.0.quantity: quantity must be greater than zero"` — field-scoped formatting. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

export function parseCreateDraftInvoiceInput(input: unknown): CreateDraftInvoiceInput {
  const result = createDraftInvoiceSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid draft invoice input — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}

export function parseUpdateDraftInvoiceInput(input: unknown): UpdateDraftInvoiceInput {
  const result = updateDraftInvoiceSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid draft invoice update input — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}
