import Link from "next/link";
import { redirect } from "next/navigation";
import { listBusinesses } from "@/server/business/businessService";
import { listCustomers } from "@/server/customer/customerService";
import { queryInvoices } from "@/server/invoice/invoiceService";
import { parseInvoiceListQuery } from "@/server/invoice/schema";
import { toInvoiceListDTO } from "@/server/actions/dto";
import { ValidationError } from "@/server/errors";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/requireSession";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AlertCircleIcon,
  BusinessIcon,
  FileTextIcon,
  PlusIcon,
} from "@/components/icons";
import { InvoiceListFilters } from "@/components/invoice/InvoiceListFilters";
import { InvoiceListTable } from "@/components/invoice/InvoiceListTable";
import { InvoiceListPagination } from "@/components/invoice/InvoiceListPagination";

/**
 * Invoice List V1 — /dashboard/invoices
 *
 * Server component. It resolves the caller's current business with the existing
 * primary-first convention and renders the *real* invoices of that business via
 * `invoiceService.queryInvoices`, which proves ownership server-side
 * (`requireBusinessOwnership`) and hard-caps the page size. Nothing about the
 * result set is decided in the browser: search, filters, sorting and pagination
 * all live in the URL and are re-validated on the server by
 * `parseInvoiceListQuery` on every request.
 *
 * States covered: loading (`loading.tsx`), empty (no business / no invoices /
 * no matches for the current filters), error (a failed query renders an inline
 * notice instead of blowing up the whole dashboard), plus the populated list.
 */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

interface InvoicesPageProps {
  searchParams?: SearchParams;
}

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** `issuedFrom`/`issuedTo` arrive as an ISO string or a Date; normalise to Date. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function NewInvoiceButton() {
  return (
    <Link href="/dashboard/invoices/new">
      <Button size="md" className="gap-2 font-bold shadow-sm">
        <PlusIcon size={18} />
        <span>ایجاد فاکتور جدید</span>
      </Button>
    </Link>
  );
}

/** Maps the compact URL params onto the validated service query contract. */
function buildQuery(searchParams: SearchParams) {
  const status = first(searchParams.status);
  return parseInvoiceListQuery({
    ...(first(searchParams.search) ? { search: first(searchParams.search) } : {}),
    ...(status ? { statuses: [status] } : {}),
    ...(first(searchParams.lifecycle) ? { lifecycle: first(searchParams.lifecycle) } : {}),
    ...(first(searchParams.type) ? { invoiceType: first(searchParams.type) } : {}),
    ...(first(searchParams.customerId) ? { customerId: first(searchParams.customerId) } : {}),
    ...(first(searchParams.from) ? { issuedFrom: first(searchParams.from) } : {}),
    ...(first(searchParams.to) ? { issuedTo: first(searchParams.to) } : {}),
    ...(first(searchParams.sortBy) ? { sortBy: first(searchParams.sortBy) } : {}),
    ...(first(searchParams.sortDir) ? { sortDirection: first(searchParams.sortDir) } : {}),
    ...(first(searchParams.page) ? { page: first(searchParams.page) } : {}),
  });
}

export default async function InvoicesPage({ searchParams = {} }: InvoicesPageProps) {
  let businesses;
  try {
    businesses = await listBusinesses();
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    throw error;
  }

  const business = businesses[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="فاکتورها"
          description="مشاهده، جستجو و مدیریت فاکتورها و پیش‌فاکتورها"
        />
        <Card>
          <CardContent className="p-8">
            <EmptyState
              icon={<BusinessIcon size={28} />}
              title="کسب‌وکاری یافت نشد"
              description="برای مشاهده و مدیریت فاکتورها، ابتدا یک کسب‌وکار ایجاد یا فعال کنید."
              action={
                <Link href="/dashboard/businesses">
                  <Button size="sm">مدیریت کسب‌وکارها</Button>
                </Link>
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // --- Query (validated + authorized server-side) ---------------------------
  let list: ReturnType<typeof toInvoiceListDTO> | null = null;
  let customers: { id: string; name: string }[] = [];
  let errorMessage: string | null = null;

  try {
    const query = buildQuery(searchParams);
    const [result, customerRecords] = await Promise.all([
      queryInvoices(business.id, {
        ...(query.search ? { search: query.search } : {}),
        ...(query.statuses ? { statuses: query.statuses } : {}),
        lifecycle: query.lifecycle,
        ...(query.invoiceType ? { invoiceType: query.invoiceType } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.issuedFrom ? { issuedFrom: toDate(query.issuedFrom) } : {}),
        ...(query.issuedTo ? { issuedTo: toDate(query.issuedTo) } : {}),
        sortBy: query.sortBy,
        sortDirection: query.sortDirection,
        page: query.page,
        pageSize: query.pageSize,
      }),
      listCustomers(business.id),
    ]);
    list = toInvoiceListDTO(result);
    customers = customerRecords.map((customer) => ({ id: customer.id, name: customer.name }));
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    // A bad query string is a user-fixable problem; anything else is reported
    // generically so no internal detail reaches the browser.
    errorMessage =
      error instanceof ValidationError
        ? "پارامترهای جستجو یا فیلتر نامعتبر هستند. لطفاً فیلترها را پاک کرده و دوباره تلاش کنید."
        : "در دریافت فهرست فاکتورها مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره تلاش کنید.";
  }

  const header = (
    <PageHeader
      title="فاکتورها"
      description={`مشاهده، جستجو و مدیریت فاکتورهای «${business.name}»`}
      actions={<NewInvoiceButton />}
    />
  );

  if (!list) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardContent className="p-8">
            <EmptyState
              icon={<AlertCircleIcon size={28} />}
              title="خطا در بارگذاری فاکتورها"
              description={errorMessage ?? "خطای ناشناخته"}
              action={
                <Link href="/dashboard/invoices">
                  <Button size="sm" variant="outline">
                    بارگذاری مجدد فهرست
                  </Button>
                </Link>
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasAnyInvoice = list.lifecycleCounts.all > 0;

  return (
    <div className="space-y-6">
      {header}

      <Card>
        <CardContent className="space-y-5 p-5">
          <InvoiceListFilters customers={customers} lifecycleCounts={list.lifecycleCounts} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {list.rows.length === 0 ? (
            <div className="p-6">
              {hasAnyInvoice ? (
                <EmptyState
                  icon={<FileTextIcon size={24} />}
                  title="فاکتوری با این فیلترها یافت نشد"
                  description="هیچ فاکتوری با جستجو و فیلترهای فعلی مطابقت ندارد. عبارت جستجو را تغییر دهید یا فیلترها را پاک کنید."
                  action={
                    <Link href="/dashboard/invoices">
                      <Button size="sm" variant="outline">
                        حذف فیلترها
                      </Button>
                    </Link>
                  }
                />
              ) : (
                <EmptyState
                  icon={<FileTextIcon size={24} />}
                  title="هنوز فاکتوری ایجاد نکرده‌اید"
                  description="اولین فاکتور خود را ایجاد کنید تا فهرست فاکتورها، وضعیت پرداخت و مانده حساب‌ها اینجا نمایش داده شوند."
                  action={
                    <Link href="/dashboard/invoices/new">
                      <Button size="sm" className="gap-1.5">
                        <PlusIcon size={16} />
                        <span>ایجاد اولین فاکتور</span>
                      </Button>
                    </Link>
                  }
                />
              )}
            </div>
          ) : (
            <>
              <InvoiceListTable rows={list.rows} />
              <InvoiceListPagination
                page={list.page}
                pageCount={list.pageCount}
                pageSize={list.pageSize}
                total={list.total}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
