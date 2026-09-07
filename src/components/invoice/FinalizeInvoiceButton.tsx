"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AlertTriangleIcon } from "@/components/icons";
import { finalizeInvoice } from "@/server/actions/invoiceActions";
import type { ActionError } from "@/server/actions/actionResult";
import {
  FINALIZATION_CONFIRMATION_MESSAGE,
  finalizationErrorMessage,
} from "@/lib/finalization";

export interface FinalizeInvoiceButtonProps {
  invoiceId: string;
}

/**
 * The only client-side entry point for Invoice Finalization V1.
 *
 * This component only:
 *   - asks for explicit confirmation before triggering a Server Action, and
 *   - refreshes the detail page after a successful finalization.
 *
 * Authorization, validation, calculation, numbering, quota, snapshots,
 * payment/status derivation and transaction safety are all owned by the
 * existing `invoiceService.finalizeInvoice`. The Server Action is thin and
 * receives only the untrusted `invoiceId`; it never accepts an accountId from
 * the browser.
 */
export function FinalizeInvoiceButton({ invoiceId }: FinalizeInvoiceButtonProps) {
  const router = useRouter();
  const [isPending, setIsPending] = React.useState(false);
  const [error, setError] = React.useState<ActionError | null>(null);

  async function handleFinalize() {
    if (typeof window === "undefined") return;
    if (!window.confirm(FINALIZATION_CONFIRMATION_MESSAGE)) return;

    setIsPending(true);
    setError(null);

    try {
      const result = await finalizeInvoice(invoiceId);

      if (result.success) {
        // Re-render the server component so the page shows the finalized
        // invoice, its official number and no draft actions.
        router.refresh();
        return;
      }

      setError(result.error);
      // A lifecycle rejection (already finalized / concurrent finalization)
      // means the visible page is stale — refresh so the user sees the truth.
      if (result.error.code === "VALIDATION_ERROR") {
        router.refresh();
      }
    } catch {
      setError({ code: "INTERNAL_ERROR", message: "An unexpected error occurred" });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {error && (
        <p
          role="alert"
          className="flex max-w-xs items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-right text-[11px] leading-relaxed text-rose-700"
        >
          <AlertTriangleIcon size={13} className="mt-0.5 shrink-0" />
          <span>{finalizationErrorMessage(error)}</span>
        </p>
      )}
      <Button
        variant="primary"
        size="sm"
        isLoading={isPending}
        disabled={!invoiceId}
        onClick={handleFinalize}
        className="shadow-sm"
      >
        <span>{isPending ? "در حال نهایی کردن…" : "نهایی کردن فاکتور"}</span>
      </Button>
    </div>
  );
}
