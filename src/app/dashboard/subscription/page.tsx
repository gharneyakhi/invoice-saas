import { redirect } from "next/navigation";
import {
  ForbiddenError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { getSubscriptionDisplay } from "@/server/subscription/subscriptionDisplayService";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircleIcon } from "@/components/icons";
import { CurrentSubscriptionCard } from "@/components/subscription/CurrentSubscriptionCard";
import { PlansGrid } from "@/components/subscription/PlansGrid";
import { PaymentHistoryTable } from "@/components/subscription/PaymentHistoryTable";

/**
 * Subscription Management — /dashboard/subscription
 *
 * Server component, mirroring the convention of the other dashboard pages
 * (`customers/page.tsx`): it authenticates with the session-scoped
 * `requireSession()` chain, loads everything through
 * `subscriptionDisplayService` (which in turn reuses the shared entitlement
 * selection + quota resolvers, so the numbers can never disagree with the
 * sidebar), and renders purely presentational components. The only
 * interactive piece is the `UpgradePlanButton` inside `PlansGrid`, which
 * talks to the existing `POST /api/subscriptions/payment/create` endpoint.
 *
 * States covered: loading (`loading.tsx`), error (`error.tsx` boundary +
 * inline query-failure notice), and the populated page.
 */
export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  let data;
  try {
    data = await getSubscriptionDisplay();
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    // Any non-auth failure renders an inline, non-leaking notice instead of
    // blowing up the dashboard shell (same posture as the customers page).
    console.error("[dashboard/subscription] failed to load subscription data", error);
    return (
      <div className="space-y-6">
        <PageHeader
          title="پلن و اشتراک"
          description="وضعیت اشتراک، پلن فعلی، سوابق پرداخت و ارتقا"
        />
        <Card>
          <CardContent className="p-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <AlertCircleIcon size={28} className="text-rose-500" />
              <h2 className="text-sm font-bold text-gray-900">مشکلی در بارگذاری اطلاعات اشتراک پیش آمد</h2>
              <p className="text-xs text-gray-500 leading-relaxed">
                لطفاً دوباره تلاش کنید. اگر مشکل ادامه داشت، با پشتیبانی تماس بگیرید.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="پلن و اشتراک"
        description="وضعیت اشتراک، پلن فعلی، سوابق پرداخت و ارتقا"
      />

      <CurrentSubscriptionCard
        current={data.current}
        effectivePlanKey={data.effectivePlanKey}
        quota={data.quota}
      />

      <PlansGrid plans={data.plans} />

      <PaymentHistoryTable payments={data.paymentHistory} />
    </div>
  );
}
