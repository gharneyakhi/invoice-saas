import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsIcon } from "@/components/icons";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="تنظیمات"
        description="تنظیمات حساب کاربری، امنیت، تمپلیت‌های فاکتور و ترجیحات سیستم"
      />

      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<SettingsIcon size={28} />}
            title="تنظیمات سیستم"
            description="شخصی‌سازی قالب‌های چاپ، شماره‌گذاری فاکتورها و ترجیحات اعلان‌ها در این بخش مدیریت خواهد شد."
          />
        </CardContent>
      </Card>
    </div>
  );
}
