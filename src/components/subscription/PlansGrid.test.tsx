import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlansGrid } from "./PlansGrid";
import type { SubscriptionPlanOfferDTO } from "@/server/subscription/subscriptionDisplayService";

function plan(overrides: Partial<SubscriptionPlanOfferDTO> = {}): SubscriptionPlanOfferDTO {
  return {
    key: "BASIC",
    name: "پایه",
    description: "برای کسب‌وکارهای کوچک",
    price: "990000.00",
    currency: "IRR",
    billingInterval: "MONTHLY",
    businessLimit: 1,
    invoiceLimit: 10,
    features: [
      { key: "PRINT", name: "چاپ", description: "چاپ فاکتور" },
      { key: "EXCEL_EXPORT", name: "خروجی اکسل", description: "خروجی اکسل فاکتورها" },
    ],
    isCurrent: false,
    purchasable: true,
    notPurchasableReason: null,
    ...overrides,
  };
}

const freePlan = plan({
  key: "FREE",
  name: "رایگان",
  description: "برای شروع و آزمایش سامانه",
  price: "0.00",
  invoiceLimit: 3,
  purchasable: false,
  notPurchasableReason: "FREE_PLAN",
});

const proPlan = plan({
  key: "PRO",
  name: "حرفه‌ای",
  description: "برای کسب‌وکارهای چندشعبه‌ای",
  price: "2970000.00",
  businessLimit: 3,
  invoiceLimit: 50,
});

describe("PlansGrid (render)", () => {
  it("offers a purchase button only for purchasable plans, and marks the current plan", () => {
    const html = renderToStaticMarkup(
      <PlansGrid
        plans={[
          freePlan,
          plan({ isCurrent: true, purchasable: false, notPurchasableReason: "ACTIVE_PAID_SUBSCRIPTION" }),
          proPlan,
        ]}
      />,
    );

    expect(html).toContain("پلن‌ها");
    expect(html).toContain("پلن فعلی"); // badge on the current card
    expect(html).toContain("پلن فعلی شماست"); // disabled current-plan CTA
    // Exactly one real buy entry point (PRO), addressed by its planKey contract:
    expect(html).toContain("انتخاب و پرداخت — پلن حرفه‌ای");
    // The free baseline explains itself instead of offering a purchase.
    expect(html).toContain("به‌صورت خودکار برای همه حساب‌ها فعال است");
  });

  it("shows the blocking explanation when a paid subscription is already in force", () => {
    const html = renderToStaticMarkup(
      <PlansGrid
        plans={[
          freePlan,
          plan({ isCurrent: true, purchasable: false, notPurchasableReason: "ACTIVE_PAID_SUBSCRIPTION" }),
          plan({ ...proPlan, purchasable: false, notPurchasableReason: "ACTIVE_PAID_SUBSCRIPTION" }),
        ]}
      />,
    );

    expect(html).toContain("خرید ممکن نیست");
    expect(html).toContain("شما از قبل یک اشتراک فعال دارید");
    expect(html).not.toContain("انتخاب و پرداخت");
  });

  it("shows an empty notice when no plans are available", () => {
    const html = renderToStaticMarkup(<PlansGrid plans={[]} />);
    expect(html).toContain("پلنی در دسترس نیست");
  });

  it("renders limits and features in Persian digits", () => {
    const html = renderToStaticMarkup(<PlansGrid plans={[proPlan]} />);
    expect(html).toContain("۵۰ فاکتور ماهانه");
    expect(html).toContain("۳ کسب‌وکار");
    expect(html).toContain("خروجی اکسل");
  });
});
