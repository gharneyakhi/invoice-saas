import Link from "next/link";
import { redirect } from "next/navigation";
import { getBusinessSettings } from "@/server/business/businessService";
import { toBusinessSettingsDTO } from "@/server/actions/dto";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { FILE_UPLOADS_ENABLED } from "@/server/storage/storageService";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BusinessSettingsForm } from "@/components/business/BusinessSettingsForm";
import {
  AlertCircleIcon,
  ArchiveIcon,
  CheckCircleIcon,
  ChevronRightIcon,
} from "@/components/icons";
import { formatPersianDate } from "@/lib/formatters";

/**
 * Business settings — profile / visual identity / banking / stamp & signature
 * / invoice settings of one business, selected explicitly by URL.
 *
 * Authorization is entirely server-side: `getBusinessSettings` proves
 * ownership via `requireBusinessOwnership` (404 for a missing row, 403 for
 * another account's row — both rendered as the same neutral "not found"
 * notice, mirroring the invoice detail page). Archived businesses render
 * read-only: their data is preserved, but not editable.
 */
export const dynamic = "force-dynamic";

interface BusinessSettingsPageProps {
  params: { businessId: string };
  searchParams?: { created?: string | string[] };
}

export default async function BusinessSettingsPage({
  params,
  searchParams,
}: BusinessSettingsPageProps) {
  let record;
  try {
    record = await getBusinessSettings(params.businessId);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    if (error instanceof NotFoundError || error instanceof ForbiddenError) {
      return (
        <div className="space-y-6">
          <PageHeader
            title="تنظیمات کسب‌وکار"
            description="کسب‌وکار مورد نظر در دسترس نیست"
            actions={
              <Link href="/dashboard/businesses">
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ChevronRightIcon size={16} />
                  <span>بازگشت به کسب‌وکارها</span>
                </Button>
              </Link>
            }
          />
          <Card>
            <CardContent className="p-8">
              <EmptyState
                icon={<AlertCircleIcon size={28} />}
                title="کسب‌وکار یافت نشد"
                description="این کسب‌وکار وجود ندارد یا به حساب کاربری شما تعلق ندارد."
                action={
                  <Link href="/dashboard/businesses">
                    <Button size="sm">بازگشت به فهرست کسب‌وکارها</Button>
                  </Link>
                }
              />
            </CardContent>
          </Card>
        </div>
      );
    }
    throw error;
  }

  const dto = toBusinessSettingsDTO(record);
  const isArchived = record.business.archivedAt !== null;
  const createdParam = searchParams?.created;
  const justCreated =
    !isArchived &&
    (Array.isArray(createdParam) ? createdParam[0] : createdParam) === "1";

  return (
    <div className="space-y-6">
      <PageHeader
        title={record.business.name}
        description={`تنظیمات پروفایل و فاکتور — ایجاد: ${formatPersianDate(record.business.createdAt)}`}
        badge={
          <span className="flex flex-wrap items-center gap-1.5">
            {record.business.isPrimary && (
              <Badge variant="default" showDot>
                پیش‌فرض
              </Badge>
            )}
            {!record.business.isActive && <Badge variant="secondary">غیرفعال</Badge>}
            {isArchived && (
              <Badge variant="warning" showDot>
                بایگانی‌شده
              </Badge>
            )}
          </span>
        }
        actions={
          <Link href="/dashboard/businesses">
            <Button variant="outline" size="sm" className="gap-1.5">
              <ChevronRightIcon size={16} />
              <span>بازگشت به کسب‌وکارها</span>
            </Button>
          </Link>
        }
      />

      {justCreated && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-800"
        >
          <CheckCircleIcon size={16} className="mt-0.5 shrink-0" />
          <p>
            کسب‌وکار با موفقیت ایجاد شد. اکنون می‌توانید اطلاعات آن را کامل کنید؛ همه
            تغییرات بعدی از همین صفحه ذخیره می‌شود.
          </p>
        </div>
      )}

      {isArchived && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800"
        >
          <ArchiveIcon size={16} className="mt-0.5 shrink-0" />
          <p>
            این کسب‌وکار بایگانی شده و فقط قابل مشاهده است. فاکتورها و داده‌های تاریخی
            آن حفظ شده‌اند؛ برای فعال‌سازی مجدد با پشتیبانی تماس بگیرید.
          </p>
        </div>
      )}

      {!isArchived && !record.invoiceSettings && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-relaxed text-gray-600"
        >
          <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
          <p>ردیف تنظیمات فاکتور این کسب‌وکار یافت نشد؛ با اولین ذخیره بازسازی می‌شود.</p>
        </div>
      )}

      <BusinessSettingsForm
        mode="edit"
        businessId={record.business.id}
        initialName={record.business.name}
        initialProfile={dto.profile}
        initialInvoiceSettings={dto.invoiceSettings}
        imageUploadsEnabled={FILE_UPLOADS_ENABLED}
        readOnly={isArchived}
      />
    </div>
  );
}
