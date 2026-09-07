import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PlusIcon, FileTextIcon } from "@/components/icons";

export default function InvoicesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="فاکتورها"
        description="مشاهده، جستجو و مدیریت فاکتورها و پیش‌فاکتورها"
        actions={
          <Link href="/dashboard/invoices/new">
            <Button size="md" className="gap-2 font-bold shadow-sm">
              <PlusIcon size={18} />
              <span>ایجاد فاکتور جدید</span>
            </Button>
          </Link>
        }
      />

      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<FileTextIcon size={28} />}
            title="مدیریت فاکتورها"
            description="فهرست کامل فاکتورها، پیش‌فاکتورها و فیلترهای پیشرفته در فاز صدور و ویرایش فاکتور فعال خواهد شد."
            action={
              <Link href="/dashboard/invoices/new">
                <Button size="sm" className="gap-1.5">
                  <PlusIcon size={16} />
                  <span>ایجاد اولین فاکتور</span>
                </Button>
              </Link>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
