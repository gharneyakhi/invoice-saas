import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BusinessLimitReachedError, ValidationError } from "@/server/errors";

/**
 * Unit tests for the Business domain layer, in the same style as
 * `src/server/auth/bootstrap.test.ts` and `requireBusinessOwnership.test.ts`:
 * the Prisma singleton is mocked (no PostgreSQL needed) and `$transaction`
 * simply invokes the callback with the same mock delegates.
 *
 * `@/server/auth/requireBusinessOwnership` is deliberately NOT mocked, so the
 * real ownership guard runs against `prismaMock.business.findUnique` and the
 * 403/404 behaviour is covered end to end. The entitlement resolver and its
 * pure subscription-selection/limit rules are also real, not mocked.
 */
const prismaMock = vi.hoisted(() => ({
  business: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    // Present only so we can assert that the archive path never reaches for
    // a hard delete (historical data must survive).
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  businessProfile: {
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  invoiceSettings: {
    create: vi.fn(),
  },
  subscription: {
    findMany: vi.fn(),
  },
  plan: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

// Do not importOriginal() this module: it pulls auth-options.ts, which throws
// at load time when GOOGLE_CLIENT_ID is unset. The error classes are
// re-declared here so instanceof checks match what the guard throws.
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
  return {
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    requireSession,
  };
});

const SESSION = { userId: "user-1", accountId: "acc-1" };
const NOW = new Date("2026-03-15T12:00:00.000Z");

interface BusinessRowOverrides {
  id?: string;
  accountId?: string;
  name?: string;
  isActive?: boolean;
  isLocked?: boolean;
  isPrimary?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  archivedAt?: Date | null;
}

function businessRow(overrides: BusinessRowOverrides = {}) {
  return {
    id: "biz-1",
    accountId: "acc-1",
    name: "کسب‌وکار من",
    isActive: true,
    isLocked: false,
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function planRow(key: "FREE" | "BASIC" | "PRO", businessLimit: number, invoiceLimit: number, features: string[] = []) {
  return {
    id: `plan-${key.toLowerCase()}`,
    key,
    isActive: true,
    businessLimit,
    invoiceLimit,
    planFeatures: features.map((featureKey) => ({ enabled: true, feature: { key: featureKey } })),
  };
}

/** The three plan limits required by the product rules. */
const FREE_PLAN = () => planRow("FREE", 1, 3, ["PDF_EXPORT"]);
const BASIC_PLAN = () => planRow("BASIC", 1, 10, ["EMAIL_SEND"]);
const PRO_PLAN = () => planRow("PRO", 3, 50, ["MULTI_BUSINESS", "ADVANCED_REPORTS"]);

function activeSubscription(plan: ReturnType<typeof PRO_PLAN>) {
  return {
    id: "sub-1",
    accountId: "acc-1",
    status: "ACTIVE",
    startDate: new Date("2026-03-01T00:00:00.000Z"),
    endDate: new Date("2026-04-01T00:00:00.000Z"),
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    plan,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback(prismaMock),
  );
  requireSession.mockResolvedValue(SESSION);
});

describe("listBusinesses", () => {
  it("returns only the authenticated account's businesses, in a stable order, excluding archived rows", async () => {
    const { listBusinesses } = await import("./businessService");

    const rows = [businessRow(), businessRow({ id: "biz-2", isPrimary: false })];
    prismaMock.business.findMany.mockResolvedValue(rows);

    const result = await listBusinesses();

    expect(result).toEqual(rows);
    expect(prismaMock.business.findMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1", archivedAt: null },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("ignores an accountId smuggled in by the caller and filters by the session account", async () => {
    const { listBusinesses } = await import("./businessService");

    prismaMock.business.findMany.mockResolvedValue([]);

    // A JS caller can still hand us extra keys; they must be ignored.
    await listBusinesses({ accountId: "acc-evil" } as unknown as Parameters<typeof listBusinesses>[0]);

    const call = prismaMock.business.findMany.mock.calls[0]?.[0];
    expect(call.where.accountId).toBe("acc-1");
  });

  it("includes archived businesses only when explicitly requested", async () => {
    const { listBusinesses } = await import("./businessService");

    prismaMock.business.findMany.mockResolvedValue([]);

    await listBusinesses({ includeArchived: true });

    expect(prismaMock.business.findMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1" },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("rejects when there is no valid session", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { listBusinesses } = await import("./businessService");

    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(listBusinesses()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.business.findMany).not.toHaveBeenCalled();
  });
});

describe("getBusiness", () => {
  it("returns the business when it belongs to the authenticated account", async () => {
    const { getBusiness } = await import("./businessService");

    const owned = businessRow();
    prismaMock.business.findUnique.mockResolvedValue(owned);

    await expect(getBusiness("biz-1")).resolves.toEqual(owned);
    expect(prismaMock.business.findUnique).toHaveBeenCalledWith({ where: { id: "biz-1" } });
  });

  it("propagates ForbiddenError (403) for another account's business", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { getBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-other", accountId: "acc-other" }));

    await expect(getBusiness("biz-other")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("propagates NotFoundError (404) for a business that does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const { getBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(null);

    await expect(getBusiness("missing-id")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("createBusiness", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates Business + BusinessProfile + InvoiceSettings under the session account when the plan allows it", async () => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([activeSubscription(PRO_PLAN())]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    prismaMock.business.findMany.mockResolvedValue([{ id: "biz-1", isPrimary: true }]);
    prismaMock.business.create.mockResolvedValue(businessRow({ id: "biz-2", isPrimary: false }));

    const result = await createBusiness({ name: "  شعبه دوم  " });

    expect(result.id).toBe("biz-2");
    expect(prismaMock.business.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.business.create).toHaveBeenCalledWith({
      data: { accountId: "acc-1", name: "شعبه دوم", isPrimary: false },
    });
    expect(prismaMock.businessProfile.create).toHaveBeenCalledWith({
      data: { businessId: "biz-2", businessName: "شعبه دوم" },
    });
    expect(prismaMock.invoiceSettings.create).toHaveBeenCalledWith({
      data: { businessId: "biz-2", nextInvoiceNumber: 1 },
    });
  });

  it("counts only the current account's live businesses toward the limit", async () => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([activeSubscription(PRO_PLAN())]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    prismaMock.business.findMany.mockResolvedValue([]);
    prismaMock.business.create.mockResolvedValue(businessRow());

    await createBusiness({ name: "کسب‌وکار جدید" });

    expect(prismaMock.business.findMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1", archivedAt: null },
      select: { id: true, isPrimary: true },
    });
  });

  it("marks the account's first business as primary (primary-business convention)", async () => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([activeSubscription(PRO_PLAN())]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    prismaMock.business.findMany.mockResolvedValue([]); // no live business yet -> no primary yet
    prismaMock.business.create.mockResolvedValue(businessRow({ id: "biz-new", isPrimary: true }));

    await createBusiness({ name: "اولین کسب‌وکار" });

    expect(prismaMock.business.create).toHaveBeenCalledWith({
      data: { accountId: "acc-1", name: "اولین کسب‌وکار", isPrimary: true },
    });
  });

  it.each([
    ["FREE", FREE_PLAN()],
    ["BASIC", BASIC_PLAN()],
  ])("rejects creation with BusinessLimitReachedError when the %s limit (1 business) is reached", async (_planKey, plan) => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([activeSubscription(plan)]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    prismaMock.business.findMany.mockResolvedValue([{ id: "biz-1", isPrimary: true }]);

    await expect(createBusiness({ name: "کسب‌وکار دوم" })).rejects.toBeInstanceOf(BusinessLimitReachedError);

    expect(prismaMock.business.create).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceSettings.create).not.toHaveBeenCalled();
  });

  it("allows up to three businesses on an in-force PRO subscription, but rejects the fourth", async () => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([activeSubscription(PRO_PLAN())]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    const existingBusinesses: Array<{ id: string; isPrimary: boolean }> = [];

    for (let count = 0; count < 3; count += 1) {
      const created = businessRow({ id: `biz-${count + 1}`, isPrimary: count === 0 });
      prismaMock.business.findMany.mockResolvedValue([...existingBusinesses]);
      prismaMock.business.create.mockResolvedValue(created);

      await expect(createBusiness({ name: "کسب‌وکار" })).resolves.toEqual(created);
      existingBusinesses.push({ id: created.id, isPrimary: created.isPrimary });
    }

    prismaMock.business.findMany.mockResolvedValue(existingBusinesses);
    await expect(createBusiness({ name: "چهارم" })).rejects.toMatchObject({
      code: "BUSINESS_LIMIT_REACHED",
      message: "Business limit reached: the PRO plan allows 3 active business(es).",
    });
    expect(prismaMock.business.create).toHaveBeenCalledTimes(3);
    expect(prismaMock.businessProfile.create).toHaveBeenCalledTimes(3);
    expect(prismaMock.invoiceSettings.create).toHaveBeenCalledTimes(3);
  });

  it("falls back to FREE limits when the subscription is not ACTIVE", async () => {
    const { createBusiness } = await import("./businessService");

    // PRO plan (3 businesses) but EXPIRED -> effective limit is FREE's 1.
    prismaMock.subscription.findMany.mockResolvedValue([{
      ...activeSubscription(PRO_PLAN()),
      status: "EXPIRED",
    }]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    prismaMock.business.findMany.mockResolvedValue([{ id: "biz-1", isPrimary: true }]);

    await expect(createBusiness({ name: "کسب‌وکار دوم" })).rejects.toBeInstanceOf(BusinessLimitReachedError);
    expect(prismaMock.business.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "expired by date",
      newest: { ...activeSubscription(BASIC_PLAN()), endDate: new Date("2026-03-10T00:00:00.000Z") },
    },
    {
      reason: "on an inactive plan",
      newest: activeSubscription({ ...BASIC_PLAN(), isActive: false }),
    },
  ])("uses an older effective PRO subscription when the newest by createdAt is $reason", async ({ newest }) => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([
      { ...newest, id: "sub-new" },
      {
        ...activeSubscription(PRO_PLAN()),
        id: "sub-old",
        startDate: new Date("2026-02-01T00:00:00.000Z"),
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    prismaMock.business.findMany.mockResolvedValue([
      { id: "biz-1", isPrimary: true },
      { id: "biz-2", isPrimary: false },
    ]);
    const created = businessRow({ id: "biz-3", isPrimary: false });
    prismaMock.business.create.mockResolvedValue(created);

    await expect(createBusiness({ name: "سوم" })).resolves.toEqual(created);
    expect(prismaMock.business.create).toHaveBeenCalledTimes(1);
  });

  it("enforces the older effective BASIC limit rather than a newer inactive PRO plan", async () => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([
      { ...activeSubscription({ ...PRO_PLAN(), isActive: false }), id: "sub-new" },
      {
        ...activeSubscription(BASIC_PLAN()),
        id: "sub-old",
        startDate: new Date("2026-02-01T00:00:00.000Z"),
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    prismaMock.business.findMany.mockResolvedValue([{ id: "biz-1", isPrimary: true }]);

    await expect(createBusiness({ name: "دوم" })).rejects.toMatchObject({
      code: "BUSINESS_LIMIT_REACHED",
      message: "Business limit reached: the BASIC plan allows 1 active business(es).",
    });
    expect(prismaMock.business.create).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceSettings.create).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "no subscription", subscriptions: [] },
    {
      reason: "date-expired PRO",
      subscriptions: [{ ...activeSubscription(PRO_PLAN()), endDate: NOW }],
    },
    {
      reason: "inactive PRO plan",
      subscriptions: [activeSubscription({ ...PRO_PLAN(), isActive: false })],
    },
    {
      reason: "not-yet-started PRO",
      subscriptions: [{
        ...activeSubscription(PRO_PLAN()),
        startDate: new Date("2026-04-01T00:00:00.000Z"),
        endDate: new Date("2026-05-01T00:00:00.000Z"),
      }],
    },
    {
      reason: "invalid subscription window",
      subscriptions: [{ ...activeSubscription(PRO_PLAN()), endDate: new Date("2026-03-01T00:00:00.000Z") }],
    },
  ])("safely falls back to one FREE business for $reason", async ({ subscriptions }) => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue(subscriptions);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());
    prismaMock.business.findMany.mockResolvedValue([]);
    const created = businessRow();
    prismaMock.business.create.mockResolvedValue(created);

    await expect(createBusiness({ name: "اول" })).resolves.toEqual(created);

    prismaMock.business.findMany.mockResolvedValue([{ id: created.id, isPrimary: true }]);
    await expect(createBusiness({ name: "دوم" })).rejects.toMatchObject({
      code: "BUSINESS_LIMIT_REACHED",
      message: "Business limit reached: the FREE plan allows 1 active business(es).",
    });
    expect(prismaMock.business.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.businessProfile.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.invoiceSettings.create).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an unknown plan key instead of granting its business limit", async () => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([{
      ...activeSubscription(PRO_PLAN()),
      plan: { ...PRO_PLAN(), key: "UNKNOWN" },
    }]);
    prismaMock.plan.findUnique.mockResolvedValue(FREE_PLAN());

    await expect(createBusiness({ name: "کسب‌وکار" })).rejects.toThrow(/Unknown plan key/);
    expect(prismaMock.business.create).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceSettings.create).not.toHaveBeenCalled();
  });

  it("uses the transaction client and the same session account for entitlement reads, usage and all writes", async () => {
    const { createBusiness } = await import("./businessService");
    requireSession.mockResolvedValue({ userId: "user-2", accountId: "acc-2" });
    const created = businessRow({ id: "biz-new", accountId: "acc-2" });
    // Distinct delegates catch any accidental use of the global client, which
    // the suite's default transaction double (prismaMock itself) cannot catch.
    const tx = {
      plan: { findUnique: vi.fn().mockResolvedValue(FREE_PLAN()) },
      subscription: {
        findMany: vi.fn().mockResolvedValue([{ ...activeSubscription(PRO_PLAN()), accountId: "acc-2" }]),
      },
      business: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(created),
      },
      businessProfile: { create: vi.fn() },
      invoiceSettings: { create: vi.fn() },
    };
    prismaMock.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) => callback(tx));

    await expect(createBusiness({ name: "کسب‌وکار" })).resolves.toEqual(created);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.plan.findUnique).toHaveBeenCalledWith({
      where: { key: "FREE" },
      include: { planFeatures: { include: { feature: true } } },
    });
    expect(tx.subscription.findMany).toHaveBeenCalledWith({
      where: { accountId: "acc-2" },
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      include: { plan: { include: { planFeatures: { include: { feature: true } } } } },
    });
    expect(tx.business.findMany).toHaveBeenCalledWith({
      where: { accountId: "acc-2", archivedAt: null },
      select: { id: true, isPrimary: true },
    });
    expect(tx.business.create).toHaveBeenCalledWith({
      data: { accountId: "acc-2", name: "کسب‌وکار", isPrimary: true },
    });
    expect(tx.businessProfile.create).toHaveBeenCalledWith({
      data: { businessId: "biz-new", businessName: "کسب‌وکار" },
    });
    expect(tx.invoiceSettings.create).toHaveBeenCalledWith({
      data: { businessId: "biz-new", nextInvoiceNumber: 1 },
    });
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.subscription.findMany).not.toHaveBeenCalled();
    expect(prismaMock.business.findMany).not.toHaveBeenCalled();
    expect(prismaMock.business.create).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceSettings.create).not.toHaveBeenCalled();
  });

  it("refuses to create anything when the FREE plan is not seeded", async () => {
    const { createBusiness } = await import("./businessService");

    prismaMock.subscription.findMany.mockResolvedValue([]);
    prismaMock.plan.findUnique.mockResolvedValue(null);

    await expect(createBusiness({ name: "کسب‌وکار" })).rejects.toMatchObject({
      name: "Error",
      message: "Cannot evaluate the business limit: the FREE plan is not seeded. Run `npm run prisma:seed` first.",
    });
    expect(prismaMock.business.create).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceSettings.create).not.toHaveBeenCalled();
  });

  it("propagates unexpected entitlement read failures without creating anything", async () => {
    const { createBusiness } = await import("./businessService");
    const failure = new Error("Database unavailable");
    prismaMock.plan.findUnique.mockRejectedValueOnce(failure);

    await expect(createBusiness({ name: "کسب‌وکار" })).rejects.toBe(failure);
    expect(prismaMock.business.create).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.invoiceSettings.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid session before validation or opening a transaction", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { createBusiness } = await import("./businessService");
    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(createBusiness({ name: "   " })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.plan.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.subscription.findMany).not.toHaveBeenCalled();
  });

  it("rejects an empty or whitespace-only name with ValidationError", async () => {
    const { createBusiness } = await import("./businessService");

    await expect(createBusiness({ name: "   " })).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a payload that tries to supply accountId (no limit bypass, no re-parenting)", async () => {
    const { createBusiness } = await import("./businessService");

    await expect(
      createBusiness({ name: "کسب‌وکار", accountId: "acc-other", isPrimary: true }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.business.create).not.toHaveBeenCalled();
  });
});

describe("updateBusiness", () => {
  it("updates an owned business and keeps BusinessProfile.businessName in sync", async () => {
    const { updateBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    const updated = businessRow({ name: "نام تازه" });
    prismaMock.business.update.mockResolvedValue(updated);

    const result = await updateBusiness("biz-1", { name: "نام تازه" });

    expect(result).toEqual(updated);
    expect(prismaMock.business.update).toHaveBeenCalledWith({
      where: { id: "biz-1" },
      data: { name: "نام تازه" },
    });
    expect(prismaMock.businessProfile.updateMany).toHaveBeenCalledWith({
      where: { businessId: "biz-1" },
      data: { businessName: "نام تازه" },
    });
  });

  it("updates isActive without touching the profile", async () => {
    const { updateBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());
    prismaMock.business.update.mockResolvedValue(businessRow({ isActive: false }));

    await updateBusiness("biz-1", { isActive: false });

    expect(prismaMock.business.update).toHaveBeenCalledWith({
      where: { id: "biz-1" },
      data: { isActive: false },
    });
    expect(prismaMock.businessProfile.updateMany).not.toHaveBeenCalled();
  });

  it("rejects updating another account's business with ForbiddenError", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { updateBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-other", accountId: "acc-other" }));

    await expect(updateBusiness("biz-other", { name: "هک" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(prismaMock.business.update).not.toHaveBeenCalled();
  });

  it("propagates NotFoundError for a business that does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const { updateBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(null);

    await expect(updateBusiness("missing-id", { name: "x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prismaMock.business.update).not.toHaveBeenCalled();
  });

  it.each([
    ["accountId", { name: "x", accountId: "acc-other" }],
    ["id", { name: "x", id: "biz-other" }],
    ["isPrimary", { isPrimary: true }],
    ["isLocked", { isLocked: false }],
    ["archivedAt", { archivedAt: null }],
  ])("rejects an update payload containing the server-owned field %s", async (_field, payload) => {
    const { updateBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(updateBusiness("biz-1", payload)).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.business.update).not.toHaveBeenCalled();
  });

  it("rejects an empty update payload with ValidationError", async () => {
    const { updateBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow());

    await expect(updateBusiness("biz-1", {})).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.business.update).not.toHaveBeenCalled();
  });
});

describe("archiveBusiness", () => {
  it("stamps archivedAt instead of deleting, so historical data survives", async () => {
    const { archiveBusiness } = await import("./businessService");

    const owned = businessRow({ isPrimary: false });
    prismaMock.business.findUnique.mockResolvedValue(owned);
    prismaMock.business.update.mockResolvedValue({ ...owned, archivedAt: new Date() });

    const result = await archiveBusiness("biz-1");

    expect(result.archivedAt).toBeInstanceOf(Date);
    expect(prismaMock.business.update).toHaveBeenCalledWith({
      where: { id: "biz-1" },
      data: { archivedAt: expect.any(Date) },
    });
    expect(prismaMock.business.delete).not.toHaveBeenCalled();
    expect(prismaMock.business.deleteMany).not.toHaveBeenCalled();
  });

  it("is idempotent for an already archived business", async () => {
    const { archiveBusiness } = await import("./businessService");

    const owned = businessRow({ archivedAt: new Date("2026-02-01T00:00:00.000Z") });
    prismaMock.business.findUnique.mockResolvedValue(owned);

    await expect(archiveBusiness("biz-1")).resolves.toEqual(owned);
    expect(prismaMock.business.update).not.toHaveBeenCalled();
  });

  it("rejects archiving another account's business with ForbiddenError", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { archiveBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-other", accountId: "acc-other" }));

    await expect(archiveBusiness("biz-other")).rejects.toBeInstanceOf(ForbiddenError);
    expect(prismaMock.business.update).not.toHaveBeenCalled();
    expect(prismaMock.business.delete).not.toHaveBeenCalled();
  });

  it("promotes the oldest remaining business to primary when the primary business is archived", async () => {
    const { archiveBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1", isPrimary: true }));
    prismaMock.business.findFirst.mockResolvedValue({ id: "biz-2" });
    prismaMock.business.update
      .mockResolvedValueOnce(businessRow({ id: "biz-1", archivedAt: new Date() }))
      .mockResolvedValueOnce(businessRow({ id: "biz-2", isPrimary: true }));

    await archiveBusiness("biz-1");

    expect(prismaMock.business.findFirst).toHaveBeenCalledWith({
      where: { accountId: "acc-1", archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(prismaMock.business.update).toHaveBeenNthCalledWith(2, {
      where: { id: "biz-2" },
      data: { isPrimary: true },
    });
  });

  it("leaves the account without a primary when the archived business was the only one", async () => {
    const { archiveBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(businessRow({ id: "biz-1", isPrimary: true }));
    prismaMock.business.findFirst.mockResolvedValue(null);
    prismaMock.business.update.mockResolvedValue(businessRow({ archivedAt: new Date() }));

    await archiveBusiness("biz-1");

    expect(prismaMock.business.update).toHaveBeenCalledTimes(1);
  });
});

describe("setPrimaryBusiness", () => {
  it("rejects an archived business", async () => {
    const { setPrimaryBusiness } = await import("./businessService");
    const { ValidationError } = await import("@/server/errors");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ id: "biz-1", archivedAt: new Date("2026-03-01") }),
    );

    await expect(setPrimaryBusiness("biz-1")).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns immediately if the business is already primary", async () => {
    const { setPrimaryBusiness } = await import("./businessService");

    const primaryRow = businessRow({ id: "biz-1", isPrimary: true });
    prismaMock.business.findUnique.mockResolvedValue(primaryRow);

    const result = await setPrimaryBusiness("biz-1");

    expect(result.id).toBe("biz-1");
    expect(prismaMock.business.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.business.update).not.toHaveBeenCalled();
  });

  it("atomically clears other primary flags and sets target business as primary", async () => {
    const { setPrimaryBusiness } = await import("./businessService");

    prismaMock.business.findUnique.mockResolvedValue(
      businessRow({ id: "biz-2", isPrimary: false }),
    );
    prismaMock.business.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.business.update.mockResolvedValue(
      businessRow({ id: "biz-2", isPrimary: true }),
    );

    const result = await setPrimaryBusiness("biz-2");

    expect(prismaMock.business.updateMany).toHaveBeenCalledWith({
      where: { accountId: "acc-1", isPrimary: true },
      data: { isPrimary: false },
    });
    expect(prismaMock.business.update).toHaveBeenCalledWith({
      where: { id: "biz-2" },
      data: { isPrimary: true },
    });
    expect(result.isPrimary).toBe(true);
  });
});

