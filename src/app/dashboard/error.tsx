"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { AlertCircleIcon } from "@/components/icons";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Log safe error diagnostics on client
    console.error("Dashboard error boundary caught:", error.message);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <div className="max-w-md w-full rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm space-y-4">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <AlertCircleIcon size={28} />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-gray-900">
            خطا در بارگذاری اطلاعات داشبورد
          </h2>
          <p className="text-xs text-gray-500 leading-relaxed">
            متأسفانه در دریافت اطلاعات داشبورد مشکلی پیش آمده است. لطفاً اتصال اینترنت خود را بررسی کرده و مجدداً تلاش نمایید.
          </p>
        </div>

        <div className="pt-2 flex justify-center gap-3">
          <Button onClick={() => reset()} className="gap-2 text-xs">
            تلاش مجدد
          </Button>
          <Button
            variant="outline"
            onClick={() => (window.location.href = "/dashboard")}
            className="text-xs"
          >
            بارگذاری مجدد صفحه
          </Button>
        </div>
      </div>
    </div>
  );
}
