"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChevronRightIcon, ChevronLeftIcon } from "@/components/icons";
import { toPersianDigits } from "@/lib/formatters";

/**
 * Pagination for the invoice list. Results are always bounded by the server
 * (`pageSize` is clamped in `invoiceService.queryInvoices`); this control only
 * moves the `page` query parameter, so the next page is fetched by the same
 * authorized server query.
 *
 * RTL note: "previous" points right (ChevronRight) and "next" points left.
 */
export interface InvoiceListPaginationProps {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
}

export function InvoiceListPagination({
  page,
  pageCount,
  pageSize,
  total,
}: InvoiceListPaginationProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const goToPage = (nextPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextPage <= 1) params.delete("page");
    else params.set("page", String(nextPage));
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-gray-100 px-5 py-3.5 sm:flex-row">
      <p className="text-[11px] text-gray-500">
        نمایش{" "}
        <span className="font-sans font-medium text-gray-700">
          {toPersianDigits(firstRow)}–{toPersianDigits(lastRow)}
        </span>{" "}
        از <span className="font-sans font-medium text-gray-700">{toPersianDigits(total)}</span>{" "}
        فاکتور
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1 text-xs"
          disabled={page <= 1}
          onClick={() => goToPage(page - 1)}
        >
          <ChevronRightIcon size={14} />
          <span>قبلی</span>
        </Button>

        <span className="px-1 font-sans text-[11px] text-gray-500">
          صفحه {toPersianDigits(page)} از {toPersianDigits(Math.max(pageCount, 1))}
        </span>

        <Button
          variant="outline"
          size="sm"
          className="gap-1 text-xs"
          disabled={page >= pageCount}
          onClick={() => goToPage(page + 1)}
        >
          <span>بعدی</span>
          <ChevronLeftIcon size={14} />
        </Button>
      </div>
    </div>
  );
}
