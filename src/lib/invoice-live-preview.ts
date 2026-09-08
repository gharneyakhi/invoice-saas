/**
 * Live invoice preview for the invoice editor (unsaved form state → document).
 *
 * The editor must show what the invoice will actually look like BEFORE
 * anything is saved. This module is the bridge between the form state and the
 * ONE preview model the printable document consumes:
 *
 *   form state ─┐
 *               ├─▶ buildLivePreviewModel ─▶ InvoicePreviewModel ─▶ InvoicePreviewDocument
 * branding ─────┘      (this module)         (@/lib/invoice-preview-model)
 *
 * Guarantees this module exists to provide:
 *
 *   1. No second source of truth for money. Every number shown in the live
 *      document comes from the existing, pure calculation engine
 *      (`calculateInvoice` in `@/lib/invoice-calculation`) — the very same
 *      engine the draft save and the finalization transaction run. The editor
 *      totals (`InvoiceTotals`) and the live preview therefore agree by
 *      construction, and the server stays authoritative: this module never
 *      persists anything; it is a pure function of its inputs (no Prisma, no
 *      auth, no next imports — it is safe to call from the client).
 *
 *   2. One visual invoice language. The model is produced by the shared
 *      `buildInvoicePreviewModel`, so the live document is literally the same
 *      model and component as `/dashboard/invoices/[invoiceId]/preview`.
 *
 *   3. The draft data law. What is rendered here is always a DRAFT: the
 *      synthetic invoice row carries `status: "DRAFT"` and no snapshots, so
 *      the shared builder applies the DRAFT branch of the law (CURRENT
 *      `BusinessProfile` for the seller, the CURRENT selected customer for the
 *      buyer). Finalized/cancelled rows never go through this module — they
 *      are read-only and keep reading their immutable snapshots through
 *      `previewService.getInvoicePreviewData`.
 *
 *   4. No fabricated invoice number. `officialNumber` stays `null` and no
 *      number is invented: an unsaved invoice carries none (the document
 *      renders "—"), a saved draft carries the real `DRAFT-…` placeholder the
 *      server returned, which the shared model hides from a printable document
 *      anyway.
 *
 * Numbers are stringly-typed in the form (users may type Persian digits or
 * thousands separators), so they are normalized with the shared
 * `normalizeLocalizedNumber` — the same normalization the editor schema uses —
 * before they reach the engine.
 */

import Decimal from "decimal.js";
import { calculateInvoice, type InvoiceCalculationResult } from "@/lib/invoice-calculation";
import {
  buildInvoicePreviewModel,
  type InvoicePreviewModel,
  type PreviewImages,
  type PreviewProfileSource,
} from "@/lib/invoice-preview-model";
import { normalizeLocalizedNumber } from "@/lib/formatters";
import type { InvoiceRecord } from "@/server/invoice/invoiceService";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One invoice line exactly as the editor holds it (raw user strings). */
export interface LivePreviewItemState {
  productId: string;
  title: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
}

/** The editable part of an invoice — the same shape the editor form holds. */
export interface LivePreviewInvoiceState {
  invoiceType: "PROFORMA" | "FINAL";
  issueDate: string;
  dueDate: string;
  customerId: string;
  notes: string;
  globalDiscountPercent: string;
  taxPercent: string;
  items: LivePreviewItemState[];
}

/** The live `Customer` rows of the business, as the editor received them. */
export interface LivePreviewCustomerEntry {
  id: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationalId: string | null;
  economicCode: string | null;
}

/**
 * The server-resolved half of the live-preview context (everything except the
 * live customer rows, which the editor already holds). The invoice editor's
 * client props are typed against this, so the branding payload the server
 * renders can never drift from what the preview expects.
 */
export type LivePreviewBrandingContext = Omit<LivePreviewContext, "customers">;

/** Server-resolved, read-only context for drafting against the current business. */
export interface LivePreviewContext {
  /** `Business.id` — carried onto the model for parity with the server route. */
  businessId: string;
  /** `Business.name` — last-resort letterhead name when no profile row exists. */
  fallbackBusinessName: string;
  /** CURRENT `BusinessProfile` (draft seller source; never a snapshot). */
  currentProfile: PreviewProfileSource | null;
  /** Logo / stamp / signature urls of the current profile (null when unset). */
  images: PreviewImages;
  /** `InvoiceSettings.currency` ("IRR" by default). */
  currency: string;
  /** Live customers, used to render the buyer block for the selected id. */
  customers: LivePreviewCustomerEntry[];
}

/** Identity of an already-saved draft, so the preview matches the real row. */
export interface LivePreviewSavedDraft {
  id: string;
  /** The server's `DRAFT-…` placeholder (never displayed on the document). */
  invoiceNumber: string;
  createdAt: string;
  updatedAt: string;
}

export interface BuildLivePreviewModelInput {
  context: LivePreviewContext;
  /** Current editor form state — saved or not, this is what the user sees. */
  values: LivePreviewInvoiceState;
  /** Present only when this draft already exists in the database. */
  savedDraft?: LivePreviewSavedDraft | null;
}

// ---------------------------------------------------------------------------
// Helpers (input normalization only — never financial logic)
// ---------------------------------------------------------------------------

function num(value: string | null | undefined): string {
  return normalizeLocalizedNumber(value) || "0";
}

/** The engine rejects a non-positive quantity, so an incomplete row previews as one unit. */
function quantityForCalc(value: string | null | undefined): string {
  const parsed = normalizeLocalizedNumber(value);
  if (parsed === "" || Number(parsed) <= 0) return "1";
  return parsed;
}

/** Percent inputs are clamped to the domain range (0–100) before they reach the engine. */
function percentForCalc(value: string | null | undefined): string {
  const parsed = normalizeLocalizedNumber(value);
  if (parsed === "") return "0";
  const decimal = new Decimal(parsed);
  if (decimal.isNegative()) return "0";
  return decimal.greaterThan(100) ? "100" : parsed;
}

function toDateOrNull(value: string | null | undefined): Date | null {
  const candidate = (value ?? "").trim();
  if (candidate === "" || isNaN(Date.parse(candidate))) return null;
  return new Date(candidate);
}

function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function money(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Preview-safe totals for the CURRENT form state, produced by the shared
 * calculation engine. Never throws: an incomplete or out-of-range row is
 * clamped/neutralized so the document keeps rendering while the form-level
 * validation messages guide the user.
 */
export function calculateLivePreviewTotals(values: LivePreviewInvoiceState): InvoiceCalculationResult {
  const items =
    values.items.length > 0
      ? values.items.map((item) => ({
          unitPrice: num(item?.unitPrice),
          quantity: quantityForCalc(item?.quantity),
          discountPercent: percentForCalc(item?.discountPercent),
        }))
      : [{ unitPrice: "0", quantity: "1", discountPercent: "0" }];

  const globalDiscountPercent = percentForCalc(values.globalDiscountPercent);
  const taxPercent = percentForCalc(values.taxPercent);

  try {
    return calculateInvoice({ items, globalDiscountPercent, taxPercent });
  } catch {
    // Defensive: whatever the engine still rejects shows an all-zero document
    // instead of crashing the editor.
    return calculateInvoice({
      items: [{ unitPrice: "0", quantity: "1", discountPercent: "0" }],
      globalDiscountPercent: "0",
      taxPercent: "0",
    });
  }
}

/**
 * Builds the `InvoicePreviewModel` for the editor's live document.
 *
 * Pure: it reads no database, mutates nothing (inputs are only ever read), and
 * returns the same model shape the finalized preview route returns.
 */
export function buildLivePreviewModel(input: BuildLivePreviewModelInput): InvoicePreviewModel {
  const { context, values, savedDraft } = input;

  const totals = calculateLivePreviewTotals(values);
  const issueDate = toDateOrNull(values.issueDate) ?? new Date();
  const dueDate = toDateOrNull(values.dueDate);
  const rowId = savedDraft?.id ?? "draft-live-preview";

  // A synthetic DRAFT row carrying only what the preview model reads. Money
  // comes from the shared engine; `status: "DRAFT"` + no snapshots is what
  // makes `buildInvoicePreviewModel` apply the DRAFT half of the data law.
  const draftRecord: InvoiceRecord = {
    id: rowId,
    businessId: context.businessId,
    customerId: blankToNull(values.customerId),
    // Never invented: no number while unsaved, the server's real placeholder
    // when the draft exists (the shared model hides both from the document).
    invoiceNumber: savedDraft?.invoiceNumber ?? "",
    invoiceType: values.invoiceType,
    issueDate,
    dueDate,
    status: "DRAFT",
    subtotal: money(totals.subtotal),
    itemDiscountAmount: money(totals.itemDiscountAmount),
    globalDiscountPercent: money(totals.globalDiscountPercent),
    globalDiscountAmount: money(totals.globalDiscountAmount),
    taxPercent: money(totals.taxPercent),
    taxAmount: money(totals.taxAmount),
    taxableAmount: money(totals.taxableAmount),
    total: money(totals.total),
    paidAmount: new Decimal(0),
    remainingAmount: money(totals.total),
    notes: blankToNull(values.notes),
    createdAt: savedDraft?.createdAt ? new Date(savedDraft.createdAt) : issueDate,
    updatedAt: savedDraft?.updatedAt ? new Date(savedDraft.updatedAt) : issueDate,
    finalizedAt: null,
    cancelledAt: null,
    sellerSnapshot: null,
    customerSnapshot: null,
    items: values.items.map((item, index) => {
      const line = totals.items[index];
      return {
        id: `${rowId}-item-${index}`,
        invoiceId: rowId,
        productId: blankToNull(item?.productId),
        title: (item?.title ?? "").trim(),
        description: blankToNull(item?.description),
        itemDate: null,
        unitPrice: money(num(item?.unitPrice)),
        quantity: money(normalizeLocalizedNumber(item?.quantity) || "0"),
        unit: blankToNull(item?.unit),
        discountPercent: money(percentForCalc(item?.discountPercent)),
        discountAmount: money(line?.discountAmount ?? new Decimal(0)),
        subtotal: money(line?.subtotal ?? new Decimal(0)),
        total: money(line?.total ?? new Decimal(0)),
        sortOrder: index,
      };
    }),
  };

  // The buyer block reflects the *selected* live customer, so changing the
  // customer in the form updates the document without a round-trip.
  const selectedCustomer = values.customerId
    ? context.customers.find((customer) => customer.id === values.customerId) ?? null
    : null;

  return buildInvoicePreviewModel({
    invoice: draftRecord,
    fallbackBusinessName: context.fallbackBusinessName,
    currentProfile: context.currentProfile,
    currentCustomer: selectedCustomer,
    images: context.images,
    currency: context.currency,
  });
}
