import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  GMAIL_SEND_SCOPE,
  buildGmailConnectUrl,
  isGmailSendScopeGranted,
  isSafeReturnTo,
  mergeOAuthScope,
  readGmailOAuthConfig,
  signGmailOAuthState,
  verifyGmailOAuthState,
  GmailOAuthStateError,
} from "./gmailOAuth";

/**
 * Gmail OAuth helper tests: scope checks/merging, connect-URL building and
 * the signed connect-flow state (CSRF + user binding). `generateAuthUrl`
 * is pure URL building (no network), so no Google mocking is needed.
 */

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REDIRECT_URI", "APP_URL", "NEXTAUTH_SECRET"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.APP_URL = "https://app.example.ir";
  process.env.NEXTAUTH_SECRET = "test-nextauth-secret-for-hmac-signing";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllEnvs();
});

describe("gmail scopes", () => {
  it("detects the gmail.send grant inside space-separated scopes", () => {
    expect(isGmailSendScopeGranted(GMAIL_SEND_SCOPE)).toBe(true);
    expect(isGmailSendScopeGranted(`openid email profile ${GMAIL_SEND_SCOPE}`)).toBe(true);
    expect(isGmailSendScopeGranted("openid email profile")).toBe(false);
    expect(isGmailSendScopeGranted(null)).toBe(false);
    expect(isGmailSendScopeGranted(undefined)).toBe(false);
  });

  it("merges scopes without losing login grants", () => {
    expect(mergeOAuthScope("openid email", GMAIL_SEND_SCOPE)).toBe(`openid email ${GMAIL_SEND_SCOPE}`);
    expect(mergeOAuthScope(`openid ${GMAIL_SEND_SCOPE}`, GMAIL_SEND_SCOPE)).toBe(
      `openid ${GMAIL_SEND_SCOPE}`,
    );
    expect(mergeOAuthScope(null, GMAIL_SEND_SCOPE)).toBe(GMAIL_SEND_SCOPE);
  });
});

describe("connect url", () => {
  it("requests offline access + consent for the gmail.send scope", () => {
    const url = buildGmailConnectUrl("state-123");
    expect(url).toContain("accounts.google.com");
    expect(url).toContain(`scope=${encodeURIComponent(GMAIL_SEND_SCOPE)}`);
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    expect(url).toContain("state=state-123");
    expect(url).toContain(encodeURIComponent("https://app.example.ir/api/gmail/callback"));
  });

  it("honours an explicit GMAIL_REDIRECT_URI override", () => {
    process.env.GMAIL_REDIRECT_URI = "https://app.example.ir/custom-gmail-callback";
    const config = readGmailOAuthConfig();
    expect(config?.redirectUri).toBe("https://app.example.ir/custom-gmail-callback");
  });

  it("reports unconfigured when OAuth credentials are missing", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(readGmailOAuthConfig()).toBeNull();
  });
});

describe("connect-flow state", () => {
  it("round-trips for the same user", () => {
    const state = signGmailOAuthState({ userId: "user-1", returnTo: "/dashboard/invoices/inv-1" });
    expect(verifyGmailOAuthState(state, "user-1")).toEqual({
      returnTo: "/dashboard/invoices/inv-1",
    });
  });

  it("rejects tampered states", () => {
    const state = signGmailOAuthState({ userId: "user-1", returnTo: "/dashboard" });
    const [payload, signature] = state.split(".");
    const tamperedPayload = `${(payload as string).slice(0, -2)}AA`;
    expect(() => verifyGmailOAuthState(`${tamperedPayload}.${signature}`, "user-1")).toThrow(
      GmailOAuthStateError,
    );
    expect(() => verifyGmailOAuthState("not-a-state", "user-1")).toThrow(GmailOAuthStateError);
  });

  it("rejects states bound to another user (CSRF across accounts)", () => {
    const state = signGmailOAuthState({ userId: "user-1", returnTo: "/dashboard" });
    expect(() => verifyGmailOAuthState(state, "user-2")).toThrow(GmailOAuthStateError);
  });

  it("rejects unsafe return targets", () => {
    expect(isSafeReturnTo("/dashboard/invoices")).toBe(true);
    expect(isSafeReturnTo("https://evil.example/phish")).toBe(false);
    expect(isSafeReturnTo("//evil.example/phish")).toBe(false);
    expect(isSafeReturnTo("/x\r\nLocation: evil")).toBe(false);
    expect(() => signGmailOAuthState({ userId: "user-1", returnTo: "https://evil.example" })).toThrow(
      GmailOAuthStateError,
    );
  });
});
