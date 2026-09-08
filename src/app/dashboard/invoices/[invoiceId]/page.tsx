import * as React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listBusinesses } from "@/server/business/businessService";
import { getInvoice } from "@/server/invoice/invoiceService";
import { toInvoiceDetailDTO } from "@/server/actions/dto";
import { prisma } from "@/lib/prisma";
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
import { FinalizeInvoiceButton } from "@/components/invoice/FinalizeInvoiceButton";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  FileTextIcon,
  PrinterIcon,
} from "@/components/icons";
import {
  canFinalizeInvoice,
  isCancelledInvoice,
  isFinalizedInvoice,
} from "@/lib/finalization";
import {
  formatCurrency,
  formatInvoiceStatus,
  formatInvoiceType,
  formatPersianDate,
  formatPersianNumber,
  toPersianDigits,
} from "@/lib/formatters";

/**
 * Read-only invoice detail view — the «مشاهده» destination of the invoice list.
 *
 * DRAFT invoices are shown in read-only form with the current BusinessProfile
 * as seller information and an «ادامه ویرایش» link that opens the editor.
 * FINALIZED (and all other non-draft) invoices show the immutable
 * InvoiceSellerSnapshot / InvoiceCustomerSnapshot taken at finalization time.
 *
 * Authorization is server-side: `getInvoice` verifies business ownership and
 * invoice isolation; `prisma.businessProfile` and live customer references are
 * fetched only for DRAFT rows so the view always reflects the current state.
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
      <p className="text-xs font-medium text-gray-800">{value ?? "—"}</p>
    </div>
  );
}

/**
 * Seller/party display shapes shared by the current profile (drafts) and the
 * immutable snapshots (finalized/cancelled rows). The detail view renders
 * whichever source the invoice lifecycle dictates — see the page body below.
 */
interface SellerDisplayInfo {
  businessName: string;
  slogan: string | null;
  ownerName: string | null;
  address: string | null;
  email: string | null;
  mobile: string | null;
  landline: string | null;
  cardNumber: string | null;
  accountNumber: string | null;
  iban: string | null;
  footerText: string | null;
}

interface CustomerDisplayInfo {
  name: string;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationalId: string | null;
  economicCode: string | null;
}

/** Shape of a `BusinessProfile`/seller-snapshot row read for DRAFT previews. */
type SellerContactRow = {
  id: string;
  businessName: string;
  slogan: string | null;
  ownerName: string | null;
  address: string | null;
  email: string | null;
  mobile: string | null;
  landline: string | null;
  cardNumber: string | null;
  accountNumber: string | null;
  iban: string | null;
  footerText: string | null;
};

type LiveCustomerRow = {
  id: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationalId: string | null;
  economicCode: string | null;
};

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
      <PageHeader
        title="مشاهده فاکتور"
        description="فاکتور مورد نظر در دسترس نیست"
        actions={<BackButton />}
      />
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

  const invoiceLifecycle = {
    status: record.status,
    finalizedAt: record.finalizedAt,
  };
  const isDraft = record.status === "DRAFT";
  const canFinalize = canFinalizeInvoice(invoiceLifecycle);
  const isFinalized = isFinalizedInvoice(invoiceLifecycle);
  const isCancelled = isCancelledInvoice(invoiceLifecycle);

  // For DRAFT invoices: resolve current BusinessProfile and live customer.
  let profile: SellerContactRow | null = null;

  let liveCustomer: LiveCustomerRow | null = null;

  if (isDraft) {
    const profileRow = await prisma.businessProfile.findUnique({
      where: { businessId: business.id },
    });
    if (profileRow) {
      profile = profileRow as SellerContactRow;
    }

    if (record.customerId) {
      const customerRow = await prisma.customer.findUnique({
        where: { id: record.customerId },
      });
      if (customerRow) {
        liveCustomer = customerRow as LiveCustomerRow;
      }
    }
  }

  const invoice = toInvoiceDetailDTO(record);
  const statusMeta = formatInvoiceStatus(invoice.status);

  // Seller info source: current profile for drafts, immutable snapshot for finalized.
  const sellerInfo: SellerDisplayInfo | null = isDraft
    ? profile
    : (record.sellerSnapshot ?? null);

  // Customer info source: live customer for drafts, immutable snapshot for finalized.
  const customerInfo: CustomerDisplayInfo | null = isDraft
    ? liveCustomer
    : (record.customerSnapshot ?? null);

  const sellerName = sellerInfo?.businessName ?? business.name;
  const customerName = customerInfo?.name ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`فاکتور ${toPersianDigits(invoice.invoiceNumber)}`}
        description={`${formatInvoiceType(invoice.invoiceType)} — صادر شده در ${formatPersianDate(invoice.issueDate)}`}
        badge={
          <Badge variant={statusMeta.variant} showDot>
            {isDraft ? "پیش‌نویس" : statusMeta.label}
          </Badge>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Preview & print — read-only for drafts and finalized rows alike;
                the preview route never finalizes, never consumes quota and
                never writes anything. */}
            <Link href={`/dashboard/invoices/${encodeURIComponent(record.id)}/preview`}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <PrinterIcon size={15} />
                <span>پیش‌نمایش / چاپ</span>
              </Button>
            </Link>
            {canFinalize && <FinalizeInvoiceButton invoiceId={record.id} />}
            {isDraft && (
              <Link href={`/dashboard/invoices/new?invoiceId=${encodeURIComponent(record.id)}`}>
                <Button size="sm" className="gap-1.5 shadow-sm">
                  <span>ادامه ویرایش</span>
                </Button>
              </Link>
            )}
            <BackButton />
          </div>
        }
      />

      {isFinalized && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-800">
          <CheckCircleIcon size={18} className="shrink-0" />
          <div className="space-y-0.5">
            <p className="font-semibold">فاکتور نهایی شده است</p>
            <p>
              این فاکتور فقط‌خواندنی است و قابل ویرایش نیست.
              {isCancelled ? (
                <span> این فاکتور لغو شده است.</span>
              ) : (
                <span> شماره رسمی: {toPersianDigits(invoice.invoiceNumber)}</span>
              )}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Invoice summary info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">اطلاعات فاکتور</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field
                label={isFinalized ? "شماره فاکتور رسمی" : "شماره فاکتور"}
                value={toPersianDigits(invoice.invoiceNumber)}
              />
              <Field label="نوع" value={formatInvoiceType(invoice.invoiceType)} />
              <Field label="وضعیت" value={isDraft ? "پیش‌نویس" : statusMeta.label} />
              <Field label="تاریخ صدور" value={formatPersianDate(invoice.issueDate)} />
              <Field
                label="سررسید"
                value={invoice.dueDate ? formatPersianDate(invoice.dueDate) : "—"}
              />
              <Field label="مشتری" value={customerName ?? "—"} />
              <Field
                label="تاریخ نهایی‌سازی"
                value={invoice.finalizedAt ? formatPersianDate(invoice.finalizedAt) : "—"}
              />
            </CardContent>
          </Card>

          {/* Seller info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">فروشنده</CardTitle>
              <p className="text-[11px] text-gray-400">
                {isDraft ? "اطلاعات فعلی کسب‌وکار" : "اطلاعات ثبت‌شده در زمان نهایی‌سازی"}
              </p>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="نام کسب‌وکار" value={sellerInfo?.businessName ?? "—"} />
              <Field label="شعار" value={sellerInfo?.slogan ?? "—"} />
              <Field label="نام صاحب" value={sellerInfo?.ownerName ?? "—"} />
              <Field label="آدرس" value={sellerInfo?.address ?? "—"} />
              <Field label="موبایل" value={sellerInfo?.mobile ?? "—"} />
              <Field label="ایمیل" value={sellerInfo?.email ?? "—"} />
              <Field label="تلفن ثابت" value={sellerInfo?.landline ?? "—"} />
              <Field label="شماره کارت" value={sellerInfo?.cardNumber ?? "—"} />
              <Field label="شماره حساب" value={sellerInfo?.accountNumber ?? "—"} />
              <Field label="شبا" value={sellerInfo?.iban ?? "—"} />
            </CardContent>
          </Card>

          {/* Customer info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">مشتری</CardTitle>
              <p className="text-[11px] text-gray-400">
                {isDraft ? "اطلاعات فعلی مشتری" : "اطلاعات ثبت‌شده در زمان نهایی‌سازی"}
              </p>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="نام" value={customerInfo?.name ?? "—"} />
              <Field label="موبایل" value={customerInfo?.mobile ?? "—"} />
              <Field label="تلفن" value={customerInfo?.phone ?? "—"} />
              <Field label="ایمیل" value={customerInfo?.email ?? "—"} />
              <Field label="آدرس" value={customerInfo?.address ?? "—"} />
              <Field label="کد ملی" value={customerInfo?.nationalId ?? "—"} />
              <Field label="شناسه اقتصادی" value={customerInfo?.economicCode ?? "—"} />
            </CardContent>
          </Card>

          {/* Invoice items */}
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
                          <th scope="col" className="px-4 py-3 font-semibold">واحد</th>
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
                              {formatPersianNumber(item.quantity)}
                            </td>
                            <td className="px-4 py-3 font-sans text-gray-600">{item.unit ?? "—"}</td>
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
                          <Field label="واحد" value={item.unit ?? "—"} />
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

        {/* Financial summary sidebar */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-sm">خلاصه مالی</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">جمع اقلام</span>
              <span className="font-sans text-gray-800">{formatCurrency(invoice.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">تخفیف اقلام</span>
              <span className="font-sans text-gray-800">{formatCurrency(invoice.itemDiscountAmount)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">تخفیف کلی</span>
              <span className="font-sans text-gray-800">{formatCurrency(invoice.globalDiscountAmount)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">مالیات بر ارزش افزوده</span>
              <span className="font-sans text-gray-800">{formatCurrency(invoice.taxAmount)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-gray-100 pt-2.5">
              <span className="font-semibold text-gray-700">مبلغ کل</span>
              <span className="font-sans text-sm font-bold text-gray-900">{formatCurrency(invoice.total)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">پرداخت شده</span>
              <span className="font-sans text-emerald-700">{formatCurrency(invoice.paidAmount)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">مانده</span>
              <span className="font-sans font-semibold text-gray-900">{formatCurrency(invoice.remainingAmount)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Notes / Footer */}
      {(invoice.notes || sellerInfo?.footerText) && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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

          {sellerInfo?.footerText && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">یادداشت فوتر</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-line text-xs leading-relaxed text-gray-600">
                  {sellerInfo.footerText}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
