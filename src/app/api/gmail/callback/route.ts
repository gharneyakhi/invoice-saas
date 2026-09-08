import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/server/auth/requireSession";
import { exchangeGmailOAuthCode, verifyGmailOAuthState } from "@/server/export/gmailOAuth";
import { saveGmailConnection } from "@/server/export/gmailService";

export const dynamic = "force-dynamic";

/**
 * Gmail OAuth callback — `GET ?code=...&state=...`.
 *
 * Verifies the signed state (rejects foreign/expired/tampered states and
 * states bound to another user), exchanges the authorization code for
 * tokens, persists them ENCRYPTED via `saveGmailConnection` and redirects
 * back to the state-bound return path with `?gmail=connected`. Every
 * failure mode (denied consent, bad state, exchange error, storage error)
 * lands on a safe in-app page with `?gmail=error` — tokens and provider
 * details never appear in URLs, logs or client payloads.
 */

const FALLBACK_RETURN_TO = "/dashboard";

function outcomeRedirect(request: NextRequest, returnTo: string, outcome: string): NextResponse {
  return NextResponse.redirect(new URL(`${returnTo}?gmail=${outcome}`, request.url));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  try {
    const { userId } = await requireSession();
    const state = params.get("state");
    const code = params.get("code");
    if (!state) {
      return outcomeRedirect(request, FALLBACK_RETURN_TO, "error");
    }
    // Google-side denial arrives without a code; verify the state so the
    // error lands back where the flow started.
    if (params.get("error") || !code) {
      const { returnTo } = verifyGmailOAuthState(state, userId);
      return outcomeRedirect(request, returnTo, "error");
    }
    const { returnTo } = verifyGmailOAuthState(state, userId);
    const exchange = await exchangeGmailOAuthCode(code);
    await saveGmailConnection(userId, exchange);
    return outcomeRedirect(request, returnTo, "connected");
  } catch {
    // Deliberately opaque: state failures, exchange failures and storage
    // failures all land here with no distinguishing detail.
    return outcomeRedirect(request, FALLBACK_RETURN_TO, "error");
  }
}
