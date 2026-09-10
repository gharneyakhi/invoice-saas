import Link from "next/link";
import { redirect } from "next/navigation";
import { listBusinesses } from "@/server/business/businessService";
import { getInvoicePreviewData } from "@/server/invoice/previewService";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/server/auth/requireSession";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { InvoicePreviewDocument } from "@/components/invoice/InvoicePreviewDocument";
import { InvoicePrintButton } from "@/components/invoice/InvoicePrintButton";
import { InvoicePdfButton } from "@/components/invoice/InvoicePdfButton";
import { InvoiceExportMenu } from "@/components/invoice/InvoiceExportMenu";
import { GmailOutcomeBanner } from "@/components/invoice/GmailOutcomeBanner";
import { AlertCircleIcon, ChevronRightIcon, EyeIcon } from "@/components/icons";

/**
 * Invoice Preview & Print V1 — /dashboard/invoices/[invoiceId]/preview
 *
 * Server component. Resolves the caller's *current* business with the same
 * primary-first, session-scoped convention every invoice route uses (the
 * dashboard shell's convention), then loads the preview payload via
 * `previewService.getInvoicePreviewData`, which:
 *
 *   - requires an authenticated session and proves business ownership
 *     (`requireBusinessOwnership`) — no businessId is ever taken from the
 *     client as proof of authorization;
 *   - proves the invoice belongs to exactly that business (`getInvoice`):
 *     missing → NotFoundError, cross-business / cross-account → ForbiddenError;
 *   - reads seller/customer data from the immutable snapshots for FINALIZED
 *     rows and from the current profile/customer for DRAFT rows;
 *   - performs NO writes: no preview quota, no numbering, no snapshot
 *     creation, no payment mutation.
 *
 * Everything below the toolbar is the pure A4 document; in print media the
 * toolbar and the dashboard chrome are hidden and only the document prints.
 */
export const dynamic = "force-dynamic";

interface InvoicePreviewPageProps {
  params: { invoiceId: string };
}

function BackToInvoiceButton({ invoiceId }: { invoiceId: string }) {
  return (
    <Link href={`/dashboard/invoices/${encodeURIComponent(invoiceId)}`}>
      <Button variant="outline" size="sm" className="gap-1.5">
        <EyeIcon size={15} />
        <span>مشاهده فاکتور</span>
      </Button>
    </Link>
  );
}

function NotAvailable({ backHref }: { backHref?: string }) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="پیش‌نمایش فاکتور"
        description="پیش‌نمایش مورد نظر در دسترس نیست"
        actions={
          backHref ? (
            <Link href={backHref}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <ChevronRightIcon size={16} />
                <span>بازگشت به فاکتورها</span>
              </Button>
            </Link>
          ) : undefined
        }
      />
      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<AlertCircleIcon size={28} />}
            title="فاکتور یافت نشد"
            description="این فاکتور وجود ندارد، به کسب‌وکار فعال شما تعلق ندارد یا کسب‌وکار آن بایگانی شده است."
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default async function InvoicePreviewPage({ params }: InvoicePreviewPageProps) {
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
  if (!business) return <NotAvailable />;

  let preview;
  try {
    preview = await getInvoicePreviewData(business.id, params.invoiceId);
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    if (error instanceof NotFoundError || error instanceof ForbiddenError) {
      return <NotAvailable backHref="/dashboard/invoices" />;
    }
    throw error;
  }

  return (
    <div className="space-y-5">
      {/* Toolbar — hidden entirely in print media */}
      <div className="print:hidden">
        <PageHeader
          title="پیش‌نمایش و چاپ فاکتور"
          description={
            preview.isDraft
              ? "پیش‌نمایش پیش‌نویس با اطلاعات فعلی کسب‌وکار — هیچ تغییری روی فاکتور اعمال نمی‌شود."
              : "نمای چاپی فاکتور نهایی بر اساس اطلاعات ثبت‌شده هنگام صدور."
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <InvoicePrintButton />
              <InvoicePdfButton invoiceId={preview.invoice.id} />
              {/* Export & Sharing V1 — file downloads + share dialogs; the
                  menu prints this page in place (mode="preview"). */}
              <InvoiceExportMenu
                businessId={business.id}
                invoiceId={preview.invoice.id}
                isDraft={preview.isDraft}
                mode="preview"
              />
              <BackToInvoiceButton invoiceId={preview.invoice.id} />
            </div>
          }
        />
        {/* Gmail connect outcome (?gmail=...) — toolbar-only, never printed. */}
        <div className="mt-4">
          <GmailOutcomeBanner />
        </div>
      </div>

      {/* A4 document */}
      <InvoicePreviewDocument model={preview} />

      <p className="print:hidden text-center text-[11px] text-gray-400">
        این صفحه برای چاپ A4 طراحی شده است؛ دکمه «چاپ فاکتور» یا Ctrl+P را بزنید.
      </p>
    </div>
  );
}
