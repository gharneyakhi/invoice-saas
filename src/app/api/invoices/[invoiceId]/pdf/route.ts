import { NextResponse } from "next/server";
import { listBusinesses } from "@/server/business/businessService";
import { exportInvoicePdf } from "@/server/export/pdfService";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";

/**
 * Invoice PDF download V1 — GET /api/invoices/[invoiceId]/pdf
 *
 * Streams the rendered invoice PDF as a file download. Business resolution
 * follows the same convention as the preview page (the caller's current
 * business — primary-first, session-scoped — via `listBusinesses()[0]`); no
 * businessId is ever taken from the client as proof of authorization.
 *
 * All domain law lives in `exportInvoicePdf` (business-ownership proof via
 * `getInvoicePreviewData`, finalized/draft snapshot law, `PDF_EXPORT`
 * entitlement gate, read-only). This handler only maps domain errors to HTTP
 * status codes:
 *
 *   - UnauthorizedError → 401 (session missing/expired)
 *   - ForbiddenError    → 403 (cross-business access or plan gate denial)
 *   - NotFoundError     → 404 (unknown invoice, or no active business)
 *   - anything else     → 500 (Next.js default error handling)
 *
 * The download filename comes from the service; it is sent both as an
 * ASCII-safe `filename` fallback and as an RFC 5987 `filename*` so Persian
 * invoice numbers survive Content-Disposition encoding.
 */
export const dynamic = "force-dynamic";

interface InvoicePdfRouteContext {
  params: { invoiceId: string };
}

function asciiFilenameFallback(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "-");
  return safe.length > 0 ? safe : "invoice.pdf";
}

export async function GET(
  _request: Request,
  { params }: InvoicePdfRouteContext,
): Promise<NextResponse> {
  let businesses;
  try {
    businesses = await listBusinesses();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw error;
  }

  const business = businesses[0] ?? null;
  if (!business) {
    return NextResponse.json({ error: "invoice_not_available" }, { status: 404 });
  }

  try {
    const result = await exportInvoicePdf(business.id, params.invoiceId);
    const body = new Uint8Array(result.bytes);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Length": String(body.byteLength),
        "Content-Disposition":
          `attachment; filename="${asciiFilenameFallback(result.filename)}"; ` +
          `filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (error instanceof NotFoundError) {
      return NextResponse.json({ error: "invoice_not_available" }, { status: 404 });
    }
    throw error;
  }
}
