"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { AlertCircleIcon } from "@/components/icons";

/**
 * Segment-level error boundary for the invoice routes. Unexpected failures
 * (DB outage, an unhandled server error) degrade to a recoverable notice with
 * the dashboard shell intact instead of a blank screen. No internal error
 * detail is rendered to the user.
 */
export default function InvoicesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("Invoices route error:", error.message);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <AlertCircleIcon size={28} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-gray-900">خطا در بارگذاری فاکتورها</h2>
          <p className="text-xs leading-relaxed text-gray-500">
            دریافت فهرست فاکتورها با مشکل مواجه شد. لطفاً دوباره تلاش کنید؛ در صورت تکرار، کمی بعد
            مراجعه نمایید.
          </p>
        </div>
        <div className="flex justify-center gap-3 pt-2">
          <Button onClick={() => reset()} className="text-xs">
            تلاش مجدد
          </Button>
          <Button
            variant="outline"
            className="text-xs"
            onClick={() => (window.location.href = "/dashboard/invoices")}
          >
            بازگشت به فهرست
          </Button>
        </div>
      </div>
    </div>
  );
}
