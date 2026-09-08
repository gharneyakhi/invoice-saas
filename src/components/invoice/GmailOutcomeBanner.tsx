"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangleIcon, CheckCircleIcon, XIcon } from "@/components/icons";

/**
 * Surfaces the Gmail connect/callback outcome (`?gmail=connected|error|
 * unavailable`) as a dismissible banner on the invoice pages. The flag is
 * read client-side from the URL the OAuth routes redirect to — no server
 * round-trip, no tokens involved.
 */

export type GmailOutcome = "connected" | "error" | "unavailable";

const OUTCOME_COPY: Record<GmailOutcome, { title: string; body: string }> = {
  connected: {
    title: "جیمیل متصل شد",
    body: "از این پس می‌توانید فاکتورها را مستقیماً از طریق جیمیل ارسال کنید.",
  },
  error: {
    title: "اتصال جیمیل ناموفق بود",
    body: "اتصال انجام نشد؛ می‌توانید دوباره تلاش کنید.",
  },
  unavailable: {
    title: "سرویس جیمیل در دسترس نیست",
    body: "اتصال جیمیل روی این محیط پیکربندی نشده است.",
  },
};

function outcomeFromParam(value: string | null): GmailOutcome | null {
  return value === "connected" || value === "error" || value === "unavailable" ? value : null;
}

/** Pure banner message (statically renderable for tests). */
export function GmailOutcomeMessage({ outcome }: { outcome: GmailOutcome }) {
  const copy = OUTCOME_COPY[outcome];
  const success = outcome === "connected";
  return (
    <div
      role={success ? "status" : "alert"}
      className={
        success
          ? "flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-800"
          : "flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800"
      }
    >
      {success ? (
        <CheckCircleIcon size={17} className="mt-0.5 shrink-0" />
      ) : (
        <AlertTriangleIcon size={17} className="mt-0.5 shrink-0" />
      )}
      <div>
        <p className="font-semibold">{copy.title}</p>
        <p>{copy.body}</p>
      </div>
    </div>
  );
}

function GmailOutcomeBannerInner() {
  const searchParams = useSearchParams();
  const [dismissed, setDismissed] = React.useState(false);
  const outcome = outcomeFromParam(searchParams.get("gmail"));

  if (!outcome || dismissed) return null;

  return (
    <div className="relative">
      <GmailOutcomeMessage outcome={outcome} />
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="بستن پیام"
        className="absolute left-3 top-3 rounded-md p-1 text-current opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

export function GmailOutcomeBanner() {
  return (
    <Suspense fallback={null}>
      <GmailOutcomeBannerInner />
    </Suspense>
  );
}
