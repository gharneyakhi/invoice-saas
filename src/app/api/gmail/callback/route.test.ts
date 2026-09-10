import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GmailOAuthStateError } from "@/server/export/gmailErrors";

/**
 * Route tests for the Gmail OAuth callback (`GET ?code=&state=`).
 *
 * These prove the redirect contract: a verified state + exchanged code
 * persists the ENCRYPTED connection and lands on the state-bound return
 * path with `?gmail=connected`; every failure mode (denied consent,
 * missing/tampered state, exchange or storage failure) lands on a SAFE
 * in-app page with `?gmail=error` — tokens and provider details never
 * appear in URLs. State verification and the token exchange are mocked
 * (covered by the gmailOAuth suite); the route's branching is real.
 */

const requireSession = vi.hoisted(() => vi.fn());
const verifyGmailOAuthState = vi.hoisted(() => vi.fn());
const exchangeGmailOAuthCode = vi.hoisted(() => vi.fn());
const saveGmailConnection = vi.hoisted(() => vi.fn());

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
  return { ...actual, verifyGmailOAuthState, exchangeGmailOAuthCode };
});

vi.mock("@/server/export/gmailService", () => ({ saveGmailConnection }));

function requestFor(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/gmail/callback${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ userId: "user-1", accountId: "acct-1" });
  verifyGmailOAuthState.mockReturnValue({ returnTo: "/dashboard/invoices" });
  exchangeGmailOAuthCode.mockResolvedValue({ accessToken: "a", refreshToken: "r" });
  saveGmailConnection.mockResolvedValue(undefined);
});

describe("GET gmail callback route", () => {
  it("verifies, exchanges, saves and lands on the state return path", async () => {
    const { GET } = await import("./route");
    const response = await GET(requestFor("?code=auth-code&state=signed-state"));

    expect(verifyGmailOAuthState).toHaveBeenCalledWith("signed-state", "user-1");
    expect(exchangeGmailOAuthCode).toHaveBeenCalledWith("auth-code");
    expect(saveGmailConnection).toHaveBeenCalledWith("user-1", {
      accessToken: "a",
      refreshToken: "r",
    });
    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("http://localhost/dashboard/invoices?gmail=connected");
    // No token material in the redirect URL.
    expect(location).not.toContain("auth-code");
    expect(location).not.toContain("signed-state");
  });

  it("lands denied consent on the state return path without exchanging", async () => {
    const { GET } = await import("./route");
    const response = await GET(requestFor("?error=access_denied&state=signed-state"));

    expect(response.headers.get("location")).toBe(
      "http://localhost/dashboard/invoices?gmail=error",
    );
    expect(exchangeGmailOAuthCode).not.toHaveBeenCalled();
    expect(saveGmailConnection).not.toHaveBeenCalled();
  });

  it("lands a tampered state on the safe fallback, never a forged path", async () => {
    const { GET } = await import("./route");
    verifyGmailOAuthState.mockImplementation(() => {
      throw new GmailOAuthStateError();
    });

    const response = await GET(requestFor("?code=x&state=forged"));

    expect(response.headers.get("location")).toBe("http://localhost/dashboard?gmail=error");
    expect(exchangeGmailOAuthCode).not.toHaveBeenCalled();
  });

  it("lands exchange and storage failures on the fallback with ?gmail=error", async () => {
    const { GET } = await import("./route");

    exchangeGmailOAuthCode.mockRejectedValueOnce(new Error("invalid_grant: boom"));
    const failed = await GET(requestFor("?code=stale&state=s"));
    expect(failed.headers.get("location")).toBe("http://localhost/dashboard?gmail=error");

    saveGmailConnection.mockRejectedValueOnce(new Error("db down"));
    const broken = await GET(requestFor("?code=ok&state=s2"));
    expect(broken.headers.get("location")).toBe("http://localhost/dashboard?gmail=error");
  });

  it("lands missing state and missing session on the fallback", async () => {
    const { GET } = await import("./route");

    const missing = await GET(requestFor("?code=orphan"));
    expect(missing.headers.get("location")).toBe("http://localhost/dashboard?gmail=error");

    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    requireSession.mockRejectedValue(new UnauthorizedError());
    const anon = await GET(requestFor("?code=x&state=y"));
    expect(anon.headers.get("location")).toBe("http://localhost/dashboard?gmail=error");
  });
});
