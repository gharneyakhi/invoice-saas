import { NextResponse } from "next/server";
import { createSubscriptionCheckout } from "@/server/subscription/subscriptionPaymentService";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { SubscriptionAlreadyActiveError, ValidationError } from "@/server/errors";
import {
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  PaymentProviderUnavailableError,
} from "@/server/payments/paymentErrors";

/**
 * POST /api/subscriptions/payment/create — start a SaaS subscription checkout.
 *
 * Request body (the ONLY client input):
 *
 *   { "planKey": "BASIC" | "PRO" }
 *
 * Response contract:
 *
 *   200 → { success: true, data: { paymentId, redirectUrl } }
 *         `paymentId` is the opaque SubscriptionPayment identifier,
 *         `redirectUrl` the gateway URL to send the payer to. Nothing else —
 *         no merchant ID, no secrets, no authority echo, no gateway envelope.
 *   4xx → { success: false, error: { code, message } }  (client-fixable)
 *   5xx → { success: false, error: { code, message } }  (generic, safe)
 *
 * The error mapping is deliberately conservative:
 *   - domain errors (validation, not-found, already-active) pass through
 *     their server-authored messages — those strings are written in this
 *     codebase and are safe;
 *   - EVERYTHING from the gateway layer maps to ONE fixed generic message:
 *     gateway internals, provider codes and configuration details never
 *     reach the client, and a failed gateway call is never reported as a
 *     successful checkout (the service has already compensated the DB state).
 */

/** Fixed client-facing message for any gateway-side failure. */
const PAYMENT_GATEWAY_ERROR_MESSAGE =
  "The payment gateway could not start this payment. No charge has been made. Please try again.";

function jsonOk(data: { paymentId: string; redirectUrl: string }): NextResponse {
  return NextResponse.json({ success: true, data }, { status: 200 });
}

function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "VALIDATION_ERROR", "Request body must be valid JSON");
  }

  try {
    const result = await createSubscriptionCheckout(body);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in");
    }
    if (error instanceof ForbiddenError) {
      return jsonError(403, "FORBIDDEN", "You do not have permission to do this");
    }
    if (error instanceof NotFoundError) {
      return jsonError(404, "NOT_FOUND", "Plan not found");
    }
    if (error instanceof ValidationError) {
      return jsonError(400, "VALIDATION_ERROR", error.message);
    }
    if (error instanceof SubscriptionAlreadyActiveError) {
      return jsonError(409, "SUBSCRIPTION_ALREADY_ACTIVE", error.message);
    }
    if (
      error instanceof PaymentProviderNotConfiguredError ||
      error instanceof PaymentProviderUnavailableError ||
      error instanceof PaymentProviderError
    ) {
      // One fixed message for every gateway-side failure — configuration
      // problems (503) and gateway rejections/outages (502) look identical
      // to the client by design.
      const status = error instanceof PaymentProviderNotConfiguredError ? 503 : 502;
      return jsonError(status, "PAYMENT_GATEWAY_ERROR", PAYMENT_GATEWAY_ERROR_MESSAGE);
    }

    // Unknown failure (DB outage, raw Prisma error, ...): opaque on purpose.
    console.error("[subscriptions/payment/create] unexpected error", error);
    return jsonError(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
  }
}
