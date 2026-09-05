import { z } from "zod";
import { ValidationError } from "@/server/errors";

/**
 * Zod contracts for the Business domain layer (Phase 3).
 *
 * Every schema is `.strict()`, so an unrecognized key is *rejected* rather
 * than silently dropped. That is deliberate: `accountId`, `id`, `isPrimary`,
 * `isLocked` and `archivedAt` are server-owned fields. A client that smuggles
 * one of them into a create/update payload gets a `ValidationError` instead
 * of quietly re-parenting a Business to another Account, promoting itself to
 * primary, or un-archiving a row.
 *
 * Parsing failures are converted to `ValidationError` (src/server/errors.ts)
 * so callers deal with one domain error type instead of ZodError leaking out
 * of the server layer.
 */

const BUSINESS_NAME_MAX_LENGTH = 120;

const businessName = z
  .string({
    required_error: "Business name is required",
    invalid_type_error: "Business name must be a string",
  })
  .trim()
  .min(1, "Business name is required")
  .max(
    BUSINESS_NAME_MAX_LENGTH,
    `Business name must be at most ${BUSINESS_NAME_MAX_LENGTH} characters`,
  );

export const createBusinessSchema = z
  .object({
    name: businessName,
  })
  .strict();

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

export const updateBusinessSchema = z
  .object({
    name: businessName.optional(),
    isActive: z.boolean({ invalid_type_error: "isActive must be a boolean" }).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one business field must be provided",
  });

export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;

/** `"name: Business name is required; isActive: Expected boolean"` — one line, field-scoped. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

export function parseCreateBusinessInput(input: unknown): CreateBusinessInput {
  const result = createBusinessSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid business input — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}

export function parseUpdateBusinessInput(input: unknown): UpdateBusinessInput {
  const result = updateBusinessSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid business update — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}
