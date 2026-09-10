import type { InvoicePreviewModel } from "@/lib/invoice-preview-model";
import {
  BRAND_COLOR_FALLBACK,
  FOOTER_COLOR_FALLBACK,
  contrastForeground,
  normalizeBrandColor,
} from "@/lib/invoice-brand";
import { invoiceCurrencyLabel } from "@/lib/currency";
import {
  formatCurrency,
  formatInvoiceStatus,
  formatInvoiceType,
  formatPersianDate,
  formatPersianNumber,
  formatPersianPercent,
  toPersianDigits,
} from "@/lib/formatters";

/**
 * Pure export content model (unit-testable, no pdf-lib).
 *
 * RECOVERED from the Export V1 branch (`dd2d54c`,
 * `src/server/export/pdfService.ts` → `buildPdfContent` + `PdfContent`) and
 * relocated here verbatim, because on this branch the PDF renderer is the
 * UBA-pipeline engine (`./pdfService.ts`) while the PNG/JPG renderer
 * (`./imageService.ts`) still consumes this shared content model. One
 * export content model, two renderers.
 *
 * The single deliberate change vs the recovered source: the local
 * `percentFa` helper is replaced by the identical shared
 * `formatPersianPercent` from `@/lib/formatters` (same regexes, same
 * branches — also used by the preview document and the PDF engine), so
 * percent labels stay canonical in one place.
 */

export interface PdfContentItem {
  rowNumber: string;
  title: string;
  description: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  discount: string;
  total: string;
}

export interface PdfContent {
  businessName: string;
  slogan: string | null;
  ownerName: string | null;
  contacts: string | null;
  address: string | null;
  cardNumber: string | null;
  accountNumber: string | null;
  iban: string | null;
  documentTitle: string;
  documentSubtitle: string;
  isDraft: boolean;
  officialNumber: string | null;
  issueDate: string;
  dueDate: string;
  statusLabel: string;
  customerName: string | null;
  customerLines: string[];
  items: PdfContentItem[];
  subtotal: string;
  itemDiscount: string;
  globalDiscountLabel: string;
  globalDiscount: string;
  taxLabel: string | null;
  taxAmount: string;
  total: string;
  paidAmount: string | null;
  remainingAmount: string | null;
  notes: string | null;
  headerBackground: string;
  headerForeground: string;
  footerBackground: string;
  footerForeground: string;
  footerText: string | null;
  hasFooter: boolean;
  currencyUnit: string;
}

function orDash(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "—";
}

function joinPresent(parts: Array<string | null | undefined>): string | null {
  const present = parts.filter((p): p is string => Boolean(p && p.trim() !== ""));
  return present.length > 0 ? present.join(" · ") : null;
}

/**
 * Maps the authorized preview model onto flat, display-ready PDF strings.
 * Snapshot selection already happened upstream (`previewService`): whatever
 * seller/customer/currency the model carries is what the PDF shows.
 */
export function buildPdfContent(model: InvoicePreviewModel): PdfContent {
  const invoice = model.invoice;
  const seller = model.seller;
  const customer = model.customer;
  const statusMeta = formatInvoiceStatus(invoice.status);
  const currency = model.currency;
  const unit = invoiceCurrencyLabel(currency);

  const headerBackground =
    normalizeBrandColor(seller?.primaryColor) ?? BRAND_COLOR_FALLBACK;
  const footerBackground =
    normalizeBrandColor(seller?.footerBackgroundColor) ?? FOOTER_COLOR_FALLBACK;

  const customerLines: string[] = [];
  if (customer) {
    if (customer.mobile) customerLines.push(`موبایل: ${customer.mobile}`);
    if (customer.phone) customerLines.push(`تلفن: ${customer.phone}`);
    if (customer.email) customerLines.push(`ایمیل: ${customer.email}`);
    if (customer.nationalId) customerLines.push(`کد ملی: ${customer.nationalId}`);
    if (customer.economicCode) customerLines.push(`شناسه اقتصادی: ${customer.economicCode}`);
    if (customer.address) customerLines.push(`نشانی: ${customer.address}`);
  }

  const items: PdfContentItem[] = invoice.items.map((item, index) => {
    const hasPercent = Number(item.discountPercent) > 0;
    return {
      rowNumber: toPersianDigits(index + 1),
      title: item.title,
      description: item.description?.trim() ? item.description : null,
      quantity: formatPersianNumber(item.quantity),
      unit: orDash(item.unit),
      unitPrice: formatPersianNumber(item.unitPrice),
      discount: hasPercent
        ? `${formatPersianNumber(item.discountAmount)} (${formatPersianPercent(item.discountPercent)})`
        : formatPersianNumber(item.discountAmount),
      total: formatPersianNumber(item.total),
    };
  });

  const hasTax = Number(invoice.taxPercent) > 0 || Number(invoice.taxAmount) > 0;
  const hasGlobalPercent = Number(invoice.globalDiscountPercent) > 0;

  return {
    businessName: seller?.businessName ?? "—",
    slogan: seller?.slogan?.trim() ? seller.slogan : null,
    ownerName: seller?.ownerName?.trim() ? seller.ownerName : null,
    contacts: joinPresent([seller?.mobile, seller?.landline, seller?.email]),
    address: seller?.address?.trim() ? seller.address : null,
    cardNumber: seller?.cardNumber?.trim() ? seller.cardNumber : null,
    accountNumber: seller?.accountNumber?.trim() ? seller.accountNumber : null,
    iban: seller?.iban?.trim() ? seller.iban : null,
    documentTitle: formatInvoiceType(invoice.invoiceType),
    documentSubtitle: "فروش کالا و خدمات",
    isDraft: model.isDraft,
    officialNumber: model.officialNumber ? toPersianDigits(model.officialNumber) : null,
    issueDate: formatPersianDate(invoice.issueDate),
    dueDate: invoice.dueDate ? formatPersianDate(invoice.dueDate) : "—",
    statusLabel: model.isDraft ? "پیش‌نویس" : statusMeta.label,
    customerName: customer?.name ?? null,
    customerLines,
    items,
    subtotal: formatCurrency(invoice.subtotal, currency),
    itemDiscount: formatCurrency(invoice.itemDiscountAmount, currency),
    globalDiscountLabel: hasGlobalPercent
      ? `تخفیف کلی (${formatPersianPercent(invoice.globalDiscountPercent)})`
      : "تخفیف کلی",
    globalDiscount: formatCurrency(invoice.globalDiscountAmount, currency),
    taxLabel: hasTax ? `مالیات بر ارزش افزوده (${formatPersianPercent(invoice.taxPercent)})` : null,
    taxAmount: formatCurrency(invoice.taxAmount, currency),
    total: formatCurrency(invoice.total, currency),
    paidAmount: model.isDraft ? null : formatCurrency(invoice.paidAmount, currency),
    remainingAmount: model.isDraft ? null : formatCurrency(invoice.remainingAmount, currency),
    notes: invoice.notes?.trim() ? invoice.notes : null,
    headerBackground,
    headerForeground: contrastForeground(headerBackground),
    footerBackground,
    footerForeground: contrastForeground(footerBackground),
    footerText: seller?.footerText?.trim() ? seller.footerText : null,
    hasFooter: Boolean(seller?.footerBackgroundColor || seller?.footerText?.trim()),
    currencyUnit: unit,
  };
}
