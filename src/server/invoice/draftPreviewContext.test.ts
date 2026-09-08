import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDraftPreviewContext } from "@/server/invoice/previewService";
import {
  buildInvoicePreviewModel,
  previewLifecycle,
  previewSellerSourceKind,
} from "@/server/invoice/previewService";
import * as previewModel from "@/server/invoice/previewService";
import { buildInvoicePreviewModel as sharedBuilder } from "@/lib/invoice-preview-model";

/**
 * Draft live-preview context (server side).
 *
 * The editor needs the CURRENT business branding to show a faithful preview
 * before anything is saved. This loader is the only server call the live
 * preview makes, so these tests pin its two promises: it reads only (never
 * writes, never touches quota/numbering/snapshots), and it degrades instead of
 * failing when branding assets cannot be resolved.
 */

const prismaMock = vi.hoisted(() => ({
  businessProfile: { findUnique: vi.fn() },
  file: { findMany: vi.fn() },
}));

const getInvoiceSettingsMock = vi.hoisted(() => vi.fn());
const requireBusinessOwnershipMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/server/invoice/invoiceService", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getInvoiceSettings: getInvoiceSettingsMock };
});
vi.mock("@/server/auth/requireBusinessOwnership", () => ({
  requireBusinessOwnership: requireBusinessOwnershipMock,
}));
// The auth chain (session → next-auth options) needs server env that a preview
// read does not depend on; stub the errors this module actually uses.
vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  class NotFoundError extends Error {}
  return { UnauthorizedError, ForbiddenError, NotFoundError, requireSession: vi.fn() };
});

const PROFILE = {
  businessId: "biz-1",
  businessName: "فروشگاه البرز",
  slogan: "کیفیت، به قیمت منصفانه",
  ownerName: "علی رضایی",
  address: "کرج، خیابان بهار ۱۲",
  email: "sales@alborz.test",
  mobile: "09126667777",
  landline: "02632223333",
  cardNumber: "6104337800000000",
  accountNumber: "1234567890",
  iban: "IR820540102680020900941012",
  logoFileId: "file-logo",
  sellerStampFileId: "file-stamp",
  sellerSignatureFileId: null,
  primaryColor: "#0f766e",
  footerBackgroundColor: "#111827",
  footerText: "با تشکر از همراهی شما",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireBusinessOwnershipMock.mockResolvedValue({ id: "biz-1", name: "البرز" });
  prismaMock.businessProfile.findUnique.mockResolvedValue(PROFILE);
  prismaMock.file.findMany.mockResolvedValue([
    { id: "file-logo", storageKey: "businesses/biz-1/logo.png" },
    { id: "file-stamp", storageKey: "businesses/biz-1/stamp.png" },
  ]);
  getInvoiceSettingsMock.mockResolvedValue({ currency: "IRR", defaultVatPercent: "9" });
});

describe("getDraftPreviewContext", () => {
  it("returns the current profile, the business name and the invoice currency", async () => {
    const context = await getDraftPreviewContext("biz-1");

    expect(context).toMatchObject({
      businessId: "biz-1",
      fallbackBusinessName: "البرز",
      currency: "IRR",
    });
    expect(context.currentProfile?.businessName).toBe("فروشگاه البرز");
    expect(context.currentProfile?.primaryColor).toBe("#0f766e");
  });

  it("proves business ownership before reading anything", async () => {
    requireBusinessOwnershipMock.mockRejectedValueOnce(new Error("forbidden"));

    await expect(getDraftPreviewContext("biz-foreign")).rejects.toThrow("forbidden");
    expect(prismaMock.businessProfile.findUnique).not.toHaveBeenCalled();
  });

  it("resolves branding file ids through the File ledger, scoped to the business", async () => {
    const context = await getDraftPreviewContext("biz-1");

    expect(prismaMock.file.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["file-logo", "file-stamp"] },
        businessId: "biz-1",
        deletedAt: null,
      },
      select: { id: true, storageKey: true },
    });
    // No public base url configured in this environment → url is null, which
    // the document renders as "no asset" instead of a broken/invented image.
    expect(context.images.logo).toEqual({ fileId: "file-logo", url: null });
    expect(context.images.sellerSignature).toBeNull();
  });

  it("degrades to no branding instead of failing when the File ledger errors", async () => {
    prismaMock.file.findMany.mockRejectedValueOnce(new Error("db hiccup"));

    const context = await getDraftPreviewContext("biz-1");

    expect(context.images).toEqual({ logo: null, sellerStamp: null, sellerSignature: null });
    // The rest of the preview context survives, so the editor keeps working.
    expect(context.currentProfile?.businessName).toBe("فروشگاه البرز");
  });

  it("keeps a brand-new business (no profile row) usable", async () => {
    prismaMock.businessProfile.findUnique.mockResolvedValue(null);
    prismaMock.file.findMany.mockResolvedValue([]);

    const context = await getDraftPreviewContext("biz-1");

    expect(context.currentProfile).toBeNull();
    expect(context.images).toEqual({ logo: null, sellerStamp: null, sellerSignature: null });
    expect(context.fallbackBusinessName).toBe("البرز");
  });

  it("defaults the currency to IRR when InvoiceSettings is missing", async () => {
    getInvoiceSettingsMock.mockResolvedValue(null);

    expect((await getDraftPreviewContext("biz-1")).currency).toBe("IRR");
  });

  it("is read-only: the draft preview never writes, numbers or snapshots anything", async () => {
    await getDraftPreviewContext("biz-1");

    const writes = Object.values(prismaMock as unknown as Record<string, Record<string, unknown>>).flatMap(
      (model) => Object.entries(model),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const [name, value] of writes) {
      expect(typeof value).toBe("function");
      expect(name).toMatch(/^(findUnique|findMany|findFirst)$/);
    }
    expect(prismaMock).not.toHaveProperty("$transaction");
    expect(prismaMock).not.toHaveProperty("$executeRaw");
  });
});

describe("one preview model for both preview paths", () => {
  it("re-exports the shared model builder unchanged (no editor-specific fork)", () => {
    // The editor's live preview and the finalized print route must run the
    // same snapshot law. That is guaranteed by them sharing this function
    // object — a fork here would silently create a second invoice design.
    expect(previewModel.buildInvoicePreviewModel).toBe(sharedBuilder);
    expect(buildInvoicePreviewModel).toBe(sharedBuilder);
    expect(previewLifecycle("DRAFT", null)).toBe("DRAFT");
    // Only the presence of a snapshot matters to the rule, so a minimal row
    // stub is enough (the full record shape belongs to the service layer).
    type SellerSourceInvoice = Parameters<typeof previewSellerSourceKind>[0];
    const row = (overrides: Record<string, unknown>): SellerSourceInvoice =>
      ({ status: "DRAFT", finalizedAt: null, sellerSnapshot: null, ...overrides }) as unknown as SellerSourceInvoice;

    expect(previewSellerSourceKind(row({}))).toBe("PROFILE");
    expect(
      previewSellerSourceKind(
        row({
          status: "PENDING_PAYMENT",
          finalizedAt: new Date("2026-03-06"),
          sellerSnapshot: { id: "snap-1" },
        }),
      ),
    ).toBe("SNAPSHOT");
    expect(
      previewSellerSourceKind(row({ status: "CANCELLED", sellerSnapshot: { id: "snap-2" } })),
    ).toBe("SNAPSHOT");
  });
});
