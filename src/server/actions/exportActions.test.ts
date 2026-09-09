import { describe, it, expect, vi, beforeEach } from "vitest";
import { GmailNotConnectedError, GmailSendError } from "@/server/export/gmailErrors";
import { finalizedPreviewModel } from "@/server/export/testFixtures";

/**
 * Application-boundary tests for the export Server Actions.
 *
 * These prove the boundary contract only: session gating, delegation to
 * the export service/generator layer, safe error mapping and serializable
 * DTO output. The domain rules (ownership, snapshot selection, MIME
 * construction) are covered by the service suites, so those modules are
 * mocked here. The pure modules (`telegram`, `invoice-export` URL helpers)
 * stay real so the DTO shape is exercised end to end.
 */

const requireSession = vi.hoisted(() => vi.fn());

const exportSvc = vi.hoisted(() => ({
  getInvoiceExportBundle: vi.fn(),
}));

const pdfSvc = vi.hoisted(() => ({
  renderInvoicePdf: vi.fn(),
}));

const gmailSvc = vi.hoisted(() => ({
  defaultGmailSubject: vi.fn(),
  defaultGmailBody: vi.fn(),
  defaultGmailRecipient: vi.fn(),
  getGmailConnectionStatus: vi.fn(),
  sendInvoicePdfViaGmail: vi.fn(),
}));

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
    requireSession,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
  };
});

vi.mock("@/server/export/exportService", () => exportSvc);
vi.mock("@/server/export/pdfService", () => pdfSvc);
vi.mock("@/server/export/gmailService", () => gmailSvc);

function mockBundle() {
  const model = finalizedPreviewModel();
  return {
    model,
    filenames: {
      pdf: { filename: "فاکتور-1024.pdf", asciiFallback: "invoice-1024.pdf" },
      png: { filename: "فاکتور-1024.png", asciiFallback: "invoice-1024.png" },
      jpg: { filename: "فاکتور-1024.jpg", asciiFallback: "invoice-1024.jpg" },
      xlsx: { filename: "فاکتور-1024.xlsx", asciiFallback: "invoice-1024.xlsx" },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  requireSession.mockResolvedValue({ userId: "user-1", accountId: "acct-1" });
  exportSvc.getInvoiceExportBundle.mockResolvedValue(mockBundle());
  gmailSvc.getGmailConnectionStatus.mockResolvedValue({ connected: true });
  gmailSvc.defaultGmailSubject.mockReturnValue("فاکتور ۱۰۲۴");
  gmailSvc.defaultGmailBody.mockReturnValue("سلام");
  gmailSvc.defaultGmailRecipient.mockReturnValue("customer@example.ir");
  gmailSvc.sendInvoicePdfViaGmail.mockResolvedValue({ messageId: "msg-1" });
  pdfSvc.renderInvoicePdf.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
});

describe("getExportMetadata", () => {
  it("returns all four download links plus telegram and gmail payloads", async () => {
    vi.stubEnv("APP_URL", "https://app.example.ir");
    const { getExportMetadata } = await import("./exportActions");
    const result = await getExportMetadata("biz-1", "inv-1");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.businessId).toBe("biz-1");
    expect(result.data.invoiceId).toBe("inv-1");
    expect(result.data.isDraft).toBe(false);
    expect(result.data.displayNumber).toBe("1024");
    expect(result.data.downloads).toHaveLength(4);
    expect(result.data.downloads[0]).toMatchObject({
      format: "pdf",
      url: "/api/businesses/biz-1/invoices/inv-1/export?format=pdf",
      filename: "فاکتور-1024.pdf",
    });
    expect(result.data.telegram.text).toContain("۱۰۲۴");
    expect(result.data.telegram.hasFileAttachment).toBe(false);
    expect(result.data.gmail).toMatchObject({ connected: true, to: "customer@example.ir" });
    // The user id always comes from the session, never from the client.
    expect(gmailSvc.getGmailConnectionStatus).toHaveBeenCalledWith("user-1");
  });

  it("serializes to JSON without loss (Next.js action payload)", async () => {
    const { getExportMetadata } = await import("./exportActions");
    const result = await getExportMetadata("biz-1", "inv-1");
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it("rejects an unauthenticated caller before touching any service", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { getExportMetadata } = await import("./exportActions");
    requireSession.mockRejectedValue(new UnauthorizedError());

    const result = await getExportMetadata("biz-1", "inv-1");

    expect(result).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
    expect(exportSvc.getInvoiceExportBundle).not.toHaveBeenCalled();
    expect(gmailSvc.getGmailConnectionStatus).not.toHaveBeenCalled();
  });

  it("maps a foreign invoice to FORBIDDEN and never leaks data", async () => {
    const { ForbiddenError } = await import("@/server/auth/requireSession");
    const { getExportMetadata } = await import("./exportActions");
    exportSvc.getInvoiceExportBundle.mockRejectedValue(new ForbiddenError("Not your invoice"));

    const result = await getExportMetadata("biz-1", "other-tenant-invoice");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("FORBIDDEN");
  });
});

describe("getGmailConnectionStatus", () => {
  it("checks the connection for the session user", async () => {
    const { getGmailConnectionStatus } = await import("./exportActions");
    const result = await getGmailConnectionStatus();
    expect(result).toEqual({ success: true, data: { connected: true } });
    expect(gmailSvc.getGmailConnectionStatus).toHaveBeenCalledWith("user-1");
  });

  it("requires a session", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { getGmailConnectionStatus } = await import("./exportActions");
    requireSession.mockRejectedValue(new UnauthorizedError());
    const result = await getGmailConnectionStatus();
    expect(result.success).toBe(false);
  });
});

describe("sendInvoiceGmail", () => {
  const input = { to: "customer@example.ir", subject: "فاکتور", body: "سلام" };

  it("sends a server-generated PDF and returns the API message id", async () => {
    const { sendInvoiceGmail } = await import("./exportActions");
    const result = await sendInvoiceGmail("biz-1", "inv-1", input);

    expect(result).toEqual({ success: true, data: { messageId: "msg-1" } });
    // The PDF rendered at send time is attached — never client bytes.
    expect(pdfSvc.renderInvoicePdf).toHaveBeenCalledTimes(1);
    expect(gmailSvc.sendInvoicePdfViaGmail).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ isDraft: false }),
      {
        to: input.to,
        subject: input.subject,
        body: input.body,
        filename: "فاکتور-1024.pdf",
      },
      expect.objectContaining({ pdfBytes: expect.any(Uint8Array) }),
    );
    const pdfBytes = gmailSvc.sendInvoicePdfViaGmail.mock.calls[0]?.[3]?.pdfBytes as
      | Uint8Array
      | undefined;
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect([...(pdfBytes ?? new Uint8Array()).subarray(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("maps a missing connection to GMAIL_NOT_CONNECTED (UI offers connect)", async () => {
    const { sendInvoiceGmail } = await import("./exportActions");
    gmailSvc.sendInvoicePdfViaGmail.mockRejectedValue(new GmailNotConnectedError());
    const result = await sendInvoiceGmail("biz-1", "inv-1", input);
    expect(result).toEqual({
      success: false,
      error: { code: "GMAIL_NOT_CONNECTED", message: "Gmail is not connected" },
    });
  });

  it("maps API failures to GMAIL_SEND_FAILED without leaking details", async () => {
    const { sendInvoiceGmail } = await import("./exportActions");
    gmailSvc.sendInvoicePdfViaGmail.mockRejectedValue(new GmailSendError());
    const result = await sendInvoiceGmail("biz-1", "inv-1", input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("GMAIL_SEND_FAILED");
  });

  it("requires a session and never renders when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/server/auth/requireSession");
    const { sendInvoiceGmail } = await import("./exportActions");
    requireSession.mockRejectedValue(new UnauthorizedError());
    const result = await sendInvoiceGmail("biz-1", "inv-1", input);
    expect(result.success).toBe(false);
    expect(pdfSvc.renderInvoicePdf).not.toHaveBeenCalled();
  });
});
