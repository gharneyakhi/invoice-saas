import { describe, expect, it } from "vitest";
import {
  DRAFT_INVOICE_DISPLAY_LABEL,
  formatInvoiceIdentifierDisplay,
} from "./invoice-identifier-display";

/**
 * Presentation contract for the invoice identifier shown in the Dashboard UI.
 *
 * The fixtures mirror the exact shape produced by the real data flow:
 * `dashboardService.toRecentInvoiceDTO` maps `status` and `invoiceNumber`
 * 1:1 from the `invoices` table — a DRAFT row carries
 * `{ status: "DRAFT", invoiceNumber: "DRAFT-<uuid>", finalizedAt: null }`.
 * The status pill renders from the same `status` field, so any row whose pill
 * says «پیش‌نویس» must render «پیش‌نویس» (never the UUID) in the number cell.
 */

const DRAFT_UUID = "3f5a4d2c-1b6e-4c7d-9a0e-8b2f1d3c5a77";

describe("formatInvoiceIdentifierDisplay — real DTO shape", () => {
  it("renders «پیش‌نویس» for the exact dashboard DTO of a draft (status DRAFT + DRAFT-<uuid>)", () => {
    expect(
      formatInvoiceIdentifierDisplay("DRAFT", `DRAFT-${DRAFT_UUID}`),
    ).toBe(DRAFT_INVOICE_DISPLAY_LABEL);
    expect(formatInvoiceIdentifierDisplay("DRAFT", `DRAFT-${DRAFT_UUID}`)).toBe("پیش‌نویس");
  });

  it("never exposes the UUID or any DRAFT-<uuid>/DRAFT:<uuid> placeholder", () => {
    const outputs = [
      formatInvoiceIdentifierDisplay("DRAFT", `DRAFT-${DRAFT_UUID}`),
      formatInvoiceIdentifierDisplay("DRAFT", `DRAFT:${DRAFT_UUID}`),
      // Defense-in-depth: a row that left DRAFT but still carries the
      // placeholder (e.g. a draft cancelled before finalization).
      formatInvoiceIdentifierDisplay("CANCELLED", `DRAFT-${DRAFT_UUID}`),
    ];

    for (const output of outputs) {
      expect(output).toBe("پیش‌نویس");
      expect(output).not.toContain(DRAFT_UUID);
      expect(output).not.toMatch(/DRAFT[:-][0-9a-f-]{8,}/i);
    }
  });

  it("keeps the official invoice number of finalized invoices (Persian digits only)", () => {
    expect(formatInvoiceIdentifierDisplay("PENDING_PAYMENT", "14052")).toBe("۱۴۰۵۲");
    expect(formatInvoiceIdentifierDisplay("PAID", "14052")).toBe("۱۴۰۵۲");
    expect(formatInvoiceIdentifierDisplay("SENT", "INV-101")).toBe("INV-۱۰۱");
  });

  it("falls back to «—» when no identifier is present", () => {
    expect(formatInvoiceIdentifierDisplay("ISSUED", "")).toBe("—");
    expect(formatInvoiceIdentifierDisplay("ISSUED", null)).toBe("—");
    expect(formatInvoiceIdentifierDisplay("ISSUED", undefined)).toBe("—");
  });
});
