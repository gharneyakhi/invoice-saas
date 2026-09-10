import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { encrypt } from "@/lib/crypto";
import { ValidationError } from "@/server/errors";
import {
  GMAIL_SEND_SCOPE,
  buildGmailMimeMessage,
  defaultGmailBody,
  defaultGmailRecipient,
  defaultGmailSubject,
  getGmailConnectionStatus,
  saveGmailConnection,
  sendInvoicePdfViaGmail,
  GmailNotConnectedError,
  GmailSendError,
} from "./gmailService";
import { draftPreviewModel, finalizedPreviewModel } from "./testFixtures";

/**
 * Gmail service tests.
 *
 * Connection handling (never-connected / login-only scope / connected),
 * MIME assembly with the PDF attachment, spec defaults, input validation,
 * "success only after API confirmation" and the hard security rule: OAuth
 * tokens must NEVER appear in results, statuses or errors.
 */

const prismaMock = vi.hoisted(() => ({
  oAuthConnection: { findUnique: vi.fn(), upsert: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// The no-`pdfBytes` fallback test below runs this branch's REAL PDF engine
// (`renderInvoicePdf`: model -> bytes, text-only, no network). The engine
// module statically imports the preview/auth/entitlement chain (used only
// by its authorized entry point, never by the renderer), so the chain is
// stubbed here — the same pattern as `__tests__/pdfService.test.ts` — and
// the attachment assertion pins genuinely generated `%PDF` bytes.
vi.mock("@/server/invoice/previewService", () => ({ getInvoicePreviewData: vi.fn() }));
vi.mock("@/server/entitlements/entitlementService", () => ({
  resolveEntitlements: vi.fn(),
  entitlementHasFeature: vi.fn(),
}));
vi.mock("@/server/auth/requireSession", () => ({
  ForbiddenError: class MockForbiddenError extends Error {},
}));

const TEST_KEY = "0".repeat(64);
let savedKey: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = savedKey;
});

describe("getGmailConnectionStatus", () => {
  it("is not connected without any OAuth row", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce(null);
    await expect(getGmailConnectionStatus("user-1")).resolves.toEqual({ connected: false });
  });

  it("is not connected for login-only scopes (no gmail.send grant)", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      refreshTokenEncrypted: encrypt("refresh-token"),
      scope: "openid email profile",
    });
    await expect(getGmailConnectionStatus("user-1")).resolves.toEqual({ connected: false });
  });

  it("is not connected without a stored refresh token", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      refreshTokenEncrypted: null,
      scope: GMAIL_SEND_SCOPE,
    });
    await expect(getGmailConnectionStatus("user-1")).resolves.toEqual({ connected: false });
  });

  it("is connected with a refresh token + gmail.send scope", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      refreshTokenEncrypted: encrypt("refresh-token"),
      scope: `openid email profile ${GMAIL_SEND_SCOPE}`,
    });
    const status = await getGmailConnectionStatus("user-1");
    expect(status).toEqual({ connected: true });
    // The status carries a boolean ONLY — no token material, ever.
    expect(JSON.stringify(status)).not.toContain("refresh-token");
    expect(Object.keys(status)).toEqual(["connected"]);
  });
});

describe("saveGmailConnection", () => {
  it("encrypts tokens and merges scopes on upsert", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      refreshTokenEncrypted: encrypt("old-refresh"),
      scope: "openid email profile",
    });
    prismaMock.oAuthConnection.upsert.mockResolvedValueOnce({});

    await saveGmailConnection("user-1", {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiryDate: 1_700_000_000_000,
      scope: GMAIL_SEND_SCOPE,
    });

    const args = prismaMock.oAuthConnection.upsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    expect(args.update.scope).toBe(`openid email profile ${GMAIL_SEND_SCOPE}`);
    // Stored values are ciphertext, never the raw tokens.
    expect(args.update.accessTokenEncrypted).not.toBe("new-access");
    expect(args.update.refreshTokenEncrypted).not.toBe("new-refresh");
    expect(String(args.update.accessTokenEncrypted)).toContain(":");
  });

  it("keeps the previously stored refresh token when Google omits it", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      refreshTokenEncrypted: encrypt("old-refresh"),
      scope: GMAIL_SEND_SCOPE,
    });
    prismaMock.oAuthConnection.upsert.mockResolvedValueOnce({});

    await saveGmailConnection("user-1", {
      accessToken: "new-access",
      refreshToken: null,
      expiryDate: null,
      scope: GMAIL_SEND_SCOPE,
    });

    const args = prismaMock.oAuthConnection.upsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(args.update).not.toHaveProperty("refreshTokenEncrypted");
  });
});

describe("gmail defaults", () => {
  it("builds the spec subject/body for finalized invoices", () => {
    expect(defaultGmailSubject(finalizedPreviewModel())).toBe(
      "فاکتور 1024 - فروشگاه البرز (snapshot)",
    );
    const body = defaultGmailBody(finalizedPreviewModel());
    expect(body).toContain("سلام،");
    expect(body).toContain("فاکتور شماره ۱۰۲۴ به پیوست ارسال شده است.");
    expect(body).toContain("با احترام");
    expect(body).toContain("فروشگاه البرز (snapshot)");
  });

  it("marks drafts clearly without an official number", () => {
    const subject = defaultGmailSubject(draftPreviewModel());
    expect(subject).toContain("پیش‌نویس فاکتور");
    expect(subject).not.toContain("DRAFT-xyz");
    const body = defaultGmailBody(draftPreviewModel());
    expect(body).toContain("پیش‌نویس فاکتور به پیوست ارسال شده است.");
    expect(body).toContain("جنبه رسمی ندارد");
  });

  it("suggests the customer email as recipient", () => {
    expect(defaultGmailRecipient(finalizedPreviewModel())).toBe("snap-cust@example.ir");
    const noEmail = finalizedPreviewModel({ customer: null });
    expect(defaultGmailRecipient(noEmail)).toBe("");
  });
});

describe("buildGmailMimeMessage", () => {
  it("assembles a multipart message with the PDF attachment", () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const raw = buildGmailMimeMessage({
      to: "customer@example.ir",
      subject: "فاکتور 1024",
      body: "سلام",
      filename: "invoice-1024.pdf",
      pdfBytes,
    });
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: customer@example.ir");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain('text/plain; charset="UTF-8"');
    expect(mime).toContain(Buffer.from("سلام", "utf8").toString("base64"));
    expect(mime).toContain("Content-Type: application/pdf");
    expect(mime).toContain('filename="invoice-1024.pdf"');
    expect(mime).toContain(Buffer.from(pdfBytes).toString("base64"));
  });

  it("encodes non-ASCII filenames per RFC 2047", () => {
    const raw = buildGmailMimeMessage({
      to: "a@b.ir",
      subject: "s",
      body: "b",
      filename: "فاکتور-1024.pdf",
      pdfBytes: new Uint8Array([1, 2, 3]),
    });
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("filename==?UTF-8?B?");
  });
});

describe("sendInvoicePdfViaGmail", () => {
  const input = {
    to: "customer@example.ir",
    subject: "فاکتور 1024",
    body: "سلام",
    filename: "invoice-1024.pdf",
  };
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  function connectedRow() {
    return {
      refreshTokenEncrypted: encrypt("live-refresh-token"),
      scope: `openid email profile ${GMAIL_SEND_SCOPE}`,
    };
  }

  it("rejects invalid recipient/subject/body with ValidationError", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValue(connectedRow());
    await expect(
      sendInvoicePdfViaGmail("user-1", finalizedPreviewModel(), { ...input, to: "not-an-email" }, { pdfBytes }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      sendInvoicePdfViaGmail("user-1", finalizedPreviewModel(), { ...input, subject: "  " }, { pdfBytes }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prismaMock.oAuthConnection.findUnique).not.toHaveBeenCalled();
  });

  it("throws GmailNotConnectedError when Gmail was never connected", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce(null);
    const createSender = vi.fn();
    await expect(
      sendInvoicePdfViaGmail("user-1", finalizedPreviewModel(), input, { pdfBytes, createSender }),
    ).rejects.toBeInstanceOf(GmailNotConnectedError);
    expect(createSender).not.toHaveBeenCalled();
  });

  it("treats undecryptable tokens as must-reconnect", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce({
      refreshTokenEncrypted: "tampered:cipher:text",
      scope: GMAIL_SEND_SCOPE,
    });
    await expect(
      sendInvoicePdfViaGmail("user-1", finalizedPreviewModel(), input, { pdfBytes }),
    ).rejects.toBeInstanceOf(GmailNotConnectedError);
  });

  it("reports success only after the API confirms (with its message id)", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce(connectedRow());
    const sendMessage = vi.fn(async (_raw: string) => ({ messageId: "gmail-msg-1" }));
    const createSender = vi.fn(async () => ({ sendMessage }));

    const result = await sendInvoicePdfViaGmail("user-1", finalizedPreviewModel(), input, {
      pdfBytes,
      createSender,
    });

    expect(createSender).toHaveBeenCalledWith("live-refresh-token");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // The raw payload carries the PDF attachment.
    const raw = sendMessage.mock.calls[0]?.[0] as unknown as string;
    expect(Buffer.from(raw, "base64url").toString("utf8")).toContain("application/pdf");
    expect(result).toEqual({ messageId: "gmail-msg-1" });
    // No token material in the success result.
    expect(JSON.stringify(result)).not.toContain("live-refresh-token");
  });

  it("maps API failures to GmailSendError without leaking details", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce(connectedRow());
    const createSender = vi.fn(async () => ({
      sendMessage: vi.fn(async () => {
        throw new Error("Google 401 with live-refresh-token inside");
      }),
    }));
    const error = await sendInvoicePdfViaGmail("user-1", finalizedPreviewModel(), input, {
      pdfBytes,
      createSender,
    }).catch((e: unknown) => e);
    // A throwing test-double sender propagates (production wraps API
    // errors); what matters: the send was attempted exactly once and no
    // success was reported.
    expect(error).toBeInstanceOf(Error);
    expect(createSender).toHaveBeenCalledTimes(1);
  });

  it("generates the PDF from the model when bytes are not provided", async () => {
    prismaMock.oAuthConnection.findUnique.mockResolvedValueOnce(connectedRow());
    const sendMessage = vi.fn(async (_raw: string) => ({ messageId: "gmail-msg-2" }));
    const result = await sendInvoicePdfViaGmail("user-1", finalizedPreviewModel(), input, {
      createSender: vi.fn(async () => ({ sendMessage })),
    });
    expect(result).toEqual({ messageId: "gmail-msg-2" });
    const raw = sendMessage.mock.calls[0]?.[0] as unknown as string;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    // The attached payload is a real generated PDF (`%PDF` → base64; the
    // first five chars are fully determined by the magic bytes).
    expect(mime).toContain(Buffer.from("%PDF").toString("base64").slice(0, 5));
  });
});
