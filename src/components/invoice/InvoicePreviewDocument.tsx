import * as React from "react";
import type { CSSProperties } from "react";
import { brandCssVars } from "@/lib/invoice-brand";
import { invoiceCurrencyLabel } from "@/lib/currency";
import {
  formatCurrency,
  formatInvoiceStatus,
  formatInvoiceType,
  formatPersianDate,
  formatPersianNumber,
  toPersianDigits,
} from "@/lib/formatters";
import type {
  InvoicePreviewCustomer,
  InvoicePreviewModel,
  InvoicePreviewSeller,
} from "@/lib/invoice-preview-model";

/**
 * Invoice Preview / Print Document V1 (Persian RTL, A4-ready).
 *
 * Rendered by BOTH the server route `/dashboard/invoices/[invoiceId]/preview`
 * and the invoice editor's live preview — the two only differ in where their
 * `InvoicePreviewModel` came from, never in markup or styling.
 *
 * This component renders ONE invoice exactly as it must be presented to a
 * customer — the letterhead, invoice meta, seller/customer parties, line-item
 * table, totals, payment state, notes and stamp/signature images — for both
 * the on-screen preview and the A4 print output of the browser.
 *
 * Data law (enforced upstream by `@/lib/invoice-preview-model` — the model
 * this component renders — and rendered verbatim here):
 *   - DRAFT rows show the CURRENT BusinessProfile / live Customer;
 *   - FINALIZED / CANCELLED rows show the immutable finalization snapshots;
 *   - all money/percent/date values come from the authoritative server DTO
 *     and are only FORMATTED here — this component performs no financial
 *     math and re-computes nothing.
 *
 * No hooks and no client state: it is pure markup over a model, so the same
 * tree serves server rendering, the editor's live preview and, later, a PDF
 * generator — without restructuring and without recomputing anything.
 */

// ---------------------------------------------------------------------------
// Small display helpers (formatting only — never calculation)
// ---------------------------------------------------------------------------

function orDash(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "—";
}

/** Money-ish decimal string ("100000.00") → Persian number ("۱۰۰٬۰۰۰"). */
function moneyDigits(value: string | null | undefined): string {
  return formatPersianNumber(value);
}

/** Percent decimal string ("9.00") → Persian percent ("۹٪"). */
function percentLabel(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (normalized === "") return "۰٪";
  const trimmed = normalized.replace(/0+$/, "").replace(/\.$/, "");
  const digits = trimmed === "" ? "0" : trimmed;
  return `${toPersianDigits(digits)}٪`;
}

function currencyUnit(currency: string): string {
  return invoiceCurrencyLabel(currency);
}

/** Joins non-empty optional lines of the letterhead with a separator. */
function joinOptional(parts: Array<string | null | undefined>, separator = " · "): string | null {
  const present = parts.filter((part): part is string => Boolean(part && part.trim() !== ""));
  return present.length > 0 ? present.join(separator) : null;
}

// ---------------------------------------------------------------------------
// Sectional subcomponents
// ---------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium text-gray-400">{label}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-gray-800">{value ?? "—"}</p>
    </div>
  );
}

/**
 * Colored header strip: logo + name + slogan sit on the brand BACKGROUND.
 * Foreground colour is auto-computed from luminance (no font-color setting).
 */
function BrandHeader({ seller }: { seller: InvoicePreviewSeller | null }) {
  return (
    <header
      className="flex items-center gap-4 px-5 py-5 sm:px-9 print:px-[12mm] print:py-[8mm]"
      style={{ backgroundColor: "var(--pv-header-bg)", color: "var(--pv-header-fg)" }}
      aria-label="سربرگ فاکتور"
    >
      {seller?.logo?.url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={seller.logo.url}
          alt="لوگوی کسب‌وکار"
          className="h-16 w-16 shrink-0 rounded-lg border border-white/40 bg-white object-contain p-1"
        />
      )}
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-xl font-extrabold leading-snug">
          {seller?.businessName ?? "—"}
        </h2>
        {seller?.slogan && (
          <p className="text-[11px] leading-relaxed opacity-90">{seller.slogan}</p>
        )}
      </div>
    </header>
  );
}

/** Contact / banking (right) + document title & key meta (left). */
function Letterhead({
  model,
  seller,
}: {
  model: InvoicePreviewModel;
  seller: InvoicePreviewSeller | null;
}) {
  const invoice = model.invoice;
  const statusMeta = formatInvoiceStatus(invoice.status);
  const documentTypeLabel = formatInvoiceType(invoice.invoiceType);
  const isDraft = model.isDraft;

  const contacts = joinOptional([
    seller?.mobile,
    seller?.landline,
    seller?.email,
  ]);
  const hasBanking = Boolean(
    seller?.cardNumber || seller?.accountNumber || seller?.iban,
  );

  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
      {/* Seller contact / banking — identity lives in the colored header. */}
      <section className="min-w-0 flex-1 space-y-3" aria-label="فروشنده">
        {seller?.ownerName && (
          <p className="text-[11px] leading-relaxed text-gray-600">
            مدیر / صاحب امتیاز: {seller.ownerName}
          </p>
        )}

        {contacts && (
          <p className="text-[11px] leading-relaxed text-gray-600" dir="auto">
            {contacts}
          </p>
        )}
        {seller?.address && (
          <p className="text-[11px] leading-relaxed text-gray-600" dir="auto">
            نشانی: {seller.address}
          </p>
        )}

        {hasBanking && (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 sm:grid-cols-3">
            {seller?.cardNumber && (
              <div className="min-w-0">
                <dt className="text-[10px] text-gray-400">شماره کارت</dt>
                <dd className="font-sans text-[11px] text-gray-800" dir="ltr">
                  {seller.cardNumber}
                </dd>
              </div>
            )}
            {seller?.accountNumber && (
              <div className="min-w-0">
                <dt className="text-[10px] text-gray-400">شماره حساب</dt>
                <dd className="font-sans text-[11px] text-gray-800" dir="ltr">
                  {seller.accountNumber}
                </dd>
              </div>
            )}
            {seller?.iban && (
              <div className="min-w-0">
                <dt className="text-[10px] text-gray-400">شبا</dt>
                <dd className="font-sans text-[11px] text-gray-800" dir="ltr">
                  {seller.iban}
                </dd>
              </div>
            )}
          </dl>
        )}
      </section>

      {/* Document title + meta */}
      <section
        className="w-full shrink-0 space-y-3 rounded-xl border border-gray-200 p-4 text-center md:w-[240px] lg:w-[280px]"
        aria-label="شناسه فاکتور"
      >
        <div className="space-y-1">
          <h1 className="text-2xl font-black tracking-tight text-gray-900">
            {documentTypeLabel}
          </h1>
          <p className="text-[11px] text-gray-500">فروش کالا و خدمات</p>
        </div>

        <div className="divide-y divide-gray-100 rounded-lg border border-gray-100 bg-gray-50/60 text-right">
          <div className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="text-[10px] text-gray-400">شماره فاکتور</span>
            <span className="font-sans text-xs font-bold text-gray-900">
              {model.officialNumber ? toPersianDigits(model.officialNumber) : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="text-[10px] text-gray-400">تاریخ صدور</span>
            <span className="text-xs font-medium text-gray-800">
              {formatPersianDate(invoice.issueDate)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="text-[10px] text-gray-400">سررسید</span>
            <span className="text-xs font-medium text-gray-800">
              {invoice.dueDate ? formatPersianDate(invoice.dueDate) : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="text-[10px] text-gray-400">وضعیت</span>
            <span className="text-xs font-semibold text-gray-800">
              {isDraft ? "پیش‌نویس" : statusMeta.label}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Buyer block — snapshot (finalized) or live customer (draft). */
function CustomerSection({ customer }: { customer: InvoicePreviewCustomer | null }) {
  if (!customer) return null;

  return (
    <section className="avoid-break rounded-xl border border-gray-200 p-4" aria-label="مشتری">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-bold text-gray-900">
          مشتری / گیرنده
        </h3>
        <span className="text-sm font-extrabold text-gray-900">{customer.name}</span>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="موبایل" value={<span className="font-sans" dir="ltr">{customer.mobile}</span>} />
        <Field label="تلفن" value={<span className="font-sans" dir="ltr">{customer.phone}</span>} />
        <Field label="ایمیل" value={<span dir="ltr">{customer.email}</span>} />
        <Field label="کد ملی" value={<span className="font-sans" dir="ltr">{customer.nationalId}</span>} />
        <Field label="شناسه اقتصادی" value={<span className="font-sans" dir="ltr">{customer.economicCode}</span>} />
        <div className="sm:col-span-2 lg:col-span-4">
          <Field label="آدرس" value={<span dir="auto">{customer.address}</span>} />
        </div>
      </div>
    </section>
  );
}

/** Line items: real table for print/desktop, stacked cards for small screens. */
function ItemsTable({ model }: { model: InvoicePreviewModel }) {
  const invoice = model.invoice;
  const unit = currencyUnit(model.currency);

  if (invoice.items.length === 0) {
    return (
      <section className="rounded-xl border border-gray-200 p-6 text-center text-xs text-gray-400">
        این فاکتور قلمی ندارد.
      </section>
    );
  }

  return (
    <section aria-label="اقلام فاکتور">
      {/* Desktop / print table */}
      <div className="hidden overflow-hidden rounded-xl border border-gray-200 md:block print:block print:overflow-visible">
        <table className="w-full table-fixed border-collapse text-right text-[11px]">
          <caption className="sr-only">اقلام فاکتور</caption>
          <colgroup>
            <col className="w-[6%]" />
            <col className="w-[34%]" />
            <col className="w-[9%]" />
            <col className="w-[8%]" />
            <col className="w-[15%]" />
            <col className="w-[13%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead className="bg-[color:var(--pv-brand-soft)] text-gray-700">
            <tr>
              <th scope="col" className="px-2 py-2.5 text-center font-bold">ردیف</th>
              <th scope="col" className="px-3 py-2.5 font-bold">شرح کالا / خدمت</th>
              <th scope="col" className="px-2 py-2.5 text-center font-bold">تعداد</th>
              <th scope="col" className="px-2 py-2.5 text-center font-bold">واحد</th>
              <th scope="col" className="px-2 py-2.5 text-left font-bold">
                قیمت واحد <span className="font-normal text-gray-500">({unit})</span>
              </th>
              <th scope="col" className="px-2 py-2.5 text-left font-bold">
                تخفیف <span className="font-normal text-gray-500">({unit})</span>
              </th>
              <th scope="col" className="px-3 py-2.5 text-left font-bold">
                مبلغ ردیف <span className="font-normal text-gray-500">({unit})</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {invoice.items.map((item, index) => (
              <tr key={item.id} className="align-top">
                <td className="px-2 py-2.5 text-center text-gray-400">
                  {toPersianDigits(index + 1)}
                </td>
                <td className="px-3 py-2.5">
                  <p className="font-semibold leading-snug text-gray-900">{item.title}</p>
                  {item.description && (
                    <p className="mt-0.5 whitespace-pre-line break-words text-[10px] leading-relaxed text-gray-500">
                      {item.description}
                    </p>
                  )}
                </td>
                <td className="px-2 py-2.5 text-center font-sans text-gray-700">
                  {formatPersianNumber(item.quantity)}
                </td>
                <td className="px-2 py-2.5 text-center text-gray-500">{item.unit ?? "—"}</td>
                <td className="px-2 py-2.5 text-left font-sans text-gray-700">
                  {moneyDigits(item.unitPrice)}
                </td>
                <td className="px-2 py-2.5 text-left font-sans text-gray-600">
                  {moneyDigits(item.discountAmount)}
                  {Number(item.discountPercent) > 0 && (
                    <span className="mr-1 text-[9px] text-gray-400">
                      ({percentLabel(item.discountPercent)})
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-left font-sans font-bold text-gray-900">
                  {moneyDigits(item.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Small-screen stacked rows */}
      <ul className="space-y-3 md:hidden print:hidden">
        {invoice.items.map((item, index) => (
          <li key={item.id} className="rounded-xl border border-gray-200 p-4">
            <div className="mb-2 flex items-start justify-between gap-3">
              <p className="text-xs font-bold text-gray-900">
                <span className="ml-1 text-gray-400">{toPersianDigits(index + 1)}.</span>
                {item.title}
              </p>
              <span className="shrink-0 font-sans text-xs font-bold text-gray-900">
                {moneyDigits(item.total)} {unit}
              </span>
            </div>
            {item.description && (
              <p className="mb-3 whitespace-pre-line text-[11px] leading-relaxed text-gray-500">
                {item.description}
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
              <div>
                <dt className="text-[10px] text-gray-400">تعداد</dt>
                <dd className="mt-0.5 font-sans text-gray-700">
                  {formatPersianNumber(item.quantity)} {item.unit ?? ""}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-gray-400">واحد</dt>
                <dd className="mt-0.5 text-gray-700">{item.unit ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-[10px] text-gray-400">قیمت واحد ({unit})</dt>
                <dd className="mt-0.5 font-sans text-gray-700">{moneyDigits(item.unitPrice)}</dd>
              </div>
              <div>
                <dt className="text-[10px] text-gray-400">تخفیف ({unit})</dt>
                <dd className="mt-0.5 font-sans text-gray-600">{moneyDigits(item.discountAmount)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Financial summary — authoritative stored values, formatted only. */
function TotalsSection({ model }: { model: InvoicePreviewModel }) {
  const invoice = model.invoice;
  const hasTax = Number(invoice.taxPercent) > 0 || Number(invoice.taxAmount) > 0;
  const hasGlobalDiscount = Number(invoice.globalDiscountPercent) > 0;
  const showPayments = !model.isDraft;

  const row = (label: string, value: string, strong = false, muted = false) => (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className={`text-[11px] ${strong ? "font-bold text-gray-900" : muted ? "text-gray-400" : "text-gray-500"}`}>
        {label}
      </span>
      <span
        className={`font-sans ${
          strong
            ? "text-base font-extrabold text-gray-900"
            : "text-[11px] font-medium text-gray-800"
        }`}
      >
        {formatCurrency(value, model.currency)}
      </span>
    </div>
  );

  return (
    <section
      className="avoid-break h-fit rounded-xl border border-gray-200 p-4"
      aria-label="خلاصه مالی"
    >
      <h3 className="mb-2 border-b border-gray-100 pb-2 text-xs font-bold text-gray-900">
        خلاصه مالی
      </h3>
      <div className="space-y-0.5">
        {row("جمع اقلام (پیش از تخفیف)", invoice.subtotal)}
        {row("مجموع تخفیف اقلام", invoice.itemDiscountAmount, false, true)}
        {row(
          hasGlobalDiscount
            ? `تخفیف کلی (${percentLabel(invoice.globalDiscountPercent)})`
            : "تخفیف کلی",
          invoice.globalDiscountAmount,
          false,
          true,
        )}
        {hasTax &&
          row(
            `مالیات بر ارزش افزوده (${percentLabel(invoice.taxPercent)})`,
            invoice.taxAmount,
          )}
        <div className="mt-1.5 border-t-2 border-dashed border-gray-300 pt-2">
          {row("مبلغ نهایی فاکتور", invoice.total, true)}
        </div>
        {showPayments && (
          <div className="mt-1 space-y-0.5 border-t border-gray-100 pt-2">
            {row("پرداخت شده", invoice.paidAmount, false, false)}
            {row("مانده قابل پرداخت", invoice.remainingAmount, true)}
          </div>
        )}
      </div>
    </section>
  );
}

/** Invoice notes + seller footer text. */
function NotesSection({ model }: { model: InvoicePreviewModel }) {
  const invoice = model.invoice;
  if (!invoice.notes) return null;

  return (
    <section className="avoid-break rounded-xl border border-gray-200 p-4" aria-label="توضیحات">
      <h3 className="mb-2 text-xs font-bold text-gray-900">توضیحات</h3>
      <p className="whitespace-pre-line text-[11px] leading-relaxed text-gray-600">{invoice.notes}</p>
    </section>
  );
}

/** Stamp / signature assets of the seller (snapshot for finalized rows). */
function StampSignatureSection({ seller }: { seller: InvoicePreviewSeller | null }) {
  const stamp = seller?.sellerStamp;
  const signature = seller?.sellerSignature;
  if (!stamp?.url && !signature?.url) return null;

  return (
    <section className="avoid-break flex flex-wrap items-end justify-end gap-8" aria-label="مهر و امضا">
      {signature?.url && (
        <figure className="space-y-1 text-center">
          <div className="flex h-24 w-40 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={signature.url} alt="امضای فروشنده" className="max-h-20 max-w-full object-contain" />
          </div>
          <figcaption className="text-[10px] text-gray-400">امضا</figcaption>
        </figure>
      )}
      {stamp?.url && (
        <figure className="space-y-1 text-center">
          <div className="flex h-24 w-24 items-center justify-center rounded-full border border-dashed border-gray-300 bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={stamp.url} alt="مهر فروشنده" className="max-h-16 max-w-full object-contain" />
          </div>
          <figcaption className="text-[10px] text-gray-400">مهر</figcaption>
        </figure>
      )}
    </section>
  );
}

/** Colored footer strip — always rendered when a footer colour or text is set. */
function DocumentFooter({ seller }: { seller: InvoicePreviewSeller | null }) {
  const hasColor = Boolean(seller?.footerBackgroundColor);
  const hasText = Boolean(seller?.footerText);
  if (!hasColor && !hasText) return null;

  return (
    <footer
      className="px-5 py-3 sm:px-9 print:px-[12mm]"
      style={{
        backgroundColor: "var(--pv-footer-bg)",
        color: "var(--pv-footer-fg)",
      }}
      aria-label="پاورقی فاکتور"
    >
      {seller?.footerText ? (
        <p className="whitespace-pre-line text-center text-[10px] leading-relaxed">
          {seller.footerText}
        </p>
      ) : (
        <div className="h-2" aria-hidden="true" />
      )}
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface InvoicePreviewDocumentProps {
  model: InvoicePreviewModel;
}

/**
 * The A4 invoice document. `model` is the fully authorized, server-assembled
 * preview payload (see `previewService.getInvoicePreviewData` for saved
 * invoices and `@/lib/invoice-live-preview` for the editor's unsaved state).
 */
export function InvoicePreviewDocument({ model }: InvoicePreviewDocumentProps) {
  const seller = model.seller;
  const style = brandCssVars(
    seller?.primaryColor,
    seller?.footerBackgroundColor,
  ) as unknown as CSSProperties;

  return (
    <div
      className="invoice-print-sheet mx-auto w-full overflow-hidden bg-white text-gray-900 shadow-xl ring-1 ring-gray-200 md:w-[210mm]"
      dir="rtl"
      style={style}
    >
      <BrandHeader seller={seller} />

      <div className="px-5 py-7 sm:px-9 print:px-[12mm] print:py-[8mm]">
        <div className="space-y-5">
          <Letterhead model={model} seller={seller} />
          <CustomerSection customer={model.customer} />
          <ItemsTable model={model} />
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="space-y-5">
              <NotesSection model={model} />
              <StampSignatureSection seller={seller} />
            </div>
            <TotalsSection model={model} />
          </div>
        </div>
      </div>

      <DocumentFooter seller={seller} />
    </div>
  );
}
