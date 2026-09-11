import * as React from "react";
import clsx from "clsx";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Progress } from "@/components/ui/progress";
import {
  formatPersianNumber,
  formatPersianDate,
  formatCurrency,
  formatSubscriptionStatus,
} from "@/lib/formatters";
import {
  SubscriptionIcon,
  ClockIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  SparklesIcon,
} from "@/components/icons";
import type {
  CurrentSubscriptionDTO,
  SubscriptionDisplayQuotaDTO,
} from "@/server/subscription/subscriptionDisplayService";

/**
 * Presentational "current subscription" card — renders exactly what
 * `subscriptionDisplayService` handed it; no entitlement decisions here.
 *
 * The status badge uses the *enforced* status (already date/plan-adjusted by
 * the shared selection rule), so what the user sees always matches what the
 * system actually enforces.
 */
export interface CurrentSubscriptionCardProps {
  current: CurrentSubscriptionDTO | null;
  effectivePlanKey: "FREE" | "BASIC" | "PRO";
  quota: SubscriptionDisplayQuotaDTO;
  className?: string;
}

/**
 * One-line explanation of why the account is being enforced as Free. Only
 * rendered when the resolver reports a non-NONE fallback reason.
 */
function fallbackNote(reason: string): string | null {
  switch (reason) {
    case "ENDED":
      return "اشتراک شما به پایان رسیده است؛ تا تمدید، محدودیت‌های پلن رایگان اعمال می‌شود.";
    case "NOT_STARTED":
      return "اشتراک شما هنوز شروع نشده است.";
    case "INCONSISTENT_WINDOW":
      return "تاریخ‌های اشتراک معتبر نیستند؛ لطفاً با پشتیبانی تماس بگیرید.";
    case "PLAN_INACTIVE":
      return "پلن این اشتراک دیگر فعال نیست؛ محدودیت‌های پلن رایگان اعمال می‌شود.";
    case "STATUS_PENDING":
      return "اشتراک در انتظار پرداخت است و هنوز فعال نشده است.";
    case "STATUS_EXPIRED":
      return "این اشتراک منقضی شده است؛ تا تمدید، محدودیت‌های پلن رایگان اعمال می‌شود.";
    case "STATUS_CANCELLED":
      return "این اشتراک لغو شده است؛ محدودیت‌های پلن رایگان اعمال می‌شود.";
    case "STATUS_PAYMENT_FAILED":
      return "پرداخت این اشتراک ناموفق بود؛ می‌توانید دوباره تلاش کنید.";
    case "NO_SUBSCRIPTION":
      return "اشتراکی برای این حساب ثبت نشده است.";
    default:
      return null;
  }
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold text-gray-900">{children}</span>
    </div>
  );
}

export function CurrentSubscriptionCard({
  current,
  effectivePlanKey,
  quota,
  className,
}: CurrentSubscriptionCardProps) {
  const status = current ? formatSubscriptionStatus(current.enforcedStatus) : null;

  const limit = Math.max(1, quota.invoiceLimit);
  const used = Math.max(0, quota.usedInvoices);
  const percentage = Math.min(100, Math.round((used / limit) * 100));
  const progressVariant =
    quota.warningLevel === "REACHED"
      ? "danger"
      : quota.warningLevel === "WARNING_80"
        ? "warning"
        : "success";

  const note = current && current.fallbackReason !== "NONE" ? fallbackNote(current.fallbackReason) : null;
  const showUpgradeCta = effectivePlanKey === "FREE";

  return (
    <Card className={className}>
      <CardHeader className="p-5 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <SubscriptionIcon size={18} />
            </div>
            <CardTitle className="text-sm font-bold text-gray-900">اشتراک فعلی</CardTitle>
          </div>
          {status && current && (
            <Badge variant={status.variant} showDot>
              {status.label}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-5 pt-1 space-y-4">
        {current ? (
          <>
            {/* Plan identity + price */}
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold text-gray-900">{current.planName}</span>
                  {!current.planActive && (
                    <Badge variant="secondary" className="text-[10px]">
                      پلن غیرفعال
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-gray-500">
                  {current.inForce ? "این اشتراک در حال حاضر فعال است." : "این اشتراک فعلاً دسترسی پرداخت‌شده‌ای نمی‌دهد."}
                </p>
              </div>
              <div className="text-left shrink-0">
                <div className="text-sm font-bold text-gray-900">
                  {formatCurrency(current.price, current.currency)}
                </div>
                <div className="text-[10px] text-gray-400">به ازای هر دوره</div>
              </div>
            </div>

            {/* Window + limits */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-gray-50/70 border border-gray-100 p-3">
              <InfoRow label="تاریخ شروع">
                <span className="inline-flex items-center gap-1.5">
                  <ClockIcon size={13} className="text-gray-400" />
                  {formatPersianDate(current.startDate)}
                </span>
              </InfoRow>
              <InfoRow label="تاریخ پایان">
                <span className="inline-flex items-center gap-1.5">
                  <ClockIcon size={13} className="text-gray-400" />
                  {current.endDate ? formatPersianDate(current.endDate) : "بدون پایان"}
                </span>
              </InfoRow>
              <InfoRow label="سقف فاکتور نهایی ماهانه">
                {formatPersianNumber(current.invoiceLimit)} فاکتور
              </InfoRow>
              <InfoRow label="سقف کسب‌وکار">
                {formatPersianNumber(current.businessLimit)} کسب‌وکار
              </InfoRow>
            </div>

            {/* Quota usage — same numbers as the sidebar by construction */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="text-gray-600">
                  {formatPersianNumber(used)} از {formatPersianNumber(quota.invoiceLimit)} فاکتور نهایی این ماه
                </span>
                <span className="text-gray-900 font-bold">%{formatPersianNumber(percentage)}</span>
              </div>
              <Progress value={percentage} variant={progressVariant} className="h-2.5" />
              <div className="flex items-center justify-between text-[11px] text-gray-500">
                <span>
                  باقی‌مانده این ماه:{" "}
                  <strong className="text-gray-800 font-semibold">
                    {formatPersianNumber(quota.remainingInvoices)} فاکتور
                  </strong>
                </span>
                {quota.periodEnd && <span>تا {formatPersianDate(quota.periodEnd)}</span>}
              </div>
            </div>

            {quota.warningLevel === "REACHED" && (
              <div className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50/80 p-3 text-xs text-rose-800">
                <AlertCircleIcon size={16} className="shrink-0 mt-0.5 text-rose-600" />
                <div className="flex-1 space-y-1">
                  <p className="font-semibold">سقف صدور فاکتور در این دوره تکمیل شده است.</p>
                  <p className="text-[11px] text-rose-700 leading-relaxed">
                    برای نهایی‌سازی فاکتورهای جدید یا افزایش ظرفیت، پلن خود را ارتقا دهید.
                  </p>
                </div>
              </div>
            )}

            {quota.warningLevel === "WARNING_80" && (
              <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-800">
                <AlertTriangleIcon size={16} className="shrink-0 mt-0.5 text-amber-600" />
                <div className="flex-1">
                  <p className="font-semibold">بیش از ۸۰٪ ظرفیت ماهانه مصرف شده است.</p>
                  <p className="text-[11px] text-amber-700 leading-relaxed mt-0.5">
                    تنها {formatPersianNumber(quota.remainingInvoices)} فاکتور تا پایان این دوره باقی مانده است.
                  </p>
                </div>
              </div>
            )}

            {note && (
              <div
                className={clsx(
                  "flex items-start gap-2.5 rounded-lg border p-3 text-xs",
                  "border-gray-200 bg-gray-50 text-gray-700",
                )}
              >
                <AlertCircleIcon size={16} className="shrink-0 mt-0.5 text-gray-400" />
                <p className="flex-1 leading-relaxed">{note}</p>
              </div>
            )}

            {/* Upgrade entry point for FREE / lapsed accounts */}
            {showUpgradeCta && (
              <div className="pt-2 border-t border-gray-100 flex items-center justify-between gap-3">
                <span className="text-[11px] text-gray-500">
                  نیاز به ظرفیت بیشتر دارید؟
                </span>
                <Link href="#plans">
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-blue-600 hover:text-blue-700 p-0 font-medium">
                    <span>انتخاب پلن و ارتقا</span>
                    <SparklesIcon size={14} className="mr-1" />
                  </Button>
                </Link>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-start gap-2.5 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
            <CheckCircleIcon size={16} className="shrink-0 mt-0.5 text-gray-400" />
            <p className="flex-1 leading-relaxed">
              هنوز اشتراکی برای این حساب ثبت نشده است. برای شروع، پلن موردنظر خود را از بخش زیر انتخاب کنید.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
