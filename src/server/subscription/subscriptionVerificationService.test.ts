import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import { createSandboxProvider } from "@/server/payments/providers/sandbox";
import {
  EntitlementDataError,
} from "@/server/errors";
import {
  PaymentProviderError,
  PaymentProviderUnavailableError,
  PaymentProviderNotConfiguredError,
} from "@/server/payments/paymentErrors";
import {
  computeSubscriptionWindowEnd,
  normalizeGatewayStatus,
} from "./subscriptionVerificationService";

/**
 * Unit tests for the subscription callback → verify → activation service, in
 * the same style as `subscriptionPaymentService.test.ts`: the Prisma
 * singleton is mocked (no PostgreSQL needed) and only the delegates the
 * service actually uses are stubbed.
 *
 * The provider is covered two ways:
 *   - via the mocked factory returning the REAL sandbox adapter, so a full
 *     checkout-authority → verify → activation round trip runs in-process;
 *   - via stub providers for gateway-rejection and failure scenarios.
 *
 * Concurrency note: a true two-connection race cannot be reproduced against a
 * mocked client — the tests below assert the lock ORDER (verify call outside
 * the transaction; `SELECT ... FOR UPDATE` first inside it) and the loser's
 * behaviour when the re-read under the lock shows the winner's terminal state.
 */
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  // The raw `SELECT id FROM "subscription_payments" ... FOR UPDATE` lock.
  $queryRaw: vi.fn(),
  subscription: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  subscriptionPayment: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const factory = vi.hoisted(() => ({ getPaymentProvider: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/server/payments/factory", () => factory);

// Do not importOriginal() this module: it pulls auth-options.ts, which throws
// at load time when GOOGLE_CLIENT_ID is unset, and the Prisma singleton. The
// error classes are re-declared so instanceof checks match what it throws.
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
  return { UnauthorizedError, ForbiddenError, NotFoundError };
});

const NOW = new Date("2026-09-11T10:00:00.000Z");
const ONE_MONTH_LATER = new Date("2026-10-11T10:00:00.000Z");

/** A sandbox-form authority: SBX + 32 hex chars (what the sandbox creates). */
const AUTHORITY = `SBX${"A".repeat(32)}`;
const SANDBOX_REFERENCE_PREFIX = "SBXRF-";

/** A PENDING SubscriptionPayment row as the checkout creates it. */
function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sp-1",
    accountId: "acc-1",
    subscriptionId: "sub-1",
    provider: "sandbox",
    amount: new Decimal("990000"),
    currency: "IRR",
    status: "PENDING",
    authority: AUTHORITY,
    transactionId: null,
    referenceId: null,
    createdAt: new Date("2026-09-11T09:00:00.000Z"),
    verifiedAt: null,
    ...overrides,
  };
}

/** The PENDING subscription row the activation step loads (with its plan). */
function pendingSubscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    accountId: "acc-1",
    planId: "plan-pro",
    status: "PENDING",
    startDate: new Date("2026-09-11T09:00:00.000Z"),
    endDate: null,
    autoRenew: false,
    createdAt: new Date("2026-09-11T09:00:00.000Z"),
    updatedAt: new Date("2026-09-11T09:00:00.000Z"),
    plan: { key: "PRO", billingInterval: "MONTHLY", isActive: true },
    ...overrides,
  };
}

function stubProvider(verification: { status: "VERIFIED" | "REJECTED"; referenceId: string | null; code: number | null }) {
  return {
    name: "zarinpal" as const,
    createPayment: vi.fn(),
    verifyPayment: vi.fn().mockResolvedValue(verification),
  };
}

async function importService() {
  return import("./subscriptionVerificationService");
}

function firstInvocationOrder(fn: { mock: { invocationCallOrder: number[] } }): number {
  return fn.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
}

beforeEach(() => {
  vi.clearAllMocks();

  prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
    // Interactive form (activation) and array form (definitive failure) both
    // appear in this service.
    if (Array.isArray(arg)) {
      return Promise.all(arg as Promise<unknown>[]);
    }
    return (arg as (tx: unknown) => unknown)(prismaMock);
  });
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.subscriptionPayment.findFirst.mockResolvedValue(paymentRow());
  prismaMock.subscriptionPayment.findUnique.mockResolvedValue(paymentRow());
  prismaMock.subscription.findUnique.mockResolvedValue(pendingSubscriptionRow());
  prismaMock.subscriptionPayment.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.subscription.updateMany.mockResolvedValue({ count: 1 });

  // Default: the factory resolves the REAL sandbox adapter from the row's
  // provider column — the same adapter the checkout used.
  factory.getPaymentProvider.mockReturnValue(createSandboxProvider({}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("subscription verification — pure helpers", () => {
  it.each([
    ["OK", "OK"],
    ["ok", "OK"],
    ["NOK", "NOK"],
    ["nok", "NOK"],
    [" Nok ", "NOK"],
  ])("normalizes gateway status %j to %j", (raw, expected) => {
    expect(normalizeGatewayStatus(raw)).toBe(expected);
  });

  it.each([undefined, null, "", "PAID", "SUCCESS"])("maps unusable status %j to null", (raw) => {
    expect(normalizeGatewayStatus(raw as string)).toBeNull();
  });

  it("computes a MONTHLY window with calendar awareness (Jan 31 → Feb 28)", () => {
    const end = computeSubscriptionWindowEnd(new Date("2026-01-31T12:00:00.000Z"), "MONTHLY");
    expect(end.toISOString()).toBe("2026-02-28T12:00:00.000Z");
  });

  it("refuses an unknown billing interval instead of guessing", () => {
    expect(() => computeSubscriptionWindowEnd(NOW, "YEARLY")).toThrow(EntitlementDataError);
    expect(() => computeSubscriptionWindowEnd(NOW, "WEEKLY")).toThrow(EntitlementDataError);
  });
});

// ---------------------------------------------------------------------------
// Authority resolution
// ---------------------------------------------------------------------------

describe("subscription verification — authority resolution", () => {
  it.each([undefined, "", "   "])("refuses an unusable authority (%j) before any lookup", async (authority) => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const service = await importService();

    await expect(
      service.verifySubscriptionCallback({ authority: authority as string }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(prismaMock.subscriptionPayment.findFirst).not.toHaveBeenCalled();
    expect(factory.getPaymentProvider).not.toHaveBeenCalled();
  });

  it("rejects an unknown authority with NotFoundError and writes nothing", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const service = await importService();

    prismaMock.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      service.verifySubscriptionCallback({ authority: "A-UNKNOWN" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
    expect(factory.getPaymentProvider).not.toHaveBeenCalled();
  });

  it("resolves the provider from the ROW's provider column, never from the query", async () => {
    const service = await importService();
    const stub = stubProvider({ status: "VERIFIED", referenceId: "1", code: 100 });
    factory.getPaymentProvider.mockReturnValue(stub);

    prismaMock.subscriptionPayment.findFirst.mockResolvedValue(
      paymentRow({ provider: "zarinpal" }),
    );
    prismaMock.subscriptionPayment.findUnique.mockResolvedValue(paymentRow({ provider: "zarinpal" }));

    await service.verifySubscriptionCallback({
      authority: AUTHORITY,
      gatewayStatus: "OK",
      // A client-sent provider hint must not exist; nothing in the input type
      // could carry it — asserted by the factory call argument below.
    });

    expect(factory.getPaymentProvider).toHaveBeenCalledWith("zarinpal");
  });

  it("refuses a row naming an unknown provider instead of verifying against it", async () => {
    const service = await importService();
    prismaMock.subscriptionPayment.findFirst.mockResolvedValue(paymentRow({ provider: "stripe" }));

    await expect(
      service.verifySubscriptionCallback({ authority: AUTHORITY, gatewayStatus: "OK" }),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Terminal rows: idempotent, never re-verified, never re-activated
// ---------------------------------------------------------------------------

describe("subscription verification — terminal (non-PENDING) rows", () => {
  it("returns ALREADY_VERIFIED for a SUCCESS row without calling the provider or writing", async () => {
    const service = await importService();
    prismaMock.subscriptionPayment.findFirst.mockResolvedValue(paymentRow({ status: "SUCCESS" }));

    const result = await service.verifySubscriptionCallback({ authority: AUTHORITY, gatewayStatus: "OK" });

    expect(result).toEqual({ status: "ALREADY_VERIFIED", paymentId: "sp-1", planKey: null });
    expect(factory.getPaymentProvider).not.toHaveBeenCalled();
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["FAILED", paymentRow({ status: "FAILED" })],
    ["CANCELLED (superseded checkout)", paymentRow({ status: "CANCELLED" })],
    ["REFUNDED", paymentRow({ status: "REFUNDED" })],
  ])("returns REJECTED for a %s row — never re-verified, never activated", async (_label, row) => {
    const service = await importService();
    prismaMock.subscriptionPayment.findFirst.mockResolvedValue(row);

    const result = await service.verifySubscriptionCallback({ authority: AUTHORITY, gatewayStatus: "OK" });

    expect(result.status).toBe("REJECTED");
    expect(factory.getPaymentProvider).not.toHaveBeenCalled();
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gateway NOK (payer abandoned the checkout)
// ---------------------------------------------------------------------------

describe("subscription verification — gateway NOK", () => {
  it.each(["NOK", "nok", "Nok"])(
    "marks the payment FAILED and subscription PAYMENT_FAILED for gatewayStatus %s without a verify call",
    async (gatewayStatus) => {
      const service = await importService();

      const result = await service.verifySubscriptionCallback({ authority: AUTHORITY, gatewayStatus });

      expect(result).toEqual({ status: "REJECTED", paymentId: "sp-1", planKey: null });
      expect(factory.getPaymentProvider).not.toHaveBeenCalled();

      // Both terminal writes in ONE transaction, guarded by status PENDING.
      const lastCall = prismaMock.$transaction.mock.calls.at(-1)?.[0] as unknown;
      expect(Array.isArray(lastCall)).toBe(true);
      expect(prismaMock.subscriptionPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "sp-1", status: "PENDING" },
        data: { status: "FAILED" },
      });
      expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith({
        where: { id: "sub-1", status: "PENDING" },
        data: { status: "PAYMENT_FAILED" },
      });
    },
  );

  it("does not touch an already-terminal row on a repeated NOK callback", async () => {
    const service = await importService();
    prismaMock.subscriptionPayment.findFirst.mockResolvedValue(paymentRow({ status: "FAILED" }));

    const result = await service.verifySubscriptionCallback({ authority: AUTHORITY, gatewayStatus: "NOK" });

    expect(result.status).toBe("REJECTED");
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Verified → activation
// ---------------------------------------------------------------------------

describe("subscription verification — verified payment activation", () => {
  it("runs the FULL sandbox round trip: verifies, then activates with a one-month window", async () => {
    const service = await importService();

    const result = await service.verifySubscriptionCallback(
      { authority: AUTHORITY, gatewayStatus: "OK" },
      { now: NOW },
    );

    // The real sandbox provider verified the SBX authority and produced a
    // deterministic reference id, which was persisted.
    expect(result).toEqual({ status: "VERIFIED", paymentId: "sp-1", planKey: "PRO" });

    const paymentWrite = prismaMock.subscriptionPayment.updateMany.mock.calls[0]?.[0] as {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    };
    expect(paymentWrite.where).toEqual({ id: "sp-1", status: "PENDING" });
    expect(paymentWrite.data.status).toBe("SUCCESS");
    expect(paymentWrite.data.verifiedAt).toBe(NOW);
    expect(String(paymentWrite.data.referenceId)).toBe(
      `${SANDBOX_REFERENCE_PREFIX}${AUTHORITY.slice(3, 15)}`,
    );

    const subscriptionWrite = prismaMock.subscription.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(subscriptionWrite.where).toEqual({ id: "sub-1", status: "PENDING" });
    expect(subscriptionWrite.data).toEqual({
      status: "ACTIVE",
      startDate: NOW,
      endDate: ONE_MONTH_LATER,
    });
  });

  it("retires the bootstrap FREE baseline of the SAME account only, without touching the new subscription", async () => {
    const service = await importService();

    await service.verifySubscriptionCallback({ authority: AUTHORITY }, { now: NOW });

    expect(prismaMock.subscription.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.subscription.updateMany).toHaveBeenLastCalledWith({
      where: {
        accountId: "acc-1",
        status: "ACTIVE",
        id: { not: "sub-1" },
        plan: { key: "FREE" },
      },
      data: { status: "EXPIRED", endDate: NOW },
    });
  });

  it("verifies OUTSIDE the transaction and locks the payment row as the FIRST statement inside it", async () => {
    const service = await importService();
    const stub = stubProvider({ status: "VERIFIED", referenceId: "100", code: 100 });
    factory.getPaymentProvider.mockReturnValue(stub);

    await service.verifySubscriptionCallback({ authority: AUTHORITY });

    // Provider call happened, then exactly one interactive transaction.
    expect(stub.verifyPayment).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(firstInvocationOrder(stub.verifyPayment)).toBeLessThan(
      firstInvocationOrder(prismaMock.$transaction),
    );

    // Lock first, re-read second, inside the transaction.
    const lockSql = prismaMock.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(lockSql.join("?")).toContain("subscription_payments");
    expect(lockSql.join("?")).toContain("FOR UPDATE");
    const lockValues = prismaMock.$queryRaw.mock.calls[0]?.slice(1) as unknown[];
    expect(lockValues).toContain("sp-1");
    expect(firstInvocationOrder(prismaMock.$queryRaw)).toBeLessThan(
      firstInvocationOrder(prismaMock.subscriptionPayment.findUnique),
    );
    expect(firstInvocationOrder(prismaMock.$queryRaw)).toBeLessThan(
      firstInvocationOrder(prismaMock.subscription.updateMany),
    );
  });

  it("sends the DATABASE amount and currency to the provider (nothing from the query)", async () => {
    const service = await importService();
    const stub = stubProvider({ status: "VERIFIED", referenceId: "1", code: 100 });
    factory.getPaymentProvider.mockReturnValue(stub);

    // The callback carries no amount at all — and even a hostile extra query
    // parameter could not reach the provider, because the input type has no
    // such field. The DB Decimal price is the only source.
    await service.verifySubscriptionCallback({ authority: AUTHORITY });

    const input = stub.verifyPayment.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.amount).toBe(990000);
    expect(typeof input.amount).toBe("number");
    expect(input.currency).toBe("IRR");
    expect(input.authority).toBe(AUTHORITY);
  });

  it("uses the plan's billing interval for the window (Jan 31 start → Feb 28 end)", async () => {
    const service = await importService();
    const jan31 = new Date("2026-01-31T12:00:00.000Z");

    prismaMock.subscription.findUnique.mockResolvedValue(pendingSubscriptionRow());
    await service.verifySubscriptionCallback({ authority: AUTHORITY }, { now: jan31 });

    const subscriptionWrite = prismaMock.subscription.updateMany.mock.calls[0]?.[0] as {
      data: { endDate: Date };
    };
    expect(subscriptionWrite.data.endDate.toISOString()).toBe("2026-02-28T12:00:00.000Z");
  });

  it("refuses to activate when the payment's subscription/plan cannot be resolved", async () => {
    const service = await importService();
    prismaMock.subscription.findUnique.mockResolvedValue(null);

    await expect(
      service.verifySubscriptionCallback({ authority: AUTHORITY }, { now: NOW }),
    ).rejects.toBeInstanceOf(EntitlementDataError);

    // No terminal writes: the row stays PENDING for retry/reconciliation.
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an unknown billing interval stored on the plan", async () => {
    const service = await importService();
    prismaMock.subscription.findUnique.mockResolvedValue(
      pendingSubscriptionRow({ plan: { key: "PRO", billingInterval: "YEARLY", isActive: true } }),
    );

    await expect(
      service.verifySubscriptionCallback({ authority: AUTHORITY }, { now: NOW }),
    ).rejects.toBeInstanceOf(EntitlementDataError);
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it("handles a racing callback: the loser re-reads SUCCESS under the lock and reports ALREADY_VERIFIED without writing", async () => {
    const service = await importService();
    // Under the lock, the winner's activation is already committed.
    prismaMock.subscriptionPayment.findUnique.mockResolvedValue(paymentRow({ status: "SUCCESS" }));

    const result = await service.verifySubscriptionCallback(
      { authority: AUTHORITY },
      { now: NOW },
    );

    expect(result).toEqual({ status: "ALREADY_VERIFIED", paymentId: "sp-1", planKey: null });
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it("handles a racing definitive failure: the loser re-reads FAILED under the lock and reports REJECTED", async () => {
    const service = await importService();
    prismaMock.subscriptionPayment.findUnique.mockResolvedValue(paymentRow({ status: "FAILED" }));

    const result = await service.verifySubscriptionCallback({ authority: AUTHORITY }, { now: NOW });

    expect(result.status).toBe("REJECTED");
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it("persists referenceId only when the gateway supplied one", async () => {
    const service = await importService();
    const stub = stubProvider({ status: "VERIFIED", referenceId: null, code: 100 });
    factory.getPaymentProvider.mockReturnValue(stub);

    await service.verifySubscriptionCallback({ authority: AUTHORITY });

    const paymentWrite = prismaMock.subscriptionPayment.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(paymentWrite.data.status).toBe("SUCCESS");
    expect(paymentWrite.data).not.toHaveProperty("referenceId");
  });
});

// ---------------------------------------------------------------------------
// Definitive gateway rejection
// ---------------------------------------------------------------------------

describe("subscription verification — definitive gateway rejection", () => {
  it("marks the payment FAILED and subscription PAYMENT_FAILED when the provider rejects", async () => {
    const service = await importService();
    const stub = stubProvider({ status: "REJECTED", referenceId: null, code: -51 });
    factory.getPaymentProvider.mockReturnValue(stub);

    const result = await service.verifySubscriptionCallback({ authority: AUTHORITY });

    expect(result).toEqual({ status: "REJECTED", paymentId: "sp-1", planKey: null });
    expect(stub.verifyPayment).toHaveBeenCalledTimes(1);

    const lastCall = prismaMock.$transaction.mock.calls.at(-1)?.[0] as unknown;
    expect(Array.isArray(lastCall)).toBe(true);
    expect(prismaMock.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: { id: "sp-1", status: "PENDING" },
      data: { status: "FAILED" },
    });
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", status: "PENDING" },
      data: { status: "PAYMENT_FAILED" },
    });
  });
});

// ---------------------------------------------------------------------------
// Gateway transport failures: rows stay PENDING (retryable)
// ---------------------------------------------------------------------------

describe("subscription verification — gateway failures leave rows retryable", () => {
  it.each([
    ["unavailable", new PaymentProviderUnavailableError()],
    ["gateway error", new PaymentProviderError()],
    ["unexpected transport error", new Error("ECONNRESET")],
  ])("propagates a %s without writing any terminal state", async (_label, failure) => {
    const service = await importService();
    const stub = {
      name: "zarinpal" as const,
      createPayment: vi.fn(),
      verifyPayment: vi.fn().mockRejectedValue(failure),
    };
    factory.getPaymentProvider.mockReturnValue(stub);

    await expect(
      service.verifySubscriptionCallback({ authority: AUTHORITY }),
    ).rejects.toBeInstanceOf(Error);

    // Money may have moved: nothing is marked FAILED on a transport failure.
    expect(prismaMock.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Account isolation
// ---------------------------------------------------------------------------

describe("subscription verification — account isolation", () => {
  it("scopes every activation write to the payment's own account and rows", async () => {
    const service = await importService();
    const other = paymentRow({ id: "sp-other", accountId: "acc-other", subscriptionId: "sub-other" });
    prismaMock.subscriptionPayment.findFirst.mockResolvedValue(other);
    prismaMock.subscriptionPayment.findUnique.mockResolvedValue(other);
    prismaMock.subscription.findUnique.mockResolvedValue(
      pendingSubscriptionRow({ id: "sub-other", accountId: "acc-other" }),
    );

    await service.verifySubscriptionCallback({ authority: AUTHORITY }, { now: NOW });

    // The lock targets exactly the resolved row id.
    const lockValues = prismaMock.$queryRaw.mock.calls[0]?.slice(1) as unknown[];
    expect(lockValues).toContain("sp-other");
    expect(lockValues).not.toContain("sp-1");

    // The FREE-baseline retirement is scoped to the payment's account and
    // excludes the newly activated subscription.
    expect(prismaMock.subscription.updateMany).toHaveBeenLastCalledWith({
      where: {
        accountId: "acc-other",
        status: "ACTIVE",
        id: { not: "sub-other" },
        plan: { key: "FREE" },
      },
      data: { status: "EXPIRED", endDate: NOW },
    });
  });
});
