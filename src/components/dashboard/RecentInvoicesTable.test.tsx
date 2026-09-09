import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RecentInvoicesTable,
  INVOICE_NUMBER_CELL_CLASS,
  INVOICE_NUMBER_MOBILE_CLASS,
  CUSTOMER_CELL_CLASS,
} from "./RecentInvoicesTable";
import type { DashboardRecentInvoiceDTO } from "@/server/dashboard/dashboardService";

/**
 * Dashboard recent-invoices identifier display contract.
 *
 * Fixtures mirror the exact real DTO shape produced by the data flow:
 * `dashboardService.toRecentInvoiceDTO` maps `status` and `invoiceNumber`
 * 1:1 from the `invoices` table, so a draft row is
 * `{ status: "DRAFT", invoiceNumber: "DRAFT-<uuid>", finalizedAt: null, ... }`.
 * The status pill renders from the SAME `status` field; the number cell must
 * therefore show «پیش‌نویس» for every row whose pill says «پیش‌نویس», never
 * the internal `DRAFT-<uuid>` placeholder. Finalized invoices keep their
 * official number (only converted to Persian digits for display).
 * This is presentation-only — the underlying `invoiceNumber` value is not
 * touched and the row links/actions must keep working.
 */

const DRAFT_UUID = "3f5a4d2c-1b6e-4c7d-9a0e-8b2f1d3c5a77";

function draftInvoice(
  overrides: Partial<DashboardRecentInvoiceDTO> = {},
): DashboardRecentInvoiceDTO {
  return {
    id: "inv-draft-1",
    invoiceNumber: `DRAFT-${DRAFT_UUID}`,
    invoiceType: "FINAL",
    status: "DRAFT",
    customerName: "شرکت آلفا",
    total: "109000.00",
    paidAmount: "0.00",
    remainingAmount: "109000.00",
    currency: null,
    issueDate: "2026-03-05T00:00:00.000Z",
    dueDate: null,
    finalizedAt: null,
    createdAt: "2026-03-05T00:00:00.000Z",
    ...overrides,
  };
}

function finalizedInvoice(
  overrides: Partial<DashboardRecentInvoiceDTO> = {},
): DashboardRecentInvoiceDTO {
  return {
    id: "inv-final-1",
    invoiceNumber: "14052",
    invoiceType: "FINAL",
    status: "PENDING_PAYMENT",
    customerName: "شرکت گاما",
    total: "2500000.00",
    paidAmount: "0.00",
    remainingAmount: "2500000.00",
    currency: "IRR",
    issueDate: "2026-06-14T00:00:00.000Z",
    dueDate: "2026-07-14T00:00:00.000Z",
    finalizedAt: "2026-06-14T00:00:00.000Z",
    createdAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

function render(invoices: DashboardRecentInvoiceDTO[]): string {
  return renderToStaticMarkup(<RecentInvoicesTable invoices={invoices} hasBusiness />);
}

describe("RecentInvoicesTable — invoice identifier display", () => {
  it("renders «پیش‌نویس» for a draft and never the DRAFT-<uuid> identifier", () => {
    const html = render([draftInvoice()]);

    expect(html).toContain("پیش‌نویس");
    expect(html).not.toContain(DRAFT_UUID);
    expect(html).not.toContain(`DRAFT-${DRAFT_UUID}`);
    expect(html).not.toMatch(/DRAFT[:-][0-9a-f-]{8,}/i);
  });

  it("derives the number cell and the «پیش‌نویس» status pill from the same status field (real DTO shape)", () => {
    // Exact dashboardService output for a draft: status DRAFT, finalizedAt null,
    // currency null, invoiceNumber carrying the internal placeholder.
    const html = render([
      draftInvoice({
        status: "DRAFT",
        finalizedAt: null,
        currency: null,
        invoiceNumber: `DRAFT-${DRAFT_UUID}`,
      }),
    ]);

    // The pill (وضعیت) and the number cell must agree on «پیش‌نویس».
    expect(html).toContain("پیش‌نویس");
    expect(html).not.toContain(`DRAFT-${DRAFT_UUID}`);
    expect(html).not.toContain(DRAFT_UUID);
  });

  it("renders a finalized invoice's official number in Persian digits", () => {
    const html = render([finalizedInvoice()]);

    expect(html).toContain("۱۴۰۵۲");
    expect(html).not.toContain("14052");
  });

  it("renders the draft label and the official number side by side in one list", () => {
    const html = render([draftInvoice(), finalizedInvoice()]);

    expect(html).toContain("پیش‌نویس");
    expect(html).toContain("۱۴۰۵۲");
    expect(html).not.toContain(DRAFT_UUID);
  });

  it("keeps invoice links/actions for both draft and finalized rows", () => {
    const html = render([draftInvoice(), finalizedInvoice()]);

    expect(html).toMatch(/href="\/dashboard\/invoices"/);
    expect(html).toContain("جزئیات");
    expect(html).toContain("مشاهده فاکتور");
  });

  it("keeps official numbers at readable size and prevents wrapping", () => {
    expect(INVOICE_NUMBER_CELL_CLASS).toContain("text-[13px]");
    expect(INVOICE_NUMBER_CELL_CLASS).toContain("font-medium");
    expect(INVOICE_NUMBER_CELL_CLASS).toContain("whitespace-nowrap");
    expect(INVOICE_NUMBER_MOBILE_CLASS).toContain("text-sm");
    expect(INVOICE_NUMBER_MOBILE_CLASS).toContain("font-semibold");
    expect(INVOICE_NUMBER_MOBILE_CLASS).toContain("whitespace-nowrap");
  });
});

describe("RecentInvoicesTable — customer column & readability", () => {
  function desktopTable(html: string): string {
    const table = html.match(/<table[\s\S]*?<\/table>/);
    if (!table) throw new Error("desktop table not rendered");
    return table[0];
  }

  it("renders the real customer name (from DTO field customerName) on desktop and mobile", () => {
    const html = render([draftInvoice()]);

    // Real names come straight from the dashboard DTO — no hard-coding.
    // Visible text + title tooltip in BOTH the desktop table and the mobile card.
    expect(html.match(/شرکت آلفا/g)?.length).toBe(4);
    expect(desktopTable(html)).toContain("شرکت آلفا");
  });

  it("renders «—» for a row without a customer", () => {
    const table = desktopTable(render([finalizedInvoice({ customerName: null })]));
    const cell = table.match(
      new RegExp(`<td class="${CUSTOMER_CELL_CLASS}">([\\s\\S]*?)</td>`),
    )?.[1];

    expect(cell).toContain("—");
    expect(cell).not.toContain("title=");
  });

  it("keeps the UX column order: شماره، مشتری، نوع، تاریخ صدور، سررسید، وضعیت، مبلغ کل، مانده، عملیات", () => {
    const html = desktopTable(render([draftInvoice()]));
    const headers = Array.from(html.matchAll(/<th[\s>][^>]*>(.*?)<\/th>/g), (m) => m[1]);

    expect(headers).toEqual([
      "شماره فاکتور",
      "مشتری",
      "نوع",
      "تاریخ صدور",
      "سررسید",
      "وضعیت",
      "مبلغ کل",
      "مانده",
      "عملیات",
    ]);
  });

  it("places the customer cell between the number and type cells in each row", () => {
    const table = desktopTable(render([draftInvoice({ customerName: "شرکت آلفا" })]));
    const row =
      Array.from(table.matchAll(/<tr[\s\S]*?<\/tr>/g), (m) => m[0]).find((r) =>
        r.includes("پیش‌نویس"),
      ) ?? "";

    const numberIdx = row.indexOf("پیش‌نویس");
    const customerIdx = row.indexOf("شرکت آلفا");
    const typeIdx = row.indexOf("فاکتور رسمی");
    expect(numberIdx).toBeGreaterThanOrEqual(0);
    expect(customerIdx).toBeGreaterThan(numberIdx);
    expect(typeIdx).toBeGreaterThan(customerIdx);
  });

  it("keeps table data readable (~13px) with the customer medium and money semibold", () => {
    const html = render([finalizedInvoice()]);

    expect(html).toMatch(/<table class="w-full text-right text-\[13px\]"/);
    expect(CUSTOMER_CELL_CLASS).toContain("font-medium");
    expect(CUSTOMER_CELL_CLASS).toContain("text-gray-900");
    expect(html).toContain("font-semibold text-gray-900 font-sans whitespace-nowrap");
  });

  it("does not regress the «پیش‌نویس» draft label or the row actions when a customer column is present", () => {
    const html = render([draftInvoice()]);

    expect(html).toContain("پیش‌نویس");
    expect(html).not.toContain(DRAFT_UUID);
    expect(html).not.toMatch(/DRAFT[:-][0-9a-f-]{8,}/i);
    expect(html).toContain("مشتری");
    expect(html).toContain("جزئیات");
    expect(html).toContain("مشاهده فاکتور");
    expect(html).toMatch(/href="\/dashboard\/invoices"/);
  });
});
