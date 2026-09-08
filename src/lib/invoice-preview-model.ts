/**
 * The single, pure invoice-preview model (Invoice Preview & Print Layout V1).
 *
 * This module is the ONLY place where "what the invoice document shows" is
 * decided. It is deliberately dependency-free (no Prisma, no auth, no next
 * imports) so that BOTH presentation paths share one model and therefore one
 * visual invoice language:
 *
 *   - the server-rendered route `/dashboard/invoices/[invoiceId]/preview`
 *     (assembled by `previewService.getInvoicePreviewData`), and
 *   - the editor's LIVE preview, which feeds the current, unsaved form state
 *     into the very same builder (`@/lib/invoice-live-preview`).
 *
 * Data-source law (the snapshot rule of the domain, kept here explicitly):
 *
 *   FINALIZED (ISSUED … PAID/OVERDUE) and CANCELLED rows read seller and
 *   customer data EXCLUSIVELY from the immutable `InvoiceSellerSnapshot` /
 *   `InvoiceCustomerSnapshot` created at finalization. Current
 *   `BusinessProfile` / `Customer` rows are never substituted for them.
 *
 *   DRAFT rows have no snapshot yet by design, so they read the CURRENT
 *   `BusinessProfile` and the live `Customer` row.
 *
 * Nothing here writes, allocates invoice numbers, consumes quota or computes
 * money: monetary values arrive on the `InvoiceRecord` (server-authoritative)
 * or are handed in by a caller that ran them through the shared calculation
 * engine `@/lib/invoice-calculation`.
 */

import type {
  InvoiceCustomerSnapshotRecord,
  InvoiceRecord,
  InvoiceSellerSnapshotRecord,
} from "@/server/invoice/invoiceService";
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
  footerBackgroundColor: string | null;
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
  /**
   * Display currency: live InvoiceSettings for drafts, the invoice's own
   * snapshot for finalized/cancelled rows (default "IRR").
   */
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
  footerBackgroundColor: string | null;
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
  /** Display currency already resolved by the caller (settings vs snapshot). */
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
      footerBackgroundColor: blankToNull(s.footerBackgroundColor),
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
      footerBackgroundColor: blankToNull(currentProfile.footerBackgroundColor),
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
      footerBackgroundColor: null,
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
