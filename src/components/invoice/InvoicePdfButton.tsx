"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { DownloadIcon } from "@/components/icons";

/**
 * «دانلود PDF» — downloads the rendered invoice PDF via
 * GET /api/invoices/[invoiceId]/pdf.
 *
 * The route streams `application/pdf` with a Content-Disposition attachment
 * filename; this component turns the response into a blob download so the
 * dashboard navigation state is preserved (no full-page navigation). HTTP
 * failures are surfaced as short Persian captions under the button:
 *
 *   - 401 → session expired, re-login needed
 *   - 403 → cross-business access or plan-gate denial
 *   - 404 → invoice not available
 *   - anything else (including network errors) → generic retry hint
 */
export function InvoicePdfButton({ invoiceId }: { invoiceId: string }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleClick() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/invoices/${encodeURIComponent(invoiceId)}/pdf`,
        { method: "GET" },
      );
      if (!response.ok) {
        setError(downloadErrorMessage(response.status));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filenameFromDisposition(
          response.headers.get("content-disposition"),
        );
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      setError("دانلود PDF ناموفق بود؛ اتصال را بررسی و دوباره تلاش کنید.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-1">
      <Button
        type="button"
        variant="outline"
        onClick={handleClick}
        disabled={pending}
        className="gap-2"
      >
        <DownloadIcon size={16} />
        <span>{pending ? "در حال آماده‌سازی…" : "دانلود PDF"}</span>
      </Button>
      {error ? (
        <p role="alert" className="max-w-52 text-center text-[11px] leading-5 text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function downloadErrorMessage(status: number): string {
  if (status === 401) return "نشست شما منقضی شده؛ لطفاً دوباره وارد شوید.";
  if (status === 403) return "اجازه دانلود PDF این فاکتور را ندارید.";
  if (status === 404) return "فاکتور درخواستی در دسترس نیست.";
  return "دانلود PDF ناموفق بود؛ دوباره تلاش کنید.";
}

/**
 * Prefers the RFC 5987 `filename*` (UTF-8, survives Persian digits) and
 * falls back to the ASCII `filename` parameter, then a generic name.
 */
function filenameFromDisposition(disposition: string | null): string {
  if (disposition) {
    const extended = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (extended?.[1]) {
      try {
        return decodeURIComponent(extended[1].trim());
      } catch {
        // Fall through to the plain filename parameter.
      }
    }
    const plain = disposition.match(/filename="?([^";]+)"?/i);
    if (plain?.[1]) return plain[1].trim();
  }
  return "invoice.pdf";
}
