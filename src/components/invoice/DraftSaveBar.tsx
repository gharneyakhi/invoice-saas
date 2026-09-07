"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircleIcon, CheckCircleIcon } from "@/components/icons";

export interface SaveFeedback {
  type: "success" | "error";
  /** Persian, user-facing summary. */
  message: string;
  /** Optional server-provided domain detail (already sanitized by the action boundary). */
  detail?: string;
}

export interface DraftSaveBarProps {
  /** True after the first successful save — the editor then updates the same draft. */
  savedInvoiceId: string | null;
  isSubmitting: boolean;
  feedback: SaveFeedback | null;
}

/**
 * Save controls of the editor: draft status, save CTA (with loading state and
 * duplicate-submission protection) and success / friendly-error feedback.
 * The button is a real form submit, so it works from anywhere in the form —
 * and it sits at the bottom of the page on mobile, a natural thumb-reach.
 */
export function DraftSaveBar({ savedInvoiceId, isSubmitting, feedback }: DraftSaveBarProps) {
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      {feedback && (
        <div
          role="alert"
          className={
            feedback.type === "success"
              ? "flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-relaxed text-emerald-800"
              : "flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-relaxed text-rose-800"
          }
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="draft" showDot>
            پیش‌نویس
          </Badge>
          <p className="text-[11px] leading-relaxed text-gray-400">
            {savedInvoiceId
              ? "ذخیره‌شده؛ ذخیره مجدد همین فاکتور را به‌روز می‌کند"
              : "شماره رسمی هنگام نهایی‌سازی صادر می‌شود"}
          </p>
        </div>

        <Button
          type="submit"
          size="md"
          isLoading={isSubmitting}
          className="w-full shrink-0 gap-2 font-bold sm:w-auto"
        >
          {isSubmitting ? "در حال ذخیره…" : "ذخیره پیش‌نویس"}
        </Button>
      </div>
    </div>
  );
}
