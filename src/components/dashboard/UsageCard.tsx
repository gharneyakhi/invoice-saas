import * as React from "react";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatPersianNumber,
  formatPersianDate,
  formatPlanKey,
} from "@/lib/formatters";
import {
  SubscriptionIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  SparklesIcon,
  ChevronLeftIcon,
} from "@/components/icons";
import type { DashboardPlanDTO } from "@/server/dashboard/dashboardService";

export interface UsageCardProps {
  plan: DashboardPlanDTO;
  className?: string;
}

export function UsageCard({ plan, className }: UsageCardProps) {
  const limit = Math.max(1, plan.monthlyInvoiceLimit);
  const used = Math.max(0, plan.currentMonthlyFinalizedInvoiceCount);
  const percentage = Math.min(100, Math.round((used / limit) * 100));

  const progressVariant: "success" | "warning" | "danger" =
    plan.warningLevel === "REACHED"
      ? "danger"
      : plan.warningLevel === "WARNING_80"
        ? "warning"
        : "success";

  const planBadgeVariant =
    plan.planKey === "PRO"
      ? "default"
      : plan.planKey === "BASIC"
        ? "info"
        : "secondary";

  return (
    <Card className={className}>
      <CardHeader className="p-5 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <SubscriptionIcon size={18} />
            </div>
            <CardTitle className="text-sm font-bold text-gray-900">
              وضعیت مصرف و پلن
            </CardTitle>
          </div>
          <Badge variant={planBadgeVariant} showDot>
            {formatPlanKey(plan.planKey)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="p-5 pt-1 space-y-4">
        {/* Progress and Numbers */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium">
            <span className="text-gray-600">
              {formatPersianNumber(used)} از {formatPersianNumber(limit)} فاکتور نهایی
            </span>
            <span className="text-gray-900 font-bold">
              %{formatPersianNumber(percentage)}
            </span>
          </div>

          <Progress value={percentage} variant={progressVariant} className="h-2.5" />

          <div className="flex items-center justify-between text-[11px] text-gray-500">
            <span>
              باقی‌مانده این ماه:{" "}
              <strong className="text-gray-800 font-semibold">
                {formatPersianNumber(plan.remainingInvoiceQuota)} فاکتور
              </strong>
            </span>
            {plan.periodEnd && (
              <span>تا {formatPersianDate(plan.periodEnd)}</span>
            )}
          </div>
        </div>

        {/* Warning Banners */}
        {plan.warningLevel === "REACHED" && (
          <div className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50/80 p-3 text-xs text-rose-800">
            <AlertCircleIcon size={16} className="shrink-0 mt-0.5 text-rose-600" />
            <div className="flex-1 space-y-1">
              <p className="font-semibold">سقف صدور فاکتور در این دوره تکمیل شده است.</p>
              <p className="text-[11px] text-rose-700 leading-relaxed">
                برای نهایی‌سازی فاکتورهای جدید یا افزایش ظرفیت، پلن حساب خود را ارتقا دهید.
              </p>
            </div>
          </div>
        )}

        {plan.warningLevel === "WARNING_80" && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-800">
            <AlertTriangleIcon size={16} className="shrink-0 mt-0.5 text-amber-600" />
            <div className="flex-1">
              <p className="font-semibold">بیش از ۸۰٪ ظرفیت ماهانه مصرف شده است.</p>
              <p className="text-[11px] text-amber-700 leading-relaxed mt-0.5">
                تنها {formatPersianNumber(plan.remainingInvoiceQuota)} فاکتور تا پایان این دوره باقی مانده است.
              </p>
            </div>
          </div>
        )}

        {/* Action Link */}
        <div className="pt-2 border-t border-gray-100 flex items-center justify-between">
          <span className="text-[11px] text-gray-500">نیاز به ظرفیت بیشتر دارید؟</span>
          <Link href="/dashboard/subscription">
            <Button variant="ghost" size="sm" className="h-7 text-xs text-blue-600 hover:text-blue-700 p-0 font-medium">
              <span>ارتقای اشتراک</span>
              <ChevronLeftIcon size={14} className="mr-1" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
