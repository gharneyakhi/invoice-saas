/**
 * Print contract for the invoice preview route.
 *
 * Printing is triggered by the browser's native `window.print()` from a
 * client component (`InvoicePrintButton`); there is deliberately NO custom
 * PDF/print pipeline here — the browser print dialog is the production path
 * (this milestone builds the print-ready A4 layout only).
 *
 * The dependency is isolated behind this tiny function so the behaviour can
 * be unit-tested at the contract level without a DOM: the handler must
 * (a) be a no-op during server-side rendering / in non-browser environments
 * and (b) invoke the host's native `print()` exactly once when present.
 */

export type PrintHost = Pick<Window, "print">;

/**
 * Invokes the browser's native print dialog.
 *
 * `host` is injectable for tests; when omitted the ambient `window` is used.
 * Returns immediately (no-op) when no print host exists (e.g. SSR).
 */
export function printInvoiceDocument(host?: PrintHost | null): void {
  // SSR-safe: with no host and no `window` (server rendering) this is a no-op.
  const target = host ?? (typeof window === "undefined" ? null : window);
  if (!target) return;
  target.print();
}
