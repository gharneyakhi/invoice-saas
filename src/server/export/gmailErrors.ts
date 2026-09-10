/**
 * Gmail error types — leaf module (no imports).
 *
 * Separated from `gmailService`/`gmailOAuth` so the Server Action error
 * mapper (`actionResult.ts`) can recognize Gmail failures with `instanceof`
 * without pulling the database, crypto or Google client libraries into the
 * shared boundary module.
 */

export class GmailNotConfiguredError extends Error {
  constructor(message = "Gmail integration is not configured") {
    super(message);
    this.name = "GmailNotConfiguredError";
  }
}

export class GmailOAuthStateError extends Error {
  constructor(message = "Invalid or expired Gmail connect request") {
    super(message);
    this.name = "GmailOAuthStateError";
  }
}

export class GmailNotConnectedError extends Error {
  constructor(message = "Gmail is not connected") {
    super(message);
    this.name = "GmailNotConnectedError";
  }
}

export class GmailSendError extends Error {
  constructor(message = "Sending through Gmail failed. Please try again.") {
    super(message);
    this.name = "GmailSendError";
  }
}
