"use client";

import * as React from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  CustomersIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "@/components/icons";
import type { CustomerDTO } from "@/server/actions/dto";
import { formatPersianNumber } from "@/lib/formatters";
import { CustomerListTable } from "@/components/customer/CustomerListTable";
import { CustomerFormDialog } from "@/components/customer/CustomerFormDialog";
import { ArchiveCustomerDialog } from "@/components/customer/ArchiveCustomerDialog";
import {
  filterCustomers,
  sortCustomers,
} from "@/components/customer/customerListUtils";

/**
 * Customer Management UI — client container for `/dashboard/customers`.
 *
 * The server component loads the current business's live customers through
 * the ownership-checked `customerService.listCustomers` and hands them over
 * as DTOs; this component owns the interactive layer on top of that
 * authorized set:
 *
 *   - instant search across every visible column (client-side filtering of
 *     the authorized rows — the server already decided *which* rows are
 *     visible, archived rows never reach the browser);
 *   - create / edit / archive through the existing Server Actions, with the
 *     list updated in place from the returned DTO — no full page reload;
 *   - empty (no customers / no search matches), count and feedback states.
 *
 * `businessId` is passed to the Server Actions as an untrusted identifier
 * only; ownership is re-proven server-side on every mutation.
 */
export interface CustomersManagerProps {
  businessId: string;
  businessName: string;
  initialCustomers: CustomerDTO[];
}

type FormDialogState = { mode: "create" } | { mode: "edit"; customer: CustomerDTO } | null;

interface Notice {
  type: "success" | "error";
  message: string;
  detail?: string;
}

export function CustomersManager({
  businessId,
  businessName,
  initialCustomers,
}: CustomersManagerProps) {
  const [customers, setCustomers] = React.useState<CustomerDTO[]>(() =>
    sortCustomers(initialCustomers),
  );
  const [query, setQuery] = React.useState("");
  const [formDialog, setFormDialog] = React.useState<FormDialogState>(null);
  const [archiveTarget, setArchiveTarget] = React.useState<CustomerDTO | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  // The dashboard shell can switch the current business (BusinessSwitcher +
  // router.refresh) while this component stays mounted: the server then
  // passes a new businessId with a new row set, and every piece of
  // business-scoped state must reset with it.
  const [activeBusinessId, setActiveBusinessId] = React.useState(businessId);
  if (businessId !== activeBusinessId) {
    setActiveBusinessId(businessId);
    setCustomers(sortCustomers(initialCustomers));
    setQuery("");
    setFormDialog(null);
    setArchiveTarget(null);
    setNotice(null);
  }

  const filtered = React.useMemo(
    () => filterCustomers(customers, query),
    [customers, query],
  );
  const isFiltering = query.trim() !== "";

  function handleCreated(customer: CustomerDTO) {
    setCustomers((prev) => sortCustomers([...prev, customer]));
    setFormDialog(null);
    setNotice({ type: "success", message: `«${customer.name}» با موفقیت اضافه شد.` });
  }

  function handleUpdated(customer: CustomerDTO) {
    setCustomers((prev) =>
      sortCustomers(prev.map((row) => (row.id === customer.id ? customer : row))),
    );
    setFormDialog(null);
    setNotice({ type: "success", message: `تغییرات «${customer.name}» با موفقیت ذخیره شد.` });
  }

  function handleArchived(customer: CustomerDTO) {
    setCustomers((prev) => prev.filter((row) => row.id !== customer.id));
    setArchiveTarget(null);
    setNotice({
      type: "success",
      message: `«${customer.name}» بایگانی شد.`,
      detail: "فاکتورهای قبلی این مشتری بدون تغییر باقی می‌مانند.",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="مشتریان"
        description={`دفترچه مشتریان «${businessName}» — اطلاعات تماس و سوابق طرف‌های حساب این کسب‌وکار`}
        badge={
          <Badge variant="secondary" showDot>
            {formatPersianNumber(customers.length)} مشتری فعال
          </Badge>
        }
        actions={
          <Button
            size="md"
            className="gap-2 font-bold shadow-sm"
            onClick={() => {
              setNotice(null);
              setFormDialog({ mode: "create" });
            }}
          >
            <PlusIcon size={18} />
            <span>افزودن مشتری</span>
          </Button>
        }
      />

      {notice && (
        <div
          role={notice.type === "success" ? "status" : "alert"}
          className={
            notice.type === "success"
              ? "flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-800"
              : "flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs leading-relaxed text-rose-800"
          }
        >
          {notice.type === "success" ? (
            <CheckCircleIcon size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{notice.message}</p>
            {notice.detail && <p className="mt-0.5 opacity-80">{notice.detail}</p>}
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="بستن پیام"
            className="shrink-0 rounded-md p-1 opacity-60 transition hover:opacity-100"
          >
            <XIcon size={14} />
          </button>
        </div>
      )}

      <Card>
        <CardContent className="p-5">
          <div className="relative">
            <label htmlFor="customer-search" className="sr-only">
              جستجوی مشتری
            </label>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
              <SearchIcon size={18} />
            </span>
            <input
              id="customer-search"
              type="search"
              inputMode="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="جستجو با نام، موبایل، ایمیل، کد ملی یا آدرس…"
              autoComplete="off"
              className="h-10 w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-10 text-sm text-gray-800 shadow-sm outline-none transition-colors placeholder:text-gray-400 hover:border-gray-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-600"
            />
            {query !== "" && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="پاک کردن جستجو"
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
              >
                <XIcon size={16} />
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-gray-400" aria-live="polite">
            {isFiltering
              ? `${formatPersianNumber(filtered.length)} نتیجه برای «${query.trim()}»`
              : customers.length > 0
                ? `نمایش ${formatPersianNumber(customers.length)} مشتری`
                : "هنوز مشتری ثبت نشده است"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="p-6">
              {isFiltering ? (
                <EmptyState
                  icon={<SearchIcon size={24} />}
                  title="مشتری‌ای با این جستجو یافت نشد"
                  description={`هیچ مشتری با عبارت «${query.trim()}» مطابقت ندارد. عبارت دیگری را امتحان کنید یا جستجو را پاک کنید.`}
                  action={
                    <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                      پاک کردن جستجو
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<CustomersIcon size={28} />}
                  title="هنوز مشتری ثبت نکرده‌اید"
                  description="اولین مشتری این کسب‌وکار را اضافه کنید تا بتوانید هنگام صدور فاکتور او را انتخاب کنید و سوابق مالی‌اش را اینجا ببینید."
                  action={
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        setNotice(null);
                        setFormDialog({ mode: "create" });
                      }}
                    >
                      <PlusIcon size={16} />
                      <span>افزودن اولین مشتری</span>
                    </Button>
                  }
                />
              )}
            </div>
          ) : (
            <CustomerListTable
              customers={filtered}
              onEdit={(customer) => {
                setNotice(null);
                setFormDialog({ mode: "edit", customer });
              }}
              onArchive={(customer) => {
                setNotice(null);
                setArchiveTarget(customer);
              }}
            />
          )}
        </CardContent>
      </Card>

      {formDialog?.mode === "create" && (
        <CustomerFormDialog
          mode="create"
          businessId={businessId}
          onClose={() => setFormDialog(null)}
          onSaved={handleCreated}
        />
      )}
      {formDialog?.mode === "edit" && (
        <CustomerFormDialog
          key={formDialog.customer.id}
          mode="edit"
          businessId={businessId}
          customer={formDialog.customer}
          onClose={() => setFormDialog(null)}
          onSaved={handleUpdated}
        />
      )}
      {archiveTarget && (
        <ArchiveCustomerDialog
          businessId={businessId}
          customer={archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onArchived={handleArchived}
        />
      )}
    </div>
  );
}
