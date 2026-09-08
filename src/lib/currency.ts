/**
 * Invoice currency (V1): ریال / تومان only.
 *
 * This is NOT a generic multi-currency system. The two allowed values map onto
 * the existing `InvoiceSettings.currency` string column:
 *
 *   - `IRR` → ریال
 *   - `IRT` → تومان
 *
 * Draft invoices always display the *current* business setting. Finalized
 * invoices display the currency snapshotted onto `Invoice.currency` at
 * finalization time, so a later settings change cannot rewrite history.
 */

export const INVOICE_CURRENCIES = ["IRR", "IRT"] as const;

export type InvoiceCurrency = (typeof INVOICE_CURRENCIES)[number];

export const DEFAULT_INVOICE_CURRENCY: InvoiceCurrency = "IRR";

export const INVOICE_CURRENCY_LABELS: Record<InvoiceCurrency, string> = {
  IRR: "ریال",
  IRT: "تومان",
};

export function isInvoiceCurrency(value: string | null | undefined): value is InvoiceCurrency {
  return value === "IRR" || value === "IRT";
}

/**
 * Canonicalizes a stored/user-supplied currency code to `IRR` | `IRT`.
 *
 * Unknown / empty values fall back to ریال (`IRR`) — the historical default
 * of `InvoiceSettings.currency` — rather than inventing a third unit.
 */
export function normalizeInvoiceCurrency(value: string | null | undefined): InvoiceCurrency {
  if (typeof value !== "string") return DEFAULT_INVOICE_CURRENCY;
  const upper = value.trim().toUpperCase();
  if (upper === "IRT" || upper === "TOMAN" || upper === "TMN") return "IRT";
  if (upper === "IRR" || upper === "RIAL") return "IRR";
  return DEFAULT_INVOICE_CURRENCY;
}

/** Persian unit label for a stored currency code. */
export function invoiceCurrencyLabel(value: string | null | undefined): string {
  return INVOICE_CURRENCY_LABELS[normalizeInvoiceCurrency(value)];
}

/**
 * Which currency a document/list row must display.
 *
 *   - DRAFT  → current InvoiceSettings (the invoice has no snapshot yet)
 *   - FINALIZED / CANCELLED → the invoice's own currency snapshot, falling
 *     back to settings only for legacy rows that predate the snapshot column
 */
export function resolveInvoiceDisplayCurrency(args: {
  isDraft: boolean;
  invoiceCurrency?: string | null;
  settingsCurrency?: string | null;
}): InvoiceCurrency {
  if (!args.isDraft && args.invoiceCurrency) {
    return normalizeInvoiceCurrency(args.invoiceCurrency);
  }
  return normalizeInvoiceCurrency(args.settingsCurrency);
}
