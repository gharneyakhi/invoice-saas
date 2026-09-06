import { z } from "zod";
import { ValidationError } from "@/server/errors";

/**
 * Zod contracts for the Customer domain layer.
 *
 * Every schema is `.strict()`, matching `src/server/business/schema.ts` and
 * `src/server/invoice/schema.ts`: an unrecognized key is *rejected* rather
 * than silently dropped. That is what keeps the server-owned columns of
 * `model Customer` — `id`, `businessId`, `createdAt`, `updatedAt`,
 * `archivedAt` — out of reach of a client payload, along with `accountId`,
 * which is not a Customer column at all and must never appear.
 *
 * Only the columns that actually exist on `model Customer` in
 * `prisma/schema.prisma` are accepted; no field is invented here.
 *
 * Parse failures are converted to `ValidationError` (src/server/errors.ts) so
 * callers deal with one domain error type instead of a leaking ZodError.
 */

const NAME_MAX_LENGTH = 200;
const SHORT_TEXT_MAX_LENGTH = 50;
const EMAIL_MAX_LENGTH = 320;
const ADDRESS_MAX_LENGTH = 500;
const NOTES_MAX_LENGTH = 2000;

/**
 * A trimmed, length-capped optional column. An explicit `null` clears the
 * value and a string that is empty after trimming is normalized to `null`,
 * so `""` and "not set" cannot both end up in the database meaning the same
 * thing.
 */
const nullableText = (fieldName: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${fieldName} must be a string` })
    .trim()
    .max(maxLength, `${fieldName} must be at most ${maxLength} characters`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

const nullableEmail = z
  .string({ invalid_type_error: "email must be a string" })
  .trim()
  .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`)
  .refine((value) => value === "" || z.string().email().safeParse(value).success, {
    message: "email must be a valid email address",
  })
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .optional();

const customerName = z
  .string({
    required_error: "Customer name is required",
    invalid_type_error: "Customer name must be a string",
  })
  .trim()
  .min(1, "Customer name is required")
  .max(NAME_MAX_LENGTH, `Customer name must be at most ${NAME_MAX_LENGTH} characters`);

/** The client-writable columns of `model Customer`, and nothing else. */
const customerFields = {
  mobile: nullableText("mobile", SHORT_TEXT_MAX_LENGTH),
  phone: nullableText("phone", SHORT_TEXT_MAX_LENGTH),
  email: nullableEmail,
  address: nullableText("address", ADDRESS_MAX_LENGTH),
  nationalId: nullableText("nationalId", SHORT_TEXT_MAX_LENGTH),
  economicCode: nullableText("economicCode", SHORT_TEXT_MAX_LENGTH),
  notes: nullableText("notes", NOTES_MAX_LENGTH),
};

export const createCustomerSchema = z
  .object({
    name: customerName,
    ...customerFields,
  })
  .strict();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: customerName.optional(),
    ...customerFields,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one customer field must be provided",
  });

export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

/** `"name: Customer name is required; email: email must be a valid email address"`. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

export function parseCreateCustomerInput(input: unknown): CreateCustomerInput {
  const result = createCustomerSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid customer input — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}

export function parseUpdateCustomerInput(input: unknown): UpdateCustomerInput {
  const result = updateCustomerSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid customer update — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}
