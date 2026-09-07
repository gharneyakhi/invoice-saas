import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PlusIcon, CustomersIcon } from "@/components/icons";

export default function CustomersPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="مشتریان"
        description="دفترچه مشتریان، اطلاعات تماس و سوابق مالی طرف‌های حساب"
        actions={
          <Button size="md" className="gap-2 font-bold shadow-sm">
            <PlusIcon size={18} />
            <span>افزودن مشتری</span>
          </Button>
        }
      />

      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<CustomersIcon size={28} />}
            title="مدیریت مشتریان"
            description="امکان ثبت، ویرایش و مشاهده سوابق فاکتورهای هر مشتری در فاز اختصاصی مشتریان در دسترس خواهد بود."
          />
        </CardContent>
      </Card>
    </div>
  );
}
