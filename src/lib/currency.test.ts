import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVOICE_CURRENCY,
  invoiceCurrencyLabel,
  normalizeInvoiceCurrency,
  resolveInvoiceDisplayCurrency,
} from "./currency";

describe("normalizeInvoiceCurrency", () => {
  it("canonicalizes ریال / تومان codes", () => {
    expect(normalizeInvoiceCurrency("IRR")).toBe("IRR");
    expect(normalizeInvoiceCurrency("irt")).toBe("IRT");
    expect(normalizeInvoiceCurrency("TOMAN")).toBe("IRT");
    expect(normalizeInvoiceCurrency("RIAL")).toBe("IRR");
  });

  it("falls back to IRR for unknown or empty values", () => {
    expect(normalizeInvoiceCurrency(null)).toBe(DEFAULT_INVOICE_CURRENCY);
    expect(normalizeInvoiceCurrency("")).toBe("IRR");
    expect(normalizeInvoiceCurrency("USD")).toBe("IRR");
  });
});

describe("invoiceCurrencyLabel", () => {
  it("returns Persian unit names, not ISO codes", () => {
    expect(invoiceCurrencyLabel("IRR")).toBe("ریال");
    expect(invoiceCurrencyLabel("IRT")).toBe("تومان");
    expect(invoiceCurrencyLabel("USD")).toBe("ریال");
  });
});

describe("resolveInvoiceDisplayCurrency", () => {
  it("uses the live InvoiceSettings currency for drafts", () => {
    expect(
      resolveInvoiceDisplayCurrency({
        isDraft: true,
        invoiceCurrency: "IRR",
        settingsCurrency: "IRT",
      }),
    ).toBe("IRT");
  });

  it("uses the stored snapshot for finalized invoices, ignoring later settings", () => {
    expect(
      resolveInvoiceDisplayCurrency({
        isDraft: false,
        invoiceCurrency: "IRT",
        settingsCurrency: "IRR",
      }),
    ).toBe("IRT");
  });

  it("falls back to settings (then IRR) for legacy finalized rows without a snapshot", () => {
    expect(
      resolveInvoiceDisplayCurrency({
        isDraft: false,
        invoiceCurrency: null,
        settingsCurrency: "IRT",
      }),
    ).toBe("IRT");
    expect(
      resolveInvoiceDisplayCurrency({
        isDraft: false,
        invoiceCurrency: null,
        settingsCurrency: null,
      }),
    ).toBe("IRR");
  });
});
