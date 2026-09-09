import ExcelJS from "exceljs";
import Decimal from "decimal.js";
import type { InvoicePreviewModel } from "@/lib/invoice-preview-model";
import {
  contrastForeground,
  normalizeBrandColor,
  BRAND_COLOR_FALLBACK,
} from "@/lib/invoice-brand";
import { invoiceCurrencyLabel } from "@/lib/currency";
import {
  formatInvoiceStatus,
  formatInvoiceType,
  formatPersianDate,
  toPersianDigits,
} from "@/lib/formatters";

/**
 * Server-side invoice Excel export — a REAL `.xlsx` workbook (ExcelJS),
 * never CSV renamed.
 *
 * Data law (same as every other export): the input is the authorized
 * `InvoicePreviewModel`, so finalized rows expose their immutable
 * seller/customer/currency snapshots and drafts expose the current
 * profile — rendered here verbatim, recomputed never.
 *
 * Money & Decimal precision: Excel cells are IEEE doubles (the format has
 * no decimal type), so stored Decimal strings are converted to numbers
 * ONLY at the cell boundary via `new Decimal(stored).toNumber()` — zero
 * floating-point arithmetic happens anywhere in this module. Values are
 * written with 2-decimal number formats (3 for quantities), so what the
 * user sees and sums in Excel matches the stored amounts exactly.
 */

export const EXCEL_SHEET_NAME = "فاکتور";
export const EXCEL_MONEY_FORMAT = "#,##0.00";
export const EXCEL_QUANTITY_FORMAT = "#,##0.###";
export const EXCEL_PERCENT_FORMAT = "0.00";

/** Stored Decimal string → Excel cell number (conversion only, no math). */
function moneyCell(value: string): number {
  return new Decimal(value).toDecimalPlaces(2).toNumber();
}

function quantityCell(value: string): number {
  return new Decimal(value).toNumber();
}

function percentCell(value: string): number {
  // Stored percents are already "9.00 means 9%": write the raw number with
  // a plain format — Excel's % format would multiply by 100.
  return new Decimal(value).toDecimalPlaces(2).toNumber();
}

function hexToArgb(hex: string): string {
  const clean = hex.replace("#", "");
  return `FF${clean.toUpperCase()}`;
}

const THIN_BORDER: ExcelJS.Borders = {
  top: { style: "thin", color: { argb: "FFE5E7EB" } },
  bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
  left: { style: "thin", color: { argb: "FFE5E7EB" } },
  right: { style: "thin", color: { argb: "FFE5E7EB" } },
  // Required by the exceljs `Borders` type; empty = no diagonal lines.
  diagonal: {},
};

/**
 * Generates the invoice workbook. Returns raw `.xlsx` bytes — the API
 * route sets Content-Type / Content-Disposition from `filename.ts`.
 */
export async function generateInvoiceExcel(model: InvoicePreviewModel): Promise<Buffer> {
  const invoice = model.invoice;
  const seller = model.seller;
  const customer = model.customer;
  const currency = model.currency;
  const unit = invoiceCurrencyLabel(currency);
  const statusMeta = formatInvoiceStatus(invoice.status);
  const statusLabel = model.isDraft ? "پیش‌نویس" : statusMeta.label;

  const brand = normalizeBrandColor(seller?.primaryColor) ?? BRAND_COLOR_FALLBACK;
  const brandFg = contrastForeground(brand);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "invoice-saas";
  workbook.lastModifiedBy = "invoice-saas";
  workbook.created = new Date();
  workbook.modified = new Date();

  const ws = workbook.addWorksheet(EXCEL_SHEET_NAME, {
    views: [{ state: "normal", rightToLeft: true }],
  });

  // 9 columns (A is rightmost in the RTL view): ردیف | کالا/خدمت | شرح |
  // تعداد | واحد | قیمت واحد | ٪ تخفیف | مبلغ تخفیف | مبلغ ردیف
  ws.columns = [
    { key: "row", width: 8 },
    { key: "title", width: 28 },
    { key: "desc", width: 34 },
    { key: "qty", width: 12 },
    { key: "unit", width: 12 },
    { key: "price", width: 18 },
    { key: "discPct", width: 14 },
    { key: "discAmt", width: 18 },
    { key: "lineTotal", width: 18 },
  ];

  let row = 1;

  // Merged cells never auto-fit their row height in Excel, so wrapped text
  // in merged ranges gets an estimated height (over-estimating slightly
  // beats clipped text).
  const fitMergedRow = (rowIndex: number, text: string, charsPerLine: number, lineHeight: number): void => {
    const lines = Math.max(1, Math.ceil([...text].length / charsPerLine));
    ws.getRow(rowIndex).height = Math.max(ws.getRow(rowIndex).height ?? 0, lines * lineHeight);
  };

  // ---- Title ------------------------------------------------------------
  ws.mergeCells(`A${row}:I${row}`);
  const titleCell = ws.getCell(`A${row}`);
  const titleText = `${seller?.businessName ?? "—"} — ${formatInvoiceType(invoice.invoiceType)}`;
  titleCell.value = titleText;
  titleCell.font = { size: 16, bold: true, color: { argb: "FF111827" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  fitMergedRow(row, titleText, 80, 21);
  row += 1;

  ws.mergeCells(`A${row}:I${row}`);
  const subCell = ws.getCell(`A${row}`);
  // Drafts have no official number — never fall back to a row placeholder.
  const subText = model.isDraft
    ? `پیش‌نویس (بدون شماره رسمی) — ${formatPersianDate(invoice.issueDate)}`
    : `شماره ${toPersianDigits(model.officialNumber ?? invoice.invoiceNumber)} — ${formatPersianDate(invoice.issueDate)}`;
  subCell.value = subText;
  subCell.font = { size: 11, color: { argb: "FF6B7280" } };
  subCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  fitMergedRow(row, subText, 110, 15);
  row += 2;

  // ---- Key/value helper (label in A, value merged B:I) --------------------
  const sectionTitle = (title: string): void => {
    ws.mergeCells(`A${row}:I${row}`);
    const cell = ws.getCell(`A${row}`);
    cell.value = title;
    cell.font = { size: 12, bold: true, color: { argb: "FF111827" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
    cell.alignment = { vertical: "middle" };
    cell.border = THIN_BORDER;
    ws.getRow(row).height = Math.max(ws.getRow(row).height ?? 0, 20);
    row += 1;
  };

  const kvRow = (label: string, value: ExcelJS.CellValue, numFmt?: string): void => {
    ws.mergeCells(`B${row}:I${row}`);
    const labelCell = ws.getCell(`A${row}`);
    labelCell.value = label;
    labelCell.font = { size: 11, color: { argb: "FF6B7280" } };
    labelCell.alignment = { vertical: "middle" };
    const valueCell = ws.getCell(`B${row}`);
    valueCell.value = value;
    valueCell.font = { size: 11, color: { argb: "FF111827" } };
    valueCell.alignment = { vertical: "middle", wrapText: true };
    if (numFmt) valueCell.numFmt = numFmt;
    if (typeof value === "string") fitMergedRow(row, value, 100, 15);
    row += 1;
  };

  // ---- Invoice info ------------------------------------------------------
  sectionTitle("اطلاعات فاکتور");
  kvRow("شماره فاکتور", model.officialNumber ? toPersianDigits(model.officialNumber) : "پیش‌نویس");
  kvRow("نوع فاکتور", formatInvoiceType(invoice.invoiceType));
  kvRow("تاریخ صدور", formatPersianDate(invoice.issueDate));
  kvRow("سررسید", invoice.dueDate ? formatPersianDate(invoice.dueDate) : "—");
  kvRow("وضعیت", statusLabel);
  kvRow("واحد پول", `${unit} (${currency})`);
  row += 1;

  // ---- Seller (snapshot for finalized, profile for drafts) ----------------
  sectionTitle(model.isDraft ? "فروشنده (اطلاعات فعلی کسب‌وکار)" : "فروشنده (ثبت‌شده هنگام صدور)");
  kvRow("نام کسب‌وکار", seller?.businessName ?? "—");
  kvRow("موبایل", seller?.mobile ?? "—");
  kvRow("تلفن ثابت", seller?.landline ?? "—");
  kvRow("ایمیل", seller?.email ?? "—");
  kvRow("نشانی", seller?.address ?? "—");
  row += 1;

  // ---- Customer (snapshot for finalized, live row for drafts) -------------
  sectionTitle(model.isDraft ? "مشتری (اطلاعات فعلی)" : "مشتری (ثبت‌شده هنگام صدور)");
  kvRow("نام", customer?.name ?? "—");
  kvRow("موبایل", customer?.mobile ?? "—");
  kvRow("تلفن", customer?.phone ?? "—");
  kvRow("ایمیل", customer?.email ?? "—");
  kvRow("نشانی", customer?.address ?? "—");
  kvRow("کد ملی", customer?.nationalId ?? "—");
  kvRow("شناسه اقتصادی", customer?.economicCode ?? "—");
  row += 1;

  // ---- Items ---------------------------------------------------------------
  sectionTitle(`اقلام فاکتور (مبالغ به ${unit})`);
  const headerRowIndex = row;
  const headers = [
    "ردیف",
    "کالا / خدمت",
    "شرح",
    "تعداد",
    "واحد",
    `قیمت واحد (${unit})`,
    "درصد تخفیف (٪)",
    `مبلغ تخفیف (${unit})`,
    `مبلغ ردیف (${unit})`,
  ];
  headers.forEach((header, index) => {
    const cell = ws.getCell(row, index + 1);
    cell.value = header;
    cell.font = { size: 11, bold: true, color: { argb: hexToArgb(brandFg) } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: hexToArgb(brand) } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = THIN_BORDER;
  });
  ws.getRow(row).height = 24;
  row += 1;

  if (invoice.items.length === 0) {
    ws.mergeCells(`A${row}:I${row}`);
    const emptyCell = ws.getCell(`A${row}`);
    emptyCell.value = "این فاکتور قلمی ندارد.";
    emptyCell.font = { size: 11, color: { argb: "FF6B7280" } };
    emptyCell.alignment = { horizontal: "center", vertical: "middle" };
    emptyCell.border = THIN_BORDER;
    row += 1;
  }

  // Column kinds drive cell alignment: counters center, Persian text reads
  // from the right, money keeps Excel's numeric alignment.
  const CENTER_COLUMNS = new Set([0, 3, 6]);
  const RIGHT_COLUMNS = new Set([1, 2, 4]);
  invoice.items.forEach((item, index) => {
    const values: Array<{ value: ExcelJS.CellValue; numFmt?: string }> = [
      { value: index + 1 },
      { value: item.title },
      { value: item.description ?? "—" },
      { value: quantityCell(item.quantity), numFmt: EXCEL_QUANTITY_FORMAT },
      { value: item.unit ?? "—" },
      { value: moneyCell(item.unitPrice), numFmt: EXCEL_MONEY_FORMAT },
      { value: percentCell(item.discountPercent), numFmt: EXCEL_PERCENT_FORMAT },
      { value: moneyCell(item.discountAmount), numFmt: EXCEL_MONEY_FORMAT },
      { value: moneyCell(item.total), numFmt: EXCEL_MONEY_FORMAT },
    ];
    values.forEach(({ value, numFmt }, colIndex) => {
      const cell = ws.getCell(row, colIndex + 1);
      cell.value = value;
      cell.font = { size: 11, color: { argb: "FF111827" } };
      cell.alignment = {
        vertical: "middle",
        wrapText: true,
        horizontal: CENTER_COLUMNS.has(colIndex)
          ? "center"
          : RIGHT_COLUMNS.has(colIndex)
            ? "right"
            : undefined,
      };
      if (numFmt) cell.numFmt = numFmt;
      cell.border = THIN_BORDER;
    });
    if (index % 2 === 1) {
      for (let colIndex = 1; colIndex <= 9; colIndex += 1) {
        ws.getCell(row, colIndex).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF9FAFB" },
        };
      }
    }
    row += 1;
  });
  row += 1;

  // ---- Totals (stored values, verbatim) --------------------------------------
  sectionTitle("خلاصه مالی");
  const totalRow = (label: string, value: number, strong = false): void => {
    ws.mergeCells(`B${row}:I${row}`);
    const labelCell = ws.getCell(`A${row}`);
    labelCell.value = label;
    labelCell.font = { size: 11, bold: strong, color: { argb: "FF111827" } };
    labelCell.alignment = { vertical: "middle" };
    const valueCell = ws.getCell(`B${row}`);
    valueCell.value = value;
    valueCell.numFmt = EXCEL_MONEY_FORMAT;
    valueCell.font = { size: strong ? 12 : 11, bold: strong, color: { argb: "FF111827" } };
    valueCell.alignment = { vertical: "middle" };
    if (strong) {
      // Dividers above the grand-total rows, mirroring the PDF.
      const divider = { style: "thin" as const, color: { argb: "FFD1D5DB" } };
      labelCell.border = { ...THIN_BORDER, top: divider };
      valueCell.border = { ...THIN_BORDER, top: divider };
    }
    row += 1;
  };
  totalRow("جمع اقلام", moneyCell(invoice.subtotal));
  totalRow("مجموع تخفیف اقلام", moneyCell(invoice.itemDiscountAmount));
  kvRow("درصد تخفیف کلی (٪)", percentCell(invoice.globalDiscountPercent), EXCEL_PERCENT_FORMAT);
  totalRow("مبلغ تخفیف کلی", moneyCell(invoice.globalDiscountAmount));
  kvRow("درصد مالیات (٪)", percentCell(invoice.taxPercent), EXCEL_PERCENT_FORMAT);
  totalRow("مبلغ مالیات", moneyCell(invoice.taxAmount));
  totalRow("مبلغ نهایی فاکتور", moneyCell(invoice.total), true);
  if (!model.isDraft) {
    totalRow("پرداخت شده", moneyCell(invoice.paidAmount));
    totalRow("مانده قابل پرداخت", moneyCell(invoice.remainingAmount), true);
    kvRow("وضعیت پرداخت", statusLabel);
  }
  kvRow("واحد پول", `${unit} (${currency})`);
  row += 1;

  // ---- Notes -----------------------------------------------------------------
  if (invoice.notes?.trim()) {
    sectionTitle("توضیحات");
    ws.mergeCells(`A${row}:I${row}`);
    const notesCell = ws.getCell(`A${row}`);
    notesCell.value = invoice.notes;
    notesCell.font = { size: 11, color: { argb: "FF4B5563" } };
    notesCell.alignment = { wrapText: true, vertical: "top" };
    fitMergedRow(row, invoice.notes, 110, 15);
    row += 1;
  }

  // Freeze below the items header so long tables keep their labels.
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: headerRowIndex, rightToLeft: true }];

  // Print-ready: portrait A4, fit to page width, items header on every page.
  ws.pageSetup = {
    paperSize: 9,
    orientation: "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${headerRowIndex}:${headerRowIndex}`,
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
