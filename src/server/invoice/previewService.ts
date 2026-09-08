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
  InvoiceCustomerSnapshotRecord,
  InvoiceRecord,
  InvoiceSellerSnapshotRecord,
} from "@/server/invoice/invoiceService";
import { getInvoice } from "@/server/invoice/invoiceService";
import { requireBusinessOwnership } from "@/server/auth/requireBusinessOwnership";
import { ForbiddenError, NotFoundError } from "@/server/auth/requireSession";
import { prisma } from "@/lib/prisma";
import { resolveFilePublicUrl } from "@/server/storage/storageService";
import { toInvoiceDetailDTO, type InvoiceDetailDTO } from "@/server/actions/dto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One resolved profile/snapshot image: its file id and display URL (if any). */
export interface InvoicePreviewImage {
  fileId: string;
  url: string | null;
}

/** Seller block of the preview document. */
export interface InvoicePreviewSeller {
  /** Where the values came from — SNAPSHOT for finalized, PROFILE for drafts. */
  source: "SNAPSHOT" | "PROFILE";
  businessName: string;
  slogan: string | null;
  ownerName: string | null;
  address: string | null;
  email: string | null;
  mobile: string | null;
  landline: string | null;
  cardNumber: string | null;
  accountNumber: string | null;
  iban: string | null;
  primaryColor: string | null;
  footerText: string | null;
  logo: InvoicePreviewImage | null;
  sellerStamp: InvoicePreviewImage | null;
  sellerSignature: InvoicePreviewImage | null;
}

/** Customer block of the preview document. */
export interface InvoicePreviewCustomer {
  name: string;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationalId: string | null;
  economicCode: string | null;
}

/** Display-ready payload for the preview route / document component. */
export interface InvoicePreviewModel {
  invoice: InvoiceDetailDTO;
  businessId: string;
  /** DRAFT while editable, FINALIZED once issued/sent/paid, CANCELLED for history. */
  lifecycle: "DRAFT" | "FINALIZED" | "CANCELLED";
  isDraft: boolean;
  /**
   * Official invoice number for finalized rows; `null` for drafts (a draft
   * carries a `DRAFT-<uuid>` placeholder that must never appear on a
   * printable document — the UI shows "—" instead).
   */
  officialNumber: string | null;
  /** Seller block (snapshot for finalized, current profile for drafts). */
  seller: InvoicePreviewSeller | null;
  /** Customer block (snapshot for finalized, live row for drafts). */
  customer: InvoicePreviewCustomer | null;
  /** Currency code from InvoiceSettings (default "IRR"); not snapshotted. */
  currency: string;
}

/** Minimal structural shape of a current `BusinessProfile` row (draft source). */
export interface PreviewProfileSource {
  businessName: string;
  slogan: string | null;
  ownerName: string | null;
  address: string | null;
  email: string | null;
  mobile: string | null;
  landline: string | null;
  cardNumber: string | null;
  accountNumber: string | null;
  iban: string | null;
  logoFileId: string | null;
  sellerStampFileId: string | null;
  sellerSignatureFileId: string | null;
  primaryColor: string | null;
  footerText: string | null;
}

/** Minimal structural shape of a live `Customer` row (draft source). */
export interface PreviewCustomerSource {
  name: string;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationalId: string | null;
  economicCode: string | null;
}

/** File ids + resolved urls for the three business images. */
export interface PreviewImages {
  logo: { fileId: string; url: string | null } | null;
  sellerStamp: { fileId: string; url: string | null } | null;
  sellerSignature: { fileId: string; url: string | null } | null;
}

export type PreviewLifecycle = InvoicePreviewModel["lifecycle"];

/** Seller source of an invoice row: snapshot when one exists, else profile. */
export type PreviewSellerSourceKind = "SNAPSHOT" | "PROFILE";

export function previewLifecycle(status: string, finalizedAt: Date | null): PreviewLifecycle {
  if (status === "DRAFT") return "DRAFT";
  if (status === "CANCELLED") return "CANCELLED";
  if (finalizedAt !== null && status !== "DRAFT") return "FINALIZED";
  // A finalized row always carries finalizedAt; anything else is defensive.
  return status === "CANCELLED" ? "CANCELLED" : finalizedAt !== null ? "FINALIZED" : "DRAFT";
}

/**
 * Which seller data source the preview must use for a given invoice:
 * finalized / cancelled rows read their immutable snapshot; drafts (which
 * have no snapshot yet) read the current BusinessProfile.
 */
export function previewSellerSourceKind(invoice: Pick<InvoiceRecord, "status" | "finalizedAt" | "sellerSnapshot">): PreviewSellerSourceKind {
  return invoice.sellerSnapshot ? "SNAPSHOT" : "PROFILE";
}

// ---------------------------------------------------------------------------
// Pure model builder (unit-testable, no DB)
// ---------------------------------------------------------------------------

export interface BuildInvoicePreviewModelInput {
  invoice: InvoiceRecord;
  /** Business.name — used only as the last-resort display name for drafts. */
  fallbackBusinessName: string;
  /** Current BusinessProfile row (draft seller source; ignored for finalized). */
  currentProfile: PreviewProfileSource | null;
  /** Live Customer row (draft customer source; ignored for finalized). */
  currentCustomer: PreviewCustomerSource | null;
  /** Resolved image URLs for whichever seller source applies. */
  images: PreviewImages;
  /** Currency label from InvoiceSettings ("IRR" default). */
  currency: string;
}

function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toImage(ref: { fileId: string; url: string | null } | null): InvoicePreviewImage | null {
  return ref ? { fileId: ref.fileId, url: ref.url } : null;
}

/**
 * Builds the display model for the preview document.
 *
 * Data-source law (the reason this milestone exists):
 *   - DRAFT  → seller = current BusinessProfile (falling back to the business
 *              name alone when no profile row exists yet), customer = the
 *              live Customer row;
 *   - FINALIZED / CANCELLED → seller = InvoiceSellerSnapshot and customer =
 *              InvoiceCustomerSnapshot, verbatim. If a later profile edit
 *              changed the name/logo/address/bank details or the customer
 *              row changed, this model still shows the finalization-time
 *              values (covered by the snapshot-regression tests).
 *
 * Everything monetary is carried by the shared `toInvoiceDetailDTO` mapping
 * (Decimal → exact string); the UI never performs financial math.
 */
export function buildInvoicePreviewModel(input: BuildInvoicePreviewModelInput): InvoicePreviewModel {
  const { invoice, fallbackBusinessName, currentProfile, currentCustomer, images, currency } = input;
  const sellerSourceKind = previewSellerSourceKind(invoice);
  const isDraft = invoice.status === "DRAFT";

  let seller: InvoicePreviewSeller | null = null;

  if (sellerSourceKind === "SNAPSHOT" && invoice.sellerSnapshot) {
    const s = invoice.sellerSnapshot as InvoiceSellerSnapshotRecord;
    seller = {
      source: "SNAPSHOT",
      businessName: s.businessName,
      slogan: blankToNull(s.slogan),
      ownerName: blankToNull(s.ownerName),
      address: blankToNull(s.address),
      email: blankToNull(s.email),
      mobile: blankToNull(s.mobile),
      landline: blankToNull(s.landline),
      cardNumber: blankToNull(s.cardNumber),
      accountNumber: blankToNull(s.accountNumber),
      iban: blankToNull(s.iban),
      primaryColor: blankToNull(s.primaryColor),
      footerText: blankToNull(s.footerText),
      logo: images.logo ? toImage(images.logo) : null,
      sellerStamp: images.sellerStamp ? toImage(images.sellerStamp) : null,
      sellerSignature: images.sellerSignature ? toImage(images.sellerSignature) : null,
    };
  } else if (isDraft && currentProfile) {
    seller = {
      source: "PROFILE",
      businessName: currentProfile.businessName || fallbackBusinessName,
      slogan: blankToNull(currentProfile.slogan),
      ownerName: blankToNull(currentProfile.ownerName),
      address: blankToNull(currentProfile.address),
      email: blankToNull(currentProfile.email),
      mobile: blankToNull(currentProfile.mobile),
      landline: blankToNull(currentProfile.landline),
      cardNumber: blankToNull(currentProfile.cardNumber),
      accountNumber: blankToNull(currentProfile.accountNumber),
      iban: blankToNull(currentProfile.iban),
      primaryColor: blankToNull(currentProfile.primaryColor),
      footerText: blankToNull(currentProfile.footerText),
      logo: images.logo ? toImage(images.logo) : null,
      sellerStamp: images.sellerStamp ? toImage(images.sellerStamp) : null,
      sellerSignature: images.sellerSignature ? toImage(images.sellerSignature) : null,
    };
  } else if (isDraft && !currentProfile) {
    // No profile row yet — a valid state for a brand-new business. The
    // letterhead still shows the registered business name and nothing else
    // (no fake contact/bank details are invented).
    seller = {
      source: "PROFILE",
      businessName: fallbackBusinessName,
      slogan: null,
      ownerName: null,
      address: null,
      email: null,
      mobile: null,
      landline: null,
      cardNumber: null,
      accountNumber: null,
      iban: null,
      primaryColor: null,
      footerText: null,
      logo: null,
      sellerStamp: null,
      sellerSignature: null,
    };
  }
  // Defensive: a non-draft row without a snapshot has no trustworthy seller
  // data — seller stays null and the UI falls back to plain business name.

  let customer: InvoicePreviewCustomer | null = null;
  if (isDraft) {
    if (currentCustomer) {
      customer = {
        name: currentCustomer.name,
        mobile: blankToNull(currentCustomer.mobile),
        phone: blankToNull(currentCustomer.phone),
        email: blankToNull(currentCustomer.email),
        address: blankToNull(currentCustomer.address),
        nationalId: blankToNull(currentCustomer.nationalId),
        economicCode: blankToNull(currentCustomer.economicCode),
      };
    }
  } else if (invoice.customerSnapshot) {
    const c = invoice.customerSnapshot as InvoiceCustomerSnapshotRecord;
    customer = {
      name: c.name,
      mobile: blankToNull(c.mobile),
      phone: blankToNull(c.phone),
      email: blankToNull(c.email),
      address: blankToNull(c.address),
      nationalId: blankToNull(c.nationalId),
      economicCode: blankToNull(c.economicCode),
    };
  }

  const lifecycle = previewLifecycle(invoice.status, invoice.finalizedAt);
  const isDraftInvoice = lifecycle === "DRAFT";

  return {
    invoice: toInvoiceDetailDTO(invoice),
    businessId: invoice.businessId,
    lifecycle,
    isDraft: isDraftInvoice,
    officialNumber: isDraftInvoice ? null : invoice.invoiceNumber,
    seller,
    customer,
    currency: currency || "IRR",
  };
}

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
 * the session account (`requireBusinessOwnership`); the invoice must belong
 * to exactly that business. Missing rows → NotFoundError, foreign rows →
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
