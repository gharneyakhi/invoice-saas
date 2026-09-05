import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUsagePeriodBounds } from "@/lib/usage-period";
import { EntitlementDataError } from "@/server/errors";
import type { UsagePeriodOptions } from "./usagePeriodService";

/**
 * Unit tests for usage-period resolution, in the established style: the Prisma
 * singleton and the session are mocked, while the real `getUsagePeriodBounds()`
 * convention and the real subscription-selection rule run against those rows.
 *
 * `update`/`updateMany`/`delete`/`deleteMany` are mocked only so the tests can
 * assert they are *never* called — an existing period must be returned as found
 * (its `invoiceCount` intact) and no historical period may ever be touched.
 */
const prismaMock = vi.hoisted(() => ({
  usagePeriod: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  subscription: { findMany: vi.fn() },
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

// Do not importOriginal(): it pulls auth-options.ts, which throws at load time
// when GOOGLE_CLIENT_ID is unset.
vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  return { UnauthorizedError, requireSession };
});

const SESSION = { userId: "user-1", accountId: "acc-1" };
const NOW = new Date(2026, 2, 15, 12, 0, 0); // 15 March 2026, local time
const BOUNDS = getUsagePeriodBounds(NOW);

interface PeriodOverrides {
  id?: string;
  accountId?: string;
  subscriptionId?: string;
  periodStart?: Date;
  periodEnd?: Date;
  invoiceCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

function periodRow(overrides: PeriodOverrides = {}) {
  return {
    id: "period-1",
    accountId: "acc-1",
    subscriptionId: "sub-1",
    periodStart: BOUNDS.periodStart,
    periodEnd: BOUNDS.periodEnd,
    invoiceCount: 0,
    createdAt: BOUNDS.periodStart,
    updatedAt: BOUNDS.periodStart,
    ...overrides,
  };
}

interface SubscriptionOverrides {
  id?: string;
  status?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  createdAt?: Date;
  plan?: { isActive?: boolean };
}

function subscriptionRow(overrides: SubscriptionOverrides = {}) {
  return {
    id: "sub-1",
    status: "ACTIVE",
    startDate: new Date(2026, 2, 1),
    endDate: new Date(2026, 3, 1),
    createdAt: new Date(2026, 2, 1),
    plan: { isActive: true },
    ...overrides,
  };
}

/** Prisma's unique-constraint violation, matched structurally by the service. */
const UNIQUE_VIOLATION = Object.assign(new Error("Unique constraint failed"), {
  code: "P2002",
  meta: { target: ["accountId", "periodStart", "periodEnd"] },
});

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue(SESSION);
  prismaMock.subscription.findMany.mockResolvedValue([subscriptionRow()]);
});

describe("getCurrentUsagePeriod", () => {
  it("returns the current calendar-month period via the composite unique key", async () => {
    const { getCurrentUsagePeriod } = await import("./usagePeriodService");
    const row = periodRow({ invoiceCount: 2 });
    prismaMock.usagePeriod.findUnique.mockResolvedValue(row);

    await expect(getCurrentUsagePeriod({ now: NOW })).resolves.toEqual(row);

    expect(prismaMock.usagePeriod.findUnique).toHaveBeenCalledWith({
      where: {
        accountId_periodStart_periodEnd: {
          accountId: "acc-1",
          periodStart: BOUNDS.periodStart,
          periodEnd: BOUNDS.periodEnd,
        },
      },
    });
  });

  it("returns null when this month's period does not exist yet, without creating it", async () => {
    const { getCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);

    await expect(getCurrentUsagePeriod({ now: NOW })).resolves.toBeNull();
    expect(prismaMock.usagePeriod.create).not.toHaveBeenCalled();
  });

  it("propagates an invalid session without touching the database", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { getCurrentUsagePeriod } = await import("./usagePeriodService");
    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(getCurrentUsagePeriod({ now: NOW })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.usagePeriod.findUnique).not.toHaveBeenCalled();
  });
});

describe("ensureCurrentUsagePeriod", () => {
  it("returns an existing period unchanged and never writes to it", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    const row = periodRow({ invoiceCount: 7 });
    prismaMock.usagePeriod.findUnique.mockResolvedValue(row);

    const result = await ensureCurrentUsagePeriod({ now: NOW });

    expect(result.invoiceCount).toBe(7); // never reset
    expect(prismaMock.usagePeriod.create).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.delete).not.toHaveBeenCalled();
    expect(prismaMock.usagePeriod.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.subscription.findMany).not.toHaveBeenCalled(); // no need to look one up
  });

  it("creates the missing period for this month against the account's subscription", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    const created = periodRow();
    prismaMock.usagePeriod.create.mockResolvedValue(created);

    await expect(ensureCurrentUsagePeriod({ now: NOW })).resolves.toEqual(created);

    expect(prismaMock.usagePeriod.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.usagePeriod.create).toHaveBeenCalledWith({
      data: {
        accountId: "acc-1", // session-derived
        subscriptionId: "sub-1",
        periodStart: BOUNDS.periodStart,
        periodEnd: BOUNDS.periodEnd,
        invoiceCount: 0,
      },
    });
  });

  it("uses the existing getUsagePeriodBounds convention for the month boundaries", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    prismaMock.usagePeriod.create.mockResolvedValue(periodRow());

    await ensureCurrentUsagePeriod({ now: NOW });

    const data = prismaMock.usagePeriod.create.mock.calls[0]?.[0].data;
    const expected = getUsagePeriodBounds(NOW);
    expect(data.periodStart).toEqual(expected.periodStart);
    expect(data.periodEnd).toEqual(expected.periodEnd);
    // A different month resolves to a different bucket, so history is never
    // overwritten by a later call.
    const february = getUsagePeriodBounds(new Date(2026, 1, 10));
    expect(data.periodStart.getTime()).not.toBe(february.periodStart.getTime());
  });

  it("does not create a duplicate when called repeatedly", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    const created = periodRow({ invoiceCount: 1 });
    prismaMock.usagePeriod.findUnique
      .mockResolvedValueOnce(null) // first call: nothing there yet
      .mockResolvedValueOnce(created); // second call: the row now exists
    prismaMock.usagePeriod.create.mockResolvedValue(created);

    const first = await ensureCurrentUsagePeriod({ now: NOW });
    const second = await ensureCurrentUsagePeriod({ now: NOW });

    expect(first).toEqual(created);
    expect(second).toEqual(created);
    expect(prismaMock.usagePeriod.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();
  });

  it("survives a create race by re-reading the row the unique constraint let win", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    const winnersRow = periodRow({ id: "period-winner", invoiceCount: 3 });

    prismaMock.usagePeriod.findUnique
      .mockResolvedValueOnce(null) // our initial read: not there yet
      .mockResolvedValueOnce(winnersRow); // re-read after losing the race
    prismaMock.usagePeriod.create.mockRejectedValue(UNIQUE_VIOLATION);

    await expect(ensureCurrentUsagePeriod({ now: NOW })).resolves.toEqual(winnersRow);

    expect(prismaMock.usagePeriod.create).toHaveBeenCalledTimes(1); // no blind retry
    expect(prismaMock.usagePeriod.findUnique).toHaveBeenCalledTimes(2);
    expect(prismaMock.usagePeriod.update).not.toHaveBeenCalled();
  });

  it("does not treat a unique violation on a different constraint as a lost race", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    const otherFailure = Object.assign(new Error("Some other known request error"), { code: "P2025" });
    prismaMock.usagePeriod.create.mockRejectedValue(otherFailure);

    await expect(ensureCurrentUsagePeriod({ now: NOW })).rejects.toBe(otherFailure);
    expect(prismaMock.usagePeriod.findUnique).toHaveBeenCalledTimes(1); // no re-read
  });

  it("propagates an infrastructure failure unchanged instead of mislabelling it", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    const connectionFailure = new Error("Can't reach database server");
    prismaMock.usagePeriod.create.mockRejectedValue(connectionFailure);

    await expect(ensureCurrentUsagePeriod({ now: NOW })).rejects.toBe(connectionFailure);
  });

  it("throws a domain error when the winning row cannot be read back after a race", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null); // both reads come up empty
    prismaMock.usagePeriod.create.mockRejectedValue(UNIQUE_VIOLATION);

    await expect(ensureCurrentUsagePeriod({ now: NOW })).rejects.toBeInstanceOf(EntitlementDataError);
  });

  it("throws a domain error rather than inventing a period when the account has no subscription", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    prismaMock.subscription.findMany.mockResolvedValue([]);

    await expect(ensureCurrentUsagePeriod({ now: NOW })).rejects.toBeInstanceOf(EntitlementDataError);
    await expect(ensureCurrentUsagePeriod({ now: NOW })).rejects.toThrow(/no subscription row/);
    expect(prismaMock.usagePeriod.create).not.toHaveBeenCalled();
  });

  it("resolves through a supplied transaction client instead of the global singleton", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    const tx = {
      usagePeriod: { findUnique: vi.fn().mockResolvedValue(periodRow()) },
      subscription: { findMany: vi.fn() },
    };

    const result = await ensureCurrentUsagePeriod({
      now: NOW,
      client: tx as unknown as UsagePeriodOptions["client"],
    });

    expect(result.accountId).toBe("acc-1");
    expect(tx.usagePeriod.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.usagePeriod.findUnique).not.toHaveBeenCalled();
  });
});

describe("ensureCurrentUsagePeriod — account isolation", () => {
  it("scopes both the period lookup and the subscription lookup to the session account", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    prismaMock.usagePeriod.create.mockResolvedValue(periodRow());

    await ensureCurrentUsagePeriod({ now: NOW });

    expect(prismaMock.usagePeriod.findUnique.mock.calls[0]?.[0].where.accountId_periodStart_periodEnd.accountId).toBe(
      "acc-1",
    );
    expect(prismaMock.subscription.findMany.mock.calls[0]?.[0].where).toEqual({ accountId: "acc-1" });
    expect(prismaMock.usagePeriod.create.mock.calls[0]?.[0].data.accountId).toBe("acc-1");
  });

  it("follows the session: a different session resolves a different account's period", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    requireSession.mockResolvedValue({ userId: "user-2", accountId: "acc-2" });
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    prismaMock.usagePeriod.create.mockResolvedValue(periodRow({ accountId: "acc-2" }));

    await ensureCurrentUsagePeriod({ now: NOW });

    expect(prismaMock.subscription.findMany.mock.calls[0]?.[0].where).toEqual({ accountId: "acc-2" });
    expect(prismaMock.usagePeriod.create.mock.calls[0]?.[0].data.accountId).toBe("acc-2");
  });

  it("ignores an accountId or now-equivalent smuggled into the options object", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(periodRow());

    await ensureCurrentUsagePeriod({
      now: NOW,
      accountId: "acc-evil",
      subscriptionId: "sub-evil",
    } as unknown as UsagePeriodOptions);

    expect(prismaMock.usagePeriod.findUnique.mock.calls[0]?.[0].where.accountId_periodStart_periodEnd.accountId).toBe(
      "acc-1",
    );
  });
});

describe("ensureCurrentUsagePeriod — subscription association", () => {
  it("attaches the period to the subscription that is genuinely in force", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    prismaMock.usagePeriod.create.mockResolvedValue(periodRow({ subscriptionId: "sub-old" }));
    prismaMock.subscription.findMany.mockResolvedValue([
      // Newest-first, as SUBSCRIPTION_ORDER_BY returns them: the newest has lapsed.
      subscriptionRow({ id: "sub-new", startDate: new Date(2026, 2, 1), endDate: new Date(2026, 2, 10) }),
      subscriptionRow({ id: "sub-old", startDate: new Date(2026, 1, 1), endDate: new Date(2027, 1, 1) }),
    ]);

    await ensureCurrentUsagePeriod({ now: NOW });

    expect(prismaMock.usagePeriod.create.mock.calls[0]?.[0].data.subscriptionId).toBe("sub-old");
  });

  it("falls back to the newest row when nothing is in force, so Free accounts still get a bucket", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    prismaMock.usagePeriod.create.mockResolvedValue(periodRow({ subscriptionId: "sub-new" }));
    prismaMock.subscription.findMany.mockResolvedValue([
      subscriptionRow({ id: "sub-new", status: "CANCELLED" }),
      subscriptionRow({ id: "sub-old", status: "EXPIRED" }),
    ]);

    await ensureCurrentUsagePeriod({ now: NOW });

    expect(prismaMock.usagePeriod.create.mock.calls[0]?.[0].data.subscriptionId).toBe("sub-new");
  });

  it("still opens a bucket for an ACTIVE row whose window closed (entitlements are resolved separately)", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    prismaMock.usagePeriod.create.mockResolvedValue(periodRow());
    prismaMock.subscription.findMany.mockResolvedValue([
      subscriptionRow({ id: "sub-lapsed", startDate: new Date(2026, 0, 1), endDate: new Date(2026, 1, 1) }),
    ]);

    await expect(ensureCurrentUsagePeriod({ now: NOW })).resolves.toBeDefined();
    expect(prismaMock.usagePeriod.create.mock.calls[0]?.[0].data.subscriptionId).toBe("sub-lapsed");
  });

  it("only loads a light projection of the subscription rows", async () => {
    const { ensureCurrentUsagePeriod } = await import("./usagePeriodService");
    prismaMock.usagePeriod.findUnique.mockResolvedValue(null);
    prismaMock.usagePeriod.create.mockResolvedValue(periodRow());

    await ensureCurrentUsagePeriod({ now: NOW });

    const call = prismaMock.subscription.findMany.mock.calls[0]?.[0];
    expect(call.select).toEqual({
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      createdAt: true,
      plan: { select: { isActive: true } },
    });
    expect(call.orderBy).toEqual([{ startDate: "desc" }, { createdAt: "desc" }, { id: "desc" }]);
  });
});
