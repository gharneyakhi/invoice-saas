import crypto from "node:crypto";
import { google } from "googleapis";

/**
 * Gmail OAuth (separate consent from Google login) — Export & Sharing V1.
 *
 * Google login (`auth-options.ts`) requests only `openid email profile`.
 * Gmail sending needs the additive `gmail.send` scope, granted ONLY when
 * the user explicitly connects Gmail for invoice sending:
 *
 *   1. `GET /api/gmail/connect?returnTo=...` (session required) redirects
 *      to Google with `access_type=offline&prompt=consent` so Google issues
 *      a refresh token, plus a signed `state` binding the flow to the
 *      current user + return path;
 *   2. `GET /api/gmail/callback?code&state` verifies the state + session,
 *      exchanges the code server-side, encrypts the tokens into
 *      `OAuthConnection` (merging scopes) and redirects back.
 *
 * Tokens are never exposed to the browser: the callback only redirects
 * with a `?gmail=connected|error` flag.
 */

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/** How long a connect-flow `state` stays valid. */
export const GMAIL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

import { GmailNotConfiguredError, GmailOAuthStateError } from "./gmailErrors";

export { GmailNotConfiguredError, GmailOAuthStateError };

/** True when a stored space-separated scope string includes gmail.send. */
export function isGmailSendScopeGranted(scope: string | null | undefined): boolean {
  if (typeof scope !== "string") return false;
  return scope.split(/\s+/).includes(GMAIL_SEND_SCOPE);
}

/** Unions two space-separated OAuth scope strings (deduped, trimmed). */
export function mergeOAuthScope(
  existing: string | null | undefined,
  granted: string | null | undefined,
): string {
  const tokens = new Set<string>();
  for (const scope of [existing, granted]) {
    if (typeof scope !== "string") continue;
    for (const token of scope.split(/\s+/)) {
      const trimmed = token.trim();
      if (trimmed !== "") tokens.add(trimmed);
    }
  }
  return [...tokens].join(" ");
}

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Reads the Gmail OAuth client configuration. The redirect defaults to
 * `{APP_URL}/api/gmail/callback` and can be overridden with
 * `GMAIL_REDIRECT_URI` (Google Cloud Console must list it as an authorized
 * redirect URI). Returns `null` when the integration is not configured —
 * callers turn that into `GmailNotConfiguredError`.
 */
export function readGmailOAuthConfig(): GmailOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    process.env.GMAIL_REDIRECT_URI?.trim() ||
    (process.env.APP_URL?.trim()
      ? `${process.env.APP_URL.trim().replace(/\/+$/, "")}/api/gmail/callback`
      : "");
  if (!redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function requireGmailOAuthConfig(): GmailOAuthConfig {
  const config = readGmailOAuthConfig();
  if (!config) throw new GmailNotConfiguredError();
  return config;
}

/** OAuth2 client for the connect flow / token exchange (server-side only). */
export function createGmailOAuth2Client(config?: GmailOAuthConfig) {
  const resolved = config ?? requireGmailOAuthConfig();
  return new google.auth.OAuth2(resolved.clientId, resolved.clientSecret, resolved.redirectUri);
}

/**
 * Builds the Google consent URL for the Gmail connect flow. Pure URL
 * building (no network): `access_type=offline` + `prompt=consent` so
 * Google issues a refresh token even for returning users.
 */
export function buildGmailConnectUrl(state: string, config?: GmailOAuthConfig): string {
  const client = createGmailOAuth2Client(config);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GMAIL_SEND_SCOPE],
    state,
  });
}

// ---------------------------------------------------------------------------
// Signed connect-flow state (stateless CSRF + user binding)
// ---------------------------------------------------------------------------

interface GmailOAuthStatePayload {
  /** Session user id the flow was started by. */
  u: string;
  /** Same-app return path (validated). */
  r: string;
  /** Random nonce (uniqueness). */
  n: string;
  /** Expiry (unix ms). */
  e: number;
}

function stateSigningKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new GmailNotConfiguredError("NEXTAUTH_SECRET is not set");
  }
  return Buffer.from(secret, "utf8");
}

/** Return targets must be same-app paths (never absolute urls). */
export function isSafeReturnTo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\r") &&
    !value.includes("\n")
  );
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/**
 * Signs a connect-flow state for `userId` + `returnTo` (throws
 * `GmailOAuthStateError` for unsafe return targets).
 */
export function signGmailOAuthState(args: { userId: string; returnTo: string }): string {
  if (!isSafeReturnTo(args.returnTo)) {
    throw new GmailOAuthStateError("Unsafe return target");
  }
  const payload: GmailOAuthStatePayload = {
    u: args.userId,
    r: args.returnTo,
    n: crypto.randomBytes(16).toString("hex"),
    e: Date.now() + GMAIL_OAUTH_STATE_TTL_MS,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", stateSigningKey()).update(encoded).digest();
  return `${encoded}.${base64UrlEncode(signature)}`;
}

/**
 * Verifies a connect-flow state: valid signature, unexpired, and bound to
 * `expectedUserId`. Returns the safe return path. Throws
 * `GmailOAuthStateError` on any failure (never leaks why, to avoid
 * oracle-style probing — the callback maps everything to `?gmail=error`).
 */
export function verifyGmailOAuthState(state: string, expectedUserId: string): { returnTo: string } {
  const fail = (): never => {
    throw new GmailOAuthStateError();
  };
  if (typeof state !== "string" || !expectedUserId) fail();
  const [encoded, signature] = (state as string).split(".");
  if (!encoded || !signature) fail();
  let signatureBytes: Buffer;
  try {
    signatureBytes = base64UrlDecode(signature as string);
  } catch {
    fail();
  }
  const expected = crypto.createHmac("sha256", stateSigningKey()).update(encoded as string).digest();
  if (signatureBytes!.length !== expected.length || !crypto.timingSafeEqual(signatureBytes!, expected)) {
    fail();
  }
  let payload: GmailOAuthStatePayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded as string).toString("utf8")) as GmailOAuthStatePayload;
  } catch {
    fail();
  }
  if (
    typeof payload!.u !== "string" ||
    typeof payload!.r !== "string" ||
    typeof payload!.e !== "number" ||
    payload!.u !== expectedUserId ||
    !isSafeReturnTo(payload!.r) ||
    payload!.e < Date.now()
  ) {
    fail();
  }
  return { returnTo: payload!.r };
}

// ---------------------------------------------------------------------------
// Token exchange (callback route only)
// ---------------------------------------------------------------------------

export interface GmailTokenExchange {
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  scope: string | null;
}

/**
 * Exchanges a callback `code` for tokens (network call to Google).
 * A refresh token is issued because the connect URL forces consent; when
 * Google exceptionally omits it, `refreshToken` is null and the caller
 * must keep any previously stored one.
 */
export async function exchangeGmailOAuthCode(code: string): Promise<GmailTokenExchange> {
  const client = createGmailOAuth2Client();
  const { tokens } = await client.getToken(code);
  return {
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: tokens.expiry_date ?? null,
    scope: tokens.scope ?? GMAIL_SEND_SCOPE,
  };
}
