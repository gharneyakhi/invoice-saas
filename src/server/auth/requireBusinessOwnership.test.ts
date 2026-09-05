import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  business: {
    findUnique: vi.fn(),
  },
}));

const requireSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

// Do not importOriginal() this module: it pulls auth-options.ts, which throws
// at load time when GOOGLE_CLIENT_ID is unset (same sandbox constraint as
// running NextAuth without .env). Re-declare the error classes here so
// instanceof checks match what requireBusinessOwnership throws under the mock.
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireBusinessOwnership", () => {
  it("returns the Business when the session is valid and the Business belongs to the same Account", async () => {
    const { requireBusinessOwnership } = await import("./requireBusinessOwnership");

    requireSession.mockResolvedValue({ userId: "user-1", accountId: "acc-1" });

    const owned = {
      id: "biz-1",
      accountId: "acc-1",
      name: "کسب‌وکار من",
      isActive: true,
      isLocked: false,
      isPrimary: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      archivedAt: null,
    };
    prismaMock.business.findUnique.mockResolvedValue(owned);

    const result = await requireBusinessOwnership("biz-1");

    expect(result).toEqual(owned);
    expect(prismaMock.business.findUnique).toHaveBeenCalledWith({ where: { id: "biz-1" } });
  });

  it("rejects with ForbiddenError when the Business belongs to another Account", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { requireBusinessOwnership } = await import("./requireBusinessOwnership");

    requireSession.mockResolvedValue({ userId: "user-1", accountId: "acc-1" });
    prismaMock.business.findUnique.mockResolvedValue({
      id: "biz-other",
      accountId: "acc-other",
      name: "کسب‌وکار دیگران",
      isActive: true,
      isLocked: false,
      isPrimary: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      archivedAt: null,
    });

    await expect(requireBusinessOwnership("biz-other")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects with NotFoundError when the Business does not exist", async () => {
    const { NotFoundError } = await import("@/server/auth/requireSession");
    const { requireBusinessOwnership } = await import("./requireBusinessOwnership");

    requireSession.mockResolvedValue({ userId: "user-1", accountId: "acc-1" });
    prismaMock.business.findUnique.mockResolvedValue(null);

    await expect(requireBusinessOwnership("missing-id")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects when the session is invalid (requireSession throws)", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { requireBusinessOwnership } = await import("./requireBusinessOwnership");

    requireSession.mockRejectedValue(new UnauthorizedError());

    await expect(requireBusinessOwnership("biz-1")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.business.findUnique).not.toHaveBeenCalled();
  });
});
