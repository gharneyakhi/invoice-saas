import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ValidationError } from "@/server/errors";
import { finalizedPreviewModel } from "@/server/export/testFixtures";

/**
 * Route tests for the invoice file export (`GET ?format=...`).
 *
 * These prove the HTTP contract: format validation, correct generator
 * dispatch, download headers (`no-store`, content length, RFC 5987
 * disposition) and the safe status-code mapping. Auth/ownership/snapshot
 * rules live in the export service (mocked here, covered by its suite).
 */

const requireSession = vi.hoisted(() => vi.fn());

const exportSvc = vi.hoisted(() => ({
  getInvoiceExportSource: vi.fn(),
}));

const pdfSvc = vi.hoisted(() => ({ generateInvoicePdf: vi.fn() }));
const imageSvc = vi.hoisted(() => ({ renderInvoiceImage: vi.fn() }));
const excelSvc = vi.hoisted(() => ({ generateInvoiceExcel: vi.fn() }));

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
  return { requireSession, UnauthorizedError, ForbiddenError, NotFoundError };
});

vi.mock("@/server/export/exportService", () => exportSvc);
vi.mock("@/server/export/pdfService", () => pdfSvc);
vi.mock("@/server/export/imageService", () => imageSvc);
vi.mock("@/server/export/excelService", () => excelSvc);

const PARAMS = { params: { businessId: "biz-1", invoiceId: "inv-1" } };

function requestFor(format: string | null): NextRequest {
  const url =
    format === null
      ? "http://localhost/api/export"
      : `http://localhost/api/export?format=${format}`;
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  exportSvc.getInvoiceExportSource.mockImplementation(
    async (_biz: string, _inv: string, format: string) => ({
      model: finalizedPreviewModel(),
      filenames: {
        filename: `فاکتور-1024.${format}`,
        asciiFallback: `invoice-1024.${format}`,
        mimeType:
          format === "pdf"
            ? "application/pdf"
            : format === "xlsx"
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : format === "png"
                ? "image/png"
                : "image/jpeg",
      },
    }),
  );
  pdfSvc.generateInvoicePdf.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  imageSvc.renderInvoiceImage.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  excelSvc.generateInvoiceExcel.mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
});

describe("GET export route", () => {
  it("streams the PDF with download headers and no-store", async () => {
    const { GET } = await import("./route");
    const response = await GET(requestFor("pdf"), PARAMS);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("invoice-1024.pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    expect(pdfSvc.generateInvoicePdf).toHaveBeenCalledTimes(1);
    expect(exportSvc.getInvoiceExportSource).toHaveBeenCalledWith("biz-1", "inv-1", "pdf");
  });

  it("dispatches each format to its own generator", async () => {
    const { GET } = await import("./route");

    const png = await GET(requestFor("png"), PARAMS);
    expect(png.headers.get("content-type")).toContain("image/png");
    expect(imageSvc.renderInvoiceImage).toHaveBeenCalledWith(expect.anything(), "png");

    const jpg = await GET(requestFor("jpg"), PARAMS);
    expect(jpg.headers.get("content-type")).toContain("image/jpeg");
    expect(imageSvc.renderInvoiceImage).toHaveBeenCalledWith(expect.anything(), "jpg");

    const xlsx = await GET(requestFor("xlsx"), PARAMS);
    expect(xlsx.headers.get("content-type")).toContain("spreadsheetml");
    expect(excelSvc.generateInvoiceExcel).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown and missing formats without touching services", async () => {
    const { GET } = await import("./route");

    for (const req of [requestFor("exe"), requestFor(null), requestFor("PDF")]) {
      const response = await GET(req, PARAMS);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Unsupported export format" },
      });
    }
    expect(exportSvc.getInvoiceExportSource).not.toHaveBeenCalled();
  });

  it("maps auth failures to 401/403/404 with safe messages", async () => {
    const { UnauthorizedError, ForbiddenError, NotFoundError } = await import(
      "@/server/auth/requireSession"
    );
    const { GET } = await import("./route");

    exportSvc.getInvoiceExportSource.mockRejectedValueOnce(new UnauthorizedError());
    expect((await GET(requestFor("pdf"), PARAMS)).status).toBe(401);

    exportSvc.getInvoiceExportSource.mockRejectedValueOnce(new ForbiddenError("cross-business"));
    const forbidden = await GET(requestFor("pdf"), PARAMS);
    expect(forbidden.status).toBe(403);
    // The internal reason never reaches the browser.
    expect(await forbidden.json()).toEqual({
      success: false,
      error: { code: "FORBIDDEN", message: "You do not have permission to do this" },
    });

    exportSvc.getInvoiceExportSource.mockRejectedValueOnce(new NotFoundError());
    expect((await GET(requestFor("pdf"), PARAMS)).status).toBe(404);
  });

  it("maps a bad invoice id to 400 and anything else to an opaque 500", async () => {
    const { GET } = await import("./route");

    exportSvc.getInvoiceExportSource.mockRejectedValueOnce(new ValidationError("Bad id"));
    const bad = await GET(requestFor("pdf"), PARAMS);
    expect(bad.status).toBe(400);

    exportSvc.getInvoiceExportSource.mockRejectedValueOnce(
      new Error("prisma connection string postgresql://root:secret@db exploded"),
    );
    const broken = await GET(requestFor("pdf"), PARAMS);
    expect(broken.status).toBe(500);
    const body = (await broken.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain("postgresql");
    expect(body.error.message).not.toContain("secret");
  });
});
