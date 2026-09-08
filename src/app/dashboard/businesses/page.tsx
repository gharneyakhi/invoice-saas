import Link from "next/link";
import { redirect } from "next/navigation";
import {
  listBusinesses,
  listBusinessProfiles,
  type BusinessRecord,
  type BusinessProfileRow,
} from "@/server/business/businessService";
import {
  entitlementCanCreateBusiness,
  resolveEntitlements,
} from "@/server/entitlements/entitlementService";
import {
  ForbiddenError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { SetPrimaryBusinessButton } from "@/components/business/SetPrimaryBusinessButton";
import { ArchiveBusinessButton } from "@/components/business/ArchiveBusinessButton";
import {
  AlertCircleIcon,
  BusinessIcon,
  PlusIcon,
  SettingsIcon,
  SubscriptionIcon,
} from "@/components/icons";
import { formatPersianDate, formatPersianNumber, formatPlanKey } from "@/lib/formatters";

/**
 * Business Management — list of the authenticated account's businesses.
 *
 * Server component: everything is loaded through the existing session-scoped
 * services (`listBusinesses`, `listBusinessProfiles`, `resolveEntitlements`);
 * there is no client-supplied account/plan input anywhere. The create CTA is
 * disabled with an honest explanation when the centralized business limit is
 * reached — the limit itself is only ever *displayed* here, never enforced in
 * the browser.
 */
export const dynamic = "force-dynamic";

function BusinessLogo({
  profile,
  name,
  logoUrl,
}: {
  profile: BusinessProfileRow | null;
  name: string;
  logoUrl: string | null;
}) {
  // A stored logo renders from its public URL when the storage layer resolves
  // one; a missing or unresolvable image degrades gracefully to a brand-color
  // monogram.
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={`لوگوی ${name}`}
        className="h-12 w-12 shrink-0 rounded-xl border border-gray-200 bg-white object-contain p-1"
      />
    );
  }
  const initial = name.trim().charAt(0) || "ک";
  const color = profile?.primaryColor || undefined;
  return (
    <div
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-lg font-bold text-white shadow-inner"
      style={{ backgroundColor: color || "#2563eb" }}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}

export default async function BusinessesPage() {
  let businesses: BusinessRecord[];
  let profileList: Awaited<ReturnType<typeof listBusinessProfiles>>;
  let planKey: "FREE" | "BASIC" | "PRO";
  let businessLimit: number;
  let canCreate: boolean;

  try {
    const [businessRecords, profiles, entitlements] = await Promise.all([
      listBusinesses(),
      listBusinessProfiles(),
      resolveEntitlements(),
    ]);
    businesses = businessRecords;
    profileList = profiles;
    planKey = entitlements.plan.planKey;
    businessLimit = entitlements.businessLimit;
    // The real centralized gate (same helper the service itself uses).
    canCreate = entitlementCanCreateBusiness(entitlements, {
      currentBusinessCount: businesses.length,
      currentPeriodInvoiceCount: 0,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    throw error;
  }

  const profilesByBusinessId = new Map(profileList.profiles.map((p) => [p.businessId, p]));

  const createButton = canCreate ? (
    <Link href="/dashboard/businesses/new">
      <Button size="md" className="gap-2 font-bold shadow-sm">
        <PlusIcon size={18} />
        <span>افزودن کسب‌وکار</span>
      </Button>
    </Link>
  ) : (
    <Button
      size="md"
      className="gap-2 font-bold shadow-sm"
      disabled
      title="سقف کسب‌وکارهای پلن فعلی تکمیل شده است"
    >
      <PlusIcon size={18} />
      <span>افزودن کسب‌وکار</span>
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="کسب‌وکارها"
        description="کسب‌وکارهای خود را مدیریت کنید؛ هر کسب‌وکار پروفایل، هویت بصری و تنظیمات فاکتور مستقل خود را دارد."
        actions={createButton}
      />

      {/* Entitlement / quota summary — display only; enforcement is server-side. */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <SubscriptionIcon size={18} />
              </div>
              <p className="text-xs font-medium text-gray-600">سهمیه کسب‌وکارها</p>
            </div>
            <Badge variant={planKey === "PRO" ? "default" : planKey === "BASIC" ? "info" : "secondary"} showDot>
              {formatPlanKey(planKey)}
            </Badge>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="text-gray-600">
                {formatPersianNumber(businesses.length)} از{" "}
                {formatPersianNumber(businessLimit)} کسب‌وکار فعال
              </span>
              <span className="font-bold text-gray-900">
                ٪
                {formatPersianNumber(
                  Math.min(100, Math.round((businesses.length / Math.max(1, businessLimit)) * 100)),
                )}
              </span>
            </div>
            <Progress
              value={Math.min(100, (businesses.length / Math.max(1, businessLimit)) * 100)}
              variant={canCreate ? "success" : "warning"}
              className="h-2.5"
            />
          </div>
          {canCreate ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              می‌توانید{" "}
              {formatPersianNumber(Math.max(0, businessLimit - businesses.length))} کسب‌وکار
              دیگر اضافه کنید.
            </p>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[11px] leading-relaxed text-amber-800">
                سقف کسب‌وکارهای پلن {formatPlanKey(planKey)} تکمیل شده است
                {planKey !== "PRO" ? "؛ پلن حرفه‌ای امکان مدیریت تا ۳ کسب‌وکار را می‌دهد." : "."}
              </p>
              {planKey !== "PRO" && (
                <Link href="/dashboard/subscription" className="shrink-0">
                  <Button variant="outline" size="sm">
                    مشاهده پلن‌ها
                  </Button>
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {businesses.length === 0 ? (
        <Card>
          <CardContent className="p-8">
            <EmptyState
              icon={<BusinessIcon size={28} />}
              title="هنوز کسب‌وکاری ندارید"
              description="نخستین کسب‌وکار خود را ایجاد کنید تا بتوانید برای آن مشتری، محصول و فاکتور ثبت کنید."
              action={
                <Link href="/dashboard/businesses/new">
                  <Button size="sm" className="gap-1.5">
                    <PlusIcon size={16} />
                    <span>ایجاد نخستین کسب‌وکار</span>
                  </Button>
                </Link>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {businesses.map((business) => {
            const profile = profilesByBusinessId.get(business.id) ?? null;
            const logoUrl = profile?.logoFileId
              ? profileList.filesById[profile.logoFileId]?.url ?? null
              : null;
            return (
              <Card key={business.id} className="flex flex-col hover:shadow-md">
                <CardContent className="flex flex-1 flex-col gap-4 p-5">
                  <div className="flex items-start gap-3">
                    <BusinessLogo profile={profile} name={business.name} logoUrl={logoUrl} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="truncate text-sm font-bold text-gray-900" title={business.name}>
                          {business.name}
                        </h3>
                        {business.isPrimary && (
                          <Badge variant="default" showDot>
                            پیش‌فرض
                          </Badge>
                        )}
                        {!business.isActive && <Badge variant="secondary">غیرفعال</Badge>}
                      </div>
                      {profile?.slogan ? (
                        <p className="mt-1 truncate text-xs text-gray-500" title={profile.slogan}>
                          {profile.slogan}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-gray-400">بدون شعار</p>
                      )}
                    </div>
                    {profile?.primaryColor && (
                      <span
                        className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-gray-200"
                        style={{ backgroundColor: profile.primaryColor }}
                        title={`رنگ برند: ${profile.primaryColor}`}
                      />
                    )}
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-gray-400">
                    <span>ایجاد: {formatPersianDate(business.createdAt)}</span>
                    {profile?.email && (
                      <span className="truncate" dir="ltr" title={profile.email}>
                        {profile.email}
                      </span>
                    )}
                  </div>

                  <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                    <Link
                      href={`/dashboard/businesses/${business.id}`}
                      className="shrink-0"
                      aria-label={`تنظیمات ${business.name}`}
                    >
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <SettingsIcon size={14} />
                        <span>تنظیمات</span>
                      </Button>
                    </Link>
                    <SetPrimaryBusinessButton
                      businessId={business.id}
                      businessName={business.name}
                      isPrimary={business.isPrimary}
                    />
                    <ArchiveBusinessButton
                      businessId={business.id}
                      businessName={business.name}
                      isPrimary={business.isPrimary}
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {businesses.length > 0 && (
        <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <AlertCircleIcon size={14} className="shrink-0" />
          بایگانی کسب‌وکارها نرم است؛ فاکتورها و داده‌های تاریخی همیشه حفظ می‌شوند.
        </p>
      )}
    </div>
  );
}
