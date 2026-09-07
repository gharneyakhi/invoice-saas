import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SubscriptionIcon, SparklesIcon } from "@/components/icons";

export default function SubscriptionPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="پلن و اشتراک"
        description="مشاهده پلن‌های فعال، سهمیه فاکتورها، ارتقا و صورت‌حساب اشتراک"
      />

      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<SubscriptionIcon size={28} />}
            title="مدیریت اشتراک و ارتقای پلن"
            description="درگاه پرداخت، پلن‌های پایه و حرفه‌ای و گزارش سوابق تمدید در فاز پرداخت و اشتراک پیاده‌سازی خواهد شد."
          />
        </CardContent>
      </Card>
    </div>
  );
}
