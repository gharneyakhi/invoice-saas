import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading state for the invoice editor, mirroring its two-column
 * layout (editor main area + the live A4 preview pane). The dashboard shell
 * stays interactive while the server loads business, customers, products,
 * settings and the branding payload the preview renders.
 */
export default function NewInvoiceLoading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>

      {/* Mobile edit/preview tabs */}
      <div className="lg:hidden">
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(380px,44%)]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-3.5 w-52" />
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3.5 w-64" />
            </CardHeader>
            <CardContent className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-6 w-full" />
            </CardContent>
          </Card>

          <Skeleton className="h-28 w-full rounded-xl" />
        </div>

        {/* Live preview pane — an A4 sheet placeholder */}
        <div className="min-w-0">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3.5 w-52" />
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-100/80 p-2.5 sm:p-4">
              <div className="space-y-3 rounded-lg bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-8 rounded-lg" />
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-16 w-28 rounded-lg" />
                </div>
                <Skeleton className="h-14 w-full rounded-lg" />
                <Skeleton className="h-24 w-full rounded-lg" />
                <div className="grid grid-cols-2 gap-3">
                  <Skeleton className="h-16 w-full rounded-lg" />
                  <Skeleton className="h-24 w-full rounded-lg" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
