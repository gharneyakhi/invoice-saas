import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/server/auth/requireSession";
import {
  buildGmailConnectUrl,
  isSafeReturnTo,
  signGmailOAuthState,
} from "@/server/export/gmailOAuth";
import { GmailNotConfiguredError } from "@/server/export/gmailErrors";

export const dynamic = "force-dynamic";

/**
 * Gmail connect entry — `GET ?returnTo=/dashboard/...`.
 *
 * Signs an HMAC-bound OAuth state (user id + safe return path, 10-minute
 * TTL) and redirects to Google's consent screen with `access_type=offline`
 * + `prompt=consent` so a refresh token is issued. Failures redirect back
 * to a safe in-app page with a `?gmail=` outcome flag instead of leaking
 * configuration details; the invoice pages surface the flag as a banner.
 */

const DEFAULT_RETURN_TO = "/dashboard";

function safeReturnTo(value: string | null): string {
  return isSafeReturnTo(value) ? value : DEFAULT_RETURN_TO;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  try {
    const { userId } = await requireSession();
    const state = signGmailOAuthState({ userId, returnTo });
    return NextResponse.redirect(buildGmailConnectUrl(state));
  } catch (error) {
    if (error instanceof GmailNotConfiguredError) {
      return NextResponse.redirect(new URL(`${returnTo}?gmail=unavailable`, request.url));
    }
    // Unauthenticated (or anything unexpected): the login page is the only
    // safe destination — the return path stays server-side in the state.
    const login = new URL("/login", request.url);
    login.searchParams.set("callbackUrl", returnTo);
    return NextResponse.redirect(login);
  }
}
