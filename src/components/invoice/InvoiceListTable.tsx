import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatCurrency,
  formatInvoiceStatus,
  formatInvoiceType,
  formatPersianDateShort,
  toPersianDigits,
} from "@/lib/formatters";
import { EyeIcon, FileTextIcon } from "@/components/icons";
import type { InvoiceListRowDTO } from "@/server/actions/dto";

/**
 * Invoice list table (Invoice List V1) — responsive RTL.
 *
 * Desktop renders a real table; below `md` the same rows become stacked cards
 * so nothing is horizontally clipped on a phone. Pure presentation: it renders
 * exactly the rows the authorized server query returned.
 *
 * Row action follows the lifecycle rule enforced by the domain layer:
 *   DRAFT → «ادامه ویرایش» (re-opens the editor)
 *   everything else → «مشاهده» (read-only view)
 */

export interface InvoiceListTableProps {
  rows: InvoiceListRowDTO[];
}

function isDraft(row: InvoiceListRowDTO): boolean {
  return row.status === "DRAFT";
}

/** Drafts carry a `DRAFT-<uuid>` placeholder number — never show it raw. */
function displayInvoiceNumber(row: InvoiceListRowDTO): string {
  if (isDraft(row) || row.invoiceNumber.startsWith("DRAFT-")) return "—";
  return toPersianDigits(row.invoiceNumber);
}

function RowAction({ row }: { row: InvoiceListRowDTO }) {
  if (isDraft(row)) {
    return (
      <Link href={`/dashboard/invoices/new?invoiceId=${encodeURIComponent(row.id)}`}>
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
          <FileTextIcon size={14} />
          <span>ادامه ویرایش</span>
        </Button>
      </Link>
    );
  }

  return (
    <Link href={`/dashboard/invoices/${encodeURIComponent(row.id)}`}>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-blue-600 hover:text-blue-700"
      >
        <EyeIcon size={14} />
        <span>مشاهده</span>
      </Button>
    </Link>
  );
}

export function InvoiceListTable({ rows }: InvoiceListTableProps) {
  return (
    <>
      {/* Desktop */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-right text-xs">
          <caption className="sr-only">فهرست فاکتورهای کسب‌وکار جاری</caption>
          <thead className="border-y border-gray-100 bg-gray-50/75 text-gray-500">
            <tr>
              <th scope="col" className="px-5 py-3 font-semibold">شماره</th>
              <th scope="col" className="px-4 py-3 font-semibold">مشتری</th>
              <th scope="col" className="px-4 py-3 font-semibold">نوع</th>
              <th scope="col" className="px-4 py-3 font-semibold">وضعیت</th>
              <th scope="col" className="px-4 py-3 font-semibold">تاریخ صدور</th>
              <th scope="col" className="px-4 py-3 font-semibold">سررسید</th>
              <th scope="col" className="px-4 py-3 font-semibold">مبلغ کل</th>
              <th scope="col" className="px-4 py-3 font-semibold">مانده</th>
              <th scope="col" className="px-5 py-3 text-left font-semibold">عملیات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {rows.map((row) => {
              const statusMeta = formatInvoiceStatus(row.status);
              return (
                <tr key={row.id} className="transition-colors hover:bg-gray-50/80">
                  <td className="px-5 py-3.5 font-sans font-medium text-gray-900">
                    {displayInvoiceNumber(row)}
                  </td>
                  <td className="px-4 py-3.5 text-gray-700">{row.customerName ?? "—"}</td>
                  <td className="px-4 py-3.5 text-gray-600">{formatInvoiceType(row.invoiceType)}</td>
                  <td className="px-4 py-3.5">
                    <Badge variant={statusMeta.variant} showDot>
                      {statusMeta.label}
                    </Badge>
                  </td>
                  <td className="px-4 py-3.5 font-sans text-gray-600">
                    {formatPersianDateShort(row.issueDate)}
                  </td>
                  <td className="px-4 py-3.5 font-sans text-gray-500">
                    {row.dueDate ? formatPersianDateShort(row.dueDate) : "—"}
                  </td>
                  <td className="px-4 py-3.5 font-sans font-semibold text-gray-900">
                    {formatCurrency(row.total)}
                  </td>
                  <td className="px-4 py-3.5 font-sans text-gray-600">
                    {formatCurrency(row.remainingAmount)}
                  </td>
                  <td className="px-5 py-3.5 text-left">
                    <RowAction row={row} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <ul className="divide-y divide-gray-100 md:hidden">
        {rows.map((row) => {
          const statusMeta = formatInvoiceStatus(row.status);
          return (
            <li key={row.id} className="space-y-3 bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-semibold text-gray-900">
                    {row.customerName ?? "بدون مشتری"}
                  </p>
                  <p className="font-sans text-[11px] text-gray-400">
                    {displayInvoiceNumber(row)} · {formatInvoiceType(row.invoiceType)}
                  </p>
                </div>
                <Badge variant={statusMeta.variant} showDot>
                  {statusMeta.label}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="block text-[11px] text-gray-400">مبلغ کل</span>
                  <span className="font-sans font-bold text-gray-900">
                    {formatCurrency(row.total)}
                  </span>
                </div>
                <div>
                  <span className="block text-[11px] text-gray-400">مانده</span>
                  <span className="font-sans font-medium text-gray-700">
                    {formatCurrency(row.remainingAmount)}
                  </span>
                </div>
                <div>
                  <span className="block text-[11px] text-gray-400">تاریخ صدور</span>
                  <span className="font-sans text-gray-600">
                    {formatPersianDateShort(row.issueDate)}
                  </span>
                </div>
                <div>
                  <span className="block text-[11px] text-gray-400">سررسید</span>
                  <span className="font-sans text-gray-600">
                    {row.dueDate ? formatPersianDateShort(row.dueDate) : "—"}
                  </span>
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <RowAction row={row} />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
