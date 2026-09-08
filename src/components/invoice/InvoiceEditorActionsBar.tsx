"use client";

import * as React from "react";
import Link from "next/link";
import clsx from "clsx";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircleIcon, CheckCircleIcon, EyeIcon, StampIcon } from "@/components/icons";
import {
  resolveSaveStateLabel,
  type EditorSaveState,
  type InvoiceEditorCapabilities,
} from "@/lib/invoice-editor-state";

export interface SaveFeedback {
  type: "success" | "error";
  /** Persian, user-facing summary. */
  message: string;
  /** Optional server-provided domain detail (already sanitized by the action boundary). */
  detail?: string;
}

export interface InvoiceEditorActionsBarProps {
  capabilities: InvoiceEditorCapabilities;
  /** True once a draft exists for this editor — saves then update that row. */
  hasSavedDraft: boolean;
  saveState: EditorSaveState;
  /** React Hook Form's dirty flag against the last saved baseline. */
  isDirty: boolean;
  isSubmitting: boolean;
  feedback: SaveFeedback | null;
  onSaveDraft: () => void;
  /** Opens the confirmation dialog; the actual issuance lives behind it. */
  onRequestFinalize: () => void;
  /** Present once the invoice is persisted: the printable preview of the row. */
  previewHref: string | null;
}

const TONE_CLASSES = {
  muted: "text-gray-400",
  warning: "text-amber-600",
  info: "text-sky-600",
  success: "text-emerald-600",
} as const;

/**
 * The two — and only two — ways to leave the invoice editor:
 *
 *   ذخیره پیش‌نویس → stays a DRAFT: no official number, no quota, still editable
 *   صدور نهایی      → irreversible issuance (after an explicit confirmation)
 *
 * They are siblings, not steps: nothing in this bar forces the user through a
 * draft save before issuing, and neither button is a plain form submit — each
 * one runs its own validated path (see `runEditorSubmitFlow`). Both are
 * disabled while a request is in flight, which is the visible half of the
 * double-submission guard.
 *
 * The save-state line is deliberately non-blocking: it tells the user the
 * truth about persistence ("تغییرات ذخیره نشده") without ever gating the live
 * preview, which always shows the latest form state.
 */
export function InvoiceEditorActionsBar({
  capabilities,
  hasSavedDraft,
  saveState,
  isDirty,
  isSubmitting,
  feedback,
  onSaveDraft,
  onRequestFinalize,
  previewHref,
}: InvoiceEditorActionsBarProps) {
  const saveLabel = resolveSaveStateLabel({ saveState, isDirty, hasSavedDraft });

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      {feedback && (
        <div
          role="alert"
          aria-live="polite"
          className={clsx(
            "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed",
            feedback.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800",
          )}
        >
          {feedback.type === "success" ? (
            <CheckCircleIcon size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="font-medium">{feedback.message}</p>
            {feedback.detail && <p className="mt-0.5 text-[11px] opacity-80">{feedback.detail}</p>}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={capabilities.isDraft ? "draft" : "success"} showDot>
            {capabilities.isDraft ? "پیش‌نویس" : "نهایی شده"}
          </Badge>
          {saveLabel && capabilities.editable && (
            <p className={clsx("text-[11px] font-medium leading-relaxed", TONE_CLASSES[saveLabel.tone])}>
              {saveLabel.text}
            </p>
          )}
        </div>

        {previewHref && (
          <Link href={previewHref}>
            <Button variant="ghost" size="sm" className="gap-1.5 text-gray-500">
              <EyeIcon size={15} />
              <span>پیش‌نمایش / چاپ</span>
            </Button>
          </Link>
        )}
      </div>

      {capabilities.editable ? (
        // While a request runs both controls spin and are disabled — the
        // visible half of the double-submission guard (the editor's submit
        // lock is what actually enforces it).
        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-end">
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={onRequestFinalize}
            isLoading={isSubmitting}
            disabled={!capabilities.canFinalize || isSubmitting}
            className="w-full shrink-0 gap-2 font-bold sm:w-auto"
          >
            <StampIcon size={16} />
            <span>صدور نهایی</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={onSaveDraft}
            isLoading={isSubmitting}
            disabled={!capabilities.canSaveDraft || isSubmitting}
            className="w-full shrink-0 gap-2 sm:w-auto"
          >
            <span>ذخیره پیش‌نویس</span>
          </Button>
        </div>
      ) : (
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-500">
          این فاکتور نهایی شده و قابل ویرایش نیست. برای تغییر آن، یک پیش‌نویس جدید ایجاد کنید.
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-gray-400">
        {!capabilities.editable
          ? "شماره رسمی، مبلغ‌ها و اطلاعات فروشنده/مشتری این فاکتور ثابت است؛ همان چیزی که در پیش‌نمایش و چاپ می‌بینید."
          : hasSavedDraft
            ? "ذخیره مجدد همین پیش‌نویس را به‌روز می‌کند؛ شماره رسمی هنگام صدور نهایی صادر می‌شود."
            : "تا پیش از «صدور نهایی»، شماره رسمی صادر نمی‌شود و سهمیه‌ای مصرف نمی‌شود."}
      </p>
    </div>
  );
}
