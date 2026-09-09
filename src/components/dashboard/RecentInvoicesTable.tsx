import * as React from "react";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  formatCurrency,
  formatPersianDateShort,
  formatInvoiceStatus,
  formatInvoiceType,
} from "@/lib/formatters";
import {
  InvoicesIcon,
  PlusIcon,
  EyeIcon,
  ChevronLeftIcon,
  FileTextIcon,
} from "@/components/icons";
import { formatInvoiceIdentifierDisplay } from "@/lib/invoice-identifier-display";
import type { DashboardRecentInvoiceDTO } from "@/server/dashboard/dashboardService";

export interface RecentInvoicesTableProps {
  invoices: DashboardRecentInvoiceDTO[];
  hasBusiness: boolean;
  /** Live InvoiceSettings.currency for drafts without a snapshot. */
  fallbackCurrency?: string;
  className?: string;
}

/**
 * Identifier shown in the «شماره فاکتور» column. Drafts render the clean
 * «پیش‌نویس» label (never the internal `DRAFT-<uuid>` placeholder); finalized
 * invoices keep their official number. See `@/lib/invoice-identifier-display`.
 */
function displayRecentInvoiceNumber(inv: DashboardRecentInvoiceDTO): string {
  return formatInvoiceIdentifierDisplay(inv.status, inv.invoiceNumber);
}

/**
 * Desktop invoice-number cell typography: ~13px medium so official numbers
 * stay clearly readable, `whitespace-nowrap` so neither the number nor the
 * draft label wraps.
 */
export const INVOICE_NUMBER_CELL_CLASS =
  "py-3.5 px-5 font-medium text-gray-900 font-sans text-[13px] whitespace-nowrap";

/** Desktop customer cell: 13px medium, real name (truncated when very long). */
export const CUSTOMER_CELL_CLASS = "py-3.5 px-4 font-medium text-gray-900 font-sans";

/** Mobile invoice-number typography: 14px semi-bold, no wrapping. */
export const INVOICE_NUMBER_MOBILE_CLASS =
  "font-semibold text-sm text-gray-900 font-sans whitespace-nowrap";

export function RecentInvoicesTable({
  invoices,
  hasBusiness,
  fallbackCurrency = "IRR",
  className,
}: RecentInvoicesTableProps) {
  const currencyOf = (inv: DashboardRecentInvoiceDTO) => inv.currency ?? fallbackCurrency;
  return (
    <Card className={className}>
      <CardHeader className="p-5 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-700">
              <InvoicesIcon size={18} />
            </div>
            <CardTitle className="text-sm sm:text-base font-bold text-gray-900">
              آخرین فاکتورها
            </CardTitle>
          </div>
          {invoices.length > 0 && (
            <Link href="/dashboard/invoices">
              <Button variant="ghost" size="sm" className="text-xs text-blue-600 hover:text-blue-700 h-8 gap-1">
                <span>مشاهده همه</span>
                <ChevronLeftIcon size={14} />
              </Button>
            </Link>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {!hasBusiness ? (
          <div className="p-6">
            <EmptyState
              icon={<FileTextIcon size={24} />}
              title="کسب‌وکاری انتخاب نشده است"
              description="برای مشاهده و مدیریت فاکتورها، ابتدا یک کسب‌وکار ایجاد یا فعال نمایید."
              action={
                <Link href="/dashboard/businesses">
                  <Button size="sm" variant="outline" className="gap-1.5">
                    <PlusIcon size={16} />
                    <span>ایجاد کسب‌وکار</span>
                  </Button>
                </Link>
              }
            />
          </div>
        ) : invoices.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<FileTextIcon size={24} />}
              title="هنوز فاکتوری ایجاد نکرده‌اید"
              description="اولین فاکتور خود را ایجاد کنید و وضعیت مالی کسب‌وکارتان را به‌راحتی مدیریت نمایید."
              action={
                <Link href="/dashboard/invoices/new">
                  <Button size="sm" className="gap-1.5">
                    <PlusIcon size={16} />
                    <span>ایجاد فاکتور جدید</span>
                  </Button>
                </Link>
              }
            />
          </div>
        ) : (
          <>
            {/* Desktop Table View */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-right text-[13px]">
                <thead className="border-y border-gray-100 bg-gray-50/75 text-gray-500">
                  <tr>
                    <th scope="col" className="py-3 px-5 font-semibold">شماره فاکتور</th>
                    <th scope="col" className="py-3 px-4 font-semibold">مشتری</th>
                    <th scope="col" className="py-3 px-4 font-semibold">نوع</th>
                    <th scope="col" className="py-3 px-4 font-semibold">تاریخ صدور</th>
                    <th scope="col" className="py-3 px-4 font-semibold">سررسید</th>
                    <th scope="col" className="py-3 px-4 font-semibold">وضعیت</th>
                    <th scope="col" className="py-3 px-4 font-semibold">مبلغ کل</th>
                    <th scope="col" className="py-3 px-4 font-semibold">مانده</th>
                    <th scope="col" className="py-3 px-5 text-left font-semibold">عملیات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {invoices.map((inv) => {
                    const statusMeta = formatInvoiceStatus(inv.status);
                    return (
                      <tr
                        key={inv.id}
                        className="hover:bg-gray-50/80 transition-colors group"
                      >
                        <td className={INVOICE_NUMBER_CELL_CLASS}>
                          {displayRecentInvoiceNumber(inv)}
                        </td>
                        <td className={CUSTOMER_CELL_CLASS}>
                          <span
                            className="block max-w-[16rem] truncate"
                            title={inv.customerName ?? undefined}
                          >
                            {inv.customerName ?? "—"}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-gray-600">
                          {formatInvoiceType(inv.invoiceType)}
                        </td>
                        <td className="py-3.5 px-4 text-gray-600 font-sans">
                          {formatPersianDateShort(inv.issueDate)}
                        </td>
                        <td className="py-3.5 px-4 text-gray-500 font-sans">
                          {inv.dueDate ? formatPersianDateShort(inv.dueDate) : "—"}
                        </td>
                        <td className="py-3.5 px-4">
                          <Badge variant={statusMeta.variant} showDot>
                            {statusMeta.label}
                          </Badge>
                        </td>
                        <td className="py-3.5 px-4 font-semibold text-gray-900 font-sans whitespace-nowrap">
                          {formatCurrency(inv.total, currencyOf(inv))}
                        </td>
                        <td className="py-3.5 px-4 font-medium text-gray-700 font-sans whitespace-nowrap">
                          {formatCurrency(inv.remainingAmount, currencyOf(inv))}
                        </td>
                        <td className="py-3.5 px-5 text-left">
                          <Link href={`/dashboard/invoices`}>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-blue-600 hover:text-blue-700 px-2 gap-1"
                            >
                              <EyeIcon size={14} />
                              <span>جزئیات</span>
                            </Button>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Card List View */}
            <div className="md:hidden divide-y divide-gray-100">
              {invoices.map((inv) => {
                const statusMeta = formatInvoiceStatus(inv.status);
                return (
                  <div key={inv.id} className="p-4 space-y-3 bg-white">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={INVOICE_NUMBER_MOBILE_CLASS}>
                          {displayRecentInvoiceNumber(inv)}
                        </span>
                        <span className="text-[11px] text-gray-400">
                          ({formatInvoiceType(inv.invoiceType)})
                        </span>
                      </div>
                      <Badge variant={statusMeta.variant} showDot>
                        {statusMeta.label}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-gray-400 text-[11px] shrink-0">مشتری:</span>
                      <span
                        className="font-medium text-gray-900 min-w-0 truncate"
                        title={inv.customerName ?? undefined}
                      >
                        {inv.customerName ?? "—"}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                      <div>
                        <span className="text-gray-400 block text-[11px]">مبلغ کل:</span>
                        <span className="font-bold text-gray-900 font-sans">
                          {formatCurrency(inv.total, currencyOf(inv))}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[11px]">مانده:</span>
                        <span className="font-medium text-gray-700 font-sans">
                          {formatCurrency(inv.remainingAmount, currencyOf(inv))}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[11px]">تاریخ صدور:</span>
                        <span className="text-gray-600 font-sans">
                          {formatPersianDateShort(inv.issueDate)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[11px]">سررسید:</span>
                        <span className="text-gray-600 font-sans">
                          {inv.dueDate ? formatPersianDateShort(inv.dueDate) : "—"}
                        </span>
                      </div>
                    </div>

                    <div className="pt-2 flex justify-end">
                      <Link href={`/dashboard/invoices`} className="w-full">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full text-xs h-8 gap-1"
                        >
                          <EyeIcon size={14} />
                          <span>مشاهده فاکتور</span>
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
