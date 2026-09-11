import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/server/errors";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { SubscriptionAlreadyActiveError } from "@/server/errors";
import { PaymentProviderError } from "@/server/payments/paymentErrors";

/**
 * HTTP-boundary tests for POST /api/subscriptions/payment/create.
 *
 * The service is mocked at the module boundary (the service has its own
 * thorough test file) — with one deliberate exception: the default mock
 * implementation delegates to the REAL Zod schema, so these tests prove the
 * strict `{ planKey }` contract holds end-to-end through the route, including
 * the rejection of smuggled fields like `amount`.
 *
 * What is pinned here is the response CONTRACT: status codes, the
 * `{ success, data | error }` envelope, the exact safe payload keys, and the
 * guarantee that no gateway/merchant/internal detail ever appears in a
 * response.
 */
const service = vi.hoisted(() => ({ createSubscriptionCheckout: vi.fn() }));
const requireSession = vi.hoisted(() => vi.fn());

// Same treatment as paymentService.test.ts: do not importOriginal() the auth
// module — it pulls auth-options.ts (throws at load when GOOGLE_CLIENT_ID is
// unset) and the Prisma singleton (throws when the client is not generated).
// The error classes are re-declared so instanceof checks match the real gate.
vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  class ForbiddenError extends Error {
    constructor(message = "Forbidden") {
      super(message);
      this.name = "ForbiddenError";
    }
  }
  class NotFoundError extends Error {
    constructor(message = "Not found") {
      super(message);
      this.name = "NotFoundError";
    }
  }
  return { UnauthorizedError, ForbiddenError, NotFoundError, requireSession };
});

vi.mock("@/server/subscription/subscriptionPaymentService", async () => {
  // Delegate input validation to the real schema so the route tests exercise
  // the actual client-facing contract, then return a fixed safe payload.
  const { parseCreateSubscriptionCheckoutInput } = await import("@/server/subscription/schema");
  return {
    createSubscriptionCheckout: service.createSubscriptionCheckout.mockImplementation(
      async (input: unknown) => {
        parseCreateSubscriptionCheckoutInput(input);
        return {
          paymentId: "sp-1",
          redirectUrl: "https://sandbox.zarinpal.com/pg/StartPay/A0000",
        };
      },
    ),
  };
});

import { POST } from "./route";

const MERCHANT_ID = "11111111-2222-3333-4444-555555555555";

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/subscriptions/payment/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  service.createSubscriptionCheckout.mockClear();
  // Re-install the default (validating) implementation after each test that
  // overrode it.
  service.createSubscriptionCheckout.mockImplementation(async (input: unknown) => {
    const { parseCreateSubscriptionCheckoutInput } = await import("@/server/subscription/schema");
    parseCreateSubscriptionCheckoutInput(input);
    return { paymentId: "sp-1", redirectUrl: "https://sandbox.zarinpal.com/pg/StartPay/A0000" };
  });
});

describe("POST /api/subscriptions/payment/create", () => {
  it("returns 200 with only the safe payload keys on success", async () => {
    const response = await POST(postRequest({ planKey: "PRO" }));
    const body = (await response.json()) as {
      success: boolean;
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual(["paymentId", "redirectUrl"]);
    expect(body.data.paymentId).toBe("sp-1");
    // No merchant id, no authority echo, no gateway envelope in the payload.
    expect(JSON.stringify(body)).not.toContain(MERCHANT_ID);
  });

  it("rejects an unauthenticated request with 401 and never leaks internals", async () => {
    service.createSubscriptionCheckout.mockRejectedValueOnce(new UnauthorizedError());

    const response = await POST(postRequest({ planKey: "PRO" }));
    const body = (await response.json()) as { success: boolean; error: { code: string } };

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed JSON body with 400 without calling the service", async () => {
    const response = await POST(postRequest("this is not json"));
    const body = (await response.json()) as { success: boolean; error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(service.createSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it("rejects an invalid planKey with 400 (real schema applied through the route)", async () => {
    const response = await POST(postRequest({ planKey: "GOLD" }));
    const body = (await response.json()) as { success: boolean; error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("planKey");
  });

  it("rejects a client-supplied amount with 400 (fake amounts cannot influence the charge)", async () => {
    const response = await POST(postRequest({ planKey: "PRO", amount: 1 }));
    const body = (await response.json()) as {
      success: boolean;
      error: { code: string; message: string };
      data?: unknown;
    };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("amount");
    expect(body.data).toBeUndefined();
  });

  it("maps a provider failure to 502 with ONE fixed generic message", async () => {
    service.createSubscriptionCheckout.mockRejectedValueOnce(
      new PaymentProviderError("merchant 11111111-2222-3333-4444-555555555555 invalid: raw body {}"),
    );

    const response = await POST(postRequest({ planKey: "PRO" }));
    const body = (await response.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };

    expect(response.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("PAYMENT_GATEWAY_ERROR");
    // The gateway detail must NOT be in the message — fixed text only.
    expect(body.error.message).toBe(
      "The payment gateway could not start this payment. No charge has been made. Please try again.",
    );
    expect(body.error.message).not.toContain(MERCHANT_ID);
    expect(body.error.message).not.toContain("raw body");
  });

  it("never reports a successful checkout shape when the gateway fails", async () => {
    service.createSubscriptionCheckout.mockRejectedValueOnce(new PaymentProviderError());

    const response = await POST(postRequest({ planKey: "PRO" }));
    const body = (await response.json()) as {
      success: boolean;
      data?: unknown;
      error?: { code: string; message: string };
    };

    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
    expect(body.error?.code).toBe("PAYMENT_GATEWAY_ERROR");
  });

  it("maps an already-active subscription to 409", async () => {
    service.createSubscriptionCheckout.mockRejectedValueOnce(new SubscriptionAlreadyActiveError());

    const response = await POST(postRequest({ planKey: "PRO" }));
    const body = (await response.json()) as { success: boolean; error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("SUBSCRIPTION_ALREADY_ACTIVE");
  });

  it("maps a missing plan to 404 and a forbidden account to 403", async () => {
    service.createSubscriptionCheckout.mockRejectedValueOnce(new NotFoundError("Plan not found"));
    expect((await POST(postRequest({ planKey: "PRO" }))).status).toBe(404);

    service.createSubscriptionCheckout.mockRejectedValueOnce(new ForbiddenError());
    expect((await POST(postRequest({ planKey: "PRO" }))).status).toBe(403);
  });

  it("maps an unexpected internal error to 500 with an opaque message", async () => {
    service.createSubscriptionCheckout.mockRejectedValueOnce(
      new Error("PrismaClientKnownRequestError: connect ECONNREFUSED db:5432"),
    );

    const response = await POST(postRequest({ planKey: "PRO" }));
    const body = (await response.json()) as { success: boolean; error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("An unexpected error occurred. Please try again.");
    expect(body.error.message).not.toContain("ECONNREFUSED");
  });

  it("hands the parsed JSON body to the service untouched", async () => {
    await POST(postRequest({ planKey: "BASIC" }));
    expect(service.createSubscriptionCheckout).toHaveBeenCalledWith({ planKey: "BASIC" });
  });
});
