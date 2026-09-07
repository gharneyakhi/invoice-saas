"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AlertCircleIcon, ChevronRightIcon } from "@/components/icons";

export default function InvoiceDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("Invoice detail route error:", error.message);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <AlertCircleIcon size={28} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-gray-900">خطا در بارگذاری فاکتور</h2>
          <p className="text-xs leading-relaxed text-gray-500">
            دریافت جزئیات فاکتور با مشکل مواجه شد. لطفاً دوباره تلاش کنید؛ در صورت تکرار، کمی بعد مراجعه نمایید.
          </p>
        </div>
        <div className="flex justify-center gap-3 pt-2">
          <Button onClick={() => reset()} className="text-xs">
            تلاش مجدد
          </Button>
          <Link href="/dashboard/invoices">
            <Button variant="outline" className="text-xs gap-1.5">
              <ChevronRightIcon size={16} />
              بازگشت به فهرست
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
