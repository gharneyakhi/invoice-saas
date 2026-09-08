import Link from "next/link";
import { redirect } from "next/navigation";
import { listBusinesses } from "@/server/business/businessService";
import {
  entitlementCanCreateBusiness,
  resolveEntitlements,
} from "@/server/entitlements/entitlementService";
import {
  ForbiddenError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { FILE_UPLOADS_ENABLED } from "@/server/storage/storageService";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BusinessSettingsForm } from "@/components/business/BusinessSettingsForm";
import {
  AlertCircleIcon,
  BusinessIcon,
  ChevronRightIcon,
  SubscriptionIcon,
} from "@/components/icons";
import { formatPersianNumber, formatPlanKey } from "@/lib/formatters";

/**
 * Business creation — the full creation form (name + profile fields), gated
 * server-side by the centralized entitlement limit before the form is even
 * rendered. The submit action re-checks the limit in `createBusiness`, so a
 * stale or raced page can never bypass it.
 */
export const dynamic = "force-dynamic";

export default async function NewBusinessPage() {
  let canCreate: boolean;
  let planKey: "FREE" | "BASIC" | "PRO";
  let businessLimit: number;
  let currentCount: number;

  try {
    const [businesses, entitlements] = await Promise.all([
      listBusinesses(),
      resolveEntitlements(),
    ]);
    planKey = entitlements.plan.planKey;
    businessLimit = entitlements.businessLimit;
    currentCount = businesses.length;
    canCreate = entitlementCanCreateBusiness(entitlements, {
      currentBusinessCount: currentCount,
      currentPeriodInvoiceCount: 0,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    throw error;
  }

  const backButton = (
    <Link href="/dashboard/businesses">
      <Button variant="outline" size="sm" className="gap-1.5">
        <ChevronRightIcon size={16} />
        <span>بازگشت به کسب‌وکارها</span>
      </Button>
    </Link>
  );

  if (!canCreate) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="افزودن کسب‌وکار"
          description="سقف کسب‌وکارهای پلن فعلی شما تکمیل شده است"
          actions={backButton}
        />
        <Card>
          <CardContent className="p-8">
            <EmptyState
              icon={<AlertCircleIcon size={28} />}
              title="امکان افزودن کسب‌وکار جدید نیست"
              description={`پلن ${formatPlanKey(planKey)} اجازه حداکثر ${formatPersianNumber(businessLimit)} کسب‌وکار فعال را می‌دهد و شما در حال حاضر ${formatPersianNumber(currentCount)} کسب‌وکار فعال دارید. برای بایگانی یک کسب‌وکار از فهرست کسب‌وکارها اقدام کنید یا پلن خود را ارتقا دهید.`}
              action={
                planKey !== "PRO" ? (
                  <Link href="/dashboard/subscription">
                    <Button size="sm" className="gap-1.5">
                      <SubscriptionIcon size={16} />
                      <span>مشاهده پلن‌ها</span>
                    </Button>
                  </Link>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="افزودن کسب‌وکار جدید"
        description="نام کسب‌وکار الزامی است؛ بقیه اطلاعات را می‌توانید بعداً از تنظیمات کامل کنید."
        badge={
          <span className="flex items-center gap-1 text-[11px] font-medium text-gray-400">
            <BusinessIcon size={14} />
            {formatPersianNumber(currentCount + 1)} از {formatPersianNumber(businessLimit)}
          </span>
        }
        actions={backButton}
      />

      <BusinessSettingsForm mode="create" imageUploadsEnabled={FILE_UPLOADS_ENABLED} />
    </div>
  );
}
