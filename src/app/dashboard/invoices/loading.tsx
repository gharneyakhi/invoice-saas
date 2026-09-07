import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state for the invoice list, mirroring its real layout
 * (header + filter bar + table rows) so the shell never jumps when the real
 * data streams in.
 */
export default function InvoicesLoading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-40 rounded-lg" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-5">
          <Skeleton className="h-11 w-full rounded-xl" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4, 5, 6, 7].map((i) => (
              <Skeleton key={i} className="h-9 w-full rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Skeleton className="h-10 w-full rounded-none" />
          <div className="divide-y divide-gray-100">
            {[1, 2, 3, 4, 5, 6].map((row) => (
              <div key={row} className="flex items-center justify-between gap-4 px-5 py-4">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="hidden h-4 w-28 sm:block" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="hidden h-4 w-20 md:block" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-7 w-24 rounded-lg" />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-8 w-48 rounded-lg" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
