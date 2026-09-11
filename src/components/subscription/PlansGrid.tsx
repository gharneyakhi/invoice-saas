import * as React from "react";
import clsx from "clsx";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckIcon, SparklesIcon } from "@/components/icons";
import { formatPersianNumber, formatCurrency } from "@/lib/formatters";
import type { SubscriptionPlanOfferDTO } from "@/server/subscription/subscriptionDisplayService";
import { UpgradePlanButton } from "./UpgradePlanButton";

/**
 * Presentational plan grid — the upgrade entry points of the page.
 *
 * Every decision (is this the current plan? may this account buy it, and why
 * not?) is pre-computed by `subscriptionDisplayService`; this component only
 * renders: a `purchasable` card gets an `UpgradePlanButton`, everything else
 * gets an explanatory disabled state. The only client input that can leave
 * the browser from this grid is a `planKey`.
 */
export interface PlansGridProps {
  plans: SubscriptionPlanOfferDTO[];
  className?: string;
}

function PlanCard({ plan }: { plan: SubscriptionPlanOfferDTO }) {
  const highlighted = plan.isCurrent;

  return (
    <Card
      className={clsx(
        "flex flex-col",
        highlighted ? "border-blue-300 ring-1 ring-blue-200" : "border-gray-200",
      )}
    >
      <div className="flex-1 p-5 space-y-4">
        {/* Plan name + price */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold text-gray-900">{plan.name}</span>
            {highlighted && (
              <Badge variant="default" showDot className="text-[10px]">
                پلن فعلی
              </Badge>
            )}
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-lg font-bold text-gray-900">
              {formatCurrency(plan.price, plan.currency)}
            </span>
            <span className="text-[11px] text-gray-400">/ ماه</span>
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed min-h-8">{plan.description}</p>
        </div>

        {/* Limits */}
        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex items-center rounded-md bg-gray-50 border border-gray-100 px-2 py-1 text-[11px] font-medium text-gray-700">
            {formatPersianNumber(plan.invoiceLimit)} فاکتور ماهانه
          </span>
          <span className="inline-flex items-center rounded-md bg-gray-50 border border-gray-100 px-2 py-1 text-[11px] font-medium text-gray-700">
            {formatPersianNumber(plan.businessLimit)} کسب‌وکار
          </span>
        </div>

        {/* Features */}
        <ul className="space-y-1.5 border-t border-gray-100 pt-3">
          {plan.features.map((feature) => (
            <li key={feature.key} className="flex items-start gap-2 text-[11px] text-gray-700">
              <CheckIcon size={13} className="shrink-0 mt-0.5 text-emerald-600" />
              <span>{feature.name}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* CTA — the upgrade entry point */}
      <div className="p-5 pt-0">
        {plan.isCurrent ? (
          <Button variant="outline" className="w-full" disabled>
            پلن فعلی شماست
          </Button>
        ) : plan.purchasable ? (
          <UpgradePlanButton planKey={plan.key} planName={plan.name} />
        ) : plan.key === "FREE" ? (
          <div className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-center">
            <p className="text-[11px] font-medium text-gray-600">پلن رایگان</p>
            <p className="text-[10px] text-gray-400 mt-0.5">به‌صورت خودکار برای همه حساب‌ها فعال است</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Button variant="outline" className="w-full" disabled>
              خرید ممکن نیست
            </Button>
            {plan.notPurchasableReason === "ACTIVE_PAID_SUBSCRIPTION" && (
              <p className="text-center text-[10px] text-gray-400 leading-relaxed">
                شما از قبل یک اشتراک فعال دارید؛ پس از پایان آن می‌توانید پلن دیگر انتخاب کنید.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function PlansGrid({ plans, className }: PlansGridProps) {
  if (plans.length === 0) {
    return (
      <Card className={className}>
        <div className="p-5 text-center text-xs text-gray-500">
          <SparklesIcon size={18} className="mx-auto mb-2 text-gray-300" />
          پلنی در دسترس نیست. لطفاً کمی بعد دوباره تلاش کنید.
        </div>
      </Card>
    );
  }

  return (
    <section id="plans" className={clsx("scroll-mt-20", className)}>
      <div className="mb-4 space-y-1">
        <h2 className="text-base font-bold text-gray-900">پلن‌ها</h2>
        <p className="text-xs text-gray-500">
          پلن موردنظر را انتخاب کنید؛ پرداخت از طریق درگاه امن انجام می‌شود.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
        {plans.map((plan) => (
          <PlanCard key={plan.key} plan={plan} />
        ))}
      </div>
    </section>
  );
}
