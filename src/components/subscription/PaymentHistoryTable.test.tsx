import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentHistoryTable } from "./PaymentHistoryTable";
import type { SubscriptionPaymentHistoryDTO } from "@/server/subscription/subscriptionDisplayService";

function payment(overrides: Partial<SubscriptionPaymentHistoryDTO> = {}): SubscriptionPaymentHistoryDTO {
  return {
    id: "pay-1",
    planKey: "PRO",
    planName: "حرفه‌ای",
    provider: "zarinpal",
    amount: "2970000.00",
    currency: "IRR",
    status: "SUCCESS",
    createdAt: "2026-09-01T10:00:00.000Z",
    verifiedAt: "2026-09-01T10:05:00.000Z",
    ...overrides,
  };
}

describe("PaymentHistoryTable (render)", () => {
  it("renders rows with Persian-formatted money, Jalali date, gateway label and status badge", () => {
    const html = renderToStaticMarkup(
      <PaymentHistoryTable
        payments={[
          payment({ id: "pay-1" }),
          payment({
            id: "pay-2",
            status: "PENDING",
            planKey: null,
            planName: null,
            provider: "sandbox",
            amount: "990000.00",
            verifiedAt: null,
          }),
        ]}
      />,
    );

    expect(html).toContain("سوابق پرداخت اشتراک");
    expect(html).toContain("حرفه‌ای");
    // 2,970,000 IRR → Persian digits + ریال
    expect(html).toContain("۲,۹۷۰,۰۰۰ ریال");
    // 990,000 IRR on the second row
    expect(html).toContain("۹۹۰,۰۰۰ ریال");
    expect(html).toContain("درگاه زارین‌پال");
    expect(html).toContain("درگاه آزمایشی");
    expect(html).toContain("موفق");
    expect(html).toContain("در انتظار");
    expect(html).toContain("۲ تراکنش اخیر نمایش داده شده است");
    // A row whose subscription was deleted still renders a placeholder.
    expect(html).toContain("—");
  });

  it("never leaks raw provider identifiers", () => {
    const html = renderToStaticMarkup(
      <PaymentHistoryTable payments={[payment({ provider: "zarinpal" }), payment({ provider: "sandbox", id: "pay-2" })]} />,
    );
    // The literal adapter identifiers must not appear as-is in the UI.
    expect(html).not.toContain(">zarinpal<");
    expect(html).not.toContain(">sandbox<");
  });

  it("shows an empty state when there are no payments", () => {
    const html = renderToStaticMarkup(<PaymentHistoryTable payments={[]} />);
    expect(html).toContain("هنوز تراکنشی ثبت نشده است");
  });
});
