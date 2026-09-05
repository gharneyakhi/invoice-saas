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
