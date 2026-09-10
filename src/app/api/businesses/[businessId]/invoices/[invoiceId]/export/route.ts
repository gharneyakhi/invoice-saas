import { NextResponse, type NextRequest } from "next/server";
import { getInvoiceExportSource } from "@/server/export/exportService";
import { buildContentDisposition, type ExportFileFormat } from "@/server/export/filename";
import { entitlementHasFeature, resolveEntitlements } from "@/server/entitlements/entitlementService";
import { PDF_EXPORT_FEATURE_KEY, renderInvoicePdf } from "@/server/export/pdfService";
import { renderInvoiceImage } from "@/server/export/imageService";
import { generateInvoiceExcel } from "@/server/export/excelService";
import { ValidationError } from "@/server/errors";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/server/auth/requireSession";

export const dynamic = "force-dynamic";

/**
 * Invoice file export — `GET ?format=pdf|png|jpg|xlsx`.
 *
 * Streams a server-generated file download. Auth + snapshot selection are
 * inherited from `getInvoiceExportSource` (session → business ownership →
 * invoice membership; finalized rows expose only their immutable
 * snapshots). Every request re-verifies: knowing the URL grants nothing,
 * and responses are `no-store` so a signed-out browser back-button cannot
 * serve another user's invoice from cache.
 *
 * Error payloads match the Server Action shape
 * (`{ success: false, error: { code, message } }`) with safe messages only.
 */

const FORMATS: readonly ExportFileFormat[] = ["pdf", "png", "jpg", "xlsx"];

function normalizeFormat(value: string | null): ExportFileFormat | null {
  return value !== null && (FORMATS as readonly string[]).includes(value)
    ? (value as ExportFileFormat)
    : null;
}

function errorResponse(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { businessId: string; invoiceId: string } },
): Promise<NextResponse> {
  const format = normalizeFormat(request.nextUrl.searchParams.get("format"));
  if (!format) {
    return errorResponse("VALIDATION_ERROR", "Unsupported export format", 400);
  }

  try {
    const { model, filenames } = await getInvoiceExportSource(
      params.businessId,
      params.invoiceId,
      format,
    );
    if (format === "pdf") {
      // PDF keeps this branch's `PDF_EXPORT` entitlement gate (the export
      // engine's authorization contract); other formats inherit the
      // recovered route's contract (ownership + invoice isolation only).
      const entitlements = await resolveEntitlements();
      if (!entitlementHasFeature(entitlements, PDF_EXPORT_FEATURE_KEY)) {
        throw new ForbiddenError("PDF export is not available on the current plan");
      }
    }
    const bytes =
      format === "pdf"
        ? await renderInvoicePdf(model)
        : format === "xlsx"
          ? await generateInvoiceExcel(model)
          : await renderInvoiceImage(model, format);
    return new NextResponse(bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": filenames.mimeType,
        "Content-Disposition": buildContentDisposition(filenames),
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return errorResponse("UNAUTHORIZED", "You must be signed in", 401);
    }
    if (error instanceof ForbiddenError) {
      return errorResponse("FORBIDDEN", "You do not have permission to do this", 403);
    }
    if (error instanceof NotFoundError) {
      return errorResponse("NOT_FOUND", "Not found", 404);
    }
    if (error instanceof ValidationError) {
      return errorResponse("VALIDATION_ERROR", error.message, 400);
    }
    return errorResponse("INTERNAL_ERROR", "Export failed. Please try again.", 500);
  }
}
