import Link from "next/link";
import { redirect } from "next/navigation";
import { listBusinesses } from "@/server/business/businessService";
import { listCustomers } from "@/server/customer/customerService";
import { listProducts } from "@/server/product/productService";
import { getInvoice, getInvoiceSettings } from "@/server/invoice/invoiceService";
import { getDraftPreviewContext } from "@/server/invoice/previewService";
import type { LivePreviewBrandingContext } from "@/lib/invoice-live-preview";
import {
  toCustomerDTO,
  toInvoiceDetailDTO,
  toProductDTO,
  type InvoiceDetailDTO,
} from "@/server/actions/dto";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";
import { formatGregorianDateInput } from "@/lib/formatters";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertCircleIcon, BusinessIcon, ChevronRightIcon } from "@/components/icons";
import { InvoiceEditor } from "@/components/invoice/InvoiceEditor";

/**
 * Invoice Editor V1 — /dashboard/invoices/new
 *
 * Server component: resolves the caller's primary business (existing
 * primary-first convention) and streams the *real* customers, products and
 * invoice settings of that business into the client editor. No mock data.
 *
 * `?invoiceId=<id>` re-opens an existing DRAFT (e.g. after a page refresh);
 * finalized/cancelled invoices are read-only by domain rule, so the editor
 * refuses them with a clear Persian notice instead of a form.
 *
 * The editor renders a LIVE preview of the document while the user types, so
 * this route also supplies the draft half of the preview model: the current
 * `BusinessProfile` with its branding assets resolved to public urls, and the
 * invoice currency. Both are read-only reads (`previewService`), and the
 * editor's save/finalize path remains the only way anything is persisted.
 */
export const dynamic = "force-dynamic";

interface NewInvoicePageProps {
  searchParams?: { invoiceId?: string | string[] };
}

function BackToInvoicesButton() {
  return (
    <Link href="/dashboard/invoices">
      <Button variant="outline" size="sm" className="gap-1.5">
        <ChevronRightIcon size={16} />
        <span>بازگشت به فاکتورها</span>
      </Button>
    </Link>
  );
}

export default async function NewInvoicePage({ searchParams }: NewInvoicePageProps) {
  try {
    // Primary-first business resolution — the same convention the dashboard
    // shell and dashboardService use (`listBusinesses()` is session-scoped).
    const businesses = await listBusinesses();
    const business = businesses[0] ?? null;

    if (!business) {
      return (
        <div className="space-y-6">
          <PageHeader
            title="ایجاد فاکتور جدید"
            description="برای صدور فاکتور ابتدا باید یک کسب‌وکار فعال داشته باشید"
            actions={<BackToInvoicesButton />}
          />
          <Card>
            <CardContent className="p-8">
              <EmptyState
                icon={<BusinessIcon size={28} />}
                title="کسب‌وکاری یافت نشد"
                description="پیش از صدور فاکتور، نخستین کسب‌وکار خود را ایجاد کنید؛ پس از آن امکان صدور پیش‌نویس فعال می‌شود."
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

    const [customerRecords, productRecords, settings, draftPreviewContext] = await Promise.all([
      listCustomers(business.id),
      listProducts(business.id),
      getInvoiceSettings(business.id),
      // Live-preview branding: the CURRENT BusinessProfile + its resolved
      // logo/stamp/signature urls + the invoice currency. Presentation data
      // only — the preview never writes, and finalization re-reads this row
      // for the immutable snapshot. It must never break the editor, so a
      // failure here degrades to "no branding" instead of propagating.
      getDraftPreviewContext(business.id).catch(() => null),
    ]);

    // Optional draft-to-continue (?invoiceId=...) — only DRAFT rows are
    // editable by domain rule (finalization makes them immutable).
    const invoiceIdParam = searchParams?.invoiceId;
    const invoiceId = Array.isArray(invoiceIdParam) ? invoiceIdParam[0] : invoiceIdParam;
    let initialDraft: InvoiceDetailDTO | null = null;
    let deniedNotice: { title: string; description: string } | null = null;

    if (invoiceId) {
      try {
        const record = await getInvoice(business.id, invoiceId);
        if (record.status === "DRAFT") {
          initialDraft = toInvoiceDetailDTO(record);
        } else {
          deniedNotice = {
            title: "این فاکتور قابل ویرایش نیست",
            description:
              record.status === "CANCELLED"
                ? "فاکتورهای لغوشده قابل ویرایش نیستند. لطفاً یک پیش‌نویس جدید ایجاد کنید."
                : "فقط پیش‌نویس فاکتورها قابل ویرایش هستند؛ این فاکتور نهایی شده است. برای صدور فاکتور جدید از فرم ایجاد استفاده کنید.",
          };
        }
      } catch (error) {
        if (error instanceof NotFoundError) {
          deniedNotice = {
            title: "فاکتور یافت نشد",
            description: "پیش‌نویس مورد نظر وجود ندارد یا حذف شده است. می‌توانید یک فاکتور جدید ایجاد کنید.",
          };
        } else {
          throw error;
        }
      }
    }

    if (deniedNotice) {
      return (
        <div className="space-y-6">
          <PageHeader
            title="ویرایش فاکتور"
            description="وضعیت این فاکتور اجازه ویرایش نمی‌دهد"
            actions={<BackToInvoicesButton />}
          />
          <Card>
            <CardContent className="p-8">
              <EmptyState
                icon={<AlertCircleIcon size={28} />}
                title={deniedNotice.title}
                description={deniedNotice.description}
                action={
                  <Link href="/dashboard/invoices/new">
                    <Button size="sm">ایجاد فاکتور جدید</Button>
                  </Link>
                }
              />
            </CardContent>
          </Card>
        </div>
      );
    }

    // The live preview always has a context: when branding cannot be read the
    // document simply renders without a logo/stamp/signature (Task: never
    // invent an asset url, never crash the editor).
    const previewContext: LivePreviewBrandingContext = draftPreviewContext ?? {
      businessId: business.id,
      fallbackBusinessName: business.name,
      currentProfile: null,
      images: { logo: null, sellerStamp: null, sellerSignature: null },
      currency: settings?.currency ?? "IRR",
    };

    return (
      <div className="space-y-6">
        <PageHeader
          title={initialDraft ? "ویرایش پیش‌نویس فاکتور" : "ایجاد فاکتور جدید"}
          description={`صدور پیش‌نویس برای «${business.name}» — محاسبات نهایی همواره سمت سرور انجام می‌شود.`}
          badge={
            <Badge variant="draft" showDot>
              پیش‌نویس
            </Badge>
          }
          actions={<BackToInvoicesButton />}
        />

        <InvoiceEditor
          key={initialDraft?.id ?? "new"}
          businessId={business.id}
          customers={customerRecords.map(toCustomerDTO)}
          products={productRecords.map(toProductDTO)}
          defaultVatPercent={settings ? settings.defaultVatPercent.toString() : "0"}
          currency={settings?.currency ?? "IRR"}
          defaultIssueDate={formatGregorianDateInput(new Date())}
          initialDraft={initialDraft}
          previewContext={previewContext}
        />
      </div>
    );
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    throw error;
  }
}
