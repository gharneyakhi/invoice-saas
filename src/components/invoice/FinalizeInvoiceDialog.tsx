"use client";

import * as React from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangleIcon } from "@/components/icons";
import { FINALIZATION_CONFIRMATION } from "@/lib/finalization";
import { formatCurrency, toPersianDigits } from "@/lib/formatters";

export interface FinalizeInvoiceDialogProps {
  open: boolean;
  /** `true` while the finalization request is in flight. */
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** Facts the user is confirming against — all from the current editor state. */
  summary: {
    currency: string;
    customerName: string | null;
    itemCount: number;
    total: string;
  };
}

/**
 * The «صدور نهایی» confirmation step.
 *
 * Finalization is irreversible (immutable snapshots, an official number, a
 * consumed quota slot), so the editor asks explicitly — with a real dialog
 * rather than `window.confirm`, so the buttons carry Persian labels and the
 * dialog can state what is about to happen.
 *
 * The dialog owns no domain logic and no decision: it only gates the one call
 * to the existing `finalizeInvoice` Server Action. While that call is in
 * flight the dialog stays open, both controls are disabled and dismissal is
 * ignored, which is what makes a double submission impossible (the parent's
 * submit guard is the second half of the same rule).
 */
export function FinalizeInvoiceDialog({
  open,
  isPending,
  onCancel,
  onConfirm,
  summary,
}: FinalizeInvoiceDialogProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();

  if (!open) return null;

  return (
    <Dialog
      labelledBy={titleId}
      describedBy={descriptionId}
      onClose={() => {
        // Never drop the dialog (or allow Escape/backdrop) mid-request: the
        // user must see the outcome of the action they confirmed.
        if (!isPending) onCancel();
      }}
      closeOnBackdrop={!isPending}
      className="max-w-lg"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
            <AlertTriangleIcon size={18} />
          </span>
          <div className="min-w-0 space-y-1">
            <h2 id={titleId} className="text-base font-bold text-gray-900">
              {FINALIZATION_CONFIRMATION.title}
            </h2>
            <p id={descriptionId} className="text-sm leading-relaxed text-gray-600">
              {FINALIZATION_CONFIRMATION.message}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-3 rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3 text-right">
          <div className="min-w-0">
            <dt className="text-[11px] text-gray-400">مشتری</dt>
            <dd className="mt-0.5 truncate text-xs font-semibold text-gray-800">
              {summary.customerName ?? "بدون مشتری"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-gray-400">تعداد اقلام</dt>
            <dd className="mt-0.5 text-xs font-semibold text-gray-800">
              {toPersianDigits(summary.itemCount)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-gray-400">مبلغ قابل پرداخت</dt>
            <dd className="mt-0.5 text-xs font-bold text-gray-900">
              {formatCurrency(summary.total, summary.currency)}
            </dd>
          </div>
        </dl>

        <p className="rounded-lg bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
          {FINALIZATION_CONFIRMATION.warning}
        </p>

        <div className="flex items-center justify-start gap-2 pt-1">
          <Button
            variant="primary"
            size="md"
            isLoading={isPending}
            disabled={isPending}
            onClick={onConfirm}
            className="min-w-[128px]"
          >
            {isPending ? "در حال صدور…" : FINALIZATION_CONFIRMATION.confirmLabel}
          </Button>
          <Button variant="ghost" size="md" onClick={onCancel} disabled={isPending}>
            {FINALIZATION_CONFIRMATION.cancelLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
