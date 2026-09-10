import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";

const { mockListBusinesses, mockExportInvoicePdf } = vi.hoisted(() => ({
  mockListBusinesses: vi.fn(),
  mockExportInvoicePdf: vi.fn(),
}));
const MockUnauthorizedError = vi.hoisted(() =>
  class MockUnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  },
);
const MockForbiddenError = vi.hoisted(() =>
  class MockForbiddenError extends Error {
    constructor(message = "Forbidden") {
      super(message);
      this.name = "ForbiddenError";
    }
  },
);
const MockNotFoundError = vi.hoisted(() =>
  class MockNotFoundError extends Error {
    constructor(message = "Not found") {
      super(message);
      this.name = "NotFoundError";
    }
  },
);

vi.mock("@/server/business/businessService", () => ({
  listBusinesses: mockListBusinesses,
}));

vi.mock("@/server/export/pdfService", () => ({
  exportInvoicePdf: mockExportInvoicePdf,
}));

// The real requireSession module pulls in the prisma client (no generated
// client in this environment); the route only needs the error identities.
vi.mock("@/server/auth/requireSession", () => ({
  UnauthorizedError: MockUnauthorizedError,
  ForbiddenError: MockForbiddenError,
  NotFoundError: MockNotFoundError,
}));

import { GET } from "./route";

function request(invoiceId: string): Request {
  return new Request(`http://localhost/api/invoices/${invoiceId}/pdf`);
}

function context(invoiceId: string) {
  return { params: { invoiceId } };
}

describe("GET /api/invoices/[invoiceId]/pdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListBusinesses.mockResolvedValue([{ id: "biz-1" }]);
  });

  it("streams the service bytes with download headers", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    mockExportInvoicePdf.mockResolvedValue({
      bytes,
      filename: "invoice-INV-101.pdf",
      contentType: "application/pdf",
    });

    const response = await GET(request("inv-1"), context("inv-1"));

    expect(mockExportInvoicePdf).toHaveBeenCalledWith("biz-1", "inv-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain('filename="invoice-INV-101.pdf"');
    expect(disposition).toContain("filename*=UTF-8''invoice-INV-101.pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("encodes non-ASCII filenames with RFC 5987 filename*", async () => {
    mockExportInvoicePdf.mockResolvedValue({
      bytes: new Uint8Array([1]),
      filename: "فاکتور-۱۲.pdf",
      contentType: "application/pdf",
    });

    const response = await GET(request("inv-1"), context("inv-1"));

    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("فاکتور-۱۲.pdf")}`);
    expect(disposition).toMatch(/filename="[^"]*"/);
  });

  it("returns 404 when the caller has no active business", async () => {
    mockListBusinesses.mockResolvedValue([]);

    const response = await GET(request("inv-1"), context("inv-1"));

    expect(response.status).toBe(404);
    expect(mockExportInvoicePdf).not.toHaveBeenCalled();
  });

  it("maps session errors to 401", async () => {
    mockListBusinesses.mockRejectedValue(new UnauthorizedError());

    const response = await GET(request("inv-1"), context("inv-1"));

    expect(response.status).toBe(401);
    expect(mockExportInvoicePdf).not.toHaveBeenCalled();
  });

  it("maps export denial to 403 and unknown invoices to 404", async () => {
    mockExportInvoicePdf.mockRejectedValueOnce(
      new ForbiddenError("no pdf for you"),
    );
    const forbidden = await GET(request("inv-1"), context("inv-1"));
    expect(forbidden.status).toBe(403);

    mockExportInvoicePdf.mockRejectedValueOnce(new NotFoundError("gone"));
    const missing = await GET(request("inv-1"), context("inv-1"));
    expect(missing.status).toBe(404);
  });

  it("lets unexpected failures propagate to Next.js error handling", async () => {
    mockExportInvoicePdf.mockRejectedValueOnce(new Error("disk on fire"));

    await expect(GET(request("inv-1"), context("inv-1"))).rejects.toThrow(
      "disk on fire",
    );
  });
});
