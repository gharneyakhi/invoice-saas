"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AlertTriangleIcon, ArchiveIcon } from "@/components/icons";
import { deleteDraftInvoice } from "@/server/actions/invoiceActions";
import type { ActionError } from "@/server/actions/actionResult";
import { DELETE_DRAFT_CONFIRMATION, deleteDraftErrorMessage } from "@/lib/finalization";

export interface DeleteDraftInvoiceButtonProps {
  invoiceId: string;
  redirectToInvoicesOnSuccess?: boolean;
  onDeleted?: () => void;
}

export function DeleteDraftInvoiceButton({
  invoiceId,
  redirectToInvoicesOnSuccess = true,
  onDeleted,
}: DeleteDraftInvoiceButtonProps) {
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
      const result = await deleteDraftInvoice(invoiceId);

      if (result.success) {
        setIsOpen(false);
        if (onDeleted) {
          onDeleted();
        }
        if (redirectToInvoicesOnSuccess) {
          router.push("/dashboard/invoices");
          router.refresh();
        } else {
          router.refresh();
        }
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
        <ArchiveIcon size={15} />
        <span>حذف پیش‌نویس</span>
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
                {DELETE_DRAFT_CONFIRMATION.title}
              </h2>
              <p id={descriptionId} className="text-xs leading-relaxed text-gray-600">
                {DELETE_DRAFT_CONFIRMATION.message}
              </p>
              <p className="rounded-lg bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800">
                {DELETE_DRAFT_CONFIRMATION.warning}
              </p>
              {error && (
                <p className="text-[11px] leading-relaxed text-rose-600" role="alert">
                  {deleteDraftErrorMessage(error)}
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
              {DELETE_DRAFT_CONFIRMATION.cancelLabel}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleConfirm}
              isLoading={isPending}
            >
              {isPending ? "در حال حذف…" : DELETE_DRAFT_CONFIRMATION.confirmLabel}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
