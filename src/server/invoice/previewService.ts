/**
 * Invoice Preview data assembly (Invoice Preview & Print Layout V1).
 *
 * Read-only, server-side. It answers one question: "what must the preview /
 * print document show for this invoice?" — and the answer obeys the snapshot
 * law of the domain layer:
 *
 *   FINALIZED (ISSUED … PAID/OVERDUE, plus CANCELLED history): seller and
 *   customer information come EXCLUSIVELY from the immutable
 *   `InvoiceSellerSnapshot` / `InvoiceCustomerSnapshot` rows created at
 *   finalization time. Current `BusinessProfile` / `Customer` rows are never
 *   substituted, so later profile/customer edits cannot change a finalized
 *   document.
 *
 *   DRAFT: no snapshot exists yet by design, so the preview shows the CURRENT
 *   `BusinessProfile` and the live `Customer` row (the same convention the
 *   invoice detail view already uses). A preview never creates snapshots,
 *   never allocates invoice numbers and never consumes quota — this module
 *   performs no writes of any kind.
 *
 * The display model itself is NOT built here: the pure, dependency-free
 * builder lives in `@/lib/invoice-preview-model` so the editor's LIVE preview
 * (current, unsaved form state) and this server route produce exactly the same
 * document model — one visual invoice language, two data sources.
 *
 * Authorization is the existing server-side chain: `requireBusinessOwnership`
 * (session-derived account vs the Business row) proves the business is the
 * caller's, `getInvoice` proves the invoice belongs to exactly that business
 * (NotFoundError when missing, ForbiddenError when foreign). No businessId
 * or invoiceId supplied by a client is ever trusted as proof of ownership.
 *
 * Image resolution (logo / stamp / signature): snapshots and profiles store
 * *file ids*; the loader resolves those ids to public URLs through the File
 * ledger (scoped to the owning business, soft-deleted rows excluded) using
 * the existing storage adapter. Assets that were removed from storage
 * resolve to `null` and the document simply omits them — nothing is faked.
 */

import type {
  InvoiceRecord,
  InvoiceSellerSnapshotRecord,
} from "@/server/invoice/invoiceService";
import { getInvoice, getInvoiceSettings } from "@/server/invoice/invoiceService";
import { requireBusinessOwnership } from "@/server/auth/requireBusinessOwnership";
import { ForbiddenError, NotFoundError } from "@/server/auth/requireSession";
import { prisma } from "@/lib/prisma";
import { resolveFilePublicUrl } from "@/server/storage/storageService";
import {
  buildInvoicePreviewModel,
  previewSellerSourceKind,
  type InvoicePreviewModel,
  type PreviewCustomerSource,
  type PreviewImages,
  type PreviewProfileSource,
} from "@/lib/invoice-preview-model";

// The preview model (types + pure builder) is owned by `@/lib/invoice-preview-model`
// and re-exported here unchanged, so every existing consumer of this module —
// `InvoicePreviewDocument`, the preview route, the invoice editor and the
// model tests — keeps importing from the same place.
export {
  buildInvoicePreviewModel,
  previewLifecycle,
  previewSellerSourceKind,
} from "@/lib/invoice-preview-model";
export type {
  BuildInvoicePreviewModelInput,
  InvoicePreviewCustomer,
  InvoicePreviewImage,
  InvoicePreviewModel,
  InvoicePreviewSeller,
  PreviewCustomerSource,
  PreviewImages,
  PreviewLifecycle,
  PreviewProfileSource,
  PreviewSellerSourceKind,
} from "@/lib/invoice-preview-model";

// ---------------------------------------------------------------------------
// Server loader
// ---------------------------------------------------------------------------

/** Unique non-null file ids from the three business-image columns. */
function imageFileIds(source: PreviewProfileSource | InvoiceSellerSnapshotRecord | null): string[] {
  if (!source) return [];
  const ids = [source.logoFileId, source.sellerStampFileId, source.sellerSignatureFileId];
  return Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)));
}

/**
 * Resolves stored file ids to public display URLs. File rows are scoped to the
 * owning business and soft-deleted rows are excluded; ids that resolve to no
 * row (e.g. an object retired from storage) map to `url: null` so the
 * document can omit the asset without ever breaking.
 */
async function resolveImages(
  ownedBusinessId: string,
  source: PreviewProfileSource | InvoiceSellerSnapshotRecord | null,
): Promise<PreviewImages> {
  const empty: PreviewImages = { logo: null, sellerStamp: null, sellerSignature: null };
  const ids = imageFileIds(source);
  if (ids.length === 0 || !source) return empty;

  const files = (await prisma.file.findMany({
    where: { id: { in: ids }, businessId: ownedBusinessId, deletedAt: null },
    select: { id: true, storageKey: true },
  })) as unknown as { id: string; storageKey: string }[];

  const byId = new Map(files.map((file) => [file.id, file]));
  const urlOf = (fileId: string | null): string | null => {
    const file = fileId ? byId.get(fileId) : undefined;
    return file ? resolveFilePublicUrl(file.storageKey) : null;
  };

  const toRef = (fileId: string | null): { fileId: string; url: string | null } | null =>
    fileId ? { fileId, url: urlOf(fileId) } : null;

  return {
    logo: toRef(source.logoFileId),
    sellerStamp: toRef(source.sellerStampFileId),
    sellerSignature: toRef(source.sellerSignatureFileId),
  };
}

/**
 * Loads everything the invoice preview / print document needs.
 *
 * Authorization (identical contract to `getInvoice`, which this function
 * delegates to): authenticated session required; the business must belong to
 * the session account (`requireBusinessOwnership`); the invoice must belong to
 * exactly that business. Missing rows → NotFoundError, foreign rows →
 * ForbiddenError. Reads stay available for archived businesses and cancelled
 * invoices so history remains viewable — the route decides reachability.
 *
 * Read-only by construction: no writes, no quota, no numbering, no snapshot
 * creation, no preview-count consumption.
 */
export async function getInvoicePreviewData(businessId: string, invoiceId: unknown): Promise<InvoicePreviewModel> {
  // Session + business ownership. `getInvoice` below re-verifies and binds
  // the invoice to the *verified* business row, so a foreign invoiceId can
  // never leak another business' data.
  const owned = await requireBusinessOwnership(businessId);

  if (typeof invoiceId !== "string" || invoiceId.trim() === "") {
    throw new NotFoundError("Invoice not found");
  }

  const record = await getInvoice(businessId, invoiceId);

  const isDraft = record.status === "DRAFT";
  const sourceKind = previewSellerSourceKind(record);

  // Draft reads the CURRENT profile/customer/settings (no snapshot yet);
  // finalized/cancelled rows never read the profile or customer rows — only
  // the File ledger below is touched, for image URLs.
  let profile: PreviewProfileSource | null = null;
  let customer: PreviewCustomerSource | null = null;
  if (isDraft) {
    profile = (await prisma.businessProfile.findUnique({
      where: { businessId: owned.id },
    })) as unknown as PreviewProfileSource | null;

    if (record.customerId) {
      customer = (await prisma.customer.findUnique({
        where: { id: record.customerId },
      })) as unknown as PreviewCustomerSource | null;
    }
  }

  const settings = (await prisma.invoiceSettings.findUnique({
    where: { businessId: owned.id },
  })) as unknown as { currency: string | null } | null;

  // Image source: the snapshot (finalized) or the current profile (draft).
  const imageSource =
    sourceKind === "SNAPSHOT"
      ? (record.sellerSnapshot as unknown as InvoiceSellerSnapshotRecord | null)
      : profile;

  const images = await resolveImages(owned.id, imageSource);

  return buildInvoicePreviewModel({
    invoice: record,
    fallbackBusinessName: owned.name,
    currentProfile: profile,
    currentCustomer: customer,
    images,
    currency: settings?.currency ?? "IRR",
  });
}

// ---------------------------------------------------------------------------
// Draft editor live-preview context
// ---------------------------------------------------------------------------

/**
 * Everything the invoice editor needs to render a live preview of a DRAFT
 * that does not exist (or is not saved) yet.
 *
 * The editor owns the invoice content (unsaved form state), so the server only
 * supplies the *seller* half of the document — the current `BusinessProfile`
 * with its branding assets already resolved to public URLs — plus the
 * business currency. The customer half comes from the live customer rows the
 * editor already has.
 *
 * This is exactly the draft branch of `getInvoicePreviewData`'s data law,
 * lifted out of the per-invoice lookup: no invoice row is read, no snapshot is
 * consulted (drafts have none), nothing is written, no quota is touched and no
 * invoice number is allocated.
 */
export interface DraftPreviewContext {
  businessId: string;
  /** `Business.name` — last-resort letterhead name when no profile exists. */
  fallbackBusinessName: string;
  /** Current BusinessProfile row, or null when the business has no profile yet. */
  currentProfile: PreviewProfileSource | null;
  /** Resolved logo / stamp / signature urls for the current profile. */
  images: PreviewImages;
  /** InvoiceSettings currency ("IRR" when unset). */
  currency: string;
}

export async function getDraftPreviewContext(businessId: string): Promise<DraftPreviewContext> {
  const owned = await requireBusinessOwnership(businessId);

  const [profile, settings] = await Promise.all([
    prisma.businessProfile.findUnique({
      where: { businessId: owned.id },
    }) as unknown as Promise<PreviewProfileSource | null>,
    getInvoiceSettings(owned.id),
  ]);

  // Branding must never break the editor: a storage/file-ledger hiccup only
  // means the document renders without that asset (urls → null), never a
  // synthetic URL and never an error page.
  let images: PreviewImages = { logo: null, sellerStamp: null, sellerSignature: null };
  try {
    images = await resolveImages(owned.id, profile);
  } catch (error) {
    console.warn("[invoice-preview] branding assets unavailable", error);
  }

  return {
    businessId: owned.id,
    fallbackBusinessName: owned.name,
    currentProfile: profile ?? null,
    images,
    currency: settings?.currency ?? "IRR",
  };
}
