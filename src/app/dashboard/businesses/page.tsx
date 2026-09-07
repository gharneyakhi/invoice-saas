import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PlusIcon, BusinessIcon } from "@/components/icons";

export default function BusinessesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="کسب‌وکارها"
        description="مدیریت چند کسب‌وکار، تنظیمات سربرگ و اطلاعات حقوقی فروشنده"
        actions={
          <Button size="md" className="gap-2 font-bold shadow-sm">
            <PlusIcon size={18} />
            <span>افزودن کسب‌وکار</span>
          </Button>
        }
      />

      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<BusinessIcon size={28} />}
            title="مدیریت کسب‌وکارها"
            description="تنظیمات جامع پروفایل، سربرگ، لوگو، مهر و امضای کسب‌وکارها در فاز تنظیمات کسب‌وکار پیاده‌سازی خواهد شد."
          />
        </CardContent>
      </Card>
    </div>
  );
}
