import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { normalizeLocalizedNumber } from "@/lib/formatters";

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
 * The profile contracts (Business Management phase) follow the same rule for
 * the `BusinessProfile` file columns: `logoFileId`, `sellerStampFileId` and
 * `sellerSignatureFileId` are *storage-owned* — they may only be written by
 * the upload service once a file reference genuinely exists, never by a
 * profile payload from the browser.
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

// ---------------------------------------------------------------------------
// BusinessProfile fields (only columns that exist on `model BusinessProfile`)
// ---------------------------------------------------------------------------

const SLOGAN_MAX_LENGTH = 200;
const OWNER_NAME_MAX_LENGTH = 120;
const ADDRESS_MAX_LENGTH = 500;
const EMAIL_MAX_LENGTH = 320;
const PHONE_MAX_LENGTH = 20;
const CARD_NUMBER_LENGTH = 16;
const ACCOUNT_NUMBER_MIN_LENGTH = 4;
const ACCOUNT_NUMBER_MAX_LENGTH = 24;
const IBAN_BODY_LENGTH = 24; // "IR" + 24 digits
const FOOTER_TEXT_MAX_LENGTH = 500;
const PRIMARY_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/**
 * A trimmed, length-capped optional column. An explicit `null` clears the
 * value and a string that is empty after trimming is normalized to `null`
 * (same convention as `src/server/customer/schema.ts`), so `""` and "not set"
 * cannot both end up in the database meaning the same thing.
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

/**
 * An optional digits-only column (mobile / landline / card / account number).
 * Persian and Arabic-Indic digits are normalized to ASCII via the shared
 * `normalizeLocalizedNumber` input utility before the pattern check, so a user
 * typing «۰۹۱۲…» is stored as the canonical `0912…`.
 */
const nullableDigits = (fieldName: string, pattern: RegExp, message: string) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      if (trimmed === "") return null;
      const normalized = normalizeLocalizedNumber(trimmed);
      return normalized === "" ? trimmed : normalized;
    },
    z
      .string({ invalid_type_error: `${fieldName} must be a string` })
      .regex(pattern, message)
      .nullable()
      .optional(),
  );

const nullableMobile = nullableDigits(
  "mobile",
  /^09\d{9}$/,
  "mobile must be a valid Iranian mobile number (09xxxxxxxxx)",
);

const nullableLandline = nullableDigits(
  "landline",
  /^0\d{9,10}$/,
  "landline must be a valid Iranian landline number including the area code",
);

const nullableCardNumber = nullableDigits(
  "cardNumber",
  new RegExp(`^\\d{${CARD_NUMBER_LENGTH}}$`),
  `cardNumber must be exactly ${CARD_NUMBER_LENGTH} digits`,
);

const nullableAccountNumber = nullableDigits(
  "accountNumber",
  new RegExp(`^\\d{${ACCOUNT_NUMBER_MIN_LENGTH},${ACCOUNT_NUMBER_MAX_LENGTH}}$`),
  `accountNumber must be ${ACCOUNT_NUMBER_MIN_LENGTH} to ${ACCOUNT_NUMBER_MAX_LENGTH} digits`,
);

/** Optional Iranian IBAN; accepts «IR…», «ir…» or the bare 24-digit body. */
const nullableIban = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const upper = trimmed.toUpperCase();
    const body = upper.startsWith("IR") ? upper.slice(2) : upper;
    const digits = normalizeLocalizedNumber(body);
    return digits === "" ? upper : `IR${digits}`;
  },
  z
    .string({ invalid_type_error: "iban must be a string" })
    .regex(
      new RegExp(`^IR\\d{${IBAN_BODY_LENGTH}}$`),
      "iban must be a valid Iranian IBAN (IR followed by 24 digits)",
    )
    .nullable()
    .optional(),
);

/** Optional `#rrggbb` hex string, normalized to lowercase. Empty → null. */
const nullableHexColor = (fieldName: string) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed.toLowerCase();
    },
    z
      .string({ invalid_type_error: `${fieldName} must be a string` })
      .regex(PRIMARY_COLOR_PATTERN, `${fieldName} must be a hex color like #2563eb`)
      .nullable()
      .optional(),
  );

/** Header (letterhead) background — not body text. */
const nullablePrimaryColor = nullableHexColor("primaryColor");

/** Footer strip background. */
const nullableFooterBackgroundColor = nullableHexColor("footerBackgroundColor");

/** The client-writable columns of `model BusinessProfile`, and nothing else. */
export const businessProfileFields = {
  slogan: nullableText("slogan", SLOGAN_MAX_LENGTH),
  ownerName: nullableText("ownerName", OWNER_NAME_MAX_LENGTH),
  address: nullableText("address", ADDRESS_MAX_LENGTH),
  email: nullableEmail,
  mobile: nullableMobile,
  landline: nullableLandline,
  cardNumber: nullableCardNumber,
  accountNumber: nullableAccountNumber,
  iban: nullableIban,
  primaryColor: nullablePrimaryColor,
  footerBackgroundColor: nullableFooterBackgroundColor,
  footerText: nullableText("footerText", FOOTER_TEXT_MAX_LENGTH),
} as const;

// ---------------------------------------------------------------------------
// InvoiceSettings fields (the editable subset of `model InvoiceSettings`)
// ---------------------------------------------------------------------------

const VAT_PERCENT_PATTERN = /^\d+(\.\d{1,2})?$/;
const INVOICE_PREFIX_PATTERN = /^[\w-]{1,20}$/;

/**
 * A percent stored as an exact decimal string (never a JS float), matching the
 * invoice schemas' stringly-typed convention. Persian digits are normalized
 * first.
 */
const vatPercentField = z.preprocess(
  (value) => {
    if (typeof value !== "string" && typeof value !== "number") return value;
    const normalized = normalizeLocalizedNumber(value);
    return normalized === "" ? String(value) : normalized;
  },
  z
    .string({
      invalid_type_error: "defaultVatPercent must be a number",
      required_error: "defaultVatPercent is required",
    })
    .regex(VAT_PERCENT_PATTERN, "defaultVatPercent must be a number between 0 and 100")
    .refine((value) => Number(value) >= 0 && Number(value) <= 100, {
      message: "defaultVatPercent must be a number between 0 and 100",
    }),
);

/**
 * V1 invoice unit: ریال (`IRR`) or تومان (`IRT`) only. A later settings
 * change never rewrites finalized invoices — those snapshot `Invoice.currency`
 * at finalization time.
 */
const currencyField = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(["IRR", "IRT"], {
    errorMap: () => ({ message: "currency must be IRR (ریال) or IRT (تومان)" }),
  }),
);

const invoicePrefixField = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  },
  z
    .string()
    .regex(INVOICE_PREFIX_PATTERN, "invoicePrefix must be 1 to 20 letters, digits, '-' or '_'")
    .nullable()
    .optional(),
);

/**
 * The editable `InvoiceSettings` columns. `nextInvoiceNumber` is deliberately
 * absent — official numbering is owned by the finalization transaction and
 * must never be client-writable. `defaultTemplate` is absent because no
 * template system exists yet.
 */
export const businessInvoiceSettingsSchema = z
  .object({
    defaultVatPercent: vatPercentField.optional(),
    currency: currencyField.optional(),
    calendar: z
      .enum(["JALALI", "GREGORIAN"], {
        errorMap: () => ({ message: "calendar must be JALALI or GREGORIAN" }),
      })
      .optional(),
    invoicePrefix: invoicePrefixField.optional(),
  })
  .strict();

export type BusinessInvoiceSettingsInput = z.infer<typeof businessInvoiceSettingsSchema>;

// ---------------------------------------------------------------------------
// Create / update contracts
// ---------------------------------------------------------------------------

export const createBusinessSchema = z
  .object({
    name: businessName,
    ...businessProfileFields,
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

/**
 * Full business-settings payload of the settings page: the business name, the
 * client-writable `BusinessProfile` columns and (optionally) the editable
 * `InvoiceSettings` columns. `name` is required because the settings form
 * always submits it; the service keeps `Business.name` and
 * `BusinessProfile.businessName` mirrored in one transaction.
 */
export const updateBusinessSettingsSchema = z
  .object({
    name: businessName,
    ...businessProfileFields,
    invoiceSettings: businessInvoiceSettingsSchema.optional(),
  })
  .strict();

export type UpdateBusinessSettingsInput = z.infer<typeof updateBusinessSettingsSchema>;

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

export function parseUpdateBusinessSettingsInput(input: unknown): UpdateBusinessSettingsInput {
  const result = updateBusinessSettingsSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid business settings — ${formatZodIssues(result.error)}`);
  }
  return result.data;
}
