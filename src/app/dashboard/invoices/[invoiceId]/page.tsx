import * as React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listBusinesses } from "@/server/business/businessService";
import { getInvoice } from "@/server/invoice/invoiceService";
import { toInvoiceDetailDTO } from "@/server/actions/dto";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertCircleIcon, ChevronRightIcon, FileTextIcon } from "@/components/icons";
import {
  formatCurrency,
  formatInvoiceStatus,
  formatInvoiceType,
  formatPersianDate,
  formatPersianNumber,
  toPersianDigits,
} from "@/lib/formatters";

/**
 * Read-only invoice view — the «مشاهده» destination of the invoice list.
 *
 * Finalized invoices are immutable by domain rule, so this page never offers an
 * edit affordance; a DRAFT opened here is redirected into the editor instead
 * (`ادامه ویرایش`). Authorization is server-side: `getInvoice` verifies the
 * business belongs to the session account and that the invoice belongs to that
 * exact business.
 *
 * Deliberately out of scope for V1: PDF, Excel, email/Telegram sharing,
 * payments and finalization actions.
 */
export const dynamic = "force-dynamic";

interface InvoiceViewPageProps {
  params: { invoiceId: string };
}

function BackButton() {
  return (
    <Link href="/dashboard/invoices">
      <Button variant="outline" size="sm" className="gap-1.5">
        <ChevronRightIcon size={16} />
        <span>بازگشت به فاکتورها</span>
      </Button>
    </Link>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-gray-400">{label}</p>
      <p className="text-xs font-medium text-gray-800">{value}</p>
    </div>
  );
}

export default async function InvoiceViewPage({ params }: InvoiceViewPageProps) {
  let businesses;
  try {
    businesses = await listBusinesses();
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    throw error;
  }

  const business = businesses[0] ?? null;

  const notFound = (
    <div className="space-y-6">
      <PageHeader title="مشاهده فاکتور" description="فاکتور مورد نظر در دسترس نیست" actions={<BackButton />} />
      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<AlertCircleIcon size={28} />}
            title="فاکتور یافت نشد"
            description="این فاکتور وجود ندارد یا به کسب‌وکار فعال شما تعلق ندارد."
            action={
              <Link href="/dashboard/invoices">
                <Button size="sm">بازگشت به فهرست فاکتورها</Button>
              </Link>
            }
          />
        </CardContent>
      </Card>
    </div>
  );

  if (!business) return notFound;

  let record;
  try {
    record = await getInvoice(business.id, params.invoiceId);
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return notFound;
    throw error;
  }

  // Drafts belong in the editor, not in the read-only view.
  if (record.status === "DRAFT") {
    redirect(`/dashboard/invoices/new?invoiceId=${encodeURIComponent(record.id)}`);
  }

  const invoice = toInvoiceDetailDTO(record);
  const statusMeta = formatInvoiceStatus(invoice.status);
  const customerName = record.customerSnapshot?.name ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`فاکتور ${toPersianDigits(invoice.invoiceNumber)}`}
        description={`${formatInvoiceType(invoice.invoiceType)} — صادر شده در ${formatPersianDate(invoice.issueDate)}`}
        badge={
          <Badge variant={statusMeta.variant} showDot>
            {statusMeta.label}
          </Badge>
        }
        actions={<BackButton />}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">اطلاعات فاکتور</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="شماره فاکتور" value={toPersianDigits(invoice.invoiceNumber)} />
              <Field label="نوع" value={formatInvoiceType(invoice.invoiceType)} />
              <Field label="وضعیت" value={statusMeta.label} />
              <Field label="تاریخ صدور" value={formatPersianDate(invoice.issueDate)} />
              <Field
                label="سررسید"
                value={invoice.dueDate ? formatPersianDate(invoice.dueDate) : "—"}
              />
              <Field label="مشتری" value={customerName ?? "—"} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">اقلام فاکتور</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {invoice.items.length === 0 ? (
                <div className="p-5">
                  <EmptyState icon={<FileTextIcon size={24} />} title="این فاکتور قلمی ندارد" />
                </div>
              ) : (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full text-right text-xs">
                      <thead className="border-y border-gray-100 bg-gray-50/75 text-gray-500">
                        <tr>
                          <th scope="col" className="px-5 py-3 font-semibold">شرح</th>
                          <th scope="col" className="px-4 py-3 font-semibold">تعداد</th>
                          <th scope="col" className="px-4 py-3 font-semibold">قیمت واحد</th>
                          <th scope="col" className="px-4 py-3 font-semibold">تخفیف</th>
                          <th scope="col" className="px-5 py-3 font-semibold">جمع</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {invoice.items.map((item) => (
                          <tr key={item.id}>
                            <td className="px-5 py-3 text-gray-800">{item.title}</td>
                            <td className="px-4 py-3 font-sans text-gray-600">
                              {formatPersianNumber(item.quantity)} {item.unit ?? ""}
                            </td>
                            <td className="px-4 py-3 font-sans text-gray-600">
                              {formatCurrency(item.unitPrice)}
                            </td>
                            <td className="px-4 py-3 font-sans text-gray-600">
                              {formatCurrency(item.discountAmount)}
                            </td>
                            <td className="px-5 py-3 font-sans font-semibold text-gray-900">
                              {formatCurrency(item.total)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <ul className="divide-y divide-gray-100 md:hidden">
                    {invoice.items.map((item) => (
                      <li key={item.id} className="space-y-2 p-4">
                        <p className="text-sm font-medium text-gray-900">{item.title}</p>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <Field
                            label="تعداد"
                            value={`${formatPersianNumber(item.quantity)} ${item.unit ?? ""}`}
                          />
                          <Field label="قیمت واحد" value={formatCurrency(item.unitPrice)} />
                          <Field label="تخفیف" value={formatCurrency(item.discountAmount)} />
                          <Field label="جمع" value={formatCurrency(item.total)} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-sm">خلاصه مالی</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-xs">
            {[
              ["جمع اقلام", invoice.subtotal],
              ["تخفیف اقلام", invoice.itemDiscountAmount],
              ["تخفیف کلی", invoice.globalDiscountAmount],
              ["مالیات بر ارزش افزوده", invoice.taxAmount],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-gray-500">{label}</span>
                <span className="font-sans text-gray-800">{formatCurrency(value)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-gray-100 pt-2.5">
              <span className="font-semibold text-gray-700">مبلغ کل</span>
              <span className="font-sans text-sm font-bold text-gray-900">
                {formatCurrency(invoice.total)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">پرداخت شده</span>
              <span className="font-sans text-emerald-700">{formatCurrency(invoice.paidAmount)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">مانده</span>
              <span className="font-sans font-semibold text-gray-900">
                {formatCurrency(invoice.remainingAmount)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {invoice.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">توضیحات</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-xs leading-relaxed text-gray-600">
              {invoice.notes}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
