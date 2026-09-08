import {
  BusinessLimitReachedError,
  EntitlementDataError,
  FileStorageNotConfiguredError,
  InvoiceLimitReachedError,
  ValidationError,
} from "@/server/errors";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";

/**
 * Serialization contract between the application/action boundary and the
 * browser.
 *
 * Server Actions never throw to the client and never JSON.stringify raw Prisma
 * objects / Error instances. Every action returns one of two shapes:
 *
 *   { success: true,  data: <React/Next-serializable payload> }
 *   { success: false, error: { code, message } }
 *
 * `data` is always an explicit DTO (see `dto.ts`) with Dates converted to ISO
 * strings and Decimals converted to strings. `error` carries only a stable
 * machine `code` and a human `message` — never a stack trace, SQL, Prisma
 * internals, tokens or connection details.
 */

export const ActionErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BUSINESS_LIMIT_REACHED: "BUSINESS_LIMIT_REACHED",
  INVOICE_LIMIT_REACHED: "INVOICE_LIMIT_REACHED",
  ENTITLEMENT_DATA_ERROR: "ENTITLEMENT_DATA_ERROR",
  FILE_STORAGE_NOT_CONFIGURED: "FILE_STORAGE_NOT_CONFIGURED",
  FILE_STORAGE_UPLOAD_FAILED: "FILE_STORAGE_UPLOAD_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ActionErrorCode = (typeof ActionErrorCode)[keyof typeof ActionErrorCode];

export interface ActionError {
  code: ActionErrorCode;
  message: string;
}

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: ActionError };

export const OK = <T>(data: T): ActionResult<T> => ({ success: true, data });

export const ERR = <T = never>(code: ActionErrorCode, message: string): ActionResult<T> => ({
  success: false,
  error: { code, message },
});

/**
 * Application errors carry a stable `.code` (e.g. `InvoiceLimitReachedError`).
 * Recognised via the property first so the mapper stays correct even when an
 * error class is reconstructed by a test double; everything else falls through
 * to the `instanceof` checks below.
 */
function isKnownCodeError(error: unknown): ActionError | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = (error as { code?: unknown; message?: unknown }).code;
  const known: readonly ActionErrorCode[] = [
    "BUSINESS_LIMIT_REACHED",
    "INVOICE_LIMIT_REACHED",
    "ENTITLEMENT_DATA_ERROR",
    "FILE_STORAGE_NOT_CONFIGURED",
    "FILE_STORAGE_UPLOAD_FAILED",
  ];
  if (typeof candidate === "string" && (known as readonly string[]).includes(candidate)) {
    const message =
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "Operation failed";
    return { code: candidate as ActionErrorCode, message };
  }
  return null;
}

function safeMessage(error: unknown, fallback: string): string {
  return typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : fallback;
}

/**
 * Maps any thrown value onto the safe, browser-predictable error payload.
 *
 * The fallback for anything unrecognised is a generic INTERNAL_ERROR whose
 * message never leaks the underlying cause. Domain errors (Validation,
 * entitlement limits) pass through their own messages; infrastructure
 * failures do not.
 */
export function toActionError(error: unknown): { success: false; error: ActionError } {
  if (error instanceof UnauthorizedError) {
    return { success: false, error: { code: "UNAUTHORIZED", message: safeMessage(error, "You must be signed in") } };
  }
  if (error instanceof ForbiddenError) {
    return { success: false, error: { code: "FORBIDDEN", message: safeMessage(error, "You do not have permission to do this") } };
  }
  if (error instanceof NotFoundError) {
    return { success: false, error: { code: "NOT_FOUND", message: safeMessage(error, "Not found") } };
  }
  if (error instanceof ValidationError) {
    return { success: false, error: { code: "VALIDATION_ERROR", message: safeMessage(error, "Invalid input") } };
  }
  if (error instanceof InvoiceLimitReachedError) {
    return { success: false, error: { code: "INVOICE_LIMIT_REACHED", message: safeMessage(error, "Invoice limit reached") } };
  }
  if (error instanceof BusinessLimitReachedError) {
    return { success: false, error: { code: "BUSINESS_LIMIT_REACHED", message: safeMessage(error, "Business limit reached") } };
  }
  if (error instanceof EntitlementDataError) {
    return { success: false, error: { code: "ENTITLEMENT_DATA_ERROR", message: safeMessage(error, "Entitlement data is unavailable") } };
  }

  const fromCode = isKnownCodeError(error);
  if (fromCode) {
    return { success: false, error: fromCode };
  }

  // Deliberately opaque: an unknown failure (DB outage, raw Prisma error, ...)
  // is reported generically so nothing internal reaches the browser.
  return {
    success: false,
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred. Please try again." },
  };
}

/** Convenience wrapper that maps a synchronous promise result via toActionError. */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return OK(await fn());
  } catch (error) {
    return toActionError(error);
  }
}
