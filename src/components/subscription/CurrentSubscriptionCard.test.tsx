import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrentSubscriptionCard } from "./CurrentSubscriptionCard";

// next/link needs the Next router context, which the node test environment
// does not provide — render a plain anchor instead (same mock style the
// invoice tests use for next/navigation).
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
import type {
  CurrentSubscriptionDTO,
  SubscriptionDisplayQuotaDTO,
} from "@/server/subscription/subscriptionDisplayService";

function current(overrides: Partial<CurrentSubscriptionDTO> = {}): CurrentSubscriptionDTO {
  return {
    id: "sub-1",
    planKey: "BASIC",
    planName: "پایه",
    planActive: true,
    storedStatus: "ACTIVE",
    enforcedStatus: "ACTIVE",
    inForce: true,
    fallbackReason: "NONE",
    startDate: "2026-09-01T00:00:00.000Z",
    endDate: "2026-10-01T00:00:00.000Z",
    price: "990000.00",
    currency: "IRR",
    businessLimit: 1,
    invoiceLimit: 10,
    features: [{ key: "PRINT", name: "چاپ", description: "چاپ فاکتور" }],
    ...overrides,
  };
}

const quota: SubscriptionDisplayQuotaDTO = {
  usedInvoices: 4,
  invoiceLimit: 10,
  remainingInvoices: 6,
  warningLevel: "OK",
  periodEnd: "2026-09-30T23:59:59.999Z",
};

describe("CurrentSubscriptionCard (render)", () => {
  it("shows the enforced status badge, plan name, window dates and price for an in-force paid subscription", () => {
    const html = renderToStaticMarkup(
      <CurrentSubscriptionCard current={current()} effectivePlanKey="BASIC" quota={quota} />,
    );

    expect(html).toContain("اشتراک فعلی");
    expect(html).toContain("فعال");
    expect(html).toContain("پایه");
    expect(html).toContain("تاریخ شروع");
    expect(html).toContain("تاریخ پایان");
    // IRR money → Persian digits + ریال (990,000 IRR = 990000.00 ریل)
    expect(html).toContain("۹۹۰,۰۰۰ ریال");
    // The in-force card must NOT offer an upgrade link or a lapse note.
    expect(html).not.toContain("انتخاب پلن و ارتقا");
  });

  it("labels a date-lapsed row from the ENFORCED status and explains the Free fallback", () => {
    const html = renderToStaticMarkup(
      <CurrentSubscriptionCard
        current={current({
          planKey: "PRO",
          planName: "حرفه‌ای",
          price: "2970000.00",
          storedStatus: "ACTIVE",
          enforcedStatus: "EXPIRED",
          inForce: false,
          fallbackReason: "ENDED",
        })}
        effectivePlanKey="FREE"
        quota={quota}
      />,
    );

    expect(html).toContain("منقضی‌شده");
    expect(html).toContain("اشتراک شما به پایان رسیده است");
    // Effective plan is FREE → the upgrade entry point is offered.
    expect(html).toContain("انتخاب پلن و ارتقا");
  });

  it("shows «بدون پایان» for an open-ended subscription", () => {
    const html = renderToStaticMarkup(
      <CurrentSubscriptionCard
        current={current({ planKey: "FREE", planName: "رایگان", price: "0.00", endDate: null })}
        effectivePlanKey="FREE"
        quota={quota}
      />,
    );

    expect(html).toContain("بدون پایان");
  });

  it("marks a deactivated plan as inactive", () => {
    const html = renderToStaticMarkup(
      <CurrentSubscriptionCard
        current={current({ planActive: false, enforcedStatus: "EXPIRED", inForce: false, fallbackReason: "PLAN_INACTIVE" })}
        effectivePlanKey="FREE"
        quota={quota}
      />,
    );

    expect(html).toContain("پلن غیرفعال");
  });

  it("renders a neutral notice when the account has no subscription rows", () => {
    const html = renderToStaticMarkup(
      <CurrentSubscriptionCard current={null} effectivePlanKey="FREE" quota={quota} />,
    );

    expect(html).toContain("هنوز اشتراکی برای این حساب ثبت نشده است");
  });

  it("surfaces the quota-exhausted warning when the resolver reports REACHED", () => {
    const html = renderToStaticMarkup(
      <CurrentSubscriptionCard
        current={current()}
        effectivePlanKey="BASIC"
        quota={{ ...quota, usedInvoices: 10, remainingInvoices: 0, warningLevel: "REACHED" }}
      />,
    );

    expect(html).toContain("سقف صدور فاکتور در این دوره تکمیل شده است");
  });
});
