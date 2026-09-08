import { describe, expect, it, vi } from "vitest";

// `actionResult` sits behind the auth chain (session → bootstrap → Prisma
// client). Only its error-code enum is needed here, so the auth module is
// stubbed — the same convention `previewModel.test.ts` uses for its server
// dependencies.
vi.mock("@/server/auth/requireSession", () => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  class NotFoundError extends Error {}
  return { UnauthorizedError, ForbiddenError, NotFoundError, requireSession: vi.fn() };
});
import {
  EDITOR_ERROR_MESSAGES,
  editorActionErrorDetail,
  editorActionErrorMessage,
} from "@/lib/invoice-editor-messages";
import { ActionErrorCode, type ActionError } from "@/server/actions/actionResult";

/**
 * The editor's error surface.
 *
 * Two halves of one contract: `toActionError` (server) decides what may be
 * said, and this map decides how it is said — Persian, friendly, fixed-length.
 * These tests pin the UI half: every stable code has copy, an unknown code
 * never echoes the server string, and technical detail never reaches the user.
 */

describe("friendly Persian copy per action error code", () => {
  it("covers every code the action boundary can return", () => {
    const codes = Object.values(ActionErrorCode);

    for (const code of codes) {
      const message = EDITOR_ERROR_MESSAGES[code];
      expect(message, code).toBeTruthy();
      expect(typeof message).toBe("string");
      // Persian copy, not a code or an English identifier.
      expect(message).toMatch(/[\u0600-\u06FF]/);
      expect(message).not.toMatch(/[A-Za-z]{8,}/);
    }
  });

  it("keeps the specific, actionable messages distinct (quota ≠ auth ≠ not found)", () => {
    expect(editorActionErrorMessage({ code: "INVOICE_LIMIT_REACHED", message: "…" })).toContain("سقف");
    expect(editorActionErrorMessage({ code: "UNAUTHORIZED", message: "…" })).toContain("نشست");
    expect(editorActionErrorMessage({ code: "NOT_FOUND", message: "…" })).toContain("یافت نشد");
    expect(editorActionErrorMessage({ code: "FORBIDDEN", message: "…" })).toContain("مجاز");
    expect(editorActionErrorMessage({ code: "VALIDATION_ERROR", message: "…" })).toContain("معتبر نیست");
    expect(editorActionErrorMessage({ code: "ENTITLEMENT_DATA_ERROR", message: "…" })).toContain("اشتراک");
  });

  it("falls back to the generic internal message for an unknown code", () => {
    const unknown = { code: "PRISMA_P2002", message: "Unique constraint failed" } as unknown as ActionError;

    expect(editorActionErrorMessage(unknown)).toBe(EDITOR_ERROR_MESSAGES.INTERNAL_ERROR);
    expect(editorActionErrorMessage(unknown)).not.toContain("PRISMA");
    expect(editorActionErrorMessage(unknown)).not.toContain("constraint");
  });

  it("never repeats a raw server message for infrastructure-shaped errors", () => {
    const leaks = [
      "PrismaClientKnownRequestError: Unique constraint on (invoiceId)",
      "connect ECONNREFUSED 10.0.0.4:5432",
      "The AWS Access Key Id you provided (AKIAIOSFODNN7EXAMPLE) does not exist",
      "SyntaxError: Unexpected token in SQL at QueryRaw",
    ];

    for (const message of leaks) {
      for (const code of Object.values(ActionErrorCode)) {
        const shown = editorActionErrorMessage({ code, message });
        expect(shown).not.toBe(message);
        for (const needle of ["Prisma", "ECONNREFUSED", "AKIA", "SQL", "10.0.0.4"]) {
          expect(shown).not.toContain(needle);
        }
      }
    }
  });
});

describe("when the server's own message may be shown", () => {
  it("surfaces field-level validation text — it is the user's own input", () => {
    expect(
      editorActionErrorDetail({
        code: "VALIDATION_ERROR",
        message: "items.0.title: Item title is required",
      }),
    ).toBe("items.0.title: Item title is required");
  });

  it("hides the message of every other code, including quota and storage", () => {
    expect(editorActionErrorDetail({ code: "INVOICE_LIMIT_REACHED", message: "free plan allows 5" })).toBeUndefined();
    expect(editorActionErrorDetail({ code: "INTERNAL_ERROR", message: "raw db detail" })).toBeUndefined();
    expect(editorActionErrorDetail({ code: "FILE_STORAGE_NOT_CONFIGURED", message: "STORAGE_BUCKET missing" })).toBeUndefined();
  });
});
