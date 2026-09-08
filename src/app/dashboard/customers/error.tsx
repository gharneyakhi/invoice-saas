"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { AlertCircleIcon } from "@/components/icons";

/**
 * Route-level error boundary for customer management: an unexpected failure
 * renders a Persian retry notice scoped to this section instead of blowing
 * up the whole dashboard shell.
 */
export default function CustomersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("Customers error boundary caught:", error.message);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <AlertCircleIcon size={28} />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-gray-900">خطا در بارگذاری مشتریان</h2>
          <p className="text-xs leading-relaxed text-gray-500">
            متأسفانه در دریافت اطلاعات مشتریان مشکلی پیش آمده است. لطفاً اتصال اینترنت خود را
            بررسی کرده و مجدداً تلاش نمایید.
          </p>
        </div>

        <div className="flex justify-center gap-3 pt-2">
          <Button onClick={() => reset()} className="gap-2 text-xs">
            تلاش مجدد
          </Button>
          <Button
            variant="outline"
            onClick={() => (window.location.href = "/dashboard/customers")}
            className="text-xs"
          >
            بارگذاری مجدد صفحه
          </Button>
        </div>
      </div>
    </div>
  );
}
