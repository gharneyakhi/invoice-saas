import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PlusIcon, ProductsIcon } from "@/components/icons";

export default function ProductsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="محصولات و خدمات"
        description="تعریف کالاها، خدمات، قیمت‌های پایه و واحدهای شمارش"
        actions={
          <Button size="md" className="gap-2 font-bold shadow-sm">
            <PlusIcon size={18} />
            <span>افزودن محصول / خدمت</span>
          </Button>
        }
      />

      <Card>
        <CardContent className="p-8">
          <EmptyState
            icon={<ProductsIcon size={28} />}
            title="کاتالوگ محصولات و خدمات"
            description="امکان تعریف اقلام فاکتور با قیمت‌گذاری پیش‌فرض در فاز اختصاصی محصولات فعال خواهد شد."
          />
        </CardContent>
      </Card>
    </div>
  );
}
