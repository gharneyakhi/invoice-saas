import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function InvoicePreviewLoading() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-32 rounded-lg" />
          <Skeleton className="h-9 w-28 rounded-lg" />
        </div>
      </div>

      <Card className="mx-auto max-w-3xl">
        <Skeleton className="h-2 w-full rounded-none" />
        <CardContent className="space-y-6 p-8">
          <div className="flex items-start justify-between gap-6">
            <div className="space-y-3">
              <Skeleton className="h-14 w-48 rounded-lg" />
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-28 w-56 rounded-xl" />
          </div>
          <Skeleton className="h-24 w-full rounded-xl" />
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-40 w-72 rounded-xl" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
