import Link from "next/link";
import { redirect } from "next/navigation";
import { listBusinesses } from "@/server/business/businessService";
import { listProducts } from "@/server/product/productService";
import { toProductDTO } from "@/server/actions/dto";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/requireSession";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertCircleIcon, BusinessIcon } from "@/components/icons";
import { ProductsManager } from "@/components/product/ProductsManager";

/**
 * Product/Service Management — /dashboard/products
 *
 * Server component. It resolves the caller's current business with the
 * existing primary-first convention (`listBusinesses` is session-scoped and
 * returns the primary live business first) and loads that business's live
 * products via the ownership-checked `productService.listProducts`. Archived
 * products are excluded by the service itself, so they never reach the
 * browser. The interactive layer (search, create/edit/archive dialogs) lives
 * in `ProductsManager`, which updates its list in place from the DTOs
 * returned by the existing Server Actions.
 *
 * Invoice editor compatibility: the editor's product picker is fed by this
 * very `listProducts` call (see `/dashboard/invoices/new`), so anything
 * created or updated here is immediately selectable there — and anything
 * archived here disappears from new invoices while existing invoice items
 * keep their own snapshots untouched.
 *
 * States covered: loading (`loading.tsx`), empty (no business / no products
 * / no search matches — the last two inside the manager), error (a failed
 * query renders an inline notice instead of blowing up the whole dashboard),
 * plus the populated manager.
 */
export const dynamic = "force-dynamic";

export default async function ProductsPage() {
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
          title="محصولات و خدمات"
          description="کاتالوگ کالاها و خدمات، قیمت‌های پایه و واحدهای شمارش"
        />
        <Card>
          <CardContent className="p-8">
            <EmptyState
              icon={<BusinessIcon size={28} />}
              title="کسب‌وکاری یافت نشد"
              description="برای ثبت و مدیریت کالاها و خدمات، ابتدا یک کسب‌وکار ایجاد یا فعال کنید."
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

  // --- Products (authorized + filtered server-side) -------------------------
  let products: ReturnType<typeof toProductDTO>[] | null = null;
  try {
    const records = await listProducts(business.id);
    products = records.map(toProductDTO);
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    // Anything else is reported generically so no internal detail reaches
    // the browser; the retry link below re-runs the server query.
    products = null;
  }

  if (!products) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="محصولات و خدمات"
          description={`کاتالوگ کالاها و خدمات «${business.name}»`}
        />
        <Card>
          <CardContent className="p-8">
            <EmptyState
              icon={<AlertCircleIcon size={28} />}
              title="خطا در بارگذاری محصولات"
              description="در دریافت فهرست محصولات و خدمات مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره تلاش کنید."
              action={
                <Link href="/dashboard/products">
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
    <ProductsManager
      key={business.id}
      businessId={business.id}
      businessName={business.name}
      initialProducts={products}
    />
  );
}
