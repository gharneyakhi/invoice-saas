import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import sharp from "sharp";
import {
  draftPreviewModel,
  finalizedPreviewModel,
} from "@/server/export/testFixtures";

/**
 * Deep integration tests for the export route: everything REAL except the
 * documented trust boundaries (preview-service load, entitlements, session
 * errors), which are covered by their own suites.
 *
 * These prove the route is genuinely wired: the `?format=` dispatch drives
 * the real UBA PDF engine, the real sharp rasterizer and the real ExcelJS
 * workbook, and the bytes on the wire carry the right magic numbers,
 * geometry, sheet data and Persian download filenames.
 */

const getInvoicePreviewDataMock = vi.hoisted(() => vi.fn());
const resolveEntitlementsMock = vi.hoisted(() => vi.fn());
const entitlementHasFeatureMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/invoice/previewService", () => ({
  getInvoicePreviewData: getInvoicePreviewDataMock,
}));

vi.mock("@/server/entitlements/entitlementService", () => ({
  resolveEntitlements: resolveEntitlementsMock,
  entitlementHasFeature: entitlementHasFeatureMock,
}));

vi.mock("@/server/auth/requireSession", () => {
  class MockUnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  class MockForbiddenError extends Error {
    constructor(message = "Forbidden") {
      super(message);
      this.name = "ForbiddenError";
    }
  }
  class MockNotFoundError extends Error {
    constructor(message = "Not found") {
      super(message);
      this.name = "NotFoundError";
    }
  }
  return {
    UnauthorizedError: MockUnauthorizedError,
    ForbiddenError: MockForbiddenError,
    NotFoundError: MockNotFoundError,
  };
});

const PARAMS = { params: { businessId: "biz-1", invoiceId: "inv-1" } };

function requestFor(format: string): NextRequest {
  return new NextRequest(`http://localhost/api/export?format=${format}`);
}

async function responseBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

beforeEach(() => {
  vi.clearAllMocks();
  getInvoicePreviewDataMock.mockResolvedValue(finalizedPreviewModel());
  resolveEntitlementsMock.mockResolvedValue({});
  entitlementHasFeatureMock.mockReturnValue(true);
});

describe("GET export route integration (real generators)", () => {
  it("streams a real UBA PDF with the Persian filename", async () => {
    const { GET } = await import("./route");
    const response = await GET(requestFor("pdf"), PARAMS);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("فاکتور-1024.pdf")}`);
    const bytes = await responseBytes(response);
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
    expect(getInvoicePreviewDataMock).toHaveBeenCalledWith("biz-1", "inv-1");
  });

  it("streams real PNG bytes at the export width", async () => {
    const { GET } = await import("./route");
    const response = await GET(requestFor("png"), PARAMS);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = await responseBytes(response);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(1985);
    expect(meta.format).toBe("png");
  });

  it("streams real JPEG bytes", async () => {
    const { GET } = await import("./route");
    const response = await GET(requestFor("jpg"), PARAMS);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    const bytes = await responseBytes(response);
    expect(bytes.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("streams a real RTL workbook with verbatim totals", async () => {
    const { GET } = await import("./route");
    const response = await GET(requestFor("xlsx"), PARAMS);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    const bytes = await responseBytes(response);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet("فاکتور");
    expect(sheet).toBeDefined();
    let grand: unknown = null;
    sheet?.eachRow((row) => {
      if (String(row.getCell(1).value ?? "").includes("مبلغ نهایی فاکتور")) {
        grand = row.getCell(2).value;
      }
    });
    // Stored total "186390.00" survives the Decimal→cell conversion exactly.
    expect(grand).toBe(186390);
  });

  it("names draft downloads without inventing an official number", async () => {
    getInvoicePreviewDataMock.mockResolvedValue(draftPreviewModel());
    const { GET } = await import("./route");
    const response = await GET(requestFor("pdf"), PARAMS);

    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="draft-inv-draf.pdf"');
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent("پیش‌نویس-inv-draf.pdf")}`,
    );
    expect(disposition).not.toContain("DRAFT-");
  });

  it("lets authorization failures from the service surface unchanged", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    getInvoicePreviewDataMock.mockRejectedValueOnce(new UnauthorizedError());
    const { GET } = await import("./route");

    const response = await GET(requestFor("xlsx"), PARAMS);
    expect(response.status).toBe(401);
  });
});
