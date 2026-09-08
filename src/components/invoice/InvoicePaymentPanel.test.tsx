import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoicePaymentPanel } from "./InvoicePaymentPanel";
import type { InvoicePaymentDTO } from "@/server/actions/dto";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/server/actions/paymentActions", () => ({
  createInvoicePayment: vi.fn(),
  deleteInvoicePayment: vi.fn(),
}));

function payment(overrides: Partial<InvoicePaymentDTO> = {}): InvoicePaymentDTO {
  return {
    id: "pay-1",
    invoiceId: "inv-1",
    amount: "50000.00",
    paymentDate: "2026-03-06T00:00:00.000Z",
    method: "CASH",
    referenceNumber: "REF-9",
    notes: null,
    createdAt: "2026-03-06T00:00:00.000Z",
    ...overrides,
  };
}

function render(overrides: Partial<React.ComponentProps<typeof InvoicePaymentPanel>> = {}) {
  return renderToStaticMarkup(
    <InvoicePaymentPanel
      invoiceId="inv-1"
      currency="IRT"
      total="109000.00"
      paidAmount="50000.00"
      remainingAmount="59000.00"
      status="PARTIALLY_PAID"
      payments={[payment()]}
      {...overrides}
    />,
  );
}

describe("InvoicePaymentPanel", () => {
  it("shows مبلغ کل / پرداخت‌شده / مانده / وضعیت پرداخت and never a status-to-paid field", () => {
    const html = render();

    expect(html).toContain("مبلغ کل");
    expect(html).toContain("پرداخت‌شده");
    expect(html).toContain("مانده");
    expect(html).toContain("وضعیت پرداخت");
    expect(html).toContain("پرداخت جزئی");
    expect(html).toContain("تومان");
    expect(html).not.toContain("تغییر وضعیت");
    expect(html).not.toContain("وضعیت را به پرداخت شده");
  });

  it("offers «ثبت پرداخت» and «ثبت پرداخت کامل» on a writable finalized invoice", () => {
    const html = render();

    expect(html).toContain("ثبت پرداخت");
    expect(html).toContain("ثبت پرداخت کامل");
    expect(html).toContain("مبلغ");
    expect(html).toContain("تاریخ پرداخت");
    expect(html).toContain("روش پرداخت");
    expect(html).toContain("شماره پیگیری");
  });

  it("keeps payment history visible on a cancelled invoice but hides write controls", () => {
    const html = render({
      status: "CANCELLED",
      remainingAmount: "59000.00",
      readOnly: true,
    });

    expect(html).toContain("تاریخچه پرداخت‌ها");
    expect(html).toContain("REF-9");
    expect(html).not.toContain("ثبت پرداخت کامل");
    expect(html).not.toContain(">ثبت پرداخت<");
    expect(html).not.toContain("حذف");
  });
});
