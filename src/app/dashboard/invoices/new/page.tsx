import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FileTextIcon, ChevronRightIcon } from "@/components/icons";

export default function NewInvoicePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="ایجاد فاکتور جدید"
        description="صدور فاکتور یا پیش‌فاکتور جدید برای مشتریان"
        actions={
          <Link href="/dashboard/invoices">
            <Button variant="outline" size="sm" className="gap-1.5">
              <ChevronRightIcon size={16} />
              <span>بازگشت به فاکتورها</span>
            </Button>
          </Link>
        }
      />

      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<FileTextIcon size={28} />}
            title="ویرایشگر صدور فاکتور"
            description="ویرایشگر کامل صدور فاکتور، انتخاب اقلام و پیش‌نمایش در فاز بعدی پیاده‌سازی خواهد شد."
            action={
              <Link href="/dashboard">
                <Button size="sm" variant="outline">
                  بازگشت به داشبورد
                </Button>
              </Link>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
