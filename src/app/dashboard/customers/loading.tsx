import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state for customer management, mirroring its real
 * layout (header + search bar + rows) so the shell never jumps when the
 * real data streams in.
 */
export default function CustomersLoading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-36 rounded-lg" />
      </div>

      <Card>
        <CardContent className="space-y-2 p-5">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-3 w-40" />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Skeleton className="h-10 w-full rounded-none" />
          <div className="divide-y divide-gray-100">
            {[1, 2, 3, 4, 5].map((row) => (
              <div key={row} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
                <Skeleton className="hidden h-4 w-24 sm:block" />
                <Skeleton className="hidden h-4 w-32 md:block" />
                <div className="flex gap-1.5">
                  <Skeleton className="h-7 w-16 rounded-lg" />
                  <Skeleton className="h-7 w-16 rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
