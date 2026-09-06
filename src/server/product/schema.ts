import Decimal from "decimal.js";
import { z } from "zod";
import { ValidationError } from "@/server/errors";

/**
 * Zod contracts for the Product domain layer.
 *
 * Every schema is `.strict()`, matching `src/server/business/schema.ts` and
 * `src/server/invoice/schema.ts`: an unrecognized key is *rejected* rather
 * than silently dropped. That is what keeps the server-owned columns of
 * `model Product` — `id`, `businessId`, `createdAt`, `updatedAt`,
 * `archivedAt` — out of reach of a client payload, along with `accountId`,
 * which is not a Product column at all and must never appear.
 *
 * `price` is validated with the same Decimal-safe approach used for money in
 * `src/server/invoice/schema.ts`: the value is checked through `decimal.js`,
 * never through JavaScript float comparisons, so `"0.1"`, `0.1` and
 * `new Decimal("0.1")` all behave identically and no rounding artefact can
 * sneak a negative price past the guard.
 */

const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 1000;
const UNIT_MAX_LENGTH = 50;

/**
 * Local copy of the Decimal-safe predicate used by the invoice schema.
 * Duplicated rather than exported from `@/server/invoice/schema` so this
 * module adds no coupling to — and cannot perturb — the finalized invoice
 * pipeline.
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

const nonNegativeDecimal = (fieldName: string) =>
  z.custom<Decimal.Value>(
    (val) => {
      if (!isValidDecimal(val)) return false;
      return toDecimal(val).greaterThanOrEqualTo(0);
    },
    { message: `${fieldName} must be a non-negative number` },
  );

/**
 * A trimmed, length-capped optional column. An explicit `null` clears the
 * value and a string that is empty after trimming is normalized to `null`.
 */
const nullableText = (fieldName: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${fieldName} must be a string` })
    .trim()
    .max(maxLength, `${fieldName} must be at most ${maxLength} characters`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

const productName = z
  .string({
    required_error: "Product name is required",
    invalid_type_error: "Product name must be a string",
  })
  .trim()
  .min(1, "Product name is required")
  .max(NAME_MAX_LENGTH, `Product name must be at most ${NAME_MAX_LENGTH} characters`);

/**
 * `active` is a genuine domain column on `model Product` (a product can be
 * withdrawn from the catalogue without being archived), so it is client
 * writable. `archivedAt` — the soft-delete stamp — is not.
 */
const productActive = z.boolean({ invalid_type_error: "active must be a boolean" }).optional();

export const createProductSchema = z
  .object({
    name: productName,
    description: nullableText("description", DESCRIPTION_MAX_LENGTH),
    price: nonNegativeDecimal("price"),
    unit: nullableText("unit", UNIT_MAX_LENGTH),
    active: productActive,
  })
  .strict();

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name: productName.optional(),
    description: nullableText("description", DESCRIPTION_MAX_LENGTH),
    price: nonNegativeDecimal("price").optional(),
    unit: nullableText("unit", UNIT_MAX_LENGTH),
    active: productActive,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one product field must be provided",
  });

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/** `"price: price must be a non-negative number"` — one line, field-scoped. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

export function parseCreateProductInput(input: unknown): CreateProductInput {
  const result = createProductSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid product input — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}

export function parseUpdateProductInput(input: unknown): UpdateProductInput {
  const result = updateProductSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid product update — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}
