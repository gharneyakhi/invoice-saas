"use client";

import * as React from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import clsx from "clsx";
import { Badge } from "@/components/ui/badge";
import { formatPlanKey } from "@/lib/formatters";
import {
  UserIcon,
  ChevronDownIcon,
  SettingsIcon,
  SubscriptionIcon,
  SignOutIcon,
} from "@/components/icons";
import type { DashboardAccountDTO, DashboardPlanDTO } from "@/server/dashboard/dashboardService";

export interface UserMenuProps {
  account: DashboardAccountDTO;
  plan: DashboardPlanDTO;
  className?: string;
}

export function UserMenu({ account, plan, className }: UserMenuProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const initial = account.userName ? account.userName.charAt(0).toUpperCase() : "ک";

  return (
    <div ref={containerRef} className={clsx("relative", className)}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label="منوی کاربر"
        className={clsx(
          "flex items-center gap-2 p-1 sm:px-2.5 sm:py-1.5 rounded-lg border border-transparent hover:border-gray-200 hover:bg-gray-50 transition focus:outline-none focus:ring-2 focus:ring-blue-600",
          isOpen && "bg-gray-50 border-gray-200 ring-2 ring-blue-600",
        )}
      >
        <div className="flex h-7 w-7 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white text-xs sm:text-sm font-bold shadow-sm">
          {initial}
        </div>
        <div className="hidden sm:flex flex-col text-right">
          <span className="text-xs font-semibold text-gray-900 truncate max-w-[120px]">
            {account.userName || "کاربر"}
          </span>
          <span className="text-[10px] text-gray-500 truncate max-w-[120px]">
            {account.accountName || "حساب من"}
          </span>
        </div>
        <ChevronDownIcon
          size={14}
          className={clsx(
            "text-gray-400 transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute left-0 z-50 mt-1.5 w-64 rounded-xl border border-gray-200 bg-white p-2 shadow-lg animate-in fade-in-0 zoom-in-95 duration-100"
        >
          {/* User & Account summary */}
          <div className="px-3 py-2.5 border-b border-gray-100 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-gray-900 truncate">
                {account.userName}
              </span>
              <Badge variant="default" className="text-[10px] px-1.5 py-0">
                {formatPlanKey(plan.planKey)}
              </Badge>
            </div>
            <p className="text-[11px] text-gray-500 truncate">{account.userEmail}</p>
          </div>

          {/* Links */}
          <div className="py-1 space-y-0.5">
            <Link
              href="/dashboard/subscription"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-lg transition"
            >
              <SubscriptionIcon size={16} className="text-gray-500" />
              <span>پلن و اشتراک</span>
            </Link>

            <Link
              href="/dashboard/settings"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-lg transition"
            >
              <SettingsIcon size={16} className="text-gray-500" />
              <span>تنظیمات حساب</span>
            </Link>
          </div>

          {/* SignOut */}
          <div className="pt-1 mt-1 border-t border-gray-100">
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-rose-600 hover:bg-rose-50 rounded-lg transition font-medium text-right"
            >
              <SignOutIcon size={16} className="text-rose-600" />
              <span>خروج از حساب</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
