"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import clsx from "clsx";
import { Badge } from "@/components/ui/badge";
import { formatPlanKey, formatPersianNumber } from "@/lib/formatters";
import {
  LogoIcon,
  DashboardIcon,
  InvoicesIcon,
  CustomersIcon,
  ProductsIcon,
  BusinessIcon,
  SubscriptionIcon,
  SettingsIcon,
  SignOutIcon,
  SparklesIcon,
} from "@/components/icons";
import type { DashboardAccountDTO, DashboardPlanDTO } from "@/server/dashboard/dashboardService";

export interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "داشبورد",
    href: "/dashboard",
    icon: <DashboardIcon size={18} />,
  },
  {
    label: "فاکتورها",
    href: "/dashboard/invoices",
    icon: <InvoicesIcon size={18} />,
  },
  {
    label: "مشتریان",
    href: "/dashboard/customers",
    icon: <CustomersIcon size={18} />,
  },
  {
    label: "محصولات و خدمات",
    href: "/dashboard/products",
    icon: <ProductsIcon size={18} />,
  },
  {
    label: "کسب‌وکارها",
    href: "/dashboard/businesses",
    icon: <BusinessIcon size={18} />,
  },
  {
    label: "پلن و اشتراک",
    href: "/dashboard/subscription",
    icon: <SubscriptionIcon size={18} />,
  },
  {
    label: "تنظیمات",
    href: "/dashboard/settings",
    icon: <SettingsIcon size={18} />,
  },
];

export interface SidebarProps {
  account: DashboardAccountDTO;
  plan: DashboardPlanDTO;
  className?: string;
  onLinkClick?: () => void;
}

export function Sidebar({ account, plan, className, onLinkClick }: SidebarProps) {
  const pathname = usePathname();

  function isItemActive(href: string): boolean {
    if (href === "/dashboard") {
      return pathname === "/dashboard";
    }
    return pathname?.startsWith(href) ?? false;
  }

  const initial = account.userName ? account.userName.charAt(0).toUpperCase() : "ک";

  return (
    <aside
      className={clsx(
        "flex flex-col h-full w-64 bg-white border-l border-gray-200 select-none",
        className,
      )}
    >
      {/* Brand / Logo Area */}
      <div className="flex items-center gap-3 px-6 h-16 border-b border-gray-100 shrink-0">
        <LogoIcon size={30} />
        <div className="flex flex-col">
          <span className="text-sm font-bold text-gray-900 tracking-tight">
            سامانه فاکتور
          </span>
          <span className="text-[10px] text-gray-400 font-medium">
            مدیریت هوشمند مالی
          </span>
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="منوی اصلی">
        {NAV_ITEMS.map((item) => {
          const active = isItemActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onLinkClick}
              className={clsx(
                "flex items-center gap-3 px-3 py-2.5 text-xs font-medium rounded-lg transition-colors group",
                active
                  ? "bg-blue-50 text-blue-700 font-semibold shadow-xs"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
              )}
            >
              <span
                className={clsx(
                  "shrink-0 transition-colors",
                  active ? "text-blue-600" : "text-gray-400 group-hover:text-gray-600",
                )}
              >
                {item.icon}
              </span>
              <span className="truncate">{item.label}</span>
              {active && (
                <span className="mr-auto w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Plan / Quota Promo Snippet */}
      <div className="p-3 m-3 rounded-xl bg-gradient-to-br from-gray-50 to-blue-50/40 border border-gray-200/80 space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-gray-800">
            {formatPlanKey(plan.planKey)}
          </span>
          <Badge variant="default" className="text-[10px] px-1.5 py-0">
            فعال
          </Badge>
        </div>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          {formatPersianNumber(plan.currentMonthlyFinalizedInvoiceCount)} از{" "}
          {formatPersianNumber(plan.monthlyInvoiceLimit)} فاکتور این ماه مصرف شده است.
        </p>
        <Link
          href="/dashboard/subscription"
          onClick={onLinkClick}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 transition pt-1"
        >
          <SparklesIcon size={13} />
          <span>ارتقای پلن و امکانات</span>
        </Link>
      </div>

      {/* User Info & SignOut Footer */}
      <div className="p-3 border-t border-gray-100 flex items-center justify-between gap-2 shrink-0 bg-gray-50/50">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-bold shadow-sm">
            {initial}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-gray-900 truncate">
              {account.userName || "کاربر"}
            </span>
            <span className="text-[10px] text-gray-400 truncate">
              {account.userEmail}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          title="خروج از حساب"
          aria-label="خروج از حساب"
          className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition shrink-0"
        >
          <SignOutIcon size={16} />
        </button>
      </div>
    </aside>
  );
}
