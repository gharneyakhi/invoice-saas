/**
 * Invoice PDF export V1 (server-side, Persian RTL, A4).
 *
 * What this module does: turns an authorized `InvoicePreviewModel` into PDF
 * bytes that look like the HTML preview (`InvoicePreviewDocument`, `dir=rtl`)
 * and read correctly in Persian: every string on the page flows through the
 * UBA + per-run shaping pipeline (`bidi.ts` + `persianText.ts`), so mixed
 * lines such as `تخفیف کل (۱۰٪): ۱۷,۱۰۰ تومان` or `ABC ۱۲۳ تست` render with
 * correct order, joining and bracket mirroring. The regression suite
 * (`pdfRtl.test.ts`) parses REAL generated PDFs and asserts the glyph order.
 *
 * Data law (nothing here is new logic, only reuse):
 *
 *   - Authorization, snapshots, currency: `exportInvoicePdf` loads its model
 *     via `previewService.getInvoicePreviewData` — the same ownership proofs,
 *     the same snapshot-vs-profile law and the same settings-vs-snapshot
 *     currency rule as the preview route. Drafts show the live profile and
 *     settings currency; finalized/cancelled rows show immutable snapshots.
 *   - Money: every amount/percent/date on the page is FORMATTED from the
 *     model's authoritative strings with the shared formatters
 *     (`formatCurrency`, `formatPersianNumber`, `formatPersianPercent`,
 *     `formatPersianDate`, `toPersianDigits`, `invoiceCurrencyLabel`,
 *     `formatInvoiceStatus`, `formatInvoiceType`). No financial math happens
 *     here — not even re-computation of totals.
 *   - Entitlements: the `PDF_EXPORT` feature gate (`resolveEntitlements` +
 *     `entitlementHasFeature`) is enforced server-side; without it the export
 *     throws `ForbiddenError`.
 *   - Read-only: no writes, no quota consumption, no numbering, no snapshot
 *     creation. Exporting never mutates the invoice.
 *
 * V1 limitations (deliberate, documented):
 *
 *   - Text-only: logo/stamp/signature images are NOT embedded (the storage
 *     layer allows WebP, which pdf-lib cannot embed, and this milestone is
 *     the RTL text hardening). Brand COLORS are fully honored (header, table
 *     tint, footer + contrast foregrounds, exactly like the preview).
 *   - Separators are solid hairlines (the preview uses dashed CSS borders in
 *     two places; pdf-lib's public API has no dash control).
 *   - Copy/paste from the PDF yields visual-order text (an inherent property
 *     of pre-reordered RTL PDFs without `/ActualText` spans), same as every
 *     other pdf-lib RTL pipeline. Glyph ORDER on the page is correct, which is
 *     what the tests assert.
 */

import { PDFDocument, PDFPage, PageSizes, rgb, type RGB } from "pdf-lib";
import { getInvoicePreviewData } from "@/server/invoice/previewService";
import { entitlementHasFeature, resolveEntitlements } from "@/server/entitlements/entitlementService";
import { ForbiddenError } from "@/server/auth/requireSession";
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
import type { InvoicePreviewModel } from "@/lib/invoice-preview-model";
import {
  drawParagraph,
  drawPreparedLine,
  embedExportFonts,
  hexToRgb,
  type DrawRecorder,
  layoutTextBlock,
  pickFont,
  type ExportFont,
  type ExportFontSet,
  type ParagraphAlign,
  type WrappedLine,
} from "./persianText";

/** Feature key that gates PDF export (seeded on plans; see `prisma/seed.ts`). */
export const PDF_EXPORT_FEATURE_KEY = "PDF_EXPORT";

// ---------------------------------------------------------------------------
// Page geometry + palette (A4, top-based flow coordinates)
// ---------------------------------------------------------------------------

const PAGE_WIDTH = PageSizes.A4[0];
const PAGE_HEIGHT = PageSizes.A4[1];
const MARGIN_X = 40;
const MARGIN_TOP = 34;
const MARGIN_BOTTOM = 46;
const CONTENT_LEFT = MARGIN_X;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN_X;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

const INK = hexToRgb("#111827");
const BODY = hexToRgb("#4b5563");
const MUTED = hexToRgb("#6b7280");
const FAINT = hexToRgb("#9ca3af");
const HAIRLINE = hexToRgb("#e5e7eb");
const SOFT_FILL = hexToRgb("#f9fafb");

/** Mixes a `#rrggbb` hex toward white by `ratio` (0 = as-is, 1 = white). */
export function tintTowardWhite(hex: string, ratio: number): RGB {
  const clamped = Math.min(1, Math.max(0, ratio));
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  const mix = (channel: number): number => (channel + (255 - channel) * clamped) / 255;
  return rgb(mix(red), mix(green), mix(blue));
}

function orDash(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "—";
}

/** Joins non-empty parts with a separator (mirrors the preview document). */
function joinNonEmpty(parts: Array<string | null | undefined>, separator = " · "): string | null {
  const present = parts.filter((part): part is string => Boolean(part && part.trim() !== ""));
  return present.length > 0 ? present.join(separator) : null;
}

/** Lays out a short label that must fit on one line; fails loudly if empty. */
function singleLine(flow: PageFlow, text: string, font: ExportFont, size: number, maxWidth: number): WrappedLine {
  const lines = layoutTextBlock(text, { font, size, xLeft: 0, xRight: Math.max(1, maxWidth) });
  const first = lines[0];
  if (!first) throw new Error(`[pdf-export] cannot lay out label: ${JSON.stringify(text)}`);
  return first;
}

// ---------------------------------------------------------------------------
// Flow helper (top-based cursor over pdf-lib's bottom-origin pages)
// ---------------------------------------------------------------------------

class PageFlow {
  readonly doc: PDFDocument;
  readonly fonts: ExportFontSet;
  readonly recorder?: DrawRecorder;
  page: PDFPage;
  pageIndex = 0;
  /** Cursor: distance from the TOP edge of the current page. */
  cursorTop: number;

  constructor(doc: PDFDocument, fonts: ExportFontSet, recorder?: DrawRecorder) {
    this.doc = doc;
    this.fonts = fonts;
    this.recorder = recorder;
    this.page = doc.addPage(PageSizes.A4);
    this.cursorTop = MARGIN_TOP;
  }

  /** PDF (bottom-origin) y of a top-based y. */
  y(top: number): number {
    return PAGE_HEIGHT - top;
  }

  newPage(): void {
    this.page = this.doc.addPage(PageSizes.A4);
    this.pageIndex++;
    this.cursorTop = MARGIN_TOP;
  }

  remainingHeight(): number {
    return PAGE_HEIGHT - MARGIN_BOTTOM - this.cursorTop;
  }

  /** Starts a fresh page unless `needed` points fit in the remainder. */
  ensureSpace(needed: number): void {
    if (this.cursorTop + needed > PAGE_HEIGHT - MARGIN_BOTTOM) this.newPage();
  }

  gap(points: number): void {
    this.cursorTop += points;
  }

  font(weight: "regular" | "bold"): ExportFont {
    return pickFont(this.fonts, weight);
  }

  /**
   * Draws pre-laid lines at the cursor (block alignment `align`), advancing
   * the cursor past them. The caller must `ensureSpace` first.
   */
  drawLines(
    lines: WrappedLine[],
    font: ExportFont,
    xLeft: number,
    xRight: number,
    lineHeight: number,
    align: ParagraphAlign,
    color: RGB,
  ): void {
    let baseline = this.cursorTop + lineHeight * 0.78;
    for (const line of lines) {
      const x =
        align === "right"
          ? xRight - line.width
          : align === "center"
            ? xLeft + (xRight - xLeft - line.width) / 2
            : xLeft;
      drawPreparedLine(this.page, line, font, x, this.y(baseline), color, this.recorder);
      baseline += lineHeight;
    }
    this.cursorTop += lines.length * lineHeight;
  }

  /** Bordered box outline (top-based). */
  box(top: number, height: number, xLeft = CONTENT_LEFT, width = CONTENT_WIDTH): void {
    this.page.drawRectangle({
      x: xLeft,
      y: this.y(top + height),
      width,
      height,
      borderColor: HAIRLINE,
      borderWidth: 0.75,
    });
  }

  /** Filled rect (top-based). */
  fill(top: number, height: number, color: RGB, xLeft = CONTENT_LEFT, width = CONTENT_WIDTH): void {
    this.page.drawRectangle({ x: xLeft, y: this.y(top + height), width, height, color });
  }

  /** Horizontal hairline (top-based y). */
  hline(top: number, xLeft = CONTENT_LEFT, xRight = CONTENT_RIGHT, color = HAIRLINE): void {
    this.page.drawLine({
      start: { x: xLeft, y: this.y(top) },
      end: { x: xRight, y: this.y(top) },
      thickness: 0.5,
      color,
    });
  }

  /** Vertical hairline between two top-based ys. */
  vline(x: number, top: number, bottom: number, color = HAIRLINE): void {
    this.page.drawLine({
      start: { x, y: this.y(top) },
      end: { x, y: this.y(bottom) },
      thickness: 0.5,
      color,
    });
  }
}

// ---------------------------------------------------------------------------
// Sections (each mirrors the preview document's content + strings)
// ---------------------------------------------------------------------------

function drawHeaderBand(flow: PageFlow, model: InvoicePreviewModel): void {
  const seller = model.seller;
  const brand = normalizeBrandColor(seller?.primaryColor) ?? BRAND_COLOR_FALLBACK;
  const fg = hexToRgb(contrastForeground(brand));
  const name = seller?.businessName ?? "—";
  const slogan = seller?.slogan?.trim() ? seller.slogan : null;

  const nameSize = 17;
  const nameLH = 24;
  const sloganSize = 10;
  const sloganLH = 15;
  const padV = 13;
  const sloganLines = slogan
    ? layoutTextBlock(slogan, { font: flow.font("regular"), size: sloganSize, xLeft: 0, xRight: CONTENT_WIDTH - 28 })
    : [];
  const height = padV + nameLH + (slogan ? 3 + sloganLines.length * sloganLH : 0) + padV;
  flow.ensureSpace(height);
  const top = flow.cursorTop;
  flow.fill(top, height, hexToRgb(brand));
  flow.cursorTop += padV;
  flow.drawLines(
    layoutTextBlock(name, { font: flow.font("bold"), size: nameSize, xLeft: 0, xRight: CONTENT_WIDTH - 28 }),
    flow.font("bold"),
    CONTENT_LEFT + 14,
    CONTENT_RIGHT - 14,
    nameLH,
    "right",
    fg,
  );
  if (slogan) {
    flow.gap(3);
    flow.drawLines(sloganLines, flow.font("regular"), CONTENT_LEFT + 14, CONTENT_RIGHT - 14, sloganLH, "right", fg);
  }
  flow.cursorTop = top + height;
  flow.gap(14);
}

interface MetaRow {
  label: string;
  value: string;
  boldValue?: boolean;
}

function metaRowsFor(model: InvoicePreviewModel): MetaRow[] {
  const invoice = model.invoice;
  const statusLabel = model.isDraft ? "پیش‌نویس" : formatInvoiceStatus(invoice.status).label;
  return [
    { label: "شماره فاکتور", value: model.officialNumber ? toPersianDigits(model.officialNumber) : "—", boldValue: true },
    { label: "تاریخ صدور", value: formatPersianDate(invoice.issueDate) },
    { label: "سررسید", value: invoice.dueDate ? formatPersianDate(invoice.dueDate) : "—" },
    { label: "وضعیت", value: statusLabel },
  ];
}

/**
 * Draws label-right/value-left rows inside a box (mirrors the preview's
 * `justify-between` rows). Returns the rows' total height.
 */
function drawKeyValueRows(
  flow: PageFlow,
  rows: MetaRow[],
  boxLeft: number,
  boxRight: number,
  labelSize: number,
  valueSize: number,
  rowLH: number,
): void {
  const pad = 8;
  // Value zone: everything left of the widest label + gap.
  let labelZone = 0;
  for (const row of rows) {
    const laid = layoutTextBlock(row.label, {
      font: flow.font("regular"),
      size: labelSize,
      xLeft: 0,
      xRight: boxRight - boxLeft,
    });
    labelZone = Math.max(labelZone, laid[0]?.width ?? 0);
  }
  const valueRight = boxRight - pad - labelZone - 10;
  for (const row of rows) {
    const valueLines = layoutTextBlock(row.value, {
      font: flow.font(row.boldValue ? "bold" : "regular"),
      size: valueSize,
      xLeft: 0,
      xRight: Math.max(20, valueRight - (boxLeft + pad)),
    });
    const rowHeight = Math.max(rowLH, valueLines.length * rowLH);
    flow.ensureSpace(rowHeight);
    const baseline = flow.cursorTop + rowLH * 0.78;
    const labelLine = singleLine(flow, row.label, flow.font("regular"), labelSize, labelZone + 4);
    drawPreparedLine(flow.page, labelLine, flow.font("regular"), boxRight - pad - labelLine.width, flow.y(baseline), FAINT, flow.recorder);
    let valueBaseline = baseline;
    for (const line of valueLines) {
      drawPreparedLine(flow.page, line, flow.font(row.boldValue ? "bold" : "regular"), boxLeft + pad, flow.y(valueBaseline), INK, flow.recorder);
      valueBaseline += rowLH;
    }
    flow.cursorTop += rowHeight;
  }
}

function drawTitleAndSeller(flow: PageFlow, model: InvoicePreviewModel): void {
  const seller = model.seller;
  const invoice = model.invoice;
  const documentTypeLabel = formatInvoiceType(invoice.invoiceType);

  const META_WIDTH = 196;
  const GAP = 14;
  const sellerRight = CONTENT_RIGHT;
  const sellerLeft = CONTENT_LEFT + META_WIDTH + GAP;
  const metaLeft = CONTENT_LEFT;
  const metaRight = CONTENT_LEFT + META_WIDTH;

  // --- Seller column (right): measure first. ---
  const sellerBlocks: Array<{ lines: WrappedLine[]; font: ExportFont; size: number; lh: number; color: RGB }> = [];
  const ownerLine = seller?.ownerName ? `مدیر / صاحب امتیاز: ${seller.ownerName}` : null;
  if (ownerLine) {
    sellerBlocks.push({
      lines: layoutTextBlock(ownerLine, { font: flow.font("regular"), size: 10, xLeft: 0, xRight: sellerRight - sellerLeft }),
      font: flow.font("regular"),
      size: 10,
      lh: 16,
      color: BODY,
    });
  }
  const contacts = joinNonEmpty([seller?.mobile, seller?.landline, seller?.email]);
  if (contacts) {
    sellerBlocks.push({
      lines: layoutTextBlock(contacts, { font: flow.font("regular"), size: 10, xLeft: 0, xRight: sellerRight - sellerLeft }),
      font: flow.font("regular"),
      size: 10,
      lh: 16,
      color: BODY,
    });
  }
  if (seller?.address) {
    sellerBlocks.push({
      lines: layoutTextBlock(`نشانی: ${seller.address}`, {
        font: flow.font("regular"),
        size: 10,
        xLeft: 0,
        xRight: sellerRight - sellerLeft,
      }),
      font: flow.font("regular"),
      size: 10,
      lh: 16,
      color: BODY,
    });
  }
  const banking: MetaRow[] = [];
  if (seller?.cardNumber) banking.push({ label: "شماره کارت", value: seller.cardNumber });
  if (seller?.accountNumber) banking.push({ label: "شماره حساب", value: seller.accountNumber });
  if (seller?.iban) banking.push({ label: "شبا", value: seller.iban });
  let sellerHeight = sellerBlocks.reduce((sum, block, index) => sum + block.lines.length * block.lh + (index > 0 ? 7 : 0), 0);
  const BANK_ROW_LH = 15;
  if (banking.length > 0) {
    sellerHeight += (sellerBlocks.length > 0 ? 8 : 0) + 8 + banking.length * (8 + BANK_ROW_LH) + 2;
  }

  // --- Meta box (left): measure. Title + subtitle + rows. ---
  const titleLines = layoutTextBlock(documentTypeLabel, { font: flow.font("bold"), size: 17, xLeft: 0, xRight: META_WIDTH - 16 });
  const subtitleLines = layoutTextBlock("فروش کالا و خدمات", {
    font: flow.font("regular"),
    size: 9.5,
    xLeft: 0,
    xRight: META_WIDTH - 16,
  });
  const rows = metaRowsFor(model);
  const META_ROW_LH = 17;
  const metaHeight = 10 + titleLines.length * 24 + 2 + subtitleLines.length * 14 + 8 + rows.length * META_ROW_LH + 10;

  const rowHeight = Math.max(sellerHeight, metaHeight, 40);
  flow.ensureSpace(rowHeight);
  const top = flow.cursorTop;

  // Seller column.
  {
    const savedCursor = flow.cursorTop;
    flow.cursorTop = top;
    sellerBlocks.forEach((block, index) => {
      if (index > 0) flow.gap(7);
      flow.drawLines(block.lines, block.font, sellerLeft, sellerRight, block.lh, "right", block.color);
    });
    if (banking.length > 0) {
      if (sellerBlocks.length > 0) flow.gap(8);
      const bankTop = flow.cursorTop;
      const bankHeight = 8 + banking.length * (8 + BANK_ROW_LH) + 2;
      flow.page.drawRectangle({
        x: sellerLeft,
        y: flow.y(bankTop + bankHeight),
        width: sellerRight - sellerLeft,
        height: bankHeight,
        color: SOFT_FILL,
        borderColor: HAIRLINE,
        borderWidth: 0.5,
      });
      flow.cursorTop += 8;
      for (const entry of banking) {
        flow.drawLines(
          layoutTextBlock(entry.label, { font: flow.font("regular"), size: 8, xLeft: 0, xRight: sellerRight - sellerLeft - 14 }),
          flow.font("regular"),
          sellerLeft + 7,
          sellerRight - 7,
          8,
          "right",
          FAINT,
        );
        flow.drawLines(
          layoutTextBlock(entry.value, { font: flow.font("regular"), size: 10, xLeft: 0, xRight: sellerRight - sellerLeft - 14 }),
          flow.font("regular"),
          sellerLeft + 7,
          sellerRight - 7,
          BANK_ROW_LH,
          "right",
          INK,
        );
      }
      flow.cursorTop = bankTop + bankHeight;
    }
    flow.cursorTop = savedCursor;
  }

  // Meta box.
  {
    flow.page.drawRectangle({
      x: metaLeft,
      y: flow.y(top + metaHeight),
      width: META_WIDTH,
      height: metaHeight,
      borderColor: HAIRLINE,
      borderWidth: 0.75,
    });
    const savedCursor = flow.cursorTop;
    flow.cursorTop = top + 10;
    flow.drawLines(titleLines, flow.font("bold"), metaLeft + 8, metaRight - 8, 24, "center", INK);
    flow.gap(2);
    flow.drawLines(subtitleLines, flow.font("regular"), metaLeft + 8, metaRight - 8, 14, "center", MUTED);
    flow.gap(8);
    // Inner rows panel.
    const rowsTop = flow.cursorTop;
    const rowsHeight = rows.length * META_ROW_LH;
    flow.page.drawRectangle({
      x: metaLeft + 8,
      y: flow.y(rowsTop + rowsHeight),
      width: META_WIDTH - 16,
      height: rowsHeight,
      color: SOFT_FILL,
      borderColor: HAIRLINE,
      borderWidth: 0.5,
    });
    drawKeyValueRows(flow, rows, metaLeft + 8, metaRight - 8, 8.5, 10, META_ROW_LH);
    flow.cursorTop = savedCursor;
  }

  flow.cursorTop = top + rowHeight;
  flow.gap(14);
}

function drawCustomerBox(flow: PageFlow, model: InvoicePreviewModel): void {
  const customer = model.customer;
  if (!customer) return;
  const pad = 10;
  const innerLeft = CONTENT_LEFT + pad;
  const innerRight = CONTENT_RIGHT - pad;
  const innerWidth = innerRight - innerLeft;
  const COLS = 3;
  const colGap = 14;
  const colWidth = (innerWidth - colGap * (COLS - 1)) / COLS;

  const fields: Array<{ label: string; value: string }> = [
    { label: "موبایل", value: orDash(customer.mobile) },
    { label: "تلفن", value: orDash(customer.phone) },
    { label: "ایمیل", value: orDash(customer.email) },
    { label: "کد ملی", value: orDash(customer.nationalId) },
    { label: "شناسه اقتصادی", value: orDash(customer.economicCode) },
  ];
  const FIELD_LH = 15;
  const LABEL_LH = 11;
  const fieldHeight = LABEL_LH + FIELD_LH;
  const gridRows = Math.ceil(fields.length / COLS);

  const nameLines = layoutTextBlock(customer.name, { font: flow.font("bold"), size: 12.5, xLeft: 0, xRight: innerWidth - 120 });
  const addressLines = layoutTextBlock(orDash(customer.address), {
    font: flow.font("regular"),
    size: 10,
    xLeft: 0,
    xRight: innerWidth,
  });
  const height =
    pad + Math.max(16, nameLines.length * 17) + 8 + gridRows * fieldHeight + (gridRows - 1) * 6 + 8 + LABEL_LH + addressLines.length * FIELD_LH + pad;
  flow.ensureSpace(height);
  const top = flow.cursorTop;
  flow.box(top, height);

  flow.cursorTop = top + pad;
  // Title row: heading right, customer name left (mirrors the preview).
  {
    const baseline = flow.cursorTop + 16 * 0.78;
    const heading = singleLine(flow, "مشتری / گیرنده", flow.font("bold"), 10, 200);
    drawPreparedLine(flow.page, heading, flow.font("bold"), innerRight - heading.width, flow.y(baseline), INK, flow.recorder);
    let nameBaseline = baseline;
    for (const line of nameLines) {
      drawPreparedLine(flow.page, line, flow.font("bold"), innerLeft, flow.y(nameBaseline), INK, flow.recorder);
      nameBaseline += 17;
    }
    flow.cursorTop += Math.max(16, nameLines.length * 17) + 8;
  }
  // Field grid (RTL: first field rightmost).
  for (let row = 0; row < gridRows; row++) {
    if (row > 0) flow.gap(6);
    for (let col = 0; col < COLS; col++) {
      const field = fields[row * COLS + col];
      if (!field) continue;
      const cellRight = innerRight - col * (colWidth + colGap);
      const cellLeft = cellRight - colWidth;
      const savedCursor = flow.cursorTop;
      flow.drawLines(
        layoutTextBlock(field.label, { font: flow.font("regular"), size: 8.5, xLeft: 0, xRight: colWidth }),
        flow.font("regular"),
        cellLeft,
        cellRight,
        LABEL_LH,
        "right",
        FAINT,
      );
      flow.drawLines(
        layoutTextBlock(field.value, { font: flow.font("regular"), size: 10, xLeft: 0, xRight: colWidth }),
        flow.font("regular"),
        cellLeft,
        cellRight,
        FIELD_LH,
        "right",
        INK,
      );
      flow.cursorTop = savedCursor;
    }
    flow.cursorTop += fieldHeight;
  }
  flow.gap(8);
  flow.drawLines(
    layoutTextBlock("آدرس", { font: flow.font("regular"), size: 8.5, xLeft: 0, xRight: innerWidth }),
    flow.font("regular"),
    innerLeft,
    innerRight,
    LABEL_LH,
    "right",
    FAINT,
  );
  flow.drawLines(addressLines, flow.font("regular"), innerLeft, innerRight, FIELD_LH, "right", INK);
  flow.cursorTop = top + height;
  flow.gap(14);
}

// --- Items table (column fractions mirror the preview's colgroup). ---

const ITEM_COLS: Array<{
  key: string;
  fraction: number;
  header: (unit: string) => string;
  align: ParagraphAlign;
}> = [
  { key: "row", fraction: 0.06, header: () => "ردیف", align: "center" },
  { key: "title", fraction: 0.34, header: () => "شرح کالا / خدمت", align: "right" },
  { key: "qty", fraction: 0.09, header: () => "تعداد", align: "center" },
  { key: "unit", fraction: 0.08, header: () => "واحد", align: "center" },
  { key: "price", fraction: 0.15, header: (unit) => `قیمت واحد (${unit})`, align: "left" },
  { key: "discount", fraction: 0.13, header: (unit) => `تخفیف (${unit})`, align: "left" },
  { key: "total", fraction: 0.15, header: (unit) => `مبلغ ردیف (${unit})`, align: "left" },
];

function columnEdges(): number[] {
  // Right-to-left: edges[0] = content right, edges[i+1] = left edge of col i.
  const edges: number[] = [CONTENT_RIGHT];
  for (const col of ITEM_COLS) {
    edges.push((edges[edges.length - 1] as number) - col.fraction * CONTENT_WIDTH);
  }
  return edges;
}

function drawItemsTable(flow: PageFlow, model: InvoicePreviewModel): void {
  const invoice = model.invoice;
  const unit = invoiceCurrencyLabel(model.currency);
  if (invoice.items.length === 0) {
    const lines = layoutTextBlock("این فاکتور قلمی ندارد.", {
      font: flow.font("regular"),
      size: 10,
      xLeft: 0,
      xRight: CONTENT_WIDTH - 20,
    });
    const height = 14 + lines.length * 16 + 14;
    flow.ensureSpace(height);
    const top = flow.cursorTop;
    flow.box(top, height);
    flow.cursorTop += 14;
    flow.drawLines(lines, flow.font("regular"), CONTENT_LEFT + 10, CONTENT_RIGHT - 10, 16, "center", FAINT);
    flow.cursorTop = top + height;
    flow.gap(14);
    return;
  }

  const edges = columnEdges();
  const colBox = (index: number): { left: number; right: number } => ({
    right: (edges[index] as number) - 4,
    left: (edges[index + 1] as number) + 4,
  });
  const HEADER_SIZE = 9;
  const BODY_SIZE = 9.5;
  const DESC_SIZE = 8.5;
  const ROW_LH = 15;
  const DESC_LH = 13;
  const ROW_PAD_V = 5;

  // Header (measured per column; unit labels can wrap on narrow columns).
  const headerCells = ITEM_COLS.map((col, index) => {
    const { left, right } = colBox(index);
    return {
      col,
      lines: layoutTextBlock(col.header(unit), { font: flow.font("bold"), size: HEADER_SIZE, xLeft: 0, xRight: right - left }),
      left,
      right,
    };
  });
  const headerHeight = Math.max(...headerCells.map((cell) => cell.lines.length * ROW_LH)) + 10;

  interface BodyRow {
    index: number;
    titleLines: WrappedLine[];
    descLines: WrappedLine[];
    qtyText: string;
    unitText: string;
    priceText: string;
    discountText: string;
    totalText: string;
    height: number;
  }
  const bodyRows: BodyRow[] = invoice.items.map((item, index) => {
    const { left, right } = colBox(1);
    const titleLines = layoutTextBlock(item.title, { font: flow.font("bold"), size: BODY_SIZE, xLeft: 0, xRight: right - left });
    const descLines = item.description
      ? layoutTextBlock(item.description, { font: flow.font("regular"), size: DESC_SIZE, xLeft: 0, xRight: right - left })
      : [];
    const discountText =
      Number(item.discountPercent) > 0
        ? `${formatPersianNumber(item.discountAmount)} (${formatPersianPercent(item.discountPercent)})`
        : formatPersianNumber(item.discountAmount);
    const height =
      ROW_PAD_V + titleLines.length * ROW_LH + (descLines.length > 0 ? 2 + descLines.length * DESC_LH : 0) + ROW_PAD_V;
    return {
      index,
      titleLines,
      descLines,
      qtyText: formatPersianNumber(item.quantity),
      unitText: item.unit ?? "—",
      priceText: formatPersianNumber(item.unitPrice),
      discountText,
      totalText: formatPersianNumber(item.total),
      height,
    };
  });

  const brand = normalizeBrandColor(model.seller?.primaryColor) ?? BRAND_COLOR_FALLBACK;
  const headerFill = tintTowardWhite(brand, 0.9);

  const drawHeader = (top: number): void => {
    flow.fill(top, headerHeight, headerFill);
    for (const cell of headerCells) {
      const savedCursor = flow.cursorTop;
      flow.cursorTop = top + 5;
      flow.drawLines(cell.lines, flow.font("bold"), cell.left, cell.right, ROW_LH, cell.col.align, BODY);
      flow.cursorTop = savedCursor;
    }
    flow.hline(top + headerHeight);
  };

  const drawRow = (row: BodyRow, top: number): void => {
    const titleBox = colBox(1);
    const savedCursor = flow.cursorTop;
    // Title + description (right-aligned شرح column).
    flow.cursorTop = top + ROW_PAD_V;
    flow.drawLines(row.titleLines, flow.font("bold"), titleBox.left, titleBox.right, ROW_LH, "right", INK);
    if (row.descLines.length > 0) {
      flow.gap(2);
      flow.drawLines(row.descLines, flow.font("regular"), titleBox.left, titleBox.right, DESC_LH, "right", MUTED);
    }
    flow.cursorTop = savedCursor;
    // Single-line cells, vertically centered-ish (first baseline aligned).
    const baseline = top + ROW_PAD_V + ROW_LH * 0.78;
    const cell = (colIndex: number, text: string, font: ExportFont, color: RGB): void => {
      const { left, right } = colBox(colIndex);
      const lines = layoutTextBlock(text, { font, size: BODY_SIZE, xLeft: 0, xRight: right - left });
      let lineBaseline = baseline;
      const align = ITEM_COLS[colIndex]?.align ?? "center";
      for (const line of lines) {
        const x =
          align === "right" ? right - line.width : align === "center" ? left + (right - left - line.width) / 2 : left;
        drawPreparedLine(flow.page, line, font, x, flow.y(lineBaseline), color, flow.recorder);
        lineBaseline += ROW_LH;
      }
    };
    cell(0, toPersianDigits(row.index + 1), flow.font("regular"), FAINT);
    cell(2, row.qtyText, flow.font("regular"), BODY);
    cell(3, row.unitText, flow.font("regular"), MUTED);
    cell(4, row.priceText, flow.font("regular"), BODY);
    cell(5, row.discountText, flow.font("regular"), BODY);
    cell(6, row.totalText, flow.font("bold"), INK);
    flow.hline(top + row.height);
  };

  // Flow rows with pagination (header repeats; borders per page segment).
  let segmentTop: number | null = null;
  const closeSegment = (bottom: number): void => {
    if (segmentTop === null) return;
    flow.box(segmentTop, bottom - segmentTop);
    for (let i = 1; i < edges.length - 1; i++) {
      flow.vline(edges[i] as number, segmentTop, bottom);
    }
    segmentTop = null;
  };
  for (const row of bodyRows) {
    const needHeader = segmentTop === null;
    const needed = row.height + (needHeader ? headerHeight : 0);
    if (flow.remainingHeight() < needed) {
      closeSegment(flow.cursorTop);
      flow.newPage();
      // Slim brand strip on continuation pages (the full band lives on
      // page 1): every page carries the seller's brand color.
      flow.fill(flow.cursorTop, 8, hexToRgb(brand));
      flow.cursorTop += 14;
    }
    if (segmentTop === null) {
      segmentTop = flow.cursorTop;
      drawHeader(flow.cursorTop);
      flow.cursorTop += headerHeight;
    }
    drawRow(row, flow.cursorTop);
    flow.cursorTop += row.height;
  }
  closeSegment(flow.cursorTop);
  flow.gap(14);
}

interface TotalsRow {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}

function totalsRowsFor(model: InvoicePreviewModel): { rows: TotalsRow[]; paymentRows: TotalsRow[]; showPayments: boolean } {
  const invoice = model.invoice;
  const hasTax = Number(invoice.taxPercent) > 0 || Number(invoice.taxAmount) > 0;
  const hasGlobalDiscount = Number(invoice.globalDiscountPercent) > 0;
  const rows: TotalsRow[] = [
    { label: "جمع اقلام (پیش از تخفیف)", value: formatCurrency(invoice.subtotal, model.currency) },
    { label: "مجموع تخفیف اقلام", value: formatCurrency(invoice.itemDiscountAmount, model.currency), muted: true },
    {
      label: hasGlobalDiscount ? `تخفیف کلی (${formatPersianPercent(invoice.globalDiscountPercent)})` : "تخفیف کلی",
      value: formatCurrency(invoice.globalDiscountAmount, model.currency),
      muted: true,
    },
  ];
  if (hasTax) {
    rows.push({
      label: `مالیات بر ارزش افزوده (${formatPersianPercent(invoice.taxPercent)})`,
      value: formatCurrency(invoice.taxAmount, model.currency),
    });
  }
  rows.push({ label: "مبلغ نهایی فاکتور", value: formatCurrency(invoice.total, model.currency), strong: true });
  const showPayments = !model.isDraft;
  const paymentRows: TotalsRow[] = showPayments
    ? [
        { label: "پرداخت شده", value: formatCurrency(invoice.paidAmount, model.currency) },
        { label: "مانده قابل پرداخت", value: formatCurrency(invoice.remainingAmount, model.currency), strong: true },
      ]
    : [];
  return { rows, paymentRows, showPayments };
}

function drawTotalsAndNotes(flow: PageFlow, model: InvoicePreviewModel): void {
  const GAP = 14;
  const totalsWidth = Math.round(CONTENT_WIDTH * 0.46);
  const notesWidth = CONTENT_WIDTH - totalsWidth - GAP;
  const totalsLeft = CONTENT_LEFT;
  const totalsRight = CONTENT_LEFT + totalsWidth;
  const notesLeft = totalsRight + GAP;
  const notesRight = CONTENT_RIGHT;

  // --- Totals box (left). ---
  const { rows, paymentRows, showPayments } = totalsRowsFor(model);
  const ROW_LH = 17;
  const TOTAL_LH = 22;
  const pad = 10;
  let totalsHeight = pad + 16 + 6; // title + separator gap
  for (const row of rows) totalsHeight += row.strong ? TOTAL_LH + 6 : ROW_LH;
  if (showPayments) totalsHeight += 6 + paymentRows.length * ROW_LH + (paymentRows[1]?.strong ? TOTAL_LH - ROW_LH : 0);
  totalsHeight += pad;

  // --- Notes (right): flowing lines, page-break safe. ---
  const notes = model.invoice.notes?.trim() ? model.invoice.notes : null;
  const notesTitleLH = 17;
  const notesLH = 16;
  const notesLines = notes
    ? layoutTextBlock(notes, { font: flow.font("regular"), size: 10, xLeft: 0, xRight: notesWidth - 20 })
    : [];
  const notesHeight = notes ? pad + notesTitleLH + 4 + notesLines.length * notesLH + pad : 0;

  // Totals start on a fresh page when they do not fit below; notes may then
  // paginate across further pages (segmented box). The footer follows
  // whichever column ends last (cursor logic at the end of this function).
  if (totalsHeight > flow.remainingHeight()) flow.newPage();
  const top = flow.cursorTop;
  const startPageIndex = flow.pageIndex;

  // Totals box (always kept together; it is short by construction).
  const totalsTop = flow.cursorTop;
  flow.page.drawRectangle({
    x: totalsLeft,
    y: flow.y(totalsTop + totalsHeight),
    width: totalsWidth,
    height: totalsHeight,
    borderColor: HAIRLINE,
    borderWidth: 0.75,
  });
  {
    const savedCursor = flow.cursorTop;
    flow.cursorTop = totalsTop + pad;
    flow.drawLines(
      layoutTextBlock("خلاصه مالی", { font: flow.font("bold"), size: 10.5, xLeft: 0, xRight: totalsWidth - 20 }),
      flow.font("bold"),
      totalsLeft + pad,
      totalsRight - pad,
      16,
      "right",
      INK,
    );
    flow.hline(flow.cursorTop + 3, totalsLeft + pad, totalsRight - pad);
    flow.gap(6);
    // Value zone left of labels.
    let labelZone = 0;
    for (const row of [...rows, ...paymentRows]) {
      const laid = layoutTextBlock(row.label, { font: flow.font(row.strong ? "bold" : "regular"), size: 9.5, xLeft: 0, xRight: totalsWidth });
      labelZone = Math.max(labelZone, laid[0]?.width ?? 0);
    }
    const valueRight = totalsRight - pad - labelZone - 10;
    const drawTotalRow = (row: TotalsRow): void => {
      const lh = row.strong ? TOTAL_LH : ROW_LH;
      const baseline = flow.cursorTop + lh * 0.78;
      const labelFont = flow.font(row.strong ? "bold" : "regular");
      const labelLine = singleLine(flow, row.label, labelFont, 9.5, labelZone + 4);
      drawPreparedLine(flow.page, labelLine, labelFont, totalsRight - pad - labelLine.width, flow.y(baseline), row.strong ? INK : row.muted ? FAINT : MUTED, flow.recorder);
      const valueFont = flow.font(row.strong ? "bold" : "regular");
      const valueSize = row.strong ? 11.5 : 10;
      const valueLines = layoutTextBlock(row.value, { font: valueFont, size: valueSize, xLeft: 0, xRight: Math.max(20, valueRight - (totalsLeft + pad)) });
      let valueBaseline = baseline;
      for (const line of valueLines) {
        drawPreparedLine(flow.page, line, valueFont, totalsLeft + pad, flow.y(valueBaseline), INK, flow.recorder);
        valueBaseline += lh;
      }
      flow.cursorTop += lh;
    };
    for (const row of rows) {
      if (row.strong) {
        flow.hline(flow.cursorTop + 3, totalsLeft + pad, totalsRight - pad);
        flow.gap(6);
      }
      drawTotalRow(row);
    }
    if (showPayments) {
      flow.hline(flow.cursorTop + 3, totalsLeft + pad, totalsRight - pad);
      flow.gap(6);
      for (const row of paymentRows) drawTotalRow(row);
    }
    flow.cursorTop = savedCursor;
  }

  // Notes box (right): segmented across pages when long. Uses the flow
  // cursor directly (no restore): when it paginates, the cursor must stay at
  // the notes' end so the footer follows the last content.
  if (notes) {
    flow.cursorTop = top;
    let segmentTop: number | null = null;
    const closeNotesSegment = (bottom: number): void => {
      if (segmentTop === null) return;
      flow.page.drawRectangle({
        x: notesLeft,
        y: flow.y(bottom),
        width: notesWidth,
        height: bottom - segmentTop,
        borderColor: HAIRLINE,
        borderWidth: 0.75,
      });
      segmentTop = null;
    };
    // Title (kept with at least the first line when possible).
    flow.ensureSpace(pad + notesTitleLH + 4 + notesLH);
    segmentTop = flow.cursorTop;
    flow.cursorTop += pad;
    flow.drawLines(
      layoutTextBlock("توضیحات", { font: flow.font("bold"), size: 10.5, xLeft: 0, xRight: notesWidth - 20 }),
      flow.font("bold"),
      notesLeft + pad,
      notesRight - pad,
      notesTitleLH,
      "right",
      INK,
    );
    flow.gap(4);
    for (const line of notesLines) {
      if (flow.remainingHeight() < notesLH) {
        closeNotesSegment(flow.cursorTop + pad);
        flow.newPage();
        segmentTop = flow.cursorTop;
        flow.cursorTop += pad;
      }
      const x = notesRight - pad - line.width;
      drawPreparedLine(flow.page, line, flow.font("regular"), x, flow.y(flow.cursorTop + notesLH * 0.78), BODY, flow.recorder);
      flow.cursorTop += notesLH;
    }
    closeNotesSegment(flow.cursorTop + pad);
  }

  if (flow.pageIndex === startPageIndex) {
    // Nothing paginated: advance past the taller column on this page.
    flow.cursorTop = top + Math.max(totalsHeight, notesHeight, 40);
  }
  // Else the notes spilled to later pages and the cursor already tracks their
  // end; the footer follows there.
  flow.gap(14);
}

function drawFooterStrip(flow: PageFlow, model: InvoicePreviewModel): void {
  const seller = model.seller;
  const hasColor = Boolean(seller?.footerBackgroundColor);
  const footerText = seller?.footerText?.trim() ? seller.footerText : null;
  if (!hasColor && !footerText) return;
  const bg = normalizeBrandColor(seller?.footerBackgroundColor) ?? FOOTER_COLOR_FALLBACK;
  const fg = hexToRgb(contrastForeground(bg));
  const size = 9.5;
  const lh = 14;
  const lines = footerText
    ? layoutTextBlock(footerText, { font: flow.font("regular"), size, xLeft: 0, xRight: CONTENT_WIDTH - 28 })
    : [];
  const height = footerText ? 10 + lines.length * lh + 10 : 18;
  flow.ensureSpace(height);
  const top = flow.cursorTop;
  flow.fill(top, height, hexToRgb(bg));
  if (footerText) {
    flow.cursorTop += 10;
    flow.drawLines(lines, flow.font("regular"), CONTENT_LEFT + 14, CONTENT_RIGHT - 14, lh, "center", fg);
  }
  flow.cursorTop = top + height;
  flow.gap(6);
}

function drawPageNumbers(flow: PageFlow): void {
  const total = flow.doc.getPageCount();
  const font = flow.font("regular");
  for (let index = 0; index < total; index++) {
    const page = flow.doc.getPage(index);
    const label = total > 1 ? `صفحه ${toPersianDigits(index + 1)} از ${toPersianDigits(total)}` : `صفحه ${toPersianDigits(index + 1)}`;
    drawParagraph(page, label, {
      font,
      size: 9,
      color: FAINT,
      xLeft: CONTENT_LEFT,
      xRight: CONTENT_RIGHT,
      firstBaselineY: 26,
      lineHeight: 12,
      align: "center",
      recorder: flow.recorder,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders the invoice PDF. Pure with respect to the database: the model
 * carries everything (snapshots, currency, formatted-then-drawn money). Reads
 * only the vendored font files from disk.
 */
export interface RenderInvoicePdfOptions {
  /**
   * Verification hook: records every run handed to pdf-lib (see
   * `DrawRecorder`). Production callers omit it; behavior is identical
   * either way.
   */
  recorder?: DrawRecorder;
}

export async function renderInvoicePdf(
  model: InvoicePreviewModel,
  options: RenderInvoicePdfOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = await embedExportFonts(doc);
  const flow = new PageFlow(doc, fonts, options.recorder);

  drawHeaderBand(flow, model);
  drawTitleAndSeller(flow, model);
  drawCustomerBox(flow, model);
  drawItemsTable(flow, model);
  drawTotalsAndNotes(flow, model);
  drawFooterStrip(flow, model);
  drawPageNumbers(flow);

  const invoice = model.invoice;
  const title = model.officialNumber
    ? `${formatInvoiceType(invoice.invoiceType)} ${model.officialNumber}`
    : `${formatInvoiceType(invoice.invoiceType)} (پیش‌نویس)`;
  doc.setTitle(title);
  return doc.save();
}

/** ASCII-safe download filename from the official number (or draft id). */
export function makeInvoicePdfFilename(model: InvoicePreviewModel): string {
  const raw = model.officialNumber ?? `draft-${model.invoice.id.slice(0, 8)}`;
  const slug = raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "invoice";
  return `invoice-${slug}.pdf`;
}

export interface ExportInvoicePdfResult {
  bytes: Uint8Array;
  filename: string;
  contentType: "application/pdf";
}

/**
 * Authorized PDF export: ownership + snapshot/currency law via
 * `getInvoicePreviewData`, `PDF_EXPORT` entitlement gate, then render.
 * Read-only (no writes of any kind).
 */
export async function exportInvoicePdf(businessId: string, invoiceId: string): Promise<ExportInvoicePdfResult> {
  const model = await getInvoicePreviewData(businessId, invoiceId);
  const entitlements = await resolveEntitlements();
  if (!entitlementHasFeature(entitlements, PDF_EXPORT_FEATURE_KEY)) {
    throw new ForbiddenError("PDF export is not available on the current plan");
  }
  const bytes = await renderInvoicePdf(model);
  return { bytes, filename: makeInvoicePdfFilename(model), contentType: "application/pdf" };
}
