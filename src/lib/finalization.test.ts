import { describe, it, expect } from "vitest";
import {
  canFinalizeInvoice,
  isFinalizedInvoice,
  isCancelledInvoice,
  canCancelInvoice,
  canDeleteDraftInvoice,
  FINALIZATION_CONFIRMATION_MESSAGE,
  CANCEL_CONFIRMATION_MESSAGE,
  DELETE_DRAFT_CONFIRMATION_MESSAGE,
  finalizationErrorMessage,
  cancelErrorMessage,
  deleteDraftErrorMessage,
  duplicateErrorMessage,
} from "./finalization";

describe("invoice finalization UI helpers", () => {
  it("allows finalization only for an untouched DRAFT invoice", () => {
    expect(canFinalizeInvoice({ status: "DRAFT", finalizedAt: null })).toBe(true);
  });

  it("never offers finalization on finalized or cancelled invoices", () => {
    const finalizedStatuses = [
      "ISSUED",
      "SENT",
      "PENDING_PAYMENT",
      "PARTIALLY_PAID",
      "PAID",
      "OVERDUE",
    ];

    for (const status of finalizedStatuses) {
      expect(canFinalizeInvoice({ status, finalizedAt: new Date("2026-03-10") })).toBe(false);
    }

    expect(canFinalizeInvoice({ status: "CANCELLED", finalizedAt: null })).toBe(false);
    expect(canFinalizeInvoice({ status: "DRAFT", finalizedAt: new Date("2026-03-10") })).toBe(false);
  });

  it("recognizes finalized and cancelled states", () => {
    expect(isFinalizedInvoice({ status: "PENDING_PAYMENT", finalizedAt: new Date("2026-03-10") })).toBe(true);
    expect(isFinalizedInvoice({ status: "DRAFT", finalizedAt: null })).toBe(false);
    expect(isCancelledInvoice({ status: "CANCELLED", finalizedAt: null })).toBe(true);
    expect(isCancelledInvoice({ status: "DRAFT", finalizedAt: null })).toBe(false);
  });

  it("allows cancellation only for finalized, un-cancelled invoices", () => {
    expect(canCancelInvoice({ status: "ISSUED", finalizedAt: new Date("2026-03-10") })).toBe(true);
    expect(canCancelInvoice({ status: "PAID", finalizedAt: new Date("2026-03-10") })).toBe(true);
    expect(canCancelInvoice({ status: "DRAFT", finalizedAt: null })).toBe(false);
    expect(canCancelInvoice({ status: "CANCELLED", finalizedAt: new Date("2026-03-10") })).toBe(false);
  });

  it("allows deleting draft only for untouched DRAFT invoices", () => {
    expect(canDeleteDraftInvoice({ status: "DRAFT", finalizedAt: null })).toBe(true);
    expect(canDeleteDraftInvoice({ status: "ISSUED", finalizedAt: new Date("2026-03-10") })).toBe(false);
    expect(canDeleteDraftInvoice({ status: "CANCELLED", finalizedAt: new Date("2026-03-10") })).toBe(false);
  });

  it("includes confirmation messages", () => {
    expect(FINALIZATION_CONFIRMATION_MESSAGE).toContain("نهایی کردن");
    expect(CANCEL_CONFIRMATION_MESSAGE).toContain("لغو");
    expect(DELETE_DRAFT_CONFIRMATION_MESSAGE).toContain("حذف");
  });
});

describe("cancellation, draft deletion, and duplication error mapping", () => {
  it("maps cancellation errors to clear Persian messages", () => {
    expect(cancelErrorMessage({ code: "VALIDATION_ERROR", message: "Invoice is already cancelled" })).toContain("قبلاً لغو شده");
    expect(cancelErrorMessage({ code: "VALIDATION_ERROR", message: "Draft invoices cannot be cancelled" })).toContain("پیش‌نویس");
    expect(cancelErrorMessage({ code: "FORBIDDEN", message: "Forbidden" })).toContain("دسترسی");
  });

  it("maps draft deletion errors to clear Persian messages", () => {
    expect(deleteDraftErrorMessage({ code: "VALIDATION_ERROR", message: "Finalized invoices cannot be deleted" })).toContain("تنها فاکتورهای پیش‌نویس");
    expect(deleteDraftErrorMessage({ code: "FORBIDDEN", message: "Forbidden" })).toContain("دسترسی");
  });

  it("maps duplication errors to clear Persian messages", () => {
    expect(duplicateErrorMessage({ code: "FORBIDDEN", message: "Invoice duplication is not available" })).toContain("پلن رایگان فعال نیست");
    expect(duplicateErrorMessage({ code: "VALIDATION_ERROR", message: "Cannot duplicate invoice referencing an archived customer" })).toContain("مشتری یا محصول بایگانی‌شده");
  });
});

describe("finalization error mapping", () => {
  it("maps each stable action error code to a clear Persian message", () => {
    expect(finalizationErrorMessage({ code: "UNAUTHORIZED", message: "Unauthorized" })).toContain("وارد");
    expect(finalizationErrorMessage({ code: "FORBIDDEN", message: "Forbidden" })).toContain("دسترسی");
    expect(finalizationErrorMessage({ code: "NOT_FOUND", message: "Invoice not found" })).toContain("یافت نشد");
    expect(finalizationErrorMessage({ code: "INVOICE_LIMIT_REACHED", message: "Invoice limit reached" })).toContain("سقف");
    expect(finalizationErrorMessage({ code: "ENTITLEMENT_DATA_ERROR", message: "Entitlement missing" })).toContain("اشتراک");
    expect(finalizationErrorMessage({ code: "INTERNAL_ERROR", message: "DB down" })).toContain("خطای غیرمنتظره");
  });

  it("turns domain lifecycle failures into safe, actionable validation messages", () => {
    expect(
      finalizationErrorMessage({
        code: "VALIDATION_ERROR",
        message: "Only draft invoices can be finalized; this invoice is already finalized",
      }),
    ).toContain("نهایی شده");
    expect(
      finalizationErrorMessage({
        code: "VALIDATION_ERROR",
        message: "Invoice is no longer in draft status and cannot be finalized",
      }),
    ).toContain("وضعیت آن تغییر کرده");
    expect(
      finalizationErrorMessage({
        code: "VALIDATION_ERROR",
        message: "Cannot finalize invoice for an archived business",
      }),
    ).toContain("بایگانی");
    expect(
      finalizationErrorMessage({
        code: "VALIDATION_ERROR",
        message: "Cannot finalize an invoice with no line items",
      }),
    ).toContain("قلم");
  });

  it("never leaks the raw failure detail for an unexpected action error", () => {
    const message = finalizationErrorMessage({ code: "INTERNAL_ERROR", message: "SQL syntax error at invoices" });
    expect(message).not.toContain("SQL");
    expect(message).toContain("خطای غیرمنتظره");
  });
});
