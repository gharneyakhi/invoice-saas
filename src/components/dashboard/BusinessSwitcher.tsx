"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { setPrimaryBusiness } from "@/server/actions/businessActions";
import {
  BusinessIcon,
  ChevronDownIcon,
  CheckIcon,
  PlusIcon,
  SettingsIcon,
} from "@/components/icons";
import type { BusinessDTO } from "@/server/dashboard/dashboardService";

export interface BusinessSwitcherProps {
  currentBusiness: BusinessDTO | null;
  businesses: BusinessDTO[];
  className?: string;
}

export function BusinessSwitcher({
  currentBusiness,
  businesses,
  className,
}: BusinessSwitcherProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = React.useState(false);
  const [isPending, setIsPending] = React.useState(false);
  const [activeBizId, setActiveBizId] = React.useState<string | null>(
    currentBusiness?.id ?? null,
  );
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (currentBusiness?.id) {
      setActiveBizId(currentBusiness.id);
    }
  }, [currentBusiness?.id]);

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

  async function handleSelectBusiness(businessId: string) {
    if (businessId === activeBizId || isPending) {
      setIsOpen(false);
      return;
    }
    setIsPending(true);
    setErrorMsg(null);

    try {
      const res = await setPrimaryBusiness(businessId);
      if (res.success) {
        setActiveBizId(businessId);
        setIsOpen(false);
        router.refresh();
      } else {
        setErrorMsg(res.error.message || "خطا در تغییر کسب‌وکار");
      }
    } catch {
      setErrorMsg("خطای غیرمنتظره رخ داد. دوباره تلاش کنید.");
    } finally {
      setIsPending(false);
    }
  }

  const displayName = currentBusiness?.name || "انتخاب کسب‌وکار";

  return (
    <div ref={containerRef} className={clsx("relative", className)}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        disabled={isPending}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label="تغییر کسب‌وکار"
        className={clsx(
          "flex items-center gap-2 px-3 py-1.5 text-xs sm:text-sm font-medium rounded-lg border border-gray-200 bg-white text-gray-800 shadow-sm transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-600",
          isOpen && "ring-2 ring-blue-600 border-transparent",
        )}
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600">
          <BusinessIcon size={14} />
        </div>
        <span className="truncate max-w-[120px] sm:max-w-[160px]">
          {isPending ? "در حال تغییر..." : displayName}
        </span>
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
          className="absolute right-0 z-50 mt-1.5 w-64 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg animate-in fade-in-0 zoom-in-95 duration-100"
        >
          <div className="px-2.5 py-2 text-[11px] font-semibold text-gray-400 border-b border-gray-100">
            کسب‌وکارهای شما
          </div>

          {errorMsg && (
            <div className="m-1.5 p-2 rounded-lg bg-rose-50 border border-rose-200 text-[11px] text-rose-700">
              {errorMsg}
            </div>
          )}

          <div className="py-1 max-h-56 overflow-y-auto space-y-0.5">
            {businesses.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-500">
                هیچ کسب‌وکاری وجود ندارد
              </div>
            ) : (
              businesses.map((biz) => {
                const isSelected = biz.id === activeBizId;
                return (
                  <button
                    key={biz.id}
                    type="button"
                    role="menuitem"
                    disabled={isPending}
                    onClick={() => handleSelectBusiness(biz.id)}
                    className={clsx(
                      "w-full flex items-center justify-between px-2.5 py-2 text-xs rounded-lg text-right transition-colors",
                      isSelected
                        ? "bg-blue-50 text-blue-700 font-semibold"
                        : "text-gray-700 hover:bg-gray-100",
                    )}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <div
                        className={clsx(
                          "w-2 h-2 rounded-full shrink-0",
                          isSelected ? "bg-blue-600" : "bg-gray-300",
                        )}
                      />
                      <span className="truncate">{biz.name}</span>
                    </div>
                    {isSelected && <CheckIcon size={14} className="text-blue-600 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>

          <div className="pt-1.5 mt-1 border-t border-gray-100 space-y-0.5">
            <Link
              href="/dashboard/businesses/new"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-2 px-2.5 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-lg transition"
            >
              <PlusIcon size={14} className="text-gray-500" />
              <span>افزودن کسب‌وکار جدید</span>
            </Link>
            <Link
              href="/dashboard/businesses"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-2 px-2.5 py-2 text-xs text-gray-500 hover:bg-gray-100 rounded-lg transition"
            >
              <SettingsIcon size={14} className="text-gray-400" />
              <span>مدیریت کسب‌وکارها</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
