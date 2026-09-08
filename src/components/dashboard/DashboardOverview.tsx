import * as React from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/dashboard/StatCard";
import { UsageCard } from "@/components/dashboard/UsageCard";
import { RecentInvoicesTable } from "@/components/dashboard/RecentInvoicesTable";
import {
  formatCurrency,
  formatPersianNumber,
  formatPlanKey,
} from "@/lib/formatters";
import {
  PlusIcon,
  ClockIcon,
  CreditCardIcon,
  SubscriptionIcon,
  FileTextIcon,
  BuildingIcon,
} from "@/components/icons";
import type { DashboardData } from "@/server/dashboard/dashboardService";

export interface DashboardOverviewProps {
  data: DashboardData;
}

export function DashboardOverview({ data }: DashboardOverviewProps) {
  const { currentBusiness, plan, totals, recentInvoices } = data;

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Welcome & Primary Header */}
      <PageHeader
        title="داشبورد"
        description={
          currentBusiness
            ? `مدیریت فاکتورها و وضعیت مالی کسب‌وکار «${currentBusiness.name}»`
            : "مدیریت فاکتورها و وضعیت مالی کسب‌وکار شما"
        }
        badge={
          currentBusiness ? (
            <Badge variant="outline" className="gap-1 hidden sm:inline-flex text-gray-600 bg-white">
              <BuildingIcon size={12} className="text-gray-400" />
              <span>{currentBusiness.name}</span>
            </Badge>
          ) : undefined
        }
        actions={
          <Link href="/dashboard/invoices/new">
            <Button size="md" className="gap-2 font-bold shadow-sm sm:h-10 sm:px-5">
              <PlusIcon size={18} />
              <span>ایجاد فاکتور جدید</span>
            </Button>
          </Link>
        }
      />

      {/* Overview Statistics Grid */}
      <section aria-label="آمار و وضعیت کلی">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
          {/* Stat 1: Pending Amount */}
          <StatCard
            title="مبلغ در انتظار پرداخت"
            value={formatCurrency(totals.pendingAmount, totals.currency)}
            subtitle="فاکتورهای نهایی منتظر تسویه"
            icon={<ClockIcon size={20} />}
            iconBgColor="bg-amber-50"
            iconTextColor="text-amber-600"
          />

          {/* Stat 2: Paid Amount */}
          <StatCard
            title="مبلغ پرداخت‌شده"
            value={formatCurrency(totals.paidAmount, totals.currency)}
            subtitle="مجموع وصولی‌های قطعی"
            icon={<CreditCardIcon size={20} />}
            iconBgColor="bg-emerald-50"
            iconTextColor="text-emerald-600"
          />

          {/* Stat 3: Monthly Usage */}
          <StatCard
            title="مصرف فاکتور ماهانه"
            value={`${formatPersianNumber(plan.currentMonthlyFinalizedInvoiceCount)} از ${formatPersianNumber(plan.monthlyInvoiceLimit)}`}
            subtitle={`${formatPersianNumber(plan.remainingInvoiceQuota)} فاکتور باقی‌مانده`}
            icon={<SubscriptionIcon size={20} />}
            iconBgColor="bg-blue-50"
            iconTextColor="text-blue-600"
            badge={
              <Badge variant={plan.warningLevel === "REACHED" ? "danger" : plan.warningLevel === "WARNING_80" ? "warning" : "success"}>
                {plan.warningLevel === "REACHED" ? "تکمیل" : plan.warningLevel === "WARNING_80" ? "نزدیک سقف" : "عادی"}
              </Badge>
            }
          />

          {/* Stat 4: Recent Invoices Count */}
          <StatCard
            title="تعداد فاکتورهای اخیر"
            value={`${formatPersianNumber(recentInvoices.length)} فاکتور`}
            subtitle={currentBusiness ? `کسب‌وکار ${currentBusiness.name}` : "بدون کسب‌وکار"}
            icon={<FileTextIcon size={20} />}
            iconBgColor="bg-violet-50"
            iconTextColor="text-violet-600"
          />
        </div>
      </section>

      {/* Main Grid: Recent Invoices (Left/Wide) + Usage & Quota Card (Right/Sidebar) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Recent Invoices Table (7 cols on lg) */}
        <div className="lg:col-span-8 order-2 lg:order-1">
          <RecentInvoicesTable
            invoices={recentInvoices}
            hasBusiness={Boolean(currentBusiness)}
            fallbackCurrency={totals.currency}
          />
        </div>

        {/* Plan / Quota Detail Card (5 cols on lg) */}
        <div className="lg:col-span-4 order-1 lg:order-2 space-y-4">
          <UsageCard plan={plan} />
        </div>
      </div>
    </div>
  );
}
