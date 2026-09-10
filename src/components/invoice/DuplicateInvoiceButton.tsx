"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AlertCircleIcon, CopyIcon } from "@/components/icons";
import { duplicateInvoice } from "@/server/actions/invoiceActions";
import type { ActionError } from "@/server/actions/actionResult";
import { DUPLICATE_CONFIRMATION, duplicateErrorMessage } from "@/lib/finalization";

export interface DuplicateInvoiceButtonProps {
  invoiceId: string;
}

export function DuplicateInvoiceButton({ invoiceId }: DuplicateInvoiceButtonProps) {
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
      const result = await duplicateInvoice(invoiceId);

      if (result.success) {
        setIsOpen(false);
        // Navigate to the newly created draft in editor mode
        router.push(`/dashboard/invoices/new?invoiceId=${encodeURIComponent(result.data.id)}`);
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
        className="gap-1.5"
      >
        <CopyIcon size={15} />
        <span>کپی فاکتور</span>
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
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600">
              <CopyIcon size={20} />
            </div>
            <div className="min-w-0 space-y-2">
              <h2 id={titleId} className="text-sm font-bold text-gray-900">
                {DUPLICATE_CONFIRMATION.title}
              </h2>
              <p id={descriptionId} className="text-xs leading-relaxed text-gray-600">
                {DUPLICATE_CONFIRMATION.message}
              </p>
              <p className="rounded-lg bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-600">
                {DUPLICATE_CONFIRMATION.warning}
              </p>
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-right text-[11px] leading-relaxed text-rose-700"
                >
                  <AlertCircleIcon size={14} className="mt-0.5 shrink-0" />
                  <span>{duplicateErrorMessage(error)}</span>
                </div>
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
              {DUPLICATE_CONFIRMATION.cancelLabel}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleConfirm}
              isLoading={isPending}
            >
              {isPending ? "در حال ایجاد کپی…" : DUPLICATE_CONFIRMATION.confirmLabel}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
