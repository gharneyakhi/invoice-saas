import { describe, expect, it, vi } from "vitest";

// Only the session source and the DB client are stubbed: with no session,
// the REAL requireSession throws before any database access, so the dummy
// prisma client is never touched. Everything else — exportInvoicePdf,
// getInvoicePreviewData, requireBusinessOwnership, requireSession, the error
// classes — is the real production code.
vi.mock("next-auth", () => {
  // Dummy OAuth env so the real auth-options module loads (its values are
  // never used: the stubbed session fails before any provider logic runs).
  process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";
  return { getServerSession: vi.fn().mockResolvedValue(null) };
});
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { exportInvoicePdf } from "../pdfService";
import { UnauthorizedError } from "@/server/auth/requireSession";

describe("exportInvoicePdf authorization (real modules)", () => {
  it("rejects unauthenticated export attempts before touching invoice data", async () => {
    await expect(exportInvoicePdf("biz-1", "inv-1")).rejects.toThrow("Unauthorized");
    await expect(exportInvoicePdf("biz-1", "inv-1")).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
