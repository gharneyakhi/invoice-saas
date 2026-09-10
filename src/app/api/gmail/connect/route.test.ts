import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GmailNotConfiguredError } from "@/server/export/gmailErrors";

/**
 * Route tests for the Gmail connect entry (`GET ?returnTo=...`).
 *
 * These prove the redirect contract: signed state handoff to Google,
 * unsafe return paths falling back to `/dashboard`, unauthenticated
 * callers landing on `/login`, and an unconfigured integration degrading
 * to a `?gmail=unavailable` flag instead of leaking server details.
 * `isSafeReturnTo` stays real so the path validation is genuinely
 * exercised; the signer and URL builder are mocked.
 */

const requireSession = vi.hoisted(() => vi.fn());
const signGmailOAuthState = vi.hoisted(() => vi.fn());
const buildGmailConnectUrl = vi.hoisted(() => vi.fn());

vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  return { requireSession, UnauthorizedError };
});

vi.mock("@/server/export/gmailOAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/export/gmailOAuth")>();
  return {
    ...actual,
    signGmailOAuthState,
    buildGmailConnectUrl,
  };
});

function requestFor(returnTo: string | null): NextRequest {
  const url =
    returnTo === null
      ? "http://localhost/api/gmail/connect"
      : `http://localhost/api/gmail/connect?returnTo=${encodeURIComponent(returnTo)}`;
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ userId: "user-1", accountId: "acct-1" });
  signGmailOAuthState.mockReturnValue("signed-state");
  buildGmailConnectUrl.mockReturnValue("https://accounts.google.com/o/oauth2/auth?state=x");
});

describe("GET gmail connect route", () => {
  it("signs the state for the session user and redirects to Google", async () => {
    const { GET } = await import("./route");
    const response = await GET(requestFor("/dashboard/businesses/biz-1/invoices/inv-1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://accounts.google.com/o/oauth2/auth?state=x",
    );
    expect(signGmailOAuthState).toHaveBeenCalledWith({
      userId: "user-1",
      returnTo: "/dashboard/businesses/biz-1/invoices/inv-1",
    });
    expect(buildGmailConnectUrl).toHaveBeenCalledWith("signed-state");
  });

  it("falls back to /dashboard for unsafe or missing return paths", async () => {
    const { GET } = await import("./route");

    await GET(requestFor("https://evil.example/phish"));
    expect(signGmailOAuthState).toHaveBeenCalledWith({ userId: "user-1", returnTo: "/dashboard" });

    await GET(requestFor(null));
    expect(signGmailOAuthState).toHaveBeenCalledWith({ userId: "user-1", returnTo: "/dashboard" });
  });

  it("sends unauthenticated callers to /login with the safe callback", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { GET } = await import("./route");
    requireSession.mockRejectedValue(new UnauthorizedError());

    const response = await GET(requestFor("/dashboard/invoices"));

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain(encodeURIComponent("/dashboard/invoices"));
    expect(signGmailOAuthState).not.toHaveBeenCalled();
  });

  it("degrades to ?gmail=unavailable when the integration is not configured", async () => {
    const { GET } = await import("./route");
    buildGmailConnectUrl.mockImplementation(() => {
      throw new GmailNotConfiguredError();
    });

    const response = await GET(requestFor("/dashboard/invoices"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/dashboard/invoices?gmail=unavailable",
    );
  });
});
