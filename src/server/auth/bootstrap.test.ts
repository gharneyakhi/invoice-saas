import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const TEST_KEY = "a".repeat(64);

// Mock the Prisma singleton so we can assert exactly which writes happen,
// without needing a real PostgreSQL instance. `prisma.$transaction` simply
// invokes the callback with our fake `tx`, mirroring Prisma's interactive
// transaction API closely enough to test the bootstrap logic in isolation.
const tx = {
  user: { upsert: vi.fn() },
  oAuthConnection: { upsert: vi.fn() },
  account: { findUnique: vi.fn(), create: vi.fn() },
  plan: { findUnique: vi.fn() },
  subscription: { create: vi.fn() },
  usagePeriod: { create: vi.fn() },
  business: { create: vi.fn() },
  businessProfile: { create: vi.fn() },
  invoiceSettings: { create: vi.fn() },
  auditLog: { create: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(tx)),
  },
}));

beforeAll(() => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bootstrapUserOnGoogleLogin", () => {
  it("creates the full User -> Account -> Subscription -> UsagePeriod -> Business -> BusinessProfile chain on first login", async () => {
    const { bootstrapUserOnGoogleLogin } = await import("./bootstrap");

    tx.user.upsert.mockResolvedValue({ id: "user-1" });
    tx.account.findUnique.mockResolvedValue(null); // no existing account -> first login
    tx.plan.findUnique.mockResolvedValue({ id: "plan-free", key: "FREE" });
    tx.account.create.mockResolvedValue({ id: "acc-1", status: "ACTIVE", ownerUserId: "user-1" });
    tx.subscription.create.mockResolvedValue({ id: "sub-1" });
    tx.business.create.mockResolvedValue({ id: "biz-1" });

    const result = await bootstrapUserOnGoogleLogin({
      googleId: "g-123",
      email: "sara@example.com",
      name: "سارا",
      avatarUrl: null,
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scope: "openid email profile",
    });

    expect(result).toEqual({
      userId: "user-1",
      accountId: "acc-1",
      status: "ACTIVE",
      createdNewAccount: true,
    });

    expect(tx.oAuthConnection.upsert).toHaveBeenCalledTimes(1);
    expect(tx.account.create).toHaveBeenCalledTimes(1);
    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
    expect(tx.usagePeriod.create).toHaveBeenCalledTimes(1);
    expect(tx.business.create).toHaveBeenCalledTimes(1);
    expect(tx.businessProfile.create).toHaveBeenCalledTimes(1);
    expect(tx.invoiceSettings.create).toHaveBeenCalledTimes(1);

    // Sanity-check the subscription is tied to the FREE plan we looked up.
    expect(tx.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ planId: "plan-free", accountId: "acc-1" }) }),
    );

    const auditCall = tx.auditLog.create.mock.calls[0]?.[0];
    expect(auditCall.data.action).toBe("ACCOUNT_BOOTSTRAPPED");
  });

  it("does NOT create a new Account or Business on a returning login", async () => {
    const { bootstrapUserOnGoogleLogin } = await import("./bootstrap");

    tx.user.upsert.mockResolvedValue({ id: "user-1" });
    tx.account.findUnique.mockResolvedValue({ id: "acc-1", status: "ACTIVE" });

    const result = await bootstrapUserOnGoogleLogin({
      googleId: "g-123",
      email: "sara@example.com",
      name: "سارا",
      avatarUrl: null,
    });

    expect(result).toEqual({
      userId: "user-1",
      accountId: "acc-1",
      status: "ACTIVE",
      createdNewAccount: false,
    });

    expect(tx.account.create).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.usagePeriod.create).not.toHaveBeenCalled();
    expect(tx.business.create).not.toHaveBeenCalled();
    expect(tx.businessProfile.create).not.toHaveBeenCalled();

    const auditCall = tx.auditLog.create.mock.calls[0]?.[0];
    expect(auditCall.data.action).toBe("LOGIN");
  });

  it("does not persist an OAuthConnection when no tokens are supplied (JWT-refresh path)", async () => {
    const { bootstrapUserOnGoogleLogin } = await import("./bootstrap");

    tx.user.upsert.mockResolvedValue({ id: "user-1" });
    tx.account.findUnique.mockResolvedValue({ id: "acc-1", status: "ACTIVE" });

    await bootstrapUserOnGoogleLogin({
      googleId: "g-123",
      email: "sara@example.com",
      name: "سارا",
      avatarUrl: null,
    });

    expect(tx.oAuthConnection.upsert).not.toHaveBeenCalled();
  });

  it("throws a clear error and creates nothing if the FREE plan is not seeded", async () => {
    const { bootstrapUserOnGoogleLogin } = await import("./bootstrap");

    tx.user.upsert.mockResolvedValue({ id: "user-1" });
    tx.account.findUnique.mockResolvedValue(null);
    tx.plan.findUnique.mockResolvedValue(null);

    await expect(
      bootstrapUserOnGoogleLogin({
        googleId: "g-123",
        email: "new@example.com",
        name: "New User",
        avatarUrl: null,
      }),
    ).rejects.toThrow(/FREE plan is not seeded/);

    expect(tx.account.create).not.toHaveBeenCalled();
  });

  it("rejects a login with no googleId or email", async () => {
    const { bootstrapUserOnGoogleLogin } = await import("./bootstrap");

    await expect(
      bootstrapUserOnGoogleLogin({ googleId: "", email: "", name: "x", avatarUrl: null }),
    ).rejects.toThrow();
  });
});
