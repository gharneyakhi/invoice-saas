import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state for the subscription page, mirroring its real
 * layout (header + current-subscription card + plan grid + history table) so
 * the shell never jumps when the data streams in.
 */
export default function SubscriptionLoading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-3 w-full rounded" />
        </CardContent>
      </Card>

      <div className="space-y-3">
        <Skeleton className="h-5 w-20" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[1, 2, 3].map((plan) => (
            <Card key={plan}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-9 w-full rounded-lg" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="space-y-2 p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
