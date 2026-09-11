import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import { ValidationError } from "@/server/errors";
import { createSandboxProvider } from "@/server/payments/providers/sandbox";
import { InvalidPaymentAmountError } from "@/server/payments/paymentErrors";

/**
 * Unit tests for the SaaS subscription checkout service, in the same style as
 * `src/server/payment/paymentService.test.ts`: the Prisma singleton is mocked
 * (no PostgreSQL needed) and only the delegates the service actually uses are
 * stubbed.
 *
 * `@/server/auth/requireSession` is deliberately NOT bypassed semantically —
 * it is mocked with the same re-declared error classes the invoice payment
 * tests use (auth-options.ts throws at import when GOOGLE_CLIENT_ID is unset).
 *
 * The payment provider is covered two ways:
 *   - via the mocked factory returning the REAL sandbox adapter (so the
 *     "successful sandbox payment creation" path exercises the actual
 *     provider → money → callback URL composition), and
 *   - via the service's internal `provider` option with a stub for
 *     gateway-failure scenarios.
 *
 * Concurrency note: as in `paymentService.test.ts`, a true two-connection
 * race cannot be reproduced against a mocked client — the lock/tx tests below
 * assert the lock ORDER and the PENDING-scoped compensation guards; real
 * PostgreSQL integration testing remains necessary.
 *
 * Realistic default state: unless a test overrides it, the mocked
 * `subscription.findMany` returns the row `bootstrap.ts` actually creates at
 * signup — an ACTIVE, open-ended FREE subscription. An empty list would be an
 * idealized state no production account is ever in, and it is exactly what
 * let the original "FREE baseline blocks checkout" bug hide.
 */
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  // The raw `SELECT id FROM "accounts" ... FOR UPDATE` checkout lock.
  $queryRaw: vi.fn(),
  plan: {
    findUnique: vi.fn(),
  },
  subscription: {
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  subscriptionPayment: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const requireSession = vi.hoisted(() => vi.fn());
const factory = vi.hoisted(() => ({ getPaymentProvider: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Same treatment as paymentService.test.ts: do not importOriginal() —
// auth-options.ts throws at load time when GOOGLE_CLIENT_ID is unset.
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

vi.mock("@/server/payments/factory", () => factory);

const SESSION = { userId: "user-1", accountId: "acc-1" };

/** The seeded-style PRO plan: database price in IRR. */
function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-pro",
    key: "PRO",
    name: "حرفه‌ای",
    price: new Decimal("990000"),
    currency: "IRR",
    isActive: true,
    ...overrides,
  };
}

/**
 * A PAID (PRO) subscription row as `selectCurrentSubscription()` needs it,
 * including the plan key the checkout guard reads.
 */
function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    accountId: "acc-1",
    planId: "plan-pro",
    status: "ACTIVE",
    startDate: new Date("2026-08-01T00:00:00.000Z"),
    endDate: new Date("2026-12-01T00:00:00.000Z"),
    autoRenew: false,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    plan: { key: "PRO", isActive: true },
    ...overrides,
  };
}

/**
 * Exactly the row `bootstrap.ts` creates at first login: an ACTIVE
 * subscription on the seeded FREE plan with startDate=now and NO endDate —
 * open-ended. Every real account has one of these from day one.
 */
function bootstrapFreeSubscriptionRow(overrides: Record<string, unknown> = {}) {
  return subscriptionRow({
    id: "sub-bootstrap-free",
    planId: "plan-free",
    plan: { key: "FREE", isActive: true },
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: null,
    ...overrides,
  });
}

const CALLBACK_BASE = "http://localhost:3000/api/payments/callback";

async function importService() {
  return import("./subscriptionPaymentService");
}

function firstInvocationOrder(fn: { mock: { invocationCallOrder: number[] } }): number {
  return fn.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PAYMENT_CALLBACK_URL", CALLBACK_BASE);

  prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
    // Interactive form (checkout state creation) and array form (atomic
    // compensation) both appear in this service.
    if (Array.isArray(arg)) {
      return Promise.all(arg as Promise<unknown>[]);
    }
    return (arg as (tx: unknown) => unknown)(prismaMock);
  });
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.plan.findUnique.mockResolvedValue(planRow());
  // Realistic bootstrap state: ACTIVE/FREE/open-ended (see file docblock).
  prismaMock.subscription.findMany.mockResolvedValue([bootstrapFreeSubscriptionRow()]);
  prismaMock.subscription.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "sub-new",
    accountId: data.accountId,
    planId: data.planId,
    status: data.status,
    startDate: new Date("2026-09-11T00:00:00.000Z"),
    endDate: null,
    autoRenew: false,
    createdAt: new Date("2026-09-11T00:00:00.000Z"),
    updatedAt: new Date("2026-09-11T00:00:00.000Z"),
  }));
  prismaMock.subscription.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.subscriptionPayment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "sp-new",
    accountId: data.accountId,
    subscriptionId: data.subscriptionId,
    provider: data.provider,
    amount: data.amount,
    currency: data.currency,
    status: data.status,
    authority: null,
    transactionId: null,
    referenceId: null,
    createdAt: new Date("2026-09-11T00:00:00.000Z"),
    verifiedAt: null,
  }));
  prismaMock.subscriptionPayment.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    }),
  );
  prismaMock.subscriptionPayment.updateMany.mockResolvedValue({ count: 0 });

  requireSession.mockResolvedValue(SESSION);

  // Default: the factory resolves the REAL sandbox adapter (the configured
  // default-gateway path), so authority/redirectUrl semantics are real.
  factory.getPaymentProvider.mockReturnValue(createSandboxProvider({}));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Authentication gate
// ---------------------------------------------------------------------------

describe("subscription checkout — authentication", () => {
  it("rejects an unauthenticated request before touching plans or creating rows", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const service = await importService();

    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
    expect(prismaMock.subscriptionPayment.create).not.toHaveBeenCalled();
  });

  it("runs the session check BEFORE input validation (auth is the first gate)", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const service = await importService();

    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(service.createSubscriptionCheckout({ planKey: "NOT-A-KEY" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("derives the account from the session only — a client-sent accountId is an unknown field", async () => {
    const service = await importService();

    await expect(
      service.createSubscriptionCheckout({ planKey: "PRO", accountId: "acc-victim" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Input validation / plan resolution
// ---------------------------------------------------------------------------

describe("subscription checkout — validation and plan resolution", () => {
  it("rejects a planKey outside the PlanKey vocabulary", async () => {
    const service = await importService();

    await expect(service.createSubscriptionCheckout({ planKey: "GOLD" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
    expect(factory.getPaymentProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["null body", null],
    ["string body", "PRO"],
    ["missing planKey", {}],
    ["array body", [{ planKey: "PRO" }]],
  ])("rejects %s with a validation error", async (_label, body) => {
    const service = await importService();
    await expect(service.createSubscriptionCheckout(body)).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a client-supplied amount, currency, provider, callback or redirect URL (strict payload)", async () => {
    const service = await importService();

    await expect(
      service.createSubscriptionCheckout({ planKey: "PRO", amount: 1000 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createSubscriptionCheckout({ planKey: "PRO", currency: "USD" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createSubscriptionCheckout({ planKey: "PRO", provider: "sandbox" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createSubscriptionCheckout({
        planKey: "PRO",
        callbackUrl: "https://attacker.example/callback",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.createSubscriptionCheckout({
        planKey: "PRO",
        redirectUrl: "https://attacker.example/pay",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
  });

  it("rejects the FREE plan as non-purchasable", async () => {
    const service = await importService();
    prismaMock.plan.findUnique.mockResolvedValue(planRow({ id: "plan-free", key: "FREE", price: new Decimal("0") }));

    await expect(service.createSubscriptionCheckout({ planKey: "FREE" })).rejects.toThrow(
      /FREE plan cannot be purchased/,
    );
    expect(factory.getPaymentProvider).not.toHaveBeenCalled();
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
    expect(prismaMock.subscriptionPayment.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown plan (key parses but no plan row exists)", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const service = await importService();

    prismaMock.plan.findUnique.mockResolvedValue(null);

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(factory.getPaymentProvider).not.toHaveBeenCalled();
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
  });

  it("resolves the plan from the database by planKey (never from the payload)", async () => {
    const service = await importService();

    await service.createSubscriptionCheckout({ planKey: "BASIC" });

    expect(prismaMock.plan.findUnique).toHaveBeenCalledWith({
      where: { key: "BASIC" },
      select: { id: true, key: true, name: true, price: true, currency: true, isActive: true },
    });
  });

  it("rejects a deactivated plan", async () => {
    const service = await importService();
    prismaMock.plan.findUnique.mockResolvedValue(planRow({ isActive: false }));

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toThrow(
      /not currently available/,
    );
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
  });

  it("rejects a zero-priced (mispriced seed) paid plan", async () => {
    const service = await importService();
    prismaMock.plan.findUnique.mockResolvedValue(planRow({ price: new Decimal("0") }));

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toThrow(
      /not available for purchase/,
    );
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
  });

  it("refuses a gateway-unconfigured environment before creating any rows", async () => {
    const { PaymentProviderNotConfiguredError } = await import("@/server/payments/paymentErrors");
    const service = await importService();

    factory.getPaymentProvider.mockImplementation(() => {
      throw new PaymentProviderNotConfiguredError();
    });

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
    expect(prismaMock.subscriptionPayment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful checkout
// ---------------------------------------------------------------------------

describe("subscription checkout — successful sandbox payment creation", () => {
  it("creates a PENDING subscription + payment, calls the sandbox gateway and persists the authority", async () => {
    const service = await importService();

    const result = await service.createSubscriptionCheckout({ planKey: "PRO" });

    // Pending subscription created explicitly as PENDING (schema default is
    // ACTIVE — activation must only ever happen in the verify step).
    expect(prismaMock.subscription.create).toHaveBeenCalledWith({
      data: {
        accountId: "acc-1",
        planId: "plan-pro",
        status: "PENDING",
        autoRenew: false,
      },
    });

    // Pending payment created from DATABASE price/currency.
    const paymentCreate = prismaMock.subscriptionPayment.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(paymentCreate.data).toMatchObject({
      accountId: "acc-1",
      subscriptionId: "sub-new",
      provider: "sandbox",
      currency: "IRR",
      status: "PENDING",
    });
    expect((paymentCreate.data.amount as Decimal).toString()).toBe("990000");

    // The gateway was asked through the factory-resolved provider with the
    // DATABASE amount (integer IRR), not any client-supplied number.
    expect(factory.getPaymentProvider).toHaveBeenCalledWith();

    // A real sandbox authority was persisted onto the payment row.
    expect(prismaMock.subscriptionPayment.update).toHaveBeenCalledTimes(1);
    const update = prismaMock.subscriptionPayment.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { authority: string };
    };
    expect(update.where.id).toBe("sp-new");
    expect(update.data.authority).toMatch(/^SBX[0-9A-F]{32}$/);

    // Safe result payload: redirect to the sandbox StartPay page + opaque id.
    expect(result.paymentId).toBe("sp-new");
    expect(result.redirectUrl).toBe(
      `http://localhost:3000/payments/sandbox/StartPay/${update.data.authority}`,
    );
    expect(Object.keys(result).sort()).toEqual(["paymentId", "redirectUrl"]);
  });

  it("passes the DB-derived integer amount and the subscription-stamped callback URL to the provider", async () => {
    const service = await importService();
    const stubProvider = {
      name: "sandbox" as const,
      createPayment: vi.fn().mockResolvedValue({
        authority: "SBXTEST",
        redirectUrl: "http://localhost:3000/payments/sandbox/StartPay/SBXTEST",
      }),
      verifyPayment: vi.fn(),
    };

    await service.createSubscriptionCheckout({ planKey: "PRO" }, { provider: stubProvider });

    expect(stubProvider.createPayment).toHaveBeenCalledTimes(1);
    const input = stubProvider.createPayment.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.amount).toBe(990000); // gateway unit, from plans.price
    expect(typeof input.amount).toBe("number");
    expect(input.currency).toBe("IRR");
    expect(input.callbackUrl).toBe(`${CALLBACK_BASE}?kind=subscription`);
    expect(input.description).toContain("PRO");
    expect((input.metadata as Record<string, string>).order_id).toBe("sp-new");
  });

  it("uses the DB amount even when the client tries to send a fake amount", async () => {
    const service = await importService();

    // 1 hinging: the fake amount is an unknown field and rejected outright…
    await expect(
      service.createSubscriptionCheckout({ planKey: "PRO", amount: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.subscriptionPayment.create).not.toHaveBeenCalled();

    // …and the only amount that can ever reach the provider is the DB price.
    const stubProvider = {
      name: "sandbox" as const,
      createPayment: vi.fn().mockResolvedValue({ authority: "SBXOK", redirectUrl: "u" }),
      verifyPayment: vi.fn(),
    };
    await service.createSubscriptionCheckout({ planKey: "PRO" }, { provider: stubProvider });
    const input = stubProvider.createPayment.mock.calls[0]?.[0] as { amount: number };
    expect(input.amount).toBe(990000);
    expect(input.amount).not.toBe(1);
  });

  it("locks the account row (SELECT ... FOR UPDATE) as the FIRST statement, before reading subscriptions", async () => {
    const service = await importService();

    await service.createSubscriptionCheckout({ planKey: "PRO" });

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    const [template, ...values] = prismaMock.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(template.join("?")).toContain("accounts");
    expect(template.join("?")).toContain("FOR UPDATE");
    expect(values).toContain("acc-1");

    // Lock strictly before the subscription read and both creates.
    expect(firstInvocationOrder(prismaMock.$queryRaw)).toBeLessThan(
      firstInvocationOrder(prismaMock.subscription.findMany),
    );
    expect(firstInvocationOrder(prismaMock.subscription.findMany)).toBeLessThan(
      firstInvocationOrder(prismaMock.subscription.create),
    );
  });

  it("wraps the pending-state creation in an interactive transaction", async () => {
    const service = await importService();
    await service.createSubscriptionCheckout({ planKey: "PRO" });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("supersedes stale PENDING checkouts (cancelled, never left competing)", async () => {
    const service = await importService();
    prismaMock.subscription.findMany.mockResolvedValue([
      // A previous abandoned checkout: pending subscription, no paid window.
      subscriptionRow({ id: "sub-old", status: "PENDING", startDate: new Date("2026-09-01T00:00:00.000Z"), endDate: null }),
    ]);

    await service.createSubscriptionCheckout({ planKey: "PRO" });

    expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1", status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    expect(prismaMock.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1", status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    // Superseding happens under the lock, before the new rows are created.
    expect(firstInvocationOrder(prismaMock.subscription.updateMany)).toBeLessThan(
      firstInvocationOrder(prismaMock.subscription.create),
    );
  });

  it("never cancels the ACTIVE FREE bootstrap baseline while superseding stale checkouts", async () => {
    const service = await importService();
    prismaMock.subscription.findMany.mockResolvedValue([
      bootstrapFreeSubscriptionRow(), // ACTIVE, not pending — must survive
      subscriptionRow({ id: "sub-old", status: "PENDING", endDate: null, startDate: new Date("2026-09-01T00:00:00.000Z") }),
    ]);

    await service.createSubscriptionCheckout({ planKey: "PRO" });

    // Exactly one subscription updateMany: the PENDING supersede. The FREE
    // baseline is never cancelled by checkout — retiring it belongs to the
    // verify step.
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1", status: "PENDING" },
      data: { status: "CANCELLED" },
    });
  });

  it("reads subscriptions in the shared newest-first order", async () => {
    const service = await importService();
    await service.createSubscriptionCheckout({ planKey: "PRO" });

    const args = prismaMock.subscription.findMany.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.orderBy).toEqual([
      { startDate: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// FREE bootstrap baseline vs. paid subscriptions (regression: PR #28 review)
// ---------------------------------------------------------------------------

describe("subscription checkout — FREE bootstrap baseline must not block purchase", () => {
  it("regression: a fresh account with only the bootstrap ACTIVE/FREE/open-ended subscription can start a PRO checkout", async () => {
    const service = await importService();

    // Exactly what bootstrap.ts leaves behind at first login.
    prismaMock.subscription.findMany.mockResolvedValue([bootstrapFreeSubscriptionRow()]);

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).resolves.toMatchObject({
      paymentId: "sp-new",
    });
    expect(prismaMock.subscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId: "acc-1", planId: "plan-pro", status: "PENDING" }),
    });
    expect(prismaMock.subscriptionPayment.create).toHaveBeenCalled();
  });

  it("regression: the bootstrap FREE baseline does not block a BASIC checkout either", async () => {
    const service = await importService();

    prismaMock.subscription.findMany.mockResolvedValue([bootstrapFreeSubscriptionRow()]);

    await expect(service.createSubscriptionCheckout({ planKey: "BASIC" })).resolves.toMatchObject({
      paymentId: "sp-new",
    });
    expect(prismaMock.subscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ planId: "plan-pro", status: "PENDING" }),
    });
  });

  it("regression: the bootstrap FREE baseline stays ACTIVE (checkout never cancels it)", async () => {
    const service = await importService();

    prismaMock.subscription.findMany.mockResolvedValue([bootstrapFreeSubscriptionRow()]);

    await service.createSubscriptionCheckout({ planKey: "PRO" });

    // The supersede write targets PENDING rows only; the ACTIVE FREE row is
    // never touched by checkout. Retiring it belongs to the verify step.
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1", status: "PENDING" },
      data: { status: "CANCELLED" },
    });
  });
});

// ---------------------------------------------------------------------------
// Already-active / competing PAID subscriptions
// ---------------------------------------------------------------------------

describe("subscription checkout — already-active paid subscription handling", () => {
  it.each([
    ["ACTIVE PRO inside its paid window", subscriptionRow()],
    ["ACTIVE PRO with no end date (open-ended)", subscriptionRow({ endDate: null })],
    ["ACTIVE BASIC (any paid plan blocks)", subscriptionRow({ plan: { key: "BASIC", isActive: true } })],
  ])("refuses to create a competing checkout when a subscription is %s", async (_label, granting) => {
    const { SubscriptionAlreadyActiveError } = await import("@/server/errors");
    const service = await importService();

    prismaMock.subscription.findMany.mockResolvedValue([granting]);

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toBeInstanceOf(
      SubscriptionAlreadyActiveError,
    );
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
    expect(prismaMock.subscriptionPayment.create).not.toHaveBeenCalled();
    expect(factory.getPaymentProvider).not.toHaveBeenCalled();
  });

  it("blocks on the newest granting PAID row even when an older FREE baseline exists", async () => {
    const { SubscriptionAlreadyActiveError } = await import("@/server/errors");
    const service = await importService();

    // Newest-first (SUBSCRIPTION_ORDER_BY): the paid PRO row is in force.
    prismaMock.subscription.findMany.mockResolvedValue([
      subscriptionRow(),
      bootstrapFreeSubscriptionRow(),
    ]);

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toBeInstanceOf(
      SubscriptionAlreadyActiveError,
    );
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
  });

  it("treats a granting row with an unrecognized plan key as paid (pessimistic)", async () => {
    const { SubscriptionAlreadyActiveError } = await import("@/server/errors");
    const service = await importService();

    prismaMock.subscription.findMany.mockResolvedValue([
      subscriptionRow({ plan: { key: "GOLD", isActive: true } }),
    ]);

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toBeInstanceOf(
      SubscriptionAlreadyActiveError,
    );
  });

  it("allows a checkout when the newest subscription is only PENDING (stale) and nothing grants", async () => {
    const service = await importService();

    prismaMock.subscription.findMany.mockResolvedValue([
      subscriptionRow({
        id: "sub-stale",
        status: "PENDING",
        endDate: null,
      }),
    ]);

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).resolves.toMatchObject({
      paymentId: "sp-new",
    });
    expect(prismaMock.subscription.create).toHaveBeenCalled();
  });

  it("treats a lapsed paid subscription (ended window) as not active", async () => {
    const service = await importService();

    prismaMock.subscription.findMany.mockResolvedValue([
      subscriptionRow({
        id: "sub-lapsed",
        status: "ACTIVE",
        startDate: new Date("2025-01-01T00:00:00.000Z"),
        endDate: new Date("2025-12-01T00:00:00.000Z"),
      }),
    ]);

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).resolves.toMatchObject({
      paymentId: "sp-new",
    });
  });

  it("allows a checkout when the paid plan itself was deactivated (retired plan falls back to Free)", async () => {
    const service = await importService();

    prismaMock.subscription.findMany.mockResolvedValue([
      subscriptionRow({ plan: { key: "PRO", isActive: false } }),
    ]);

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).resolves.toMatchObject({
      paymentId: "sp-new",
    });
  });
});

// ---------------------------------------------------------------------------
// Provider failure and compensating state
// ---------------------------------------------------------------------------

describe("subscription checkout — provider failure", () => {
  beforeEach(() => {
    // The service logs gateway failures server-side by design; keep test
    // output clean (the logging itself is exercised implicitly here).
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the payment FAILED and the subscription PAYMENT_FAILED when the gateway rejects", async () => {
    const { PaymentProviderError } = await import("@/server/payments/paymentErrors");
    const service = await importService();

    const failingProvider = {
      name: "zarinpal" as const,
      createPayment: vi.fn().mockRejectedValue(new PaymentProviderError()),
      verifyPayment: vi.fn(),
    };

    await expect(
      service.createSubscriptionCheckout({ planKey: "PRO" }, { provider: failingProvider }),
    ).rejects.toBeInstanceOf(PaymentProviderError);

    expect(prismaMock.subscriptionPayment.update).not.toHaveBeenCalled(); // no authority to persist

    // Compensation is guarded by status: "PENDING" so a concurrent transition
    // can never be clobbered.
    expect(prismaMock.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: { id: "sp-new", status: "PENDING" },
      data: { status: "FAILED" },
    });
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: "sub-new", status: "PENDING" },
      data: { status: "PAYMENT_FAILED" },
    });
  });

  it("compensates and rethrows on a gateway timeout too", async () => {
    const { PaymentProviderUnavailableError } = await import("@/server/payments/paymentErrors");
    const service = await importService();

    const hangingProvider = {
      name: "zarinpal" as const,
      createPayment: vi.fn().mockRejectedValue(new PaymentProviderUnavailableError()),
      verifyPayment: vi.fn(),
    };

    await expect(
      service.createSubscriptionCheckout({ planKey: "BASIC" }, { provider: hangingProvider }),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);

    expect(prismaMock.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: { id: "sp-new", status: "PENDING" },
      data: { status: "FAILED" },
    });
  });

  it("never returns a checkout result when the gateway call fails", async () => {
    const service = await importService();
    const failingProvider = {
      name: "sandbox" as const,
      createPayment: vi.fn().mockRejectedValue(new Error("raw gateway body: oops")),
      verifyPayment: vi.fn(),
    };

    let resolved: unknown = "not-set";
    try {
      resolved = await service.createSubscriptionCheckout({ planKey: "PRO" }, { provider: failingProvider });
    } catch {
      resolved = null;
    }
    expect(resolved).toBeNull();
  });

  it("refuses a mispriced plan (fractional IRR) before any rows exist", async () => {
    const service = await importService();
    prismaMock.plan.findUnique.mockResolvedValue(planRow({ price: new Decimal("990000.5") }));

    await expect(service.createSubscriptionCheckout({ planKey: "PRO" })).rejects.toBeInstanceOf(
      InvalidPaymentAmountError,
    );
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
    expect(prismaMock.subscriptionPayment.create).not.toHaveBeenCalled();
  });

  it("writes both terminal compensation states inside ONE transaction", async () => {
    const { PaymentProviderError } = await import("@/server/payments/paymentErrors");
    const service = await importService();

    const failingProvider = {
      name: "zarinpal" as const,
      createPayment: vi.fn().mockRejectedValue(new PaymentProviderError()),
      verifyPayment: vi.fn(),
    };

    await expect(
      service.createSubscriptionCheckout({ planKey: "PRO" }, { provider: failingProvider }),
    ).rejects.toBeInstanceOf(PaymentProviderError);

    // The compensation is a single array-form $transaction of exactly the two
    // terminal writes — a crash between two independent writes could
    // otherwise leave payment=FAILED on a still-PENDING subscription.
    const lastCall = prismaMock.$transaction.mock.calls.at(-1)?.[0] as unknown;
    expect(Array.isArray(lastCall)).toBe(true);
    expect((lastCall as unknown[]).length).toBe(2);

    // And both writes remain guarded by status: "PENDING".
    expect(prismaMock.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: { id: "sp-new", status: "PENDING" },
      data: { status: "FAILED" },
    });
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: "sub-new", status: "PENDING" },
      data: { status: "PAYMENT_FAILED" },
    });
  });
});

// ---------------------------------------------------------------------------
// Authorization / account isolation
// ---------------------------------------------------------------------------

describe("subscription checkout — account isolation", () => {
  it("scopes every read and write to the session account", async () => {
    const service = await importService();
    const otherSession = { userId: "user-2", accountId: "acc-2" };

    await service.createSubscriptionCheckout({ planKey: "PRO" }, { session: otherSession });

    // The subscription read is account-scoped.
    const findMany = prismaMock.subscription.findMany.mock.calls[0]?.[0] as { where: { accountId: string } };
    expect(findMany.where.accountId).toBe("acc-2");

    // Created rows belong to the session account, never a client-sent one.
    expect(prismaMock.subscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId: "acc-2" }),
    });
    expect(prismaMock.subscriptionPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId: "acc-2" }),
    });

    // The stale-checkout supersede is account-scoped.
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ accountId: "acc-2" }),
      data: { status: "CANCELLED" },
    });
  });

  it("locks the CALLING account's row, not another account's", async () => {
    const service = await importService();
    const otherSession = { userId: "user-2", accountId: "acc-9" };

    await service.createSubscriptionCheckout({ planKey: "PRO" }, { session: otherSession });

    const values = prismaMock.$queryRaw.mock.calls[0]?.slice(1) as unknown[];
    expect(values).toContain("acc-9");
    expect(values).not.toContain("acc-1");
  });

  it("never reads or writes another account's subscription payments", async () => {
    const service = await importService();

    await service.createSubscriptionCheckout({ planKey: "PRO" });

    // Only the newly created payment row is updated (by its server-generated id).
    const update = prismaMock.subscriptionPayment.update.mock.calls[0]?.[0] as {
      where: { id: string };
    };
    expect(update.where.id).toBe("sp-new");
    expect(prismaMock.subscriptionPayment.updateMany).toHaveBeenCalledTimes(1);
    const supersede = prismaMock.subscriptionPayment.updateMany.mock.calls[0]?.[0] as {
      where: { accountId: string };
    };
    expect(supersede.where.accountId).toBe("acc-1");
  });
});
