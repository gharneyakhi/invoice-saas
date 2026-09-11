import { z } from "zod";
import { ValidationError } from "@/server/errors";

/**
 * Zod contracts for the SaaS subscription checkout domain.
 *
 * Mirrors `src/server/payment/schema.ts` (the InvoicePayment domain): strict
 * objects, domain errors instead of leaked ZodError instances, and server-
 * owned columns structurally unreachable from a client payload.
 *
 * `.strict()` is what enforces "the client cannot influence the payment
 * beyond choosing a plan": `amount`, `currency`, `provider`, `callbackUrl`,
 * `redirectUrl`, `accountId` — anything besides `planKey` — is an unknown
 * field and therefore a hard rejection, not a silently ignored hint.
 *
 * `planKey` accepts the full `PlanKey` vocabulary from `prisma/schema.prisma`
 * (FREE/BASIC/PRO). FREE is rejected afterwards by the service with a
 * dedicated domain error — parsing and payability are separate concerns:
 * the schema validates *shape*, the service validates *business rules*
 * against the database (unknown key, deactivated plan, zero-price plan).
 */

/** Mirror of the `PlanKey` enum in `prisma/schema.prisma`, and nothing else. */
export const SUBSCRIPTION_PLAN_KEYS = ["FREE", "BASIC", "PRO"] as const;

export const createSubscriptionCheckoutSchema = z
  .object({
    planKey: z.enum(SUBSCRIPTION_PLAN_KEYS, {
      errorMap: () => ({
        message: `planKey must be one of: ${SUBSCRIPTION_PLAN_KEYS.join(", ")}`,
      }),
    }),
  })
  .strict();

export type CreateSubscriptionCheckoutInput = z.infer<typeof createSubscriptionCheckoutSchema>;

/** `"planKey: planKey must be one of: FREE, BASIC, PRO"` — field-scoped formatting. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

export function parseCreateSubscriptionCheckoutInput(input: unknown): CreateSubscriptionCheckoutInput {
  const result = createSubscriptionCheckoutSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid subscription checkout input — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}
