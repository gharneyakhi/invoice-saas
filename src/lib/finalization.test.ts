import { describe, it, expect } from "vitest";
import {
  canFinalizeInvoice,
  isFinalizedInvoice,
  isCancelledInvoice,
  FINALIZATION_CONFIRMATION_MESSAGE,
  finalizationErrorMessage,
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

  it("includes the exact required confirmation text", () => {
    expect(FINALIZATION_CONFIRMATION_MESSAGE).toBe(
      "پس از نهایی کردن، فاکتور قابل ویرایش نخواهد بود. آیا مطمئن هستید؟",
    );
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
