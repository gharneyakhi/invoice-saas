"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AlertTriangleIcon, XIcon } from "@/components/icons";
import { cancelInvoice } from "@/server/actions/invoiceActions";
import type { ActionError } from "@/server/actions/actionResult";
import { CANCEL_CONFIRMATION, cancelErrorMessage } from "@/lib/finalization";

export interface CancelInvoiceButtonProps {
  invoiceId: string;
}

export function CancelInvoiceButton({ invoiceId }: CancelInvoiceButtonProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = React.useState(false);
  const [isPending, setIsPending] = React.useState(false);
  const [error, setError] = React.useState<ActionError | null>(null);

  const titleId = React.useId();
  const descriptionId = React.useId();

  async function handleConfirm() {
    if (isPending) return;
    setIsPending(true);
    setError(null);

    try {
      const result = await cancelInvoice(invoiceId);

      if (result.success) {
        setIsOpen(false);
        router.refresh();
        return;
      }

      setError(result.error);
    } catch {
      setError({ code: "INTERNAL_ERROR", message: "An unexpected error occurred" });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setIsOpen(true);
        }}
        className="gap-1.5 border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50"
      >
        <XIcon size={15} />
        <span>لغو فاکتور</span>
      </Button>

      {isOpen && (
        <Dialog
          labelledBy={titleId}
          describedBy={descriptionId}
          onClose={isPending ? () => undefined : () => setIsOpen(false)}
          closeOnBackdrop={!isPending}
          className="max-w-md"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
              <AlertTriangleIcon size={20} />
            </div>
            <div className="min-w-0 space-y-2">
              <h2 id={titleId} className="text-sm font-bold text-gray-900">
                {CANCEL_CONFIRMATION.title}
              </h2>
              <p id={descriptionId} className="text-xs leading-relaxed text-gray-600">
                {CANCEL_CONFIRMATION.message}
              </p>
              <p className="rounded-lg bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800">
                {CANCEL_CONFIRMATION.warning}
              </p>
              {error && (
                <p className="text-[11px] leading-relaxed text-rose-600" role="alert">
                  {cancelErrorMessage(error)}
                </p>
              )}
            </div>
          </div>

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsOpen(false)}
              disabled={isPending}
            >
              {CANCEL_CONFIRMATION.cancelLabel}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleConfirm}
              isLoading={isPending}
            >
              {isPending ? "در حال لغو…" : CANCEL_CONFIRMATION.confirmLabel}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
