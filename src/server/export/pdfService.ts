import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
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
  toPersianDigits,
} from "@/lib/formatters";
import { toVisualPersianText } from "./persianText";
import { DRAFT_EXPORT_NOTICE } from "./exportCopy";
import { getVazirmatnFontBytes } from "./fontLoader";
import { fetchImageAsPng } from "./imageAssets";

/**
 * Server-side invoice PDF generation (Export & Sharing V1).
 *
 * Deterministic A4 output rendered with `pdf-lib` + the embedded Vazirmatn
 * font (correct Persian/Arabic glyphs via the presentation-forms shaper in
 * `./persianText.ts` — `pdf-lib` performs no complex text layout itself).
 *
 * Data law (same as the preview — this module recomputes NOTHING):
 *   - the input is the authorized `InvoicePreviewModel`: finalized rows
 *     already carry their immutable seller/customer/currency snapshots and
 *     drafts carry the current profile — the PDF renders the model verbatim;
 *   - every money/percent/date value is formatted from the stored DTO
 *     strings with the shared `@/lib/formatters` helpers (the same ones the
 *     preview document uses), so the PDF and the screen preview can never
 *     disagree on an amount.
 *
 * Branding (logo, header/footer colours, stamp/signature, banking details)
 * mirrors the preview document. Images that cannot be fetched resolve to
 * `null` and are omitted — never faked, never blocking the export.
 */

// ---------------------------------------------------------------------------
// Pure content model (unit-testable, no pdf-lib)
// ---------------------------------------------------------------------------

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

/** Percent decimal string ("9.00") → Persian percent ("۹٪"). */
function percentFa(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (normalized === "") return "۰٪";
  const trimmed = normalized.replace(/0+$/, "").replace(/\.$/, "");
  return `${toPersianDigits(trimmed === "" ? "0" : trimmed)}٪`;
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
        ? `${formatPersianNumber(item.discountAmount)} (${percentFa(item.discountPercent)})`
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
      ? `تخفیف کلی (${percentFa(invoice.globalDiscountPercent)})`
      : "تخفیف کلی",
    globalDiscount: formatCurrency(invoice.globalDiscountAmount, currency),
    taxLabel: hasTax ? `مالیات بر ارزش افزوده (${percentFa(invoice.taxPercent)})` : null,
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

// ---------------------------------------------------------------------------
// Assets (logo / stamp / signature, fetched + normalized to PNG)
// ---------------------------------------------------------------------------

export interface PdfAssets {
  logo: Buffer | null;
  sellerStamp: Buffer | null;
  sellerSignature: Buffer | null;
}

export { EXPORT_IMAGE_MAX_BYTES as PDF_IMAGE_MAX_BYTES } from "./imageAssets";

async function resolvePdfAssets(
  model: InvoicePreviewModel,
  fetchImage: (url: string) => Promise<Buffer | null>,
): Promise<PdfAssets> {
  // A failing fetcher degrades to "omit the image" — an unavailable logo
  // must never fail the whole export (same rule as the preview document).
  const safeFetch = async (url: string | null | undefined): Promise<Buffer | null> => {
    if (!url) return null;
    try {
      return await fetchImage(url);
    } catch {
      return null;
    }
  };
  const [logo, sellerStamp, sellerSignature] = await Promise.all([
    safeFetch(model.seller?.logo?.url),
    safeFetch(model.seller?.sellerStamp?.url),
    safeFetch(model.seller?.sellerSignature?.url),
  ]);
  return { logo, sellerStamp, sellerSignature };
}

// ---------------------------------------------------------------------------
// pdf-lib renderer (A4 portrait, RTL)
// ---------------------------------------------------------------------------

export const PDF_A4_WIDTH = 595.28;
export const PDF_A4_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_RIGHT = PDF_A4_WIDTH - MARGIN;
const CONTENT_LEFT = MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const TOP_START = PDF_A4_HEIGHT - 30;
const BOTTOM_LIMIT = 64;

const INK = rgb(0.11, 0.13, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const FAINT = rgb(0.62, 0.65, 0.7);
const LINE = rgb(0.88, 0.89, 0.91);
const SOFT_ROW = rgb(0.976, 0.98, 0.984);
const DRAFT_BG = rgb(1, 0.976, 0.92);
const DRAFT_BORDER = rgb(0.96, 0.76, 0.28);
const WHITE = rgb(1, 1, 1);

function hexToRgb(hex: string): RGB {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  if (clean.length !== 6 || Number.isNaN(value)) return rgb(0.15, 0.39, 0.92);
  return rgb(((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255);
}

interface Renderer {
  doc: PDFDocument;
  font: PDFFont;
  pages: PDFPage[];
  page: PDFPage;
  y: number;
}

function newPage(doc: PDFDocument): PDFPage {
  return doc.addPage([PDF_A4_WIDTH, PDF_A4_HEIGHT]);
}

/** Visual width of a LOGICAL string at a size (shaped, as drawn). */
function visualWidth(font: PDFFont, logical: string, size: number): number {
  return font.widthOfTextAtSize(toVisualPersianText(logical), size);
}

/** Greedy word-wrap of logical text into logical lines fitting maxWidth. */
function wrapLogical(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (visualWidth(font, candidate, size) <= maxWidth || current === "") {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}

type TextAlign = "right" | "center" | "left";

function drawText(
  r: Renderer,
  logical: string,
  xAnchor: number,
  y: number,
  size: number,
  color: RGB,
  align: TextAlign = "right",
  maxWidth?: number,
): void {
  const visual = toVisualPersianText(logical);
  const width = r.font.widthOfTextAtSize(visual, size);
  let x = xAnchor;
  if (align === "right") x = xAnchor - width;
  else if (align === "center") x = xAnchor - width / 2;
  if (maxWidth !== undefined && width > maxWidth) {
    // Defensive clip for values that must never overflow their column (ids,
    // IBANs): draw from the anchor and let the overflow run under the
    // margin rather than over neighbouring columns.
    if (align === "right") x = xAnchor - maxWidth;
    else if (align === "center") x = xAnchor - maxWidth / 2;
  }
  r.page.drawText(visual, { x, y, size, font: r.font, color });
}

function drawWrapped(
  r: Renderer,
  logical: string,
  xRight: number,
  y: number,
  size: number,
  color: RGB,
  maxWidth: number,
  lineHeight: number,
): number {
  const lines = wrapLogical(r.font, logical, size, maxWidth);
  let cursor = y;
  for (const line of lines) {
    drawText(r, line, xRight, cursor, size, color, "right");
    cursor -= lineHeight;
  }
  return cursor;
}

function ensureSpace(r: Renderer, needed: number): void {
  if (r.y - needed < BOTTOM_LIMIT) {
    r.page = newPage(r.doc);
    r.pages.push(r.page);
    r.y = TOP_START;
  }
}

function sectionHeading(r: Renderer, title: string): void {
  ensureSpace(r, 30);
  drawText(r, title, CONTENT_RIGHT, r.y, 11.5, INK, "right");
  r.y -= 8;
  r.page.drawLine({
    start: { x: CONTENT_LEFT, y: r.y },
    end: { x: CONTENT_RIGHT, y: r.y },
    thickness: 0.75,
    color: LINE,
  });
  r.y -= 14;
}

function renderHeader(r: Renderer, content: PdfContent, hasLogo: boolean): void {
  const bandHeight = 86;
  const bandTop = PDF_A4_HEIGHT;
  const bandBottom = bandTop - bandHeight;
  r.page.drawRectangle({
    x: 0,
    y: bandBottom,
    width: PDF_A4_WIDTH,
    height: bandHeight,
    color: hexToRgb(content.headerBackground),
  });

  const fg = hexToRgb(content.headerForeground);
  const logoSize = 52;
  const textRight = hasLogo ? CONTENT_RIGHT - logoSize - 12 : CONTENT_RIGHT;

  drawText(r, content.businessName, textRight, bandBottom + 44, 16, fg, "right");
  if (content.slogan) {
    drawWrapped(r, content.slogan, textRight, bandBottom + 26, 9, fg, textRight - CONTENT_LEFT, 12);
  }

  r.y = bandBottom - 22;
}

async function embedAssetPng(
  doc: PDFDocument,
  bytes: Buffer | null,
): Promise<{ image: Awaited<ReturnType<PDFDocument["embedPng"]>> } | null> {
  if (!bytes) return null;
  try {
    const image = await doc.embedPng(bytes);
    return { image };
  } catch {
    return null;
  }
}

function renderTitleMeta(r: Renderer, content: PdfContent): void {
  ensureSpace(r, 120);
  drawText(r, content.documentTitle, PDF_A4_WIDTH / 2, r.y, 15, INK, "center");
  r.y -= 16;
  drawText(r, content.documentSubtitle, PDF_A4_WIDTH / 2, r.y, 9, MUTED, "center");
  r.y -= 24;

  // Meta grid: two columns of label/value pairs, right column first (RTL).
  const colGap = 16;
  const colWidth = (CONTENT_WIDTH - colGap) / 2;
  const rightColRight = CONTENT_RIGHT;
  const leftColRight = CONTENT_RIGHT - colWidth - colGap;
  const labelValue = (label: string, value: string, xRight: number, y: number): void => {
    drawText(r, `${label}:`, xRight, y, 9, FAINT, "right");
    const labelWidth = visualWidth(r.font, `${label}:`, 9);
    drawText(r, value, xRight - labelWidth - 6, y, 9.5, INK, "right");
  };
  const numberLabel = content.isDraft ? "پیش‌نویس (بدون شماره رسمی)" : "شماره فاکتور";
  labelValue(numberLabel, content.officialNumber ?? "—", rightColRight, r.y);
  labelValue("تاریخ صدور", content.issueDate, leftColRight, r.y);
  r.y -= 15;
  labelValue("وضعیت", content.statusLabel, rightColRight, r.y);
  labelValue("سررسید", content.dueDate, leftColRight, r.y);
  r.y -= 15;

  if (content.isDraft) {
    const notice = DRAFT_EXPORT_NOTICE;
    const lines = wrapLogical(r.font, notice, 9, CONTENT_WIDTH - 24);
    const boxHeight = lines.length * 13 + 18;
    ensureSpace(r, boxHeight + 8);
    r.page.drawRectangle({
      x: CONTENT_LEFT,
      y: r.y - boxHeight + 12,
      width: CONTENT_WIDTH,
      height: boxHeight,
      color: DRAFT_BG,
      borderColor: DRAFT_BORDER,
      borderWidth: 1,
    });
    drawWrapped(r, notice, CONTENT_RIGHT - 12, r.y - 4, 9, rgb(0.55, 0.38, 0.06), CONTENT_WIDTH - 24, 13);
    r.y -= boxHeight + 2;
  }
  r.y -= 6;
}

function renderSeller(r: Renderer, content: PdfContent): void {
  sectionHeading(r, "فروشنده");
  const lines: string[] = [];
  if (content.ownerName) lines.push(`مدیر / صاحب امتیاز: ${content.ownerName}`);
  if (content.contacts) lines.push(content.contacts);
  if (content.address) lines.push(`نشانی: ${content.address}`);
  for (const line of lines) {
    ensureSpace(r, 16);
    r.y = drawWrapped(r, line, CONTENT_RIGHT, r.y, 9, MUTED, CONTENT_WIDTH, 13) - 2;
  }
  const banking: Array<[string, string]> = [];
  if (content.cardNumber) banking.push(["شماره کارت", content.cardNumber]);
  if (content.accountNumber) banking.push(["شماره حساب", content.accountNumber]);
  if (content.iban) banking.push(["شبا", content.iban]);
  if (banking.length > 0) {
    ensureSpace(r, banking.length * 15 + 8);
    for (const [label, value] of banking) {
      drawText(r, `${label}:`, CONTENT_RIGHT, r.y, 9, FAINT, "right");
      const labelWidth = visualWidth(r.font, `${label}:`, 9);
      // Banking identifiers are Latin/digit runs: draw LTR from the left so
      // long IBANs never collide with the label.
      const visual = toVisualPersianText(value);
      const valueWidth = r.font.widthOfTextAtSize(visual, 9);
      const valueRight = CONTENT_RIGHT - labelWidth - 8;
      r.page.drawText(visual, {
        x: Math.max(CONTENT_LEFT, valueRight - valueWidth),
        y: r.y,
        size: 9,
        font: r.font,
        color: INK,
      });
      r.y -= 14;
    }
  }
  r.y -= 8;
}

function renderCustomer(r: Renderer, content: PdfContent): void {
  if (!content.customerName && content.customerLines.length === 0) return;
  sectionHeading(r, "مشتری / گیرنده");
  if (content.customerName) {
    ensureSpace(r, 18);
    drawText(r, content.customerName, CONTENT_RIGHT, r.y, 11, INK, "right");
    r.y -= 16;
  }
  for (const line of content.customerLines) {
    ensureSpace(r, 16);
    r.y = drawWrapped(r, line, CONTENT_RIGHT, r.y, 9, MUTED, CONTENT_WIDTH, 13) - 2;
  }
  r.y -= 8;
}

interface TableColumn {
  title: string;
  /** Right edge x of the column (RTL: columns flow right → left). */
  right: number;
  width: number;
  align: TextAlign;
}

function tableColumns(): TableColumn[] {
  const widths = { row: 30, qty: 52, unit: 48, price: 78, discount: 78, total: 84 };
  const descWidth = CONTENT_WIDTH - (widths.row + widths.qty + widths.unit + widths.price + widths.discount + widths.total);
  let cursor = CONTENT_RIGHT;
  const col = (title: string, width: number, align: TextAlign): TableColumn => {
    const right = cursor;
    cursor -= width;
    return { title, right, width, align };
  };
  return [
    col("ردیف", widths.row, "center"),
    col("شرح کالا / خدمت", descWidth, "right"),
    col("تعداد", widths.qty, "center"),
    col("واحد", widths.unit, "center"),
    col(`قیمت واحد`, widths.price, "left"),
    col("تخفیف", widths.discount, "left"),
    col("مبلغ ردیف", widths.total, "left"),
  ];
}

function renderTableHeader(r: Renderer, columns: TableColumn[], headerBg: RGB): number {
  const height = 22;
  ensureSpace(r, height + 4);
  const top = r.y;
  r.page.drawRectangle({
    x: CONTENT_LEFT,
    y: top - height,
    width: CONTENT_WIDTH,
    height,
    color: headerBg,
    borderColor: LINE,
    borderWidth: 0.75,
  });
  for (const column of columns) {
    const cx = column.align === "center" ? column.right - column.width / 2 : column.right - 4;
    const anchorAlign: TextAlign = column.align === "left" ? "left" : column.align;
    if (column.align === "left") {
      drawText(r, column.title, column.right - column.width + 4, top - 15, 8.5, MUTED, "left");
    } else {
      drawText(r, column.title, cx, top - 15, 8.5, MUTED, anchorAlign);
    }
  }
  // Vertical separators.
  let x = CONTENT_RIGHT;
  for (const column of columns) {
    x -= column.width;
    if (x > CONTENT_LEFT + 1) {
      r.page.drawLine({
        start: { x, y: top - height },
        end: { x, y: top },
        thickness: 0.5,
        color: LINE,
      });
    }
  }
  r.y = top - height;
  return height;
}

function renderItemsTable(r: Renderer, content: PdfContent, headerBg: RGB): void {
  sectionHeading(r, `اقلام فاکتور (${content.currencyUnit})`);
  const columns = tableColumns();
  renderTableHeader(r, columns, headerBg);

  if (content.items.length === 0) {
    ensureSpace(r, 30);
    r.page.drawRectangle({
      x: CONTENT_LEFT,
      y: r.y - 26,
      width: CONTENT_WIDTH,
      height: 26,
      borderColor: LINE,
      borderWidth: 0.75,
    });
    drawText(r, "این فاکتور قلمی ندارد.", PDF_A4_WIDTH / 2, r.y - 17, 9, MUTED, "center");
    r.y -= 26;
    return;
  }

  const descCol = columns[1] as TableColumn;
  const descWidth = descCol.width - 8;

  content.items.forEach((item, index) => {
    const titleLines = wrapLogical(r.font, item.title, 9, descWidth);
    const descLines = item.description ? wrapLogical(r.font, item.description, 8, descWidth) : [];
    const rowHeight = Math.max(24, titleLines.length * 12 + descLines.length * 10.5 + 10);
    if (r.y - rowHeight < BOTTOM_LIMIT) {
      r.page = newPage(r.doc);
      r.pages.push(r.page);
      r.y = TOP_START;
      renderTableHeader(r, columns, headerBg);
    }
    const top = r.y;
    if (index % 2 === 1) {
      r.page.drawRectangle({
        x: CONTENT_LEFT,
        y: top - rowHeight,
        width: CONTENT_WIDTH,
        height: rowHeight,
        color: SOFT_ROW,
      });
    }
    // Row bottom border.
    r.page.drawLine({
      start: { x: CONTENT_LEFT, y: top - rowHeight },
      end: { x: CONTENT_RIGHT, y: top - rowHeight },
      thickness: 0.5,
      color: LINE,
    });

    const cells: Array<{ column: TableColumn; lines: string[]; size: number; color: RGB }> = [
      { column: columns[0] as TableColumn, lines: [item.rowNumber], size: 9, color: MUTED },
      { column: descCol, lines: [], size: 9, color: INK },
      { column: columns[2] as TableColumn, lines: [item.quantity], size: 9, color: INK },
      { column: columns[3] as TableColumn, lines: [item.unit], size: 8.5, color: MUTED },
      { column: columns[4] as TableColumn, lines: [item.unitPrice], size: 9, color: INK },
      { column: columns[5] as TableColumn, lines: [item.discount], size: 8.5, color: MUTED },
      { column: columns[6] as TableColumn, lines: [item.total], size: 9, color: INK },
    ];
    // Description column: title lines + dimmer description lines.
    let lineY = top - 14;
    for (const line of titleLines) {
      drawText(r, line, descCol.right - 4, lineY, 9, INK, "right");
      lineY -= 12;
    }
    for (const line of descLines) {
      drawText(r, line, descCol.right - 4, lineY, 8, MUTED, "right");
      lineY -= 10.5;
    }
    for (const cell of cells) {
      if (cell.column === descCol) continue;
      const cy = top - 15;
      if (cell.column.align === "center") {
        drawText(r, cell.lines[0] ?? "", cell.column.right - cell.column.width / 2, cy, cell.size, cell.color, "center");
      } else if (cell.column.align === "left") {
        drawText(r, cell.lines[0] ?? "", cell.column.right - cell.column.width + 4, cy, cell.size, cell.color, "left");
      } else {
        drawText(r, cell.lines[0] ?? "", cell.column.right - 4, cy, cell.size, cell.color, "right");
      }
    }
    r.y = top - rowHeight;
  });
}

function renderTotals(r: Renderer, content: PdfContent): void {
  sectionHeading(r, "خلاصه مالی");
  const rows: Array<{ label: string; value: string; strong: boolean; muted: boolean }> = [
    { label: "جمع اقلام (پیش از تخفیف)", value: content.subtotal, strong: false, muted: false },
    { label: "مجموع تخفیف اقلام", value: content.itemDiscount, strong: false, muted: true },
    { label: content.globalDiscountLabel, value: content.globalDiscount, strong: false, muted: true },
  ];
  if (content.taxLabel) {
    rows.push({ label: content.taxLabel, value: content.taxAmount, strong: false, muted: false });
  }
  rows.push({ label: "مبلغ نهایی فاکتور", value: content.total, strong: true, muted: false });
  if (content.paidAmount && content.remainingAmount) {
    rows.push({ label: "پرداخت شده", value: content.paidAmount, strong: false, muted: false });
    rows.push({ label: "مانده قابل پرداخت", value: content.remainingAmount, strong: true, muted: false });
  }

  const labelZone = 250;
  for (const row of rows) {
    ensureSpace(r, row.strong ? 24 : 18);
    const size = row.strong ? 10.5 : 9.5;
    const color = row.muted ? FAINT : INK;
    if (row.label === "مبلغ نهایی فاکتور" || row.label === "مانده قابل پرداخت") {
      r.page.drawLine({
        start: { x: CONTENT_LEFT, y: r.y + 6 },
        end: { x: CONTENT_RIGHT, y: r.y + 6 },
        thickness: 0.5,
        color: LINE,
      });
    }
    drawText(r, row.label, CONTENT_RIGHT, r.y, size, color, "right");
    drawText(r, row.value, CONTENT_RIGHT - labelZone, r.y, size, color, "right");
    r.y -= row.strong ? 20 : 16;
  }
  r.y -= 4;
}

function renderNotes(r: Renderer, content: PdfContent): void {
  if (!content.notes) return;
  sectionHeading(r, "توضیحات");
  ensureSpace(r, 30);
  const lines = wrapLogical(r.font, content.notes, 9, CONTENT_WIDTH);
  const boxHeight = lines.length * 13 + 16;
  ensureSpace(r, boxHeight);
  r.page.drawRectangle({
    x: CONTENT_LEFT,
    y: r.y - boxHeight + 10,
    width: CONTENT_WIDTH,
    height: boxHeight,
    borderColor: LINE,
    borderWidth: 0.75,
  });
  r.y = drawWrapped(r, content.notes, CONTENT_RIGHT - 10, r.y - 4, 9, MUTED, CONTENT_WIDTH - 20, 13) - 12;
}

/** Draws stamp/signature boxes; returns the new cursor. */
function renderStampSignature(
  r: Renderer,
  doc: PDFDocument,
  assets: {
    stamp: { image: Awaited<ReturnType<PDFDocument["embedPng"]>> } | null;
    signature: { image: Awaited<ReturnType<PDFDocument["embedPng"]>> } | null;
  },
): void {
  if (!assets.stamp && !assets.signature) return;
  ensureSpace(r, 110);
  sectionHeading(r, "مهر و امضا");
  let xRight = CONTENT_RIGHT;
  const drawBox = (
    embedded: { image: Awaited<ReturnType<PDFDocument["embedPng"]>> } | null,
    caption: string,
    boxWidth: number,
    boxHeight: number,
  ): void => {
    if (!embedded) return;
    const boxLeft = xRight - boxWidth;
    r.page.drawRectangle({
      x: boxLeft,
      y: r.y - boxHeight,
      width: boxWidth,
      height: boxHeight,
      borderColor: LINE,
      borderWidth: 0.75,
    });
    const { width: iw, height: ih } = embedded.image.scale(1);
    const scale = Math.min((boxWidth - 12) / iw, (boxHeight - 12) / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    r.page.drawImage(embedded.image, {
      x: boxLeft + (boxWidth - dw) / 2,
      y: r.y - boxHeight + (boxHeight - dh) / 2,
      width: dw,
      height: dh,
    });
    drawText(r, caption, boxLeft + boxWidth / 2, r.y - boxHeight - 12, 8.5, FAINT, "center");
    xRight = boxLeft - 20;
  };
  drawBox(assets.signature, "امضا", 130, 80);
  drawBox(assets.stamp, "مهر", 90, 80);
  r.y -= 100;
}

function renderFooterBand(r: Renderer, content: PdfContent): void {
  if (!content.hasFooter) return;
  const bandHeight = 34;
  r.page.drawRectangle({
    x: 0,
    y: 28,
    width: PDF_A4_WIDTH,
    height: bandHeight,
    color: hexToRgb(content.footerBackground),
  });
  if (content.footerText) {
    const lines = wrapLogical(r.font, content.footerText, 8.5, CONTENT_WIDTH);
    const visible = lines.slice(0, 2);
    let y = 28 + bandHeight - 14;
    for (const line of visible) {
      drawText(r, line, PDF_A4_WIDTH / 2, y, 8.5, hexToRgb(content.footerForeground), "center");
      y -= 11;
    }
  }
}

function renderPageNumbers(r: Renderer): void {
  const total = toPersianDigits(r.pages.length);
  r.pages.forEach((page, index) => {
    const label = toVisualPersianText(`صفحه ${toPersianDigits(index + 1)} از ${total}`);
    const width = r.font.widthOfTextAtSize(label, 8);
    page.drawText(label, {
      x: PDF_A4_WIDTH / 2 - width / 2,
      y: 16,
      size: 8,
      font: r.font,
      color: FAINT,
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateInvoicePdfOptions {
  /** Override for tests / offline environments (defaults to fetch + sharp). */
  fetchImage?: (url: string) => Promise<Buffer | null>;
  /** Override the embedded font bytes (defaults to embedded Vazirmatn). */
  fontBytes?: Buffer;
}

/**
 * Generates the A4 invoice PDF for an authorized preview model.
 *
 * The model is rendered verbatim (see `buildPdfContent`); images resolve
 * through `fetchImage` and are omitted when unavailable. Returns the raw
 * PDF bytes — headers/filenames are the API route's job.
 */
export async function generateInvoicePdf(
  model: InvoicePreviewModel,
  options: GenerateInvoicePdfOptions = {},
): Promise<Uint8Array> {
  const content = buildPdfContent(model);
  const fontBytes = options.fontBytes ?? getVazirmatnFontBytes();
  const fetchImage = options.fetchImage ?? fetchImageAsPng;
  const assets = await resolvePdfAssets(model, fetchImage);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes);

  const page = newPage(doc);
  const r: Renderer = { doc, font, pages: [page], page, y: TOP_START };

  renderHeader(r, content, Boolean(assets.logo));

  // Logo (embedded after the header band so it paints above it).
  if (assets.logo) {
    const embedded = await embedAssetPng(doc, assets.logo);
    if (embedded) {
      const size = 52;
      const { width: iw, height: ih } = embedded.image.scale(1);
      const scale = Math.min(size / iw, size / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const bandBottom = PDF_A4_HEIGHT - 86;
      r.pages[0]?.drawRectangle({
        x: CONTENT_RIGHT - size,
        y: bandBottom + (86 - size) / 2,
        width: size,
        height: size,
        color: WHITE,
      });
      r.pages[0]?.drawImage(embedded.image, {
        x: CONTENT_RIGHT - size + (size - dw) / 2,
        y: bandBottom + (86 - dh) / 2,
        width: dw,
        height: dh,
      });
    }
  }

  renderTitleMeta(r, content);
  renderSeller(r, content);
  renderCustomer(r, content);

  const headerBg = hexToRgb(content.headerBackground);
  const softHeader = rgb(
    1 - (1 - headerBg.red) * 0.08,
    1 - (1 - headerBg.green) * 0.08,
    1 - (1 - headerBg.blue) * 0.08,
  );
  renderItemsTable(r, content, softHeader);
  renderTotals(r, content);
  renderNotes(r, content);

  const [stamp, signature] = await Promise.all([
    embedAssetPng(doc, assets.sellerStamp),
    embedAssetPng(doc, assets.sellerSignature),
  ]);
  renderStampSignature(r, doc, { stamp, signature });

  // Footer band belongs to the final page only.
  const lastRenderer: Renderer = { ...r, page: r.pages[r.pages.length - 1] as PDFPage };
  renderFooterBand(lastRenderer, content);
  renderPageNumbers(r);

  const title = content.isDraft
    ? `پیش‌نویس فاکتور ${model.invoice.id.slice(0, 8)}`
    : `فاکتور ${model.officialNumber ?? model.invoice.invoiceNumber}`;
  doc.setTitle(title);
  doc.setAuthor(content.businessName);
  doc.setProducer("invoice-saas");
  doc.setCreationDate(new Date());

  return doc.save();
}
