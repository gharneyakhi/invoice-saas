import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { getInvoiceExportSource, DRAFT_EXPORT_NOTICE } from "./exportService";

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

/**
 * Authorization boundary tests for the export service.
 *
 * The service delegates data loading to `previewService.getInvoicePreviewData`
 * (mocked here; its own ownership/snapshot contract is covered by its test
 * suite), so these tests pin what the EXPORT layer adds: every failure of
 * the underlying auth chain surfaces unchanged (never swallowed, never
 * downgraded), and the returned payload always pairs the model with
 * sanitized filenames for the requested format.
 */

const getInvoicePreviewDataMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/invoice/previewService", () => ({
  getInvoicePreviewData: getInvoicePreviewDataMock,
}));

function previewModel(overrides: Record<string, unknown> = {}) {
  return {
    invoice: {
      id: "inv-1",
      businessId: "biz-1",
      invoiceNumber: "1024",
      invoiceType: "FINAL",
      status: "ISSUED",
    },
    businessId: "biz-1",
    lifecycle: "FINALIZED",
    isDraft: false,
    officialNumber: "1024",
    seller: { businessName: "فروشگاه البرز" },
    customer: { name: "مشتری" },
    currency: "IRR",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getInvoiceExportSource authorization", () => {
  it("rejects unauthenticated export with UnauthorizedError", async () => {
    getInvoicePreviewDataMock.mockRejectedValueOnce(new UnauthorizedError());
    await expect(getInvoiceExportSource("biz-1", "inv-1", "pdf")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("rejects a business the caller does not own with ForbiddenError", async () => {
    getInvoicePreviewDataMock.mockRejectedValueOnce(
      new ForbiddenError("Business does not belong to this account"),
    );
    await expect(getInvoiceExportSource("foreign-biz", "inv-1", "pdf")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects a cross-business invoice with ForbiddenError", async () => {
    getInvoicePreviewDataMock.mockRejectedValueOnce(new ForbiddenError("Foreign invoice"));
    await expect(getInvoiceExportSource("biz-1", "foreign-inv", "xlsx")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects a missing invoice with NotFoundError", async () => {
    getInvoicePreviewDataMock.mockRejectedValueOnce(new NotFoundError("Invoice not found"));
    await expect(getInvoiceExportSource("biz-1", "missing", "png")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("passes the exact business/invoice pair through to the preview loader", async () => {
    getInvoicePreviewDataMock.mockResolvedValueOnce(previewModel());
    await getInvoiceExportSource("biz-1", "inv-1", "jpg");
    expect(getInvoicePreviewDataMock).toHaveBeenCalledWith("biz-1", "inv-1");
  });
});

describe("getInvoiceExportSource payload", () => {
  it("pairs the model with sanitized filenames for the requested format", async () => {
    getInvoicePreviewDataMock.mockResolvedValueOnce(previewModel());
    const source = await getInvoiceExportSource("biz-1", "inv-1", "pdf");
    expect(source.model.officialNumber).toBe("1024");
    expect(source.filenames.filename).toBe("فاکتور-1024.pdf");
    expect(source.filenames.mimeType).toBe("application/pdf");
  });

  it("names draft exports without the DRAFT-<uuid> placeholder", async () => {
    getInvoicePreviewDataMock.mockResolvedValueOnce(
      previewModel({ isDraft: true, lifecycle: "DRAFT", officialNumber: null }),
    );
    const source = await getInvoiceExportSource("biz-1", "inv-1", "xlsx");
    expect(source.filenames.filename).toBe("پیش‌نویس-inv-1.xlsx");
    expect(source.filenames.filename).not.toContain("DRAFT");
  });

  it("exposes the shared Persian draft notice", () => {
    expect(DRAFT_EXPORT_NOTICE).toContain("پیش‌نویس");
  });
});
