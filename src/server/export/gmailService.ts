import { z } from "zod";
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import type { InvoicePreviewModel } from "@/lib/invoice-preview-model";
import { formatCurrency, formatPersianDate, toPersianDigits } from "@/lib/formatters";
import { ValidationError } from "@/server/errors";
import { generateInvoicePdf } from "./pdfService";
import { DRAFT_EXPORT_NOTICE } from "./exportCopy";
import {
  GMAIL_SEND_SCOPE,
  isGmailSendScopeGranted,
  mergeOAuthScope,
  requireGmailOAuthConfig,
  type GmailTokenExchange,
} from "./gmailOAuth";

export { GMAIL_SEND_SCOPE };

/**
 * Gmail invoice sending — server-side only (Export & Sharing V1).
 *
 * Security contract (never violated):
 *   - Google access/refresh tokens live ONLY in `OAuthConnection` in
 *     encrypted form (`encrypt`/`decrypt` with `OAUTH_TOKEN_ENCRYPTION_KEY`)
 *     and are decrypted transiently inside this module to authorize ONE
 *     Gmail API call — they are never returned to the client, never logged,
 *     never appear in errors or DTOs;
 *   - sending requires an authenticated session + business ownership +
 *     invoice isolation (enforced by the caller — `exportActions` loads the
 *     model through `getInvoiceExportSource` — this module only ever sends
 *     the model it is handed);
 *   - success is reported ONLY after the Gmail API confirms the send
 *     (`users.messages.send` resolves with a message id).
 *
 * Connection model: Gmail is "connected" when the user has completed the
 * separate Gmail consent (see `gmailOAuth.ts`) AND a usable refresh token
 * is stored. Login-only sessions (scope `openid email profile`) are NOT
 * connected — the UI shows the connect flow instead of failing silently.
 */

import { GmailNotConnectedError, GmailSendError } from "./gmailErrors";

export { GmailNotConnectedError, GmailSendError };

export interface GmailConnectionStatus {
  connected: boolean;
}

/**
 * Checks whether the user can currently send through Gmail. Returns a
 * boolean ONLY — no tokens, no expiry details, nothing sensitive.
 */
export async function getGmailConnectionStatus(userId: string): Promise<GmailConnectionStatus> {
  const connection = await prisma.oAuthConnection.findUnique({
    where: { userId_provider: { userId, provider: "GOOGLE" } },
    select: { refreshTokenEncrypted: true, scope: true },
  });
  if (!connection?.refreshTokenEncrypted) return { connected: false };
  if (!isGmailSendScopeGranted(connection.scope)) return { connected: false };
  return { connected: true };
}

/**
 * Persists tokens from the Gmail connect callback (server-side only).
 * Scopes are MERGED with any previously granted ones (login scopes are
 * kept); a missing refresh token keeps the previously stored one.
 */
export async function saveGmailConnection(
  userId: string,
  tokens: GmailTokenExchange,
): Promise<void> {
  const existing = await prisma.oAuthConnection.findUnique({
    where: { userId_provider: { userId, provider: "GOOGLE" } },
    select: { refreshTokenEncrypted: true, scope: true },
  });
  const scope = mergeOAuthScope(existing?.scope, tokens.scope ?? GMAIL_SEND_SCOPE);
  await prisma.oAuthConnection.upsert({
    where: { userId_provider: { userId, provider: "GOOGLE" } },
    update: {
      ...(tokens.accessToken ? { accessTokenEncrypted: encrypt(tokens.accessToken) } : {}),
      ...(tokens.refreshToken ? { refreshTokenEncrypted: encrypt(tokens.refreshToken) } : {}),
      expiresAt: tokens.expiryDate ? new Date(tokens.expiryDate) : null,
      scope,
    },
    create: {
      userId,
      provider: "GOOGLE",
      accessTokenEncrypted: tokens.accessToken ? encrypt(tokens.accessToken) : null,
      refreshTokenEncrypted: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiryDate ? new Date(tokens.expiryDate) : null,
      scope,
    },
  });
}

// ---------------------------------------------------------------------------
// Defaults (spec: subject/body, draft-aware)
// ---------------------------------------------------------------------------

/** `فاکتور <number> - <business>` (drafts: no official number exists). */
export function defaultGmailSubject(model: InvoicePreviewModel): string {
  const business = model.seller?.businessName ?? "";
  if (model.isDraft) {
    return `پیش‌نویس فاکتور ${model.invoice.id.slice(0, 8)} - ${business}`.trim();
  }
  return `فاکتور ${model.officialNumber ?? model.invoice.invoiceNumber} - ${business}`.trim();
}

export function defaultGmailBody(model: InvoicePreviewModel): string {
  const business = model.seller?.businessName ?? "";
  const lines = ["سلام،"];
  if (model.isDraft) {
    lines.push("پیش‌نویس فاکتور به پیوست ارسال شده است.");
    lines.push(DRAFT_EXPORT_NOTICE);
  } else {
    lines.push(
      `فاکتور شماره ${toPersianDigits(model.officialNumber ?? model.invoice.invoiceNumber)} به پیوست ارسال شده است.`,
    );
    lines.push(`مبلغ نهایی: ${formatCurrency(model.invoice.total, model.currency)}`);
    lines.push(`تاریخ صدور: ${formatPersianDate(model.invoice.issueDate)}`);
  }
  lines.push("", "با احترام", business);
  return lines.join("\n");
}

/** Suggested recipient: the snapshot/live customer email, if any. */
export function defaultGmailRecipient(model: InvoicePreviewModel): string {
  return model.customer?.email?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// MIME (pure — attachment assembly without network)
// ---------------------------------------------------------------------------

export interface GmailMimeInput {
  to: string;
  subject: string;
  body: string;
  /** Sanitized attachment filename (see `filename.ts`). */
  filename: string;
  pdfBytes: Uint8Array;
}

function base64EncodeUtf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Assembles the `multipart/mixed` message (UTF-8 Persian body + PDF
 * attachment) and returns the base64url `raw` payload for
 * `gmail.users.messages.send`. Pure: fully unit-testable without Google.
 */
export function buildGmailMimeMessage(input: GmailMimeInput): string {
  const boundary = `invoice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const encodedSubject = `=?UTF-8?B?${base64EncodeUtf8(input.subject)}?=`;
  // Filenames with non-ASCII chars use RFC 2047 encoding inside the header.
  const encodedFilename = /^[\x20-\x7e]+$/.test(input.filename)
    ? `"${input.filename}"`
    : `=?UTF-8?B?${base64EncodeUtf8(input.filename)}?=`;
  const pdfBase64 = Buffer.from(input.pdfBytes).toString("base64");

  const lines = [
    `To: ${input.to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64EncodeUtf8(input.body),
    "",
    `--${boundary}`,
    'Content-Type: application/pdf; name=' + encodedFilename,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename=${encodedFilename}`,
    "",
    // MIME line length: 76 chars per RFC 2045.
    ...(pdfBase64.match(/.{1,76}/g) ?? []),
    `--${boundary}--`,
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// Send (Gmail API, server-side only)
// ---------------------------------------------------------------------------

const sendInputSchema = z.object({
  to: z.string().trim().email("to: a valid recipient email is required"),
  subject: z.string().trim().min(1, "subject: a subject is required").max(200),
  body: z.string().trim().min(1, "body: a message is required").max(10000),
  filename: z.string().trim().min(1).max(120),
});

export interface SendInvoiceGmailArgs {
  to: string;
  subject: string;
  body: string;
  /** Sanitized PDF filename for the attachment. */
  filename: string;
}

/** Minimal Gmail sender (real implementation below, fakes in tests). */
export interface GmailSender {
  sendMessage(raw: string): Promise<{ messageId: string }>;
}

function parseSendInput(input: SendInvoiceGmailArgs): SendInvoiceGmailArgs {
  const parsed = sendInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(first?.message ?? "Invalid Gmail send input");
  }
  return parsed.data;
}

async function loadRefreshToken(userId: string): Promise<string> {
  const connection = await prisma.oAuthConnection.findUnique({
    where: { userId_provider: { userId, provider: "GOOGLE" } },
    select: { refreshTokenEncrypted: true, scope: true },
  });
  if (!connection?.refreshTokenEncrypted || !isGmailSendScopeGranted(connection.scope)) {
    throw new GmailNotConnectedError();
  }
  try {
    return decrypt(connection.refreshTokenEncrypted);
  } catch {
    // Tampered/undecryptable tokens are treated as "must reconnect" —
    // never as an internal error and never with details.
    throw new GmailNotConnectedError("Gmail needs to be reconnected");
  }
}

/** Production sender: refresh-token OAuth2 → `gmail.users.messages.send`. */
async function createGmailApiSender(refreshToken: string): Promise<GmailSender> {
  const config = requireGmailOAuthConfig();
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
  auth.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: "v1", auth });
  return {
    sendMessage: async (raw: string) => {
      try {
        const response = await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw },
        });
        const messageId = response.data.id;
        if (!messageId) throw new GmailSendError();
        return { messageId };
      } catch (error) {
        if (error instanceof GmailSendError) throw error;
        // Raw Google API errors stay server-side (they may echo request
        // details); the client gets a stable, safe failure.
        throw new GmailSendError();
      }
    },
  };
}

export interface SendInvoiceGmailDeps {
  /** Override the Gmail API sender (tests). */
  createSender?: (refreshToken: string) => Promise<GmailSender>;
  /** Skip PDF regeneration when bytes are already available. */
  pdfBytes?: Uint8Array;
}

export interface SendInvoiceGmailResult {
  messageId: string;
}

/**
 * Sends the invoice PDF through the user's connected Gmail.
 *
 * Only resolves successfully AFTER the Gmail API confirms the send (with
 * its message id). Throws `GmailNotConnectedError` when the Gmail scope
 * was never granted (the UI shows the connect flow), `ValidationError`
 * for bad recipient/subject/body, and `GmailSendError` for API failures.
 * The PDF attached is generated by the same `generateInvoicePdf` every
 * other export uses — finalized rows send their snapshots.
 */
export async function sendInvoicePdfViaGmail(
  userId: string,
  model: InvoicePreviewModel,
  input: SendInvoiceGmailArgs,
  deps: SendInvoiceGmailDeps = {},
): Promise<SendInvoiceGmailResult> {
  const parsed = parseSendInput(input);
  const refreshToken = await loadRefreshToken(userId);

  const pdfBytes = deps.pdfBytes ?? (await generateInvoicePdf(model));
  const raw = buildGmailMimeMessage({
    to: parsed.to,
    subject: parsed.subject,
    body: parsed.body,
    filename: parsed.filename,
    pdfBytes,
  });

  const sender = deps.createSender
    ? await deps.createSender(refreshToken)
    : await createGmailApiSender(refreshToken);
  return sender.sendMessage(raw);
}
