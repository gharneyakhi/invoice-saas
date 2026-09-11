import { NextResponse } from "next/server";
import { verifySubscriptionCallback } from "@/server/subscription/subscriptionVerificationService";
import { NotFoundError } from "@/server/auth/requireSession";
import { EntitlementDataError } from "@/server/errors";
import {
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  PaymentProviderUnavailableError,
} from "@/server/payments/paymentErrors";

/**
 * GET /api/payments/callback — the gateway redirect endpoint configured via
 * `PAYMENT_CALLBACK_URL` (see `src/server/payments/callbackUrl.ts`).
 *
 * This endpoint is intentionally UNAUTHENTICATED: it is the payer's browser
 * arriving back from the gateway. Nothing in the query is trusted — the
 * `authority` merely names one SubscriptionPayment row, and every
 * money-relevant value is read back from the database by
 * `verifySubscriptionCallback()`.
 *
 * Query parameters (matched case-insensitively, because gateways disagree):
 *   - `kind`      — flow discriminator stamped by `buildPaymentCallbackUrl()`.
 *                   `subscription` routes here; any other value (including a
 *                   future invoice-payment kind) is rejected so the two flows
 *                   can never process each other's payments.
 *   - `authority` / `Authority` — the gateway authority from the checkout.
 *   - `status` / `Status` — the gateway's redirect hint (ZarinPal OK/NOK).
 *
 * Responses are JSON (the billing UI is a later phase and will own the
 * post-payment landing page):
 *   200 → { success: true,  data: { status, paymentId, planKey } }
 *   4xx/5xx → { success: false, error: { code, message } }  (always safe)
 *
 * Gateway-side failures map to ONE fixed generic message, exactly like the
 * checkout route: no merchant IDs, no provider codes, no raw gateway bodies.
 */

/** Fixed client-facing message for any gateway-side failure. */
const PAYMENT_GATEWAY_ERROR_MESSAGE =
  "The payment gateway could not confirm this payment. If you were charged, our team will reconcile it — no subscription was activated yet.";

function firstQueryParam(request: Request, ...names: string[]): string | null {
  const params = new URL(request.url).searchParams;
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) return value;
  }
  return null;
}

function jsonOk(data: { status: string; paymentId: string; planKey: string | null }): NextResponse {
  return NextResponse.json({ success: true, data }, { status: 200 });
}

function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function GET(request: Request): Promise<NextResponse> {
  // Flow discrimination FIRST: a subscription callback must never be processed
  // by (or confused with) any other payment flow.
  const kind = firstQueryParam(request, "kind");
  if (kind !== "subscription") {
    return jsonError(400, "UNKNOWN_CALLBACK_KIND", "Unknown payment callback kind");
  }

  const authority = firstQueryParam(request, "authority", "Authority");
  if (authority === null || authority.trim() === "") {
    return jsonError(400, "VALIDATION_ERROR", "Missing payment authority");
  }
  const gatewayStatus = firstQueryParam(request, "status", "Status");

  try {
    const result = await verifySubscriptionCallback({ authority, gatewayStatus });
    return jsonOk(result);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return jsonError(404, "NOT_FOUND", "Payment not found");
    }
    if (
      error instanceof PaymentProviderNotConfiguredError ||
      error instanceof PaymentProviderUnavailableError ||
      error instanceof PaymentProviderError
    ) {
      // One fixed message for every gateway-side failure — configuration
      // problems (503) and gateway rejections/outages (502) look identical
      // to the client by design. The rows stay PENDING for retry.
      const status = error instanceof PaymentProviderNotConfiguredError ? 503 : 502;
      return jsonError(status, "PAYMENT_GATEWAY_ERROR", PAYMENT_GATEWAY_ERROR_MESSAGE);
    }
    if (error instanceof EntitlementDataError) {
      // Subscription/plan data inconsistent with the payment row: never
      // leak internals, never half-activate (the service threw before any
      // terminal write).
      console.error("[payments/callback] entitlement data error", error);
      return jsonError(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
    }

    // Unknown failure (DB outage, raw Prisma error, ...): opaque on purpose.
    console.error("[payments/callback] unexpected error", error);
    return jsonError(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
  }
}
