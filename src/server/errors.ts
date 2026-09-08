/**
 * Domain errors that are not session/auth primitives.
 * Auth errors (Unauthorized / Forbidden / NotFound) stay in requireSession.ts
 * so existing imports keep working; entitlement/validation failures live here
 * so they can be reused by any server module without stringly-typed throws.
 */

export class ValidationError extends Error {
  constructor(message = "Validation failed") {
    super(message);
    this.name = "ValidationError";
  }
}

export class BusinessLimitReachedError extends Error {
  readonly code = "BUSINESS_LIMIT_REACHED" as const;

  constructor(message = "Business limit reached for the current plan") {
    super(message);
    this.name = "BusinessLimitReachedError";
  }
}

export class InvoiceLimitReachedError extends Error {
  readonly code = "INVOICE_LIMIT_REACHED" as const;

  constructor(message = "Invoice limit reached for the current plan") {
    super(message);
    this.name = "InvoiceLimitReachedError";
  }
}

/**
 * The entitlement dataset itself is missing or self-contradictory — e.g. the
 * FREE plan row was never seeded (so there is no fallback baseline to enforce),
 * or an Account has no Subscription row at all (so a `UsagePeriod`, whose
 * `subscriptionId` column is NOT NULL, cannot be created honestly).
 *
 * Thrown instead of guessing: an entitlement resolver that cannot prove what an
 * account is entitled to must refuse rather than assume the most permissive
 * answer. Never constructed from a raw Prisma error, and it never carries one.
 */
export class EntitlementDataError extends Error {
  readonly code = "ENTITLEMENT_DATA_ERROR" as const;

  constructor(message = "Entitlement data is missing or inconsistent") {
    super(message);
    this.name = "EntitlementDataError";
  }
}

/**
 * The S3-compatible file-storage adapter is not wired up yet (see
 * `src/server/storage/storageService.ts` for the deliberately deferred
 * integration point). Any upload attempt fails with this error instead of
 * silently storing files somewhere they do not belong (base64 in the DB, a
 * local disk path masquerading as object storage, ...).
 */
export class FileStorageNotConfiguredError extends Error {
  readonly code = "FILE_STORAGE_NOT_CONFIGURED" as const;

  constructor(message = "File storage is not configured") {
    super(message);
    this.name = "FileStorageNotConfiguredError";
  }
}
