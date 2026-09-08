import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function BusinessesLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Card>
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-2.5 w-full" />
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Card key={index}>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-start gap-3">
                <Skeleton className="h-12 w-12 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
              <Skeleton className="h-3 w-1/3" />
              <div className="flex gap-2 border-t border-gray-100 pt-3">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-8 w-36" />
                <Skeleton className="h-8 w-16" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
