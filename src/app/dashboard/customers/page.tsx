import Link from "next/link";
import { redirect } from "next/navigation";
import { listBusinesses } from "@/server/business/businessService";
import { listCustomers } from "@/server/customer/customerService";
import { toCustomerDTO } from "@/server/actions/dto";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/requireSession";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertCircleIcon, BusinessIcon } from "@/components/icons";
import { CustomersManager } from "@/components/customer/CustomersManager";

/**
 * Customer Management — /dashboard/customers
 *
 * Server component. It resolves the caller's current business with the
 * existing primary-first convention (`listBusinesses` is session-scoped and
 * returns the primary live business first) and loads that business's live
 * customers via the ownership-checked `customerService.listCustomers`.
 * Archived customers are excluded by the service itself, so they never
 * reach the browser. The interactive layer (search, create/edit/archive
 * dialogs) lives in `CustomersManager`, which updates its list in place
 * from the DTOs returned by the existing Server Actions.
 *
 * States covered: loading (`loading.tsx`), empty (no business / no
 * customers / no search matches — the last two inside the manager), error
 * (a failed query renders an inline notice instead of blowing up the whole
 * dashboard), plus the populated manager.
 */
export const dynamic = "force-dynamic";

export default async function CustomersPage() {
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
          title="مشتریان"
          description="دفترچه مشتریان، اطلاعات تماس و سوابق مالی طرف‌های حساب"
        />
        <Card>
          <CardContent className="p-8">
            <EmptyState
              icon={<BusinessIcon size={28} />}
              title="کسب‌وکاری یافت نشد"
              description="برای ثبت و مدیریت مشتریان، ابتدا یک کسب‌وکار ایجاد یا فعال کنید."
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

  // --- Customers (authorized + filtered server-side) ------------------------
  let customers: ReturnType<typeof toCustomerDTO>[] | null = null;
  try {
    const records = await listCustomers(business.id);
    customers = records.map(toCustomerDTO);
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    // Anything else is reported generically so no internal detail reaches
    // the browser; the retry link below re-runs the server query.
    customers = null;
  }

  if (!customers) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="مشتریان"
          description={`دفترچه مشتریان «${business.name}»`}
        />
        <Card>
          <CardContent className="p-8">
            <EmptyState
              icon={<AlertCircleIcon size={28} />}
              title="خطا در بارگذاری مشتریان"
              description="در دریافت فهرست مشتریان مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره تلاش کنید."
              action={
                <Link href="/dashboard/customers">
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

  return (
    <CustomersManager
      key={business.id}
      businessId={business.id}
      businessName={business.name}
      initialCustomers={customers}
    />
  );
}
