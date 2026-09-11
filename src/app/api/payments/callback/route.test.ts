import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/server/auth/requireSession";
import {
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  PaymentProviderUnavailableError,
} from "@/server/payments/paymentErrors";

/**
 * HTTP-boundary tests for GET /api/payments/callback.
 *
 * The service is mocked at the module boundary (it has its own thorough test
 * file); what is pinned here is the route CONTRACT: the `kind=subscription`
 * flow discrimination, case-insensitive gateway parameter handling, the safe
 * `{ success, data | error }` envelope, fixed generic gateway-failure
 * messages, and the guarantee that no authority echo, merchant ID or gateway
 * detail ever appears in a response.
 */
const service = vi.hoisted(() => ({ verifySubscriptionCallback: vi.fn() }));
const requireSession = vi.hoisted(() => vi.fn());

// Same treatment as the other boundary tests: do not importOriginal() the
// auth module (auth-options.ts throws at load when GOOGLE_CLIENT_ID is unset,
// and the Prisma singleton throws while the client is not generated).
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

vi.mock("@/server/subscription/subscriptionVerificationService", () => service);

import { GET } from "./route";

const AUTHORITY = "A0000000000000000000000000000abc";

const VERIFIED_RESULT = {
  status: "VERIFIED",
  paymentId: "sp-1",
  planKey: "PRO",
};

function callbackUrl(params: Record<string, string>): Request {
  const query = new URLSearchParams(params).toString();
  return new Request(`http://localhost:3000/api/payments/callback?${query}`);
}

beforeEach(() => {
  service.verifySubscriptionCallback.mockReset();
  service.verifySubscriptionCallback.mockResolvedValue(VERIFIED_RESULT);
});

describe("GET /api/payments/callback — flow discrimination", () => {
  it("processes a subscription callback (kind=subscription)", async () => {
    const response = await GET(callbackUrl({ kind: "subscription", authority: AUTHORITY, status: "OK" }));

    expect(response.status).toBe(200);
    expect(service.verifySubscriptionCallback).toHaveBeenCalledWith({
      authority: AUTHORITY,
      gatewayStatus: "OK",
    });
  });

  it("rejects a missing kind with 400 and never calls the service", async () => {
    const response = await GET(callbackUrl({ authority: AUTHORITY }));
    const body = (await response.json()) as { success: boolean; error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNKNOWN_CALLBACK_KIND");
    expect(service.verifySubscriptionCallback).not.toHaveBeenCalled();
  });

  it("rejects a foreign kind (e.g. invoice) with 400 — flows can never process each other's payments", async () => {
    const response = await GET(
      callbackUrl({ kind: "invoice", authority: AUTHORITY, status: "OK" }),
    );
    const body = (await response.json()) as { success: boolean; error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("UNKNOWN_CALLBACK_KIND");
    expect(service.verifySubscriptionCallback).not.toHaveBeenCalled();
  });
});

describe("GET /api/payments/callback — parameter handling", () => {
  it.each([
    ["lowercase params", { kind: "subscription", authority: AUTHORITY, status: "OK" }, AUTHORITY, "OK"],
    ["ZarinPal-style params", { kind: "subscription", Authority: AUTHORITY, Status: "OK" }, AUTHORITY, "OK"],
    ["mixed case params", { kind: "subscription", Authority: AUTHORITY, Status: "NOK" }, AUTHORITY, "NOK"],
  ])("accepts %s and forwards authority + gateway status", async (_label, params, expectedAuthority, expectedStatus) => {
    await GET(callbackUrl(params));

    expect(service.verifySubscriptionCallback).toHaveBeenCalledWith({
      authority: expectedAuthority,
      gatewayStatus: expectedStatus,
    });
  });

  it("rejects a callback with no authority at all with 400", async () => {
    const response = await GET(callbackUrl({ kind: "subscription", Status: "OK" }));
    const body = (await response.json()) as { success: boolean; error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(service.verifySubscriptionCallback).not.toHaveBeenCalled();
  });
});

describe("GET /api/payments/callback — response contract", () => {
  it("returns 200 with exactly the safe payload keys on success", async () => {
    const response = await GET(
      callbackUrl({ kind: "subscription", authority: AUTHORITY, Status: "OK" }),
    );
    const body = (await response.json()) as {
      success: boolean;
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual(["paymentId", "planKey", "status"]);
    // No authority echo in the response.
    expect(JSON.stringify(body)).not.toContain(AUTHORITY);
  });

  it("maps an unknown authority to 404", async () => {
    service.verifySubscriptionCallback.mockRejectedValueOnce(new NotFoundError("Payment not found"));

    const response = await GET(
      callbackUrl({ kind: "subscription", authority: AUTHORITY, Status: "OK" }),
    );
    const body = (await response.json()) as { success: boolean; error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("maps every gateway-side failure to ONE fixed generic message (502/503) with no gateway detail", async () => {
    const FIXED_MESSAGE =
      "The payment gateway could not confirm this payment. If you were charged, our team will reconcile it — no subscription was activated yet.";

    service.verifySubscriptionCallback.mockRejectedValueOnce(
      new PaymentProviderUnavailableError(),
    );
    const unavailable = await GET(
      callbackUrl({ kind: "subscription", authority: AUTHORITY, Status: "OK" }),
    );
    const unavailableBody = (await unavailable.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };
    expect(unavailable.status).toBe(502);
    expect(unavailableBody.error.code).toBe("PAYMENT_GATEWAY_ERROR");
    expect(unavailableBody.error.message).toBe(FIXED_MESSAGE);

    service.verifySubscriptionCallback.mockRejectedValueOnce(
      new PaymentProviderError("merchant 11111111-2222-3333-4444-555555555555 exploded: raw {}"),
    );
    const providerError = await GET(
      callbackUrl({ kind: "subscription", authority: AUTHORITY, Status: "OK" }),
    );
    const providerBody = (await providerError.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };
    expect(providerError.status).toBe(502);
    expect(providerBody.error.message).toBe(FIXED_MESSAGE);
    expect(providerBody.error.message).not.toContain("11111111");
    expect(providerBody.error.message).not.toContain("raw");

    service.verifySubscriptionCallback.mockRejectedValueOnce(
      new PaymentProviderNotConfiguredError(),
    );
    const notConfigured = await GET(
      callbackUrl({ kind: "subscription", authority: AUTHORITY, Status: "OK" }),
    );
    expect(notConfigured.status).toBe(503);
    const notConfiguredBody = (await notConfigured.json()) as {
      error: { code: string; message: string };
    };
    expect(notConfiguredBody.error.code).toBe("PAYMENT_GATEWAY_ERROR");
    expect(notConfiguredBody.error.message).toBe(FIXED_MESSAGE);
  });

  it("never reports a success shape when processing fails", async () => {
    service.verifySubscriptionCallback.mockRejectedValueOnce(new PaymentProviderError());

    const response = await GET(
      callbackUrl({ kind: "subscription", authority: AUTHORITY, Status: "OK" }),
    );
    const body = (await response.json()) as { success: boolean; data?: unknown };

    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
  });

  it("maps an unexpected internal error to 500 with an opaque message", async () => {
    service.verifySubscriptionCallback.mockRejectedValueOnce(
      new Error("PrismaClientKnownRequestError: connect ECONNREFUSED db:5432"),
    );

    const response = await GET(
      callbackUrl({ kind: "subscription", authority: AUTHORITY, Status: "OK" }),
    );
    const body = (await response.json()) as { success: boolean; error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("An unexpected error occurred. Please try again.");
    expect(body.error.message).not.toContain("ECONNREFUSED");
  });
});
