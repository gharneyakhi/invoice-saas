"use client";

import * as React from "react";
import Link from "next/link";
import clsx from "clsx";
import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import { UserMenu } from "@/components/shell/UserMenu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPlanKey } from "@/lib/formatters";
import {
  MenuIcon,
  PlusIcon,
  LogoIcon,
} from "@/components/icons";
import type {
  DashboardAccountDTO,
  DashboardPlanDTO,
  BusinessDTO,
} from "@/server/dashboard/dashboardService";

export interface HeaderProps {
  account: DashboardAccountDTO;
  currentBusiness: BusinessDTO | null;
  businesses: BusinessDTO[];
  plan: DashboardPlanDTO;
  onOpenMobileMenu: () => void;
  className?: string;
}

export function Header({
  account,
  currentBusiness,
  businesses,
  plan,
  onOpenMobileMenu,
  className,
}: HeaderProps) {
  const planVariant =
    plan.planKey === "PRO"
      ? "default"
      : plan.planKey === "BASIC"
        ? "info"
        : "secondary";

  return (
    <header
      className={clsx(
        "sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-gray-200 bg-white/95 px-4 sm:px-6 backdrop-blur-sm",
        className,
      )}
    >
      {/* Right Side (Start in RTL): Mobile Hamburger & Business Switcher */}
      <div className="flex items-center gap-2 sm:gap-4">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="باز کردن منو"
          className="lg:hidden p-2 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition"
        >
          <MenuIcon size={22} />
        </button>

        {/* Mobile Brand Snippet */}
        <div className="lg:hidden flex items-center gap-1.5 pl-2 border-l border-gray-100">
          <LogoIcon size={24} />
        </div>

        {/* Business Switcher */}
        <BusinessSwitcher
          currentBusiness={currentBusiness}
          businesses={businesses}
        />
      </div>

      {/* Left Side (End in RTL): Plan Badge, Create Invoice Shortcut & User Menu */}
      <div className="flex items-center gap-2.5 sm:gap-4">
        <div className="hidden sm:block">
          <Badge variant={planVariant} showDot>
            {formatPlanKey(plan.planKey)}
          </Badge>
        </div>

        <Link href="/dashboard/invoices/new" className="hidden sm:inline-flex">
          <Button size="sm" className="gap-1.5 text-xs font-semibold shadow-xs">
            <PlusIcon size={16} />
            <span>فاکتور جدید</span>
          </Button>
        </Link>

        <UserMenu account={account} plan={plan} />
      </div>
    </header>
  );
}
