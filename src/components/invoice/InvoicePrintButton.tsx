"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { PrinterIcon } from "@/components/icons";
import { printInvoiceDocument } from "@/lib/invoice-print";

/**
 * «چاپ فاکتور» — triggers the browser's native print dialog.
 *
 * The A4 layout lives entirely in CSS (`@media print`): the dashboard chrome
 * and this toolbar are hidden by print styles, so only the invoice document
 * is printed. This component deliberately adds NO custom print pipeline —
 * `window.print()` is the production path for this milestone.
 */
export function InvoicePrintButton() {
  return (
    <Button
      type="button"
      variant="primary"
      onClick={() => printInvoiceDocument()}
      className="gap-2 shadow-sm"
    >
      <PrinterIcon size={16} />
      <span>چاپ فاکتور</span>
    </Button>
  );
}
