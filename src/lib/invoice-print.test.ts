import { describe, expect, it, vi } from "vitest";
import { printInvoiceDocument } from "@/lib/invoice-print";

/**
 * Print behaviour — contract-level tests.
 *
 * The full browser print flow (window.print dialog, `@media print` CSS hiding
 * the dashboard chrome) cannot be exercised in this repo's node-only test
 * environment (no jsdom / no rendering), so the DOM-independent contract is
 * pinned here instead:
 *   1. printing is a no-op during server-side rendering (no `window`);
 *   2. in a browser the handler invokes the host's native `print()` exactly
 *      once — the client button (`InvoicePrintButton`) is only a thin wrapper
 *      over this contract.
 */

describe("printInvoiceDocument contract", () => {
  it("is a no-op when no window exists (SSR safety)", () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;

    try {
      expect(() => printInvoiceDocument()).not.toThrow();
    } finally {
      if (originalWindow !== undefined) {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("does not throw when window exists but no host is injected", () => {
    const print = vi.fn();
    (globalThis as { window?: unknown }).window = { print } as unknown as Window;

    try {
      expect(() => printInvoiceDocument()).not.toThrow();
      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("invokes the injected print host exactly once", () => {
    const print = vi.fn();
    const host = { print };

    printInvoiceDocument(host);
    printInvoiceDocument(host);

    expect(print).toHaveBeenCalledTimes(2);
  });

  it("prefers the injected host over the ambient window", () => {
    const windowPrint = vi.fn();
    const hostPrint = vi.fn();
    (globalThis as { window?: unknown }).window = { print: windowPrint } as unknown as Window;

    try {
      printInvoiceDocument({ print: hostPrint });
      expect(hostPrint).toHaveBeenCalledTimes(1);
      expect(windowPrint).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
