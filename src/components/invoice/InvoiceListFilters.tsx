"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { Button } from "@/components/ui/button";
import { XIcon } from "@/components/icons";
import { toPersianDigits } from "@/lib/formatters";

/**
 * Invoice list controls (search / filters / sorting) — Invoice List V1.
 *
 * The URL is the single source of truth: every control writes into the query
 * string and the *server* component re-runs the authorized, bounded query.
 * Nothing is filtered client-side, so what the user sees always matches what
 * the server authorized them to see.
 */

export interface InvoiceListFiltersProps {
  /** Customers of the current business, for the customer filter. */
  customers: { id: string; name: string }[];
  lifecycleCounts: { all: number; draft: number; finalized: number; cancelled: number };
  isPending?: boolean;
}

const LIFECYCLE_TABS = [
  { value: "ALL", label: "همه" },
  { value: "DRAFT", label: "پیش‌نویس" },
  { value: "FINALIZED", label: "نهایی‌شده" },
  { value: "CANCELLED", label: "لغو شده" },
] as const;

const STATUS_OPTIONS = [
  { value: "", label: "همه وضعیت‌های پرداخت" },
  { value: "PENDING_PAYMENT", label: "در انتظار پرداخت" },
  { value: "PARTIALLY_PAID", label: "پرداخت جزئی" },
  { value: "PAID", label: "پرداخت شده" },
  { value: "OVERDUE", label: "سررسید گذشته" },
  { value: "ISSUED", label: "صادر شده" },
  { value: "SENT", label: "ارسال شده" },
] as const;

const TYPE_OPTIONS = [
  { value: "", label: "همه انواع" },
  { value: "FINAL", label: "فاکتور رسمی" },
  { value: "PROFORMA", label: "پیش‌فاکتور" },
] as const;

const SORT_OPTIONS = [
  { value: "createdAt:desc", label: "جدیدترین" },
  { value: "createdAt:asc", label: "قدیمی‌ترین" },
  { value: "issueDate:desc", label: "تاریخ صدور (نزولی)" },
  { value: "issueDate:asc", label: "تاریخ صدور (صعودی)" },
  { value: "dueDate:asc", label: "نزدیک‌ترین سررسید" },
  { value: "total:desc", label: "بیشترین مبلغ" },
  { value: "total:asc", label: "کمترین مبلغ" },
  { value: "invoiceNumber:asc", label: "شماره فاکتور" },
] as const;

const selectClass =
  "h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-xs text-gray-700 shadow-sm outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-60";

export function InvoiceListFilters({
  customers,
  lifecycleCounts,
  isPending = false,
}: InvoiceListFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentSearch = searchParams.get("search") ?? "";
  const [searchValue, setSearchValue] = React.useState(currentSearch);

  // Keep the input in sync when the URL changes from elsewhere (back button,
  // "clear filters", a link) without fighting the user while they type.
  React.useEffect(() => {
    setSearchValue(currentSearch);
  }, [currentSearch]);

  const pushWith = React.useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      // Any filter/sort change resets pagination — page 3 of the old result
      // set is meaningless for the new one.
      params.delete("page");
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const setParam = React.useCallback(
    (key: string, value: string) => {
      pushWith((params) => {
        if (value === "") params.delete(key);
        else params.set(key, value);
      });
    },
    [pushWith],
  );

  // Debounced search so typing doesn't fire a server round-trip per keystroke.
  React.useEffect(() => {
    if (searchValue === currentSearch) return;
    const timer = setTimeout(() => setParam("search", searchValue.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchValue, currentSearch, setParam]);

  const lifecycle = searchParams.get("lifecycle") ?? "ALL";
  const status = searchParams.get("status") ?? "";
  const invoiceType = searchParams.get("type") ?? "";
  const customerId = searchParams.get("customerId") ?? "";
  const issuedFrom = searchParams.get("from") ?? "";
  const issuedTo = searchParams.get("to") ?? "";
  const sort = `${searchParams.get("sortBy") ?? "createdAt"}:${searchParams.get("sortDir") ?? "desc"}`;

  const hasActiveFilters =
    currentSearch !== "" ||
    lifecycle !== "ALL" ||
    status !== "" ||
    invoiceType !== "" ||
    customerId !== "" ||
    issuedFrom !== "" ||
    issuedTo !== "";

  const counts: Record<string, number> = {
    ALL: lifecycleCounts.all,
    DRAFT: lifecycleCounts.draft,
    FINALIZED: lifecycleCounts.finalized,
    CANCELLED: lifecycleCounts.cancelled,
  };

  return (
    <div className="space-y-4" aria-busy={isPending}>
      {/* Lifecycle tabs */}
      <div
        role="tablist"
        aria-label="گروه‌بندی فاکتورها"
        className="flex flex-wrap items-center gap-1.5 rounded-xl border border-gray-200 bg-gray-50/70 p-1.5"
      >
        {LIFECYCLE_TABS.map((tab) => {
          const active = lifecycle === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setParam("lifecycle", tab.value === "ALL" ? "" : tab.value)}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-white text-blue-700 shadow-sm ring-1 ring-blue-100"
                  : "text-gray-600 hover:bg-white/70 hover:text-gray-900",
              )}
            >
              <span>{tab.label}</span>
              <span
                className={clsx(
                  "rounded-full px-1.5 py-px text-[10px] font-sans",
                  active ? "bg-blue-50 text-blue-700" : "bg-gray-200/80 text-gray-600",
                )}
              >
                {toPersianDigits(counts[tab.value] ?? 0)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search + filters */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-2">
          <label htmlFor="invoice-search" className="mb-1.5 block text-[11px] font-medium text-gray-500">
            جستجو
          </label>
          <input
            id="invoice-search"
            type="search"
            inputMode="search"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder="شماره فاکتور، نام مشتری یا توضیحات…"
            className="h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-xs text-gray-800 shadow-sm outline-none transition-colors placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>

        <div>
          <label htmlFor="invoice-status" className="mb-1.5 block text-[11px] font-medium text-gray-500">
            وضعیت پرداخت
          </label>
          <select
            id="invoice-status"
            value={status}
            onChange={(event) => setParam("status", event.target.value)}
            className={selectClass}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="invoice-type" className="mb-1.5 block text-[11px] font-medium text-gray-500">
            نوع فاکتور
          </label>
          <select
            id="invoice-type"
            value={invoiceType}
            onChange={(event) => setParam("type", event.target.value)}
            className={selectClass}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="invoice-customer" className="mb-1.5 block text-[11px] font-medium text-gray-500">
            مشتری
          </label>
          <select
            id="invoice-customer"
            value={customerId}
            onChange={(event) => setParam("customerId", event.target.value)}
            className={selectClass}
          >
            <option value="">همه مشتریان</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="invoice-from" className="mb-1.5 block text-[11px] font-medium text-gray-500">
            صدور از تاریخ
          </label>
          <input
            id="invoice-from"
            type="date"
            value={issuedFrom}
            onChange={(event) => setParam("from", event.target.value)}
            className={clsx(selectClass, "font-sans")}
          />
        </div>

        <div>
          <label htmlFor="invoice-to" className="mb-1.5 block text-[11px] font-medium text-gray-500">
            صدور تا تاریخ
          </label>
          <input
            id="invoice-to"
            type="date"
            value={issuedTo}
            onChange={(event) => setParam("to", event.target.value)}
            className={clsx(selectClass, "font-sans")}
          />
        </div>

        <div>
          <label htmlFor="invoice-sort" className="mb-1.5 block text-[11px] font-medium text-gray-500">
            مرتب‌سازی
          </label>
          <select
            id="invoice-sort"
            value={sort}
            onChange={(event) => {
              const [sortBy, sortDir] = event.target.value.split(":");
              pushWith((params) => {
                params.set("sortBy", sortBy ?? "createdAt");
                params.set("sortDir", sortDir ?? "desc");
              });
            }}
            className={selectClass}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {hasActiveFilters && (
        <div className="flex items-center justify-between gap-3 border-t border-dashed border-gray-200 pt-3">
          <p className="text-[11px] text-gray-500">
            فیلترهای فعال روی نتایج اعمال شده‌اند.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs text-gray-600"
            onClick={() => router.push(pathname)}
          >
            <XIcon size={14} />
            <span>حذف فیلترها</span>
          </Button>
        </div>
      )}
    </div>
  );
}
