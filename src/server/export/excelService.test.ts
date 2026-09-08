import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";
import { generateInvoiceExcel, EXCEL_SHEET_NAME } from "./excelService";
import { draftPreviewModel, finalizedPreviewModel } from "./testFixtures";

/**
 * Excel export tests: the buffer must be a REAL `.xlsx` (parseable by
 * ExcelJS itself), with the exact columns, exact Decimal values, payment
 * state and finalized snapshots the spec requires.
 */

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = workbook.getWorksheet(EXCEL_SHEET_NAME);
  if (!ws) throw new Error("invoice sheet missing");
  return ws;
}

/** Finds the first row whose column-A value equals `label`. */
function findRowByLabel(ws: ExcelJS.Worksheet, label: string): ExcelJS.Row {
  for (let i = 1; i <= ws.rowCount; i += 1) {
    const cell = ws.getCell(i, 1);
    if (cell.value === label) return ws.getRow(i);
  }
  throw new Error(`label row not found: ${label}`);
}

function decimalOf(cell: ExcelJS.Cell): Decimal {
  return new Decimal(cell.value as number);
}

describe("generateInvoiceExcel workbook contract", () => {
  it("produces a real RTL .xlsx workbook with the invoice sheet", async () => {
    const buffer = await generateInvoiceExcel(finalizedPreviewModel());
    // ZIP signature — a genuine Office Open XML container.
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);

    const ws = await loadWorkbook(buffer);
    expect(ws.name).toBe(EXCEL_SHEET_NAME);
    expect(ws.views).toHaveLength(1);
    expect(ws.views[0]?.rightToLeft).toBe(true);
    expect(ws.getCell("A1").value).toContain("فروشگاه البرز (snapshot)");
  });

  it("renders finalized snapshots (seller/customer/currency)", async () => {
    const ws = await loadWorkbook(await generateInvoiceExcel(finalizedPreviewModel()));

    expect(findRowByLabel(ws, "نام کسب‌وکار").getCell(2).value).toBe(
      "فروشگاه البرز (snapshot)",
    );
    expect(findRowByLabel(ws, "نام").getCell(2).value).toBe("مشتری snapshot");
    expect(findRowByLabel(ws, "واحد پول").getCell(2).value).toContain("تومان");
    expect(findRowByLabel(ws, "شماره فاکتور").getCell(2).value).toBe("۱۰۲۴");
    expect(findRowByLabel(ws, "وضعیت پرداخت").getCell(2).value).toBe("در انتظار پرداخت");
  });

  it("renders drafts from the profile with no official number", async () => {
    const ws = await loadWorkbook(await generateInvoiceExcel(draftPreviewModel()));
    expect(findRowByLabel(ws, "نام کسب‌وکار").getCell(2).value).toBe(
      "فروشگاه البرز (profile)",
    );
    expect(findRowByLabel(ws, "شماره فاکتور").getCell(2).value).toBe("پیش‌نویس");
    expect(findRowByLabel(ws, "وضعیت").getCell(2).value).toBe("پیش‌نویس");
    expect(() => findRowByLabel(ws, "وضعیت پرداخت")).toThrow();
  });

  it("writes the exact item columns", async () => {
    const ws = await loadWorkbook(await generateInvoiceExcel(finalizedPreviewModel()));
    const headerRow = findRowByLabel(ws, "ردیف");
    const headers = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((col) => headerRow.getCell(col).value);
    expect(headers).toEqual([
      "ردیف",
      "کالا / خدمت",
      "شرح",
      "تعداد",
      "واحد",
      "قیمت واحد (تومان)",
      "درصد تخفیف (٪)",
      "مبلغ تخفیف (تومان)",
      "مبلغ ردیف (تومان)",
    ]);

    const itemRow = ws.getRow(headerRow.number + 1);
    expect(itemRow.getCell(1).value).toBe(1);
    expect(itemRow.getCell(2).value).toBe("خدمات طراحی وب");
    expect(itemRow.getCell(3).value).toBe("صفحه اصلی و وبلاگ");
    expect(itemRow.getCell(5).value).toBe("عدد");
  });

  it("preserves Decimal precision for money, quantities and percents", async () => {
    const model = finalizedPreviewModel();
    const item = model.invoice.items[0] as (typeof model.invoice.items)[number];
    item.quantity = "2.500";
    item.unitPrice = "99999.99";
    model.invoice.taxAmount = "15390.00";
    model.invoice.total = "9999999999.99";

    const ws = await loadWorkbook(await generateInvoiceExcel(model));
    const headerRow = findRowByLabel(ws, "ردیف");
    const itemRow = ws.getRow(headerRow.number + 1);

    expect(decimalOf(itemRow.getCell(4)).equals(new Decimal("2.5"))).toBe(true);
    expect(
      decimalOf(itemRow.getCell(6)).toDecimalPlaces(2).equals(new Decimal("99999.99")),
    ).toBe(true);
    expect(
      decimalOf(itemRow.getCell(7)).toDecimalPlaces(2).equals(new Decimal("10")),
    ).toBe(true);
    expect(
      decimalOf(findRowByLabel(ws, "مبلغ مالیات").getCell(2))
        .toDecimalPlaces(2)
        .equals(new Decimal("15390.00")),
    ).toBe(true);
    expect(
      decimalOf(findRowByLabel(ws, "مبلغ نهایی فاکتور").getCell(2))
        .toDecimalPlaces(2)
        .equals(new Decimal("9999999999.99")),
    ).toBe(true);
  });

  it("writes stored totals and payment values verbatim", async () => {
    const ws = await loadWorkbook(await generateInvoiceExcel(finalizedPreviewModel()));
    const amount = (label: string): Decimal =>
      decimalOf(findRowByLabel(ws, label).getCell(2)).toDecimalPlaces(2);
    expect(amount("جمع اقلام").equals(new Decimal("200000"))).toBe(true);
    expect(amount("مجموع تخفیف اقلام").equals(new Decimal("20000"))).toBe(true);
    expect(amount("مبلغ تخفیف کلی").equals(new Decimal("9000"))).toBe(true);
    expect(amount("مبلغ نهایی فاکتور").equals(new Decimal("186390"))).toBe(true);
    expect(amount("پرداخت شده").equals(new Decimal("50000"))).toBe(true);
    expect(amount("مانده قابل پرداخت").equals(new Decimal("136390"))).toBe(true);
    expect(findRowByLabel(ws, "توضیحات")).toBeTruthy();
  });

  it("tints the items header with the snapshot brand colour", async () => {
    const ws = await loadWorkbook(await generateInvoiceExcel(finalizedPreviewModel()));
    const headerRow = findRowByLabel(ws, "ردیف");
    const fill = headerRow.getCell(1).fill as ExcelJS.FillPattern;
    expect(fill.fgColor?.argb).toBe("FF0055FF");
  });

  it("handles invoices without items", async () => {
    const model = finalizedPreviewModel();
    model.invoice.items = [];
    const ws = await loadWorkbook(await generateInvoiceExcel(model));
    let found = false;
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value === "این فاکتور قلمی ندارد.") found = true;
      });
    });
    expect(found).toBe(true);
  });
});
