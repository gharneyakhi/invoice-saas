import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import {
  calculateInvoice,
  calculateRemainingAmount,
  derivePaymentStatus,
  type InvoiceCalculationInput,
} from "@/lib/invoice-calculation";
import { requireSession, ForbiddenError, NotFoundError } from "@/server/auth/requireSession";
import { requireBusinessOwnership } from "@/server/auth/requireBusinessOwnership";
import { InvoiceLimitReachedError, ValidationError } from "@/server/errors";
import { resolveEntitlements } from "@/server/entitlements/entitlementService";
import { ensureCurrentUsagePeriod } from "@/server/entitlements/usagePeriodService";
import {
  formatOfficialInvoiceNumber,
  generateDraftInvoiceNumber,
  parseCreateDraftInvoiceInput,
  parseUpdateDraftInvoiceInput,
  type CreateDraftInvoiceInput,
} from "@/server/invoice/schema";
import { normalizeInvoiceCurrency } from "@/lib/currency";
import { canDuplicateInvoice } from "@/lib/entitlements";

/**
 * Row shape of an invoice line item (mirrors `model InvoiceItem` in
 * `prisma/schema.prisma`). Declared locally so the service can be used and
 * tested independently of Prisma client generation.
 */
export interface InvoiceItemRecord {
  id: string;
  invoiceId: string;
  productId: string | null;
  title: string;
  description: string | null;
  itemDate: Date | null;
  unitPrice: Decimal;
  quantity: Decimal;
  unit: string | null;
  discountPercent: Decimal;
  discountAmount: Decimal;
  subtotal: Decimal;
  total: Decimal;
  sortOrder: number;
}

/**
 * Row shape of an immutable seller snapshot taken at finalization time.
 */
export interface InvoiceSellerSnapshotRecord {
  id: string;
  invoiceId: string;
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

/**
 * Row shape of an immutable customer snapshot taken at finalization time.
 */
export interface InvoiceCustomerSnapshotRecord {
  id: string;
  invoiceId: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationalId: string | null;
  economicCode: string | null;
}

/**
 * Row shape of an invoice (mirrors `model Invoice` in `prisma/schema.prisma`).
 */
export interface InvoiceRecord {
  id: string;
  businessId: string;
  customerId: string | null;
  invoiceNumber: string;
  invoiceType: "PROFORMA" | "FINAL";
  issueDate: Date;
  dueDate: Date | null;
  status:
    | "DRAFT"
    | "ISSUED"
    | "SENT"
    | "PENDING_PAYMENT"
    | "PARTIALLY_PAID"
    | "PAID"
    | "OVERDUE"
    | "CANCELLED";
  subtotal: Decimal;
  itemDiscountAmount: Decimal;
  globalDiscountPercent: Decimal;
  globalDiscountAmount: Decimal;
  taxPercent: Decimal;
  taxAmount: Decimal;
  taxableAmount: Decimal;
  total: Decimal;
  paidAmount: Decimal;
  remainingAmount: Decimal;
  /** Snapshotted at finalization from InvoiceSettings.currency; drafts stay null. */
  currency: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt: Date | null;
  cancelledAt: Date | null;
  items?: InvoiceItemRecord[];
  sellerSnapshot?: InvoiceSellerSnapshotRecord | null;
  customerSnapshot?: InvoiceCustomerSnapshotRecord | null;
}

/**
 * Stable, meaningful order for invoice lists: newest created first, with `id`
 * as a final tie-breaker so two invoices created in the same millisecond never
 * swap places between requests (deterministic ordering for UI lists).
 */
export const INVOICE_LIST_ORDER_BY = [
  { createdAt: "desc" as const },
  { id: "asc" as const },
];

export interface ListInvoicesOptions {
  /**
   * Optional status filter (e.g. `DRAFT` to list drafts, `PAID` for settled
   * invoices). When omitted every invoice of the business is returned.
   */
  status?: InvoiceRecord["status"];
  /**
   * Hard cap on rows returned (never more than this default of 200), so an
   * invoice list can never become an unbounded `SELECT *`.
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Invoice list query (Invoice List V1) — search / filter / sort / paginate
// ---------------------------------------------------------------------------

/** Sort keys the invoice list UI is allowed to ask for (allow-list, never raw SQL). */
export const INVOICE_SORT_KEYS = ["createdAt", "issueDate", "dueDate", "total", "invoiceNumber"] as const;
export type InvoiceSortKey = (typeof INVOICE_SORT_KEYS)[number];
export type InvoiceSortDirection = "asc" | "desc";

/** Lifecycle grouping used by the list UI's primary tabs. */
export type InvoiceLifecycleFilter = "ALL" | "DRAFT" | "FINALIZED" | "CANCELLED";

export const INVOICE_LIST_DEFAULT_PAGE_SIZE = 20;
export const INVOICE_LIST_MAX_PAGE_SIZE = 100;

export interface QueryInvoicesOptions {
  /** Free-text search over invoice number, customer name and notes. */
  search?: string;
  /** Exact payment/lifecycle statuses to include (allow-listed by the caller's schema). */
  statuses?: InvoiceRecord["status"][];
  /** Draft vs finalized vs cancelled grouping. */
  lifecycle?: InvoiceLifecycleFilter;
  /** PROFORMA / FINAL filter. */
  invoiceType?: InvoiceRecord["invoiceType"];
  /** Restrict to one customer of the same business. */
  customerId?: string;
  /** Issue-date window (inclusive lower / upper bound). */
  issuedFrom?: Date;
  issuedTo?: Date;
  sortBy?: InvoiceSortKey;
  sortDirection?: InvoiceSortDirection;
  /** 1-based page number. */
  page?: number;
  /** Rows per page, hard-capped at {@link INVOICE_LIST_MAX_PAGE_SIZE}. */
  pageSize?: number;
}

/** One row of the invoice list, plus the (current) customer name for display. */
export interface InvoiceListRow extends InvoiceRecord {
  customerName: string | null;
}

export interface InvoiceListResult {
  rows: InvoiceListRow[];
  /** Total rows matching the filters (not just this page). */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Counts per lifecycle group for the *unfiltered* business, for the tabs. */
  lifecycleCounts: { all: number; draft: number; finalized: number; cancelled: number };
}

const FINALIZED_STATUSES: InvoiceRecord["status"][] = [
  "ISSUED",
  "SENT",
  "PENDING_PAYMENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
];

/**
 * Turns the inclusive "issued up to" day the user picked into an *exclusive*
 * upper bound one day later.
 *
 * `issueDate` is a timestamp, not a date: invoices created without an explicit
 * issue date are stored with the full current time (`new Date()`), while the
 * editor's `YYYY-MM-DD` input parses to midnight UTC. A naive `lte: 2026-03-01`
 * would therefore silently exclude every invoice issued *during* 2026-03-01.
 * Comparing `< 2026-03-02T00:00Z` keeps the filter inclusive of the whole day,
 * matching the UTC day boundary the write path already uses.
 *
 * A bound that already carries a time component (an explicit ISO timestamp) is
 * left exactly as given.
 */
function exclusiveUpperBound(issuedTo: Date): Date {
  const isMidnightUtc =
    issuedTo.getUTCHours() === 0 &&
    issuedTo.getUTCMinutes() === 0 &&
    issuedTo.getUTCSeconds() === 0 &&
    issuedTo.getUTCMilliseconds() === 0;

  if (!isMidnightUtc) return issuedTo;

  const next = new Date(issuedTo.getTime());
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function lifecycleWhere(lifecycle: InvoiceLifecycleFilter | undefined) {
  switch (lifecycle) {
    case "DRAFT":
      return { status: "DRAFT" as const };
    case "FINALIZED":
      return { status: { in: FINALIZED_STATUSES } };
    case "CANCELLED":
      return { status: "CANCELLED" as const };
    default:
      return {};
  }
}

/**
 * Search / filter / sort / paginate the invoices of a business the caller owns.
 *
 * Ownership is proven by `requireBusinessOwnership(businessId)` and the query is
 * scoped to the verified row's `id`, so a foreign `businessId` can never widen
 * the result set. Every user-controllable knob is sanitised here:
 *
 *   - `sortBy` is matched against an allow-list ({@link INVOICE_SORT_KEYS});
 *   - `pageSize` is clamped to {@link INVOICE_LIST_MAX_PAGE_SIZE} so the list
 *     can never become an unbounded `SELECT *`;
 *   - `customerId` is intersected with the same business, so filtering by a
 *     foreign customer simply yields nothing rather than leaking rows.
 *
 * No line items or snapshots are loaded — only the summary columns the list
 * renders, plus the customer's current name.
 */
export async function queryInvoices(
  businessId: string,
  options: QueryInvoicesOptions = {},
): Promise<InvoiceListResult> {
  const owned = await requireBusinessOwnership(businessId);

  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? INVOICE_LIST_DEFAULT_PAGE_SIZE, INVOICE_LIST_MAX_PAGE_SIZE),
  );
  const page = Math.max(1, Math.floor(options.page ?? 1));

  const sortBy: InvoiceSortKey = INVOICE_SORT_KEYS.includes(options.sortBy as InvoiceSortKey)
    ? (options.sortBy as InvoiceSortKey)
    : "createdAt";
  const sortDirection: InvoiceSortDirection = options.sortDirection === "asc" ? "asc" : "desc";

  const search = (options.search ?? "").trim();

  const where: Record<string, unknown> = {
    businessId: owned.id, // verified row id — never the raw client value
    ...lifecycleWhere(options.lifecycle),
  };

  if (options.statuses && options.statuses.length > 0) {
    // Intersect with the lifecycle grouping instead of overwriting it.
    where.AND = [
      ...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []),
      { status: { in: options.statuses } },
    ];
  }

  if (options.invoiceType) {
    where.invoiceType = options.invoiceType;
  }

  if (options.customerId) {
    where.customerId = options.customerId;
  }

  if (options.issuedFrom || options.issuedTo) {
    where.issueDate = {
      ...(options.issuedFrom ? { gte: options.issuedFrom } : {}),
      ...(options.issuedTo ? { lt: exclusiveUpperBound(options.issuedTo) } : {}),
    };
  }

  if (search !== "") {
    where.OR = [
      { invoiceNumber: { contains: search, mode: "insensitive" } },
      { notes: { contains: search, mode: "insensitive" } },
      { customer: { is: { name: { contains: search, mode: "insensitive" } } } },
    ];
  }

  // Deterministic ordering: the requested key first, `id` always last so rows
  // never swap places between pages when the sort key ties.
  const orderBy =
    sortBy === "createdAt"
      ? [{ createdAt: sortDirection }, { id: "asc" as const }]
      : [{ [sortBy]: sortDirection }, { createdAt: "desc" as const }, { id: "asc" as const }];

  const baseWhere = { businessId: owned.id };

  const [total, rows, draftCount, finalizedCount, cancelledCount, allCount] = await Promise.all([
    prisma.invoice.count({ where: where as never }),
    prisma.invoice.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { customer: { select: { name: true } } },
    } as never),
    prisma.invoice.count({ where: { ...baseWhere, status: "DRAFT" } }),
    prisma.invoice.count({ where: { ...baseWhere, status: { in: FINALIZED_STATUSES } } }),
    prisma.invoice.count({ where: { ...baseWhere, status: "CANCELLED" } }),
    prisma.invoice.count({ where: baseWhere }),
  ]);

  const pageCount = total === 0 ? 0 : Math.ceil(total / pageSize);

  return {
    rows: (rows as unknown as (InvoiceRecord & { customer?: { name: string } | null })[]).map(
      (row) => {
        const { customer, ...rest } = row;
        return { ...(rest as InvoiceRecord), customerName: customer?.name ?? null };
      },
    ),
    total,
    page,
    pageSize,
    pageCount,
    lifecycleCounts: {
      all: allCount,
      draft: draftCount,
      finalized: finalizedCount,
      cancelled: cancelledCount,
    },
  };
}

function assertInvoiceId(invoiceId: unknown): string {
  if (typeof invoiceId !== "string" || invoiceId.trim() === "") {
    throw new ValidationError("Invoice ID is required");
  }
  return invoiceId;
}

// ---------------------------------------------------------------------------
// Shared draft-reference guards (used by both createDraftInvoice and
// updateDraftInvoice — the two paths must apply exactly the same
// cross-business / archive rules so a draft can never be created *or* edited
// into referencing another account's rows).
// ---------------------------------------------------------------------------

/**
 * Verifies that a referenced customer exists, belongs to the exact same
 * business and is not archived. Distinct errors match the rest of the domain
 * layer: missing → NotFoundError, foreign business → ForbiddenError,
 * archived → ValidationError.
 */
async function assertCustomerReference(
  tx: Prisma.TransactionClient,
  businessId: string,
  customerId: string,
): Promise<void> {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
  });

  if (!customer) {
    throw new NotFoundError("Customer not found");
  }

  if (customer.businessId !== businessId) {
    throw new ForbiddenError("Customer does not belong to this business");
  }

  if (customer.archivedAt !== null) {
    throw new ValidationError("Cannot reference an archived customer");
  }
}

/**
 * Verifies that every referenced product exists, belongs to the exact same
 * business and is not archived. Unique-de-duplicates ids before querying.
 */
async function assertProductReferences(
  tx: Prisma.TransactionClient,
  businessId: string,
  items: readonly { productId?: string | null }[],
): Promise<void> {
  const productIds = Array.from(
    new Set(items.map((item) => item.productId).filter((id): id is string => Boolean(id))),
  );

  if (productIds.length === 0) {
    return;
  }

  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
  });

  if (products.length !== productIds.length) {
    throw new NotFoundError("One or more referenced products were not found");
  }

  for (const product of products) {
    if (product.businessId !== businessId) {
      throw new ForbiddenError("Product does not belong to this business");
    }
    if (product.archivedAt !== null) {
      throw new ValidationError("Cannot reference an archived product");
    }
  }
}

/**
 * Resolves the effective VAT rate for a draft: an explicit per-invoice
 * `taxPercent` wins, otherwise the business `InvoiceSettings.defaultVatPercent`,
 * otherwise 0. Never trusts a client-supplied tax *amount*.
 */
async function resolveDraftTaxPercent(
  tx: Prisma.TransactionClient,
  businessId: string,
  explicitTaxPercent: Decimal.Value | undefined,
): Promise<Decimal.Value> {
  if (explicitTaxPercent !== undefined) {
    return explicitTaxPercent;
  }

  const settings = await tx.invoiceSettings.findUnique({
    where: { businessId },
  });

  return settings?.defaultVatPercent ?? 0;
}

/**
 * Lists the invoices of a business the caller owns, newest first.
 *
 * Ownership is proven by `requireBusinessOwnership(businessId)` — the invoice
 * query is scoped to the verified Business row's `id`, so a caller can never
 * read another account's invoices by supplying a foreign `businessId`.
 *
 * Deliberately narrow: no `items`, snapshots or payments are loaded, and the
 * result is capped by `ListInvoicesOptions.limit` (default 200). A dashboard /
 * list view rarely needs full line items; callers that do should use
 * `getInvoice` for a single row.
 */
export async function listInvoices(
  businessId: string,
  options: ListInvoicesOptions = {},
): Promise<InvoiceRecord[]> {
  const owned = await requireBusinessOwnership(businessId);
  const limit = options.limit === undefined ? 200 : Math.max(1, Math.min(options.limit, 200));

  return (await prisma.invoice.findMany({
    where: {
      businessId: owned.id, // the verified row's id, never the raw client value
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: INVOICE_LIST_ORDER_BY,
    take: limit,
  })) as unknown as InvoiceRecord[];
}

/**
 * Returns a single invoice of a business the caller owns, together with its
 * line items and immutable snapshots (enough to render a full invoice view).
 *
 * Distinct errors, matching the rest of the domain layer: a missing invoice →
 * `NotFoundError`; a row that exists but belongs to a different Business (e.g.
 * another account's) → `ForbiddenError`. Reads stay available for cancelled
 * invoices and archived businesses so history remains viewable.
 */
export async function getInvoice(
  businessId: string,
  invoiceId: unknown,
): Promise<InvoiceRecord> {
  const owned = await requireBusinessOwnership(businessId);
  const id = assertInvoiceId(invoiceId);

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      sellerSnapshot: true,
      customerSnapshot: true,
    },
  });

  if (!invoice) {
    throw new NotFoundError("Invoice not found");
  }

  if (invoice.businessId !== owned.id) {
    throw new ForbiddenError("Invoice does not belong to this business");
  }

  return invoice as unknown as InvoiceRecord;
}

/**
 * Creates a DRAFT invoice for the specified business.
 *
 * Authorization & Business Isolation Rules:
 *   1. Requires an active authenticated session (`requireSession()`).
 *   2. Proves business ownership server-side (`business.accountId === session.accountId`).
 *   3. Rejects creation if the business is archived.
 *   4. References to Customer or Product rows must belong to the exact same business
 *      and must not be archived. Cross-business references are rejected with `ForbiddenError`.
 *
 * Money & Calculation Rules:
 *   5. Never trusts client-supplied totals/subtotals/discounts/taxes. All monetary
 *      values are recalculated server-side via the pure `calculateInvoice()` engine
 *      using Decimal arithmetic.
 *
 * Draft Invariants:
 *   6. Status is ALWAYS `DRAFT`.
 *   7. Uses a safe unique draft placeholder (`DRAFT-<UUID>`) that satisfies the
 *      `(businessId, invoiceNumber)` uniqueness constraint without colliding.
 *   8. Does NOT consume or advance `InvoiceSettings.nextInvoiceNumber`.
 *   9. Does NOT consume invoice quota or touch `UsagePeriod`.
 *  10. Does NOT create immutable seller/customer snapshots (snapshots belong to finalization).
 *  11. Does NOT create payment records.
 *
 * Transactional Persistence:
 *  12. The Invoice and all its InvoiceItems are persisted atomically in a single
 *      interactive transaction (`prisma.$transaction`), and every query uses
 *      the transaction client (`tx`).
 */
export async function createDraftInvoice(
  businessIdOrInput: string | CreateDraftInvoiceInput | unknown,
  maybeInput?: unknown,
): Promise<InvoiceRecord> {
  let rawPayload: unknown;
  if (typeof businessIdOrInput === "string") {
    rawPayload =
      typeof maybeInput === "object" && maybeInput !== null
        ? { ...maybeInput, businessId: businessIdOrInput }
        : { businessId: businessIdOrInput };
  } else {
    rawPayload = businessIdOrInput;
  }

  // Preserve authentication before validation (matches businessService convention)
  const session = await requireSession();
  const data = parseCreateDraftInvoiceInput(rawPayload);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Verify business ownership and state
    const business = await tx.business.findUnique({
      where: { id: data.businessId },
    });

    if (!business) {
      throw new NotFoundError("Business not found");
    }

    if (business.accountId !== session.accountId) {
      throw new ForbiddenError("Business does not belong to this account");
    }

    if (business.archivedAt !== null) {
      throw new ValidationError("Cannot create draft invoice for an archived business");
    }

    // 2. Verify customer (if provided)
    if (data.customerId) {
      await assertCustomerReference(tx, business.id, data.customerId);
    }

    // 3. Verify products (if referenced by line items)
    await assertProductReferences(tx, business.id, data.items);

    // 4. Resolve tax rate (explicit taxPercent > business defaultVatPercent > 0)
    const taxPercent = await resolveDraftTaxPercent(tx, business.id, data.taxPercent);

    // 5. Authoritative recalculation via pure calculation engine
    const calculationInput: InvoiceCalculationInput = {
      items: data.items.map((item) => ({
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discountPercent: item.discountPercent ?? 0,
      })),
      globalDiscountPercent: data.globalDiscountPercent ?? 0,
      taxPercent,
    };

    const calcResult = calculateInvoice(calculationInput);

    // 6. Safe unique draft placeholder (never advances nextInvoiceNumber)
    const draftInvoiceNumber = generateDraftInvoiceNumber();

    // 7. Parse issue and due dates
    const issueDate = data.issueDate ? new Date(data.issueDate) : new Date();
    const dueDate = data.dueDate ? new Date(data.dueDate) : null;

    // 8. Persist Invoice + InvoiceItems atomically
    const invoice = await tx.invoice.create({
      data: {
        businessId: business.id,
        customerId: data.customerId ?? null,
        invoiceNumber: draftInvoiceNumber,
        invoiceType: data.invoiceType ?? "FINAL",
        issueDate,
        dueDate,
        status: "DRAFT",
        subtotal: calcResult.subtotal,
        itemDiscountAmount: calcResult.itemDiscountAmount,
        globalDiscountPercent: calcResult.globalDiscountPercent,
        globalDiscountAmount: calcResult.globalDiscountAmount,
        taxPercent: calcResult.taxPercent,
        taxAmount: calcResult.taxAmount,
        taxableAmount: calcResult.taxableAmount,
        total: calcResult.total,
        paidAmount: new Decimal(0),
        remainingAmount: calcResult.total,
        notes: data.notes ?? null,
        items: {
          create: data.items.map((item, index) => {
            const lineCalc = calcResult.items[index];
            const itemDate = item.itemDate ? new Date(item.itemDate) : null;
            return {
              productId: item.productId ?? null,
              title: item.title,
              description: item.description ?? null,
              itemDate,
              unitPrice: new Decimal(item.unitPrice),
              quantity: new Decimal(item.quantity),
              unit: item.unit ?? null,
              discountPercent: new Decimal(item.discountPercent ?? 0),
              discountAmount: lineCalc!.discountAmount,
              subtotal: lineCalc!.subtotal,
              total: lineCalc!.total,
              sortOrder: item.sortOrder ?? index,
            };
          }),
        },
      },
      include: {
        items: {
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    return invoice as unknown as InvoiceRecord;
  });
}

/**
 * Row shape of a business' invoice settings (defaults applied when drafting).
 */
export interface InvoiceSettingsRecord {
  id: string;
  businessId: string;
  invoicePrefix: string | null;
  nextInvoiceNumber: number;
  defaultVatPercent: Decimal;
  currency: string;
  calendar: "JALALI" | "GREGORIAN";
  defaultTemplate: string;
}

/**
 * Returns the invoice settings of a business the caller owns (or null when the
 * row is absent), so the invoice editor can pre-fill defaults (VAT percent,
 * currency). Read-only — it never exposes or mutates `nextInvoiceNumber`
 * beyond returning the raw row, and official numbering remains owned by
 * finalization.
 */
export async function getInvoiceSettings(businessId: string): Promise<InvoiceSettingsRecord | null> {
  const owned = await requireBusinessOwnership(businessId);

  const settings = await prisma.invoiceSettings.findUnique({
    where: { businessId: owned.id },
  });

  return (settings as unknown as InvoiceSettingsRecord | null) ?? null;
}

/**
 * Replaces the editable content of an existing DRAFT invoice.
 *
 * Authorization & Business Isolation Rules:
 *   1. Requires an active authenticated session (`requireSession()`).
 *   2. Proves the business belongs to the session account, and that the
 *      invoice belongs to exactly that business. Cross-business / cross-account
 *      references are rejected (`ForbiddenError`).
 *   3. Rejects edits when the business is archived.
 *
 * Lifecycle Rules (draft editing contract):
 *   4. ONLY invoices in `DRAFT` status can be edited. Finalized (issued /
 *      sent / paid / overdue) invoices and cancelled invoices are rejected
 *      with a `ValidationError` — a finalized invoice is an immutable
 *      accounting record, a cancelled invoice is closed history.
 *
 * Money & Calculation Rules:
 *   5. Never trusts client-supplied totals/subtotals/discounts/taxes; every
 *      monetary value is recalculated server-side via `calculateInvoice()`.
 *
 * Invariants preserved (all belong to finalization / payment flows, never to
 * draft editing):
 *   6. `invoiceNumber` (draft placeholder), `status` (`DRAFT`), `paidAmount`,
 *      `finalizedAt` and `cancelledAt` are never modified here.
 *   7. Does NOT consume or advance `InvoiceSettings.nextInvoiceNumber`.
 *   8. Does NOT consume invoice quota or touch `UsagePeriod`.
 *   9. Does NOT create immutable seller/customer snapshots or payments.
 *
 * Transactional Persistence & Concurrency:
 *  10. Everything runs in one interactive transaction; the invoice row is
 *      locked (`SELECT ... FOR UPDATE`) first — the same lock
 *      `finalizeInvoice` takes as its first statement — so a draft edit can
 *      never interleave with a concurrent finalization and overwrite the
 *      finalized record. The loser sees the committed state and is rejected
 *      by the DRAFT check before writing anything.
 */
export async function updateDraftInvoice(
  businessId: string,
  invoiceId: unknown,
  input: unknown,
): Promise<InvoiceRecord> {
  // Preserve authentication before validation (matches createDraftInvoice convention)
  const session = await requireSession();

  // businessId / invoiceId are server-side identifiers from the action
  // boundary; the request body may only carry the editable invoice payload.
  const rawPayload =
    typeof input === "object" && input !== null ? { ...input, businessId, invoiceId } : { businessId, invoiceId };
  const data = parseUpdateDraftInvoiceInput(rawPayload);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 0. Lock the invoice row FIRST (see note on finalizeInvoice step 0).
    //    A missing invoice locks nothing and falls through to NotFoundError.
    await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${data.invoiceId} FOR UPDATE`;

    // 1. Verify business ownership and state
    const business = await tx.business.findUnique({
      where: { id: data.businessId },
    });

    if (!business) {
      throw new NotFoundError("Business not found");
    }

    if (business.accountId !== session.accountId) {
      throw new ForbiddenError("Business does not belong to this account");
    }

    if (business.archivedAt !== null) {
      throw new ValidationError("Cannot edit an invoice of an archived business");
    }

    // 2. Load the invoice (authoritative: post-lock) and bind it to the business
    const invoice = await tx.invoice.findUnique({
      where: { id: data.invoiceId },
    });

    if (!invoice) {
      throw new NotFoundError("Invoice not found");
    }

    if (invoice.businessId !== business.id) {
      throw new ForbiddenError("Invoice does not belong to this business");
    }

    // 3. Lifecycle rule — only drafts are editable
    if (invoice.status !== "DRAFT") {
      throw new ValidationError(
        invoice.cancelledAt !== null || invoice.status === "CANCELLED"
          ? "Cancelled invoices cannot be edited"
          : "Only draft invoices can be edited; this invoice is already finalized",
      );
    }

    // 4. Verify customer (if provided)
    if (data.customerId) {
      await assertCustomerReference(tx, business.id, data.customerId);
    }

    // 5. Verify products (if referenced by line items)
    await assertProductReferences(tx, business.id, data.items);

    // 6. Resolve tax rate (explicit taxPercent > business defaultVatPercent > 0)
    const taxPercent = await resolveDraftTaxPercent(tx, business.id, data.taxPercent);

    // 7. Authoritative recalculation via pure calculation engine
    const calculationInput: InvoiceCalculationInput = {
      items: data.items.map((item) => ({
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discountPercent: item.discountPercent ?? 0,
      })),
      globalDiscountPercent: data.globalDiscountPercent ?? 0,
      taxPercent,
    };

    const calcResult = calculateInvoice(calculationInput);

    // 8. Parse issue and due dates
    const issueDate = data.issueDate ? new Date(data.issueDate) : new Date();
    const dueDate = data.dueDate ? new Date(data.dueDate) : null;

    // 9. Replace line items atomically. Draft items are throwaway rows (the
    //    immutable accounting record starts at finalization), so a full
    //    delete + nested re-create keeps the diff semantics simple and the
    //    stored line values always match the authoritative recalculation.
    await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } });

    // 10. Persist the updated draft. `invoiceNumber`, `status`, `paidAmount`,
    //     `finalizedAt` and `cancelledAt` are deliberately absent. Any payment
    //     recorded earlier stays intact; the remaining amount is re-derived
    //     from the recalculated total and the preserved paid amount.
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        customerId: data.customerId ?? null,
        invoiceType: data.invoiceType ?? "FINAL",
        issueDate,
        dueDate,
        subtotal: calcResult.subtotal,
        itemDiscountAmount: calcResult.itemDiscountAmount,
        globalDiscountPercent: calcResult.globalDiscountPercent,
        globalDiscountAmount: calcResult.globalDiscountAmount,
        taxPercent: calcResult.taxPercent,
        taxAmount: calcResult.taxAmount,
        taxableAmount: calcResult.taxableAmount,
        total: calcResult.total,
        remainingAmount: calculateRemainingAmount(calcResult.total, invoice.paidAmount),
        notes: data.notes ?? null,
        items: {
          create: data.items.map((item, index) => {
            const lineCalc = calcResult.items[index];
            const itemDate = item.itemDate ? new Date(item.itemDate) : null;
            return {
              productId: item.productId ?? null,
              title: item.title,
              description: item.description ?? null,
              itemDate,
              unitPrice: new Decimal(item.unitPrice),
              quantity: new Decimal(item.quantity),
              unit: item.unit ?? null,
              discountPercent: new Decimal(item.discountPercent ?? 0),
              discountAmount: lineCalc!.discountAmount,
              subtotal: lineCalc!.subtotal,
              total: lineCalc!.total,
              sortOrder: item.sortOrder ?? index,
            };
          }),
        },
      },
      include: {
        items: {
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    return updated as unknown as InvoiceRecord;
  });
}

export interface FinalizeInvoiceOptions {
  /** Server-side time reference (for testing / deterministic date boundaries). */
  now?: Date;
  /** Optional transaction client if invoked within an outer transaction. */
  client?: Prisma.TransactionClient;
}

/**
 * Converts an existing DRAFT invoice into a finalized/issued invoice safely.
 *
 * Requirements & Invariants:
 *   1. Requires an authenticated session (`requireSession()`).
 *   2. Proves the target business belongs to the session account.
 *   3. Rejects finalization if the business is archived.
 *   4. Only DRAFT invoices can be finalized. Rejects already finalized, issued,
 *      or cancelled invoices.
 *   5. Re-validates customer and product references for cross-business leakage.
 *   6. Authoritatively recalculates all totals server-side via `calculateInvoice()`.
 *   7. Resolves effective entitlements and ensures the current `UsagePeriod`.
 *   8. Atomically checks plan invoice limit and increments `UsagePeriod.invoiceCount`.
 *   9. Atomically allocates official invoice number and increments `InvoiceSettings.nextInvoiceNumber`.
 *  10. Writes immutable historical snapshots: `InvoiceSellerSnapshot` and `InvoiceCustomerSnapshot`.
 *  11. Derives authoritative payment state (`paidAmount`, `remainingAmount`, `status`).
 *  12. Sets `finalizedAt: now`.
 *  13. Executes entirely inside an atomic database transaction, and locks the
 *      invoice row (`SELECT ... FOR UPDATE`) as the first statement so that
 *      duplicate/concurrent finalizations of the same invoice serialize and
 *      the loser is rejected by the DRAFT check before it writes anything.
 *
 * Numbering / quota / snapshots rely on the transaction: the counter
 * increment, quota increment, snapshot inserts and the conditional invoice
 * update either all commit or all roll back, so a failed finalization never
 * permanently consumes an official number or a quota unit.
 */
export async function finalizeInvoice(
  invoiceIdOrOptions: string | ({ invoiceId: string } & FinalizeInvoiceOptions),
  maybeOptions: FinalizeInvoiceOptions = {},
): Promise<InvoiceRecord> {
  // Null-safe argument discrimination. `typeof null === "object"`, so a bare
  // `null` used to fall into the options-object branch and crash with a raw
  // TypeError on property access; `null`, `undefined`, primitives and objects
  // without a usable invoice ID must all yield the established ValidationError
  // instead. The object form is only taken for a non-null object; everything
  // else flows into the invoiceId guard below as-is.
  const options: FinalizeInvoiceOptions =
    invoiceIdOrOptions !== null && typeof invoiceIdOrOptions === "object"
      ? invoiceIdOrOptions
      : maybeOptions;
  const invoiceId =
    invoiceIdOrOptions !== null && typeof invoiceIdOrOptions === "object"
      ? invoiceIdOrOptions.invoiceId
      : invoiceIdOrOptions;

  if (typeof invoiceId !== "string" || invoiceId.trim() === "") {
    throw new ValidationError("Invoice ID is required");
  }

  // Session verification — executed exactly once per finalization. The session
  // resolved here is handed to the internal entitlement / usage-period helpers
  // (server-to-server), which would otherwise repeat this same requireSession()
  // round-trip two more times. The session still originates exclusively from
  // requireSession(); no caller can supply one from request input.
  const session = await requireSession();
  const now = options.now ?? new Date();

  const runWithTx = async (tx: Prisma.TransactionClient) => {
    // 0. Lock the invoice row FIRST — before it is read and before anything
    //    is written. This is the same minimal PostgreSQL lock the payment
    //    service takes (`SELECT id FROM "invoices" WHERE id = $1 FOR UPDATE`,
    //    id bound as a parameter), and it exists for duplicate/concurrent
    //    finalize requests on the SAME invoice:
    //
    //    Without it, two finalizations both pass the DRAFT check on a
    //    non-locked read; the loser then serializes at the UsagePeriod row,
    //    and once the winner commits it still increments the quota, allocates
    //    the next official number and only fails at the seller-snapshot
    //    unique index (a raw Prisma P2002). PostgreSQL rolls all of that back,
    //    so the end state was already consistent — but the loser surfaced an
    //    infrastructure error instead of the domain ValidationError and
    //    churned the quota/number rows first.
    //
    //    With the lock, the loser waits here until the winner commits, its
    //    subsequent read (READ COMMITTED: a fresh snapshot per statement) sees
    //    the committed finalized row, and step 4 rejects it cleanly before any
    //    write. It also serializes finalization against concurrent payment
    //    mutations on the same invoice, which take the same lock. A missing
    //    invoice locks nothing and falls through to the NotFoundError below.
    await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${invoiceId} FOR UPDATE`;

    // 1. Load the complete invoice and business (authoritative: post-lock)
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        business: true,
      },
    });

    if (!invoice) {
      throw new NotFoundError("Invoice not found");
    }

    // 2. Authorization / Account boundary check
    if (invoice.business.accountId !== session.accountId) {
      throw new ForbiddenError("Invoice does not belong to this account");
    }

    // 3. Business lifecycle check
    if (invoice.business.archivedAt !== null) {
      throw new ValidationError("Cannot finalize invoice for an archived business");
    }

    // 4. Draft lifecycle check
    if (invoice.status !== "DRAFT" || invoice.finalizedAt !== null) {
      throw new ValidationError(
        invoice.cancelledAt !== null || invoice.status === "CANCELLED"
          ? "Cannot finalize a cancelled invoice"
          : "Only draft invoices can be finalized; this invoice is already finalized",
      );
    }

    if (!invoice.items || invoice.items.length === 0) {
      throw new ValidationError("Cannot finalize an invoice with no line items");
    }

    const lineItems = invoice.items as InvoiceItemRecord[];

    // 5. Verify customer references (if referenced)
    let customer: {
      id: string;
      businessId: string;
      name: string;
      mobile: string | null;
      phone: string | null;
      email: string | null;
      address: string | null;
      nationalId: string | null;
      economicCode: string | null;
      archivedAt: Date | null;
    } | null = null;

    if (invoice.customerId) {
      customer = await tx.customer.findUnique({
        where: { id: invoice.customerId },
      });

      if (!customer) {
        throw new NotFoundError("Customer not found");
      }

      if (customer.businessId !== invoice.businessId) {
        throw new ForbiddenError("Customer does not belong to this business");
      }

      if (customer.archivedAt !== null) {
        throw new ValidationError("Cannot finalize invoice referencing an archived customer");
      }
    }

    // 6. Verify product references (if referenced by line items)
    const productIds = Array.from(
      new Set(
        lineItems
          .map((item) => item.productId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    if (productIds.length > 0) {
      const products = await tx.product.findMany({
        where: { id: { in: productIds } },
      });

      if (products.length !== productIds.length) {
        throw new NotFoundError("One or more referenced products were not found");
      }

      for (const product of products) {
        if (product.businessId !== invoice.businessId) {
          throw new ForbiddenError("Product does not belong to this business");
        }
        if (product.archivedAt !== null) {
          throw new ValidationError("Cannot finalize invoice referencing an archived product");
        }
      }
    }

    // 7. Authoritative server-side recalculation of line items and invoice totals
    const calculationInput: InvoiceCalculationInput = {
      items: lineItems.map((item) => ({
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discountPercent: item.discountPercent,
      })),
      globalDiscountPercent: invoice.globalDiscountPercent,
      taxPercent: invoice.taxPercent,
    };

    const calcResult = calculateInvoice(calculationInput);

    // 8. Entitlement & Quota Check (inside the transaction) — the already
    //    verified session is passed through so these internal helpers do not
    //    re-run requireSession() redundantly.
    const entitlements = await resolveEntitlements({ client: tx, now, session });
    const period = await ensureCurrentUsagePeriod({ client: tx, now, session });
    const effectiveLimit = entitlements.invoiceLimit;

    // Database-level atomic quota increment: only succeeds if current invoiceCount < limit
    const quotaUpdate = await tx.usagePeriod.updateMany({
      where: {
        id: period.id,
        invoiceCount: { lt: effectiveLimit },
      },
      data: {
        invoiceCount: { increment: 1 },
      },
    });

    if (quotaUpdate.count === 0) {
      throw new InvoiceLimitReachedError(
        `Invoice limit reached: the ${entitlements.plan.planKey} plan allows ${effectiveLimit} finalized invoice(s) per month.`,
      );
    }

    // 9. Atomic invoice number allocation (locking the InvoiceSettings row)
    const settings = await tx.invoiceSettings.update({
      where: { businessId: invoice.businessId },
      data: {
        nextInvoiceNumber: { increment: 1 },
      },
    });

    const sequenceNumber = settings.nextInvoiceNumber - 1;
    const officialInvoiceNumber = formatOfficialInvoiceNumber(
      settings.invoicePrefix,
      sequenceNumber,
    );

    // 10. Create immutable Seller Snapshot from BusinessProfile
    const profile = await tx.businessProfile.findUnique({
      where: { businessId: invoice.businessId },
    });

    await tx.invoiceSellerSnapshot.create({
      data: {
        invoiceId: invoice.id,
        businessName: profile?.businessName ?? invoice.business.name,
        slogan: profile?.slogan ?? null,
        ownerName: profile?.ownerName ?? null,
        address: profile?.address ?? null,
        email: profile?.email ?? null,
        mobile: profile?.mobile ?? null,
        landline: profile?.landline ?? null,
        cardNumber: profile?.cardNumber ?? null,
        accountNumber: profile?.accountNumber ?? null,
        iban: profile?.iban ?? null,
        logoFileId: profile?.logoFileId ?? null,
        sellerStampFileId: profile?.sellerStampFileId ?? null,
        sellerSignatureFileId: profile?.sellerSignatureFileId ?? null,
        primaryColor: profile?.primaryColor ?? null,
        footerBackgroundColor: profile?.footerBackgroundColor ?? null,
        footerText: profile?.footerText ?? null,
      },
    });

    // 11. Create immutable Customer Snapshot (if invoice references a customer)
    if (customer) {
      await tx.invoiceCustomerSnapshot.create({
        data: {
          invoiceId: invoice.id,
          name: customer.name,
          mobile: customer.mobile ?? null,
          phone: customer.phone ?? null,
          email: customer.email ?? null,
          address: customer.address ?? null,
          nationalId: customer.nationalId ?? null,
          economicCode: customer.economicCode ?? null,
        },
      });
    }

    // 12. Authoritative payment state calculation
    const payments = await tx.invoicePayment.findMany({
      where: { invoiceId: invoice.id },
    });

    const paidAmount = (payments as Array<{ amount: Decimal.Value }>).reduce(
      (acc: Decimal, p) => acc.plus(new Decimal(p.amount)),
      new Decimal(0),
    );
    const remainingAmount = calcResult.total.minus(paidAmount);
    const derivedStatus = derivePaymentStatus({
      total: calcResult.total,
      paidAmount,
      dueDate: invoice.dueDate,
      now,
    });

    // 13. Persist authoritative line item values
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i]!;
      const lineCalc = calcResult.items[i]!;
      await tx.invoiceItem.update({
        where: { id: item.id },
        data: {
          discountAmount: lineCalc.discountAmount,
          subtotal: lineCalc.subtotal,
          total: lineCalc.total,
        },
      });
    }

    // 14. Conditional atomic update of the Invoice row (guaranteeing single finalization)
    const invoiceUpdate = await tx.invoice.updateMany({
      where: {
        id: invoice.id,
        status: "DRAFT",
        finalizedAt: null,
      },
      data: {
        invoiceNumber: officialInvoiceNumber,
        status: derivedStatus,
        subtotal: calcResult.subtotal,
        itemDiscountAmount: calcResult.itemDiscountAmount,
        globalDiscountPercent: calcResult.globalDiscountPercent,
        globalDiscountAmount: calcResult.globalDiscountAmount,
        taxPercent: calcResult.taxPercent,
        taxAmount: calcResult.taxAmount,
        taxableAmount: calcResult.taxableAmount,
        total: calcResult.total,
        paidAmount,
        remainingAmount,
        currency: normalizeInvoiceCurrency(settings.currency),
        finalizedAt: now,
      },
    });

    if (invoiceUpdate.count === 0) {
      throw new ValidationError("Invoice is no longer in draft status and cannot be finalized");
    }

    // 15. Return the finalized invoice with items and snapshots
    const finalized = await tx.invoice.findUnique({
      where: { id: invoice.id },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        sellerSnapshot: true,
        customerSnapshot: true,
      },
    });

    return finalized as unknown as InvoiceRecord;
  };

  if (options.client) {
    return runWithTx(options.client);
  }

  return prisma.$transaction(runWithTx);
}

// ---------------------------------------------------------------------------
// Invoice Lifecycle V2: cancelInvoice, deleteDraftInvoice, duplicateInvoice
// ---------------------------------------------------------------------------

export interface CancelInvoiceOptions {
  now?: Date;
  client?: Prisma.TransactionClient;
}

/**
 * Cancels a previously finalized invoice safely.
 *
 * Requirements & Invariants:
 *   1. Requires an authenticated session (`requireSession()`).
 *   2. Proves the target business belongs to the session account.
 *   3. Rejects cancellation if the business is archived.
 *   4. Only FINALIZED invoices can be cancelled. Draft invoices cannot be cancelled
 *      (use `deleteDraftInvoice` instead).
 *   5. Rejects already cancelled invoices (`cancelledAt !== null` or `status === "CANCELLED"`).
 *   6. Official invoice number is NEVER freed, cleared, or reused.
 *   7. Immutable seller and customer snapshots are PRESERVED.
 *   8. Payment history (InvoicePayment rows) is PRESERVED.
 *   9. Sets `status: "CANCELLED"` and `cancelledAt: now`.
 *  10. Consumed quota is NOT refunded or decremented.
 *  11. Executes inside a database transaction with a row lock (`SELECT ... FOR UPDATE`).
 *  12. Records an AuditLog entry.
 */
export async function cancelInvoice(
  invoiceId: string,
  options: CancelInvoiceOptions = {},
): Promise<InvoiceRecord> {
  const cleanInvoiceId = assertInvoiceId(invoiceId);
  const session = await requireSession();
  const now = options.now ?? new Date();

  const runWithTx = async (tx: Prisma.TransactionClient) => {
    // 0. Lock invoice row to prevent concurrent mutations
    await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${cleanInvoiceId} FOR UPDATE`;

    // 1. Load invoice with business, items, snapshots
    const invoice = await tx.invoice.findUnique({
      where: { id: cleanInvoiceId },
      include: {
        business: true,
        items: { orderBy: { sortOrder: "asc" } },
        sellerSnapshot: true,
        customerSnapshot: true,
      },
    });

    if (!invoice) {
      throw new NotFoundError("Invoice not found");
    }

    // 2. Ownership check
    if (invoice.business.accountId !== session.accountId) {
      throw new ForbiddenError("Invoice does not belong to this account");
    }

    // 3. Business archived check
    if (invoice.business.archivedAt !== null) {
      throw new ValidationError("Cannot cancel invoice for an archived business");
    }

    // 4. Lifecycle checks: only finalized invoices can be cancelled
    if (invoice.status === "DRAFT" || invoice.finalizedAt === null) {
      throw new ValidationError("Draft invoices cannot be cancelled; only finalized invoices can be cancelled");
    }

    if (invoice.status === "CANCELLED" || invoice.cancelledAt !== null) {
      throw new ValidationError("Invoice is already cancelled");
    }

    // 5. Update invoice to CANCELLED
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
      },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        sellerSnapshot: true,
        customerSnapshot: true,
      },
    });

    // 6. AuditLog record
    await tx.auditLog.create({
      data: {
        accountId: session.accountId,
        userId: session.userId,
        action: "INVOICE_CANCELLED",
        entityType: "Invoice",
        entityId: invoice.id,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          businessId: invoice.businessId,
          cancelledAt: now.toISOString(),
        },
      },
    });

    return updated as unknown as InvoiceRecord;
  };

  if (options.client) {
    return runWithTx(options.client);
  }

  return prisma.$transaction(runWithTx);
}

export interface DeleteDraftInvoiceOptions {
  client?: Prisma.TransactionClient;
}

/**
 * Deletes a DRAFT invoice and its line items safely.
 *
 * Requirements & Invariants:
 *   1. Requires an authenticated session (`requireSession()`).
 *   2. Proves the target business belongs to the session account.
 *   3. Rejects deletion if the business is archived.
 *   4. ONLY DRAFT invoices can be deleted. Finalized and cancelled invoices cannot
 *      be deleted (accounting history is immutable).
 *   5. Does NOT touch or alter quota / `UsagePeriod` (drafts never consumed quota).
 *   6. Line items are deleted atomically.
 *   7. Records an AuditLog entry.
 */
export async function deleteDraftInvoice(
  invoiceId: string,
  options: DeleteDraftInvoiceOptions = {},
): Promise<{ id: string; success: boolean }> {
  const cleanInvoiceId = assertInvoiceId(invoiceId);
  const session = await requireSession();

  const runWithTx = async (tx: Prisma.TransactionClient) => {
    // 0. Lock invoice row
    await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${cleanInvoiceId} FOR UPDATE`;

    // 1. Load invoice with business
    const invoice = await tx.invoice.findUnique({
      where: { id: cleanInvoiceId },
      include: { business: true },
    });

    if (!invoice) {
      throw new NotFoundError("Invoice not found");
    }

    // 2. Ownership check
    if (invoice.business.accountId !== session.accountId) {
      throw new ForbiddenError("Invoice does not belong to this account");
    }

    // 3. Business archived check
    if (invoice.business.archivedAt !== null) {
      throw new ValidationError("Cannot delete draft invoice for an archived business");
    }

    // 4. Lifecycle check: ONLY drafts can be deleted
    if (invoice.status !== "DRAFT" || invoice.finalizedAt !== null) {
      throw new ValidationError(
        invoice.status === "CANCELLED" || invoice.cancelledAt !== null
          ? "Cancelled invoices cannot be deleted; accounting history must be preserved"
          : "Finalized invoices cannot be deleted; only draft invoices can be deleted",
      );
    }

    // 5. Delete items then invoice (explicit delete inside tx)
    await tx.invoiceItem.deleteMany({
      where: { invoiceId: invoice.id },
    });

    await tx.invoice.delete({
      where: { id: invoice.id },
    });

    // 6. AuditLog record
    await tx.auditLog.create({
      data: {
        accountId: session.accountId,
        userId: session.userId,
        action: "INVOICE_DRAFT_DELETED",
        entityType: "Invoice",
        entityId: invoice.id,
        metadata: {
          businessId: invoice.businessId,
        },
      },
    });

    return { id: invoice.id, success: true };
  };

  if (options.client) {
    return runWithTx(options.client);
  }

  return prisma.$transaction(runWithTx);
}

export interface DuplicateInvoiceOptions {
  now?: Date;
  client?: Prisma.TransactionClient;
}

/**
 * Creates a brand new DRAFT invoice cloned from an existing invoice (draft, finalized, or cancelled).
 *
 * Requirements & Invariants:
 *   1. Requires an authenticated session (`requireSession()`).
 *   2. Proves the target business belongs to the session account.
 *   3. Rejects duplication if the business is archived.
 *   4. Entitlements check: verifies `canDuplicateInvoice` (feature `INVOICE_DUPLICATION`,
 *      allowed on Basic and Pro plans).
 *   5. Never reuses the official invoice number; generates a fresh `DRAFT-<UUID>` placeholder.
 *   6. Status is initialized to `DRAFT` with `finalizedAt: null`, `cancelledAt: null`, and `currency: null`.
 *   7. Re-verifies customer (if any) and referenced products against business & archive rules.
 *   8. Server-side authoritative recalculation of all totals using calculation engine.
 *   9. Payment status and payment records are NEVER copied (`paidAmount: 0`, `remainingAmount: total`).
 *  10. Immutable snapshots from the original invoice are NEVER attached/copied to the new draft.
 *  11. Does NOT consume invoice quota (draft creation is quota-free).
 *  12. Records an AuditLog entry.
 */
export async function duplicateInvoice(
  invoiceId: string,
  options: DuplicateInvoiceOptions = {},
): Promise<InvoiceRecord> {
  const cleanInvoiceId = assertInvoiceId(invoiceId);
  const session = await requireSession();
  const now = options.now ?? new Date();

  const runWithTx = async (tx: Prisma.TransactionClient) => {
    // 1. Entitlements check for INVOICE_DUPLICATION
    const entitlements = await resolveEntitlements({ client: tx, now, session });
    if (!canDuplicateInvoice(entitlements.plan, entitlements.subscription, entitlements.freePlan)) {
      throw new ForbiddenError(
        `Invoice duplication is not available on the ${entitlements.plan.planKey} plan. Please upgrade your plan.`,
      );
    }

    // 2. Load source invoice with items and business
    const sourceInvoice = await tx.invoice.findUnique({
      where: { id: cleanInvoiceId },
      include: {
        business: true,
        items: { orderBy: { sortOrder: "asc" } },
      },
    });

    if (!sourceInvoice) {
      throw new NotFoundError("Invoice not found");
    }

    // 3. Ownership check
    if (sourceInvoice.business.accountId !== session.accountId) {
      throw new ForbiddenError("Invoice does not belong to this account");
    }

    // 4. Business archived check
    if (sourceInvoice.business.archivedAt !== null) {
      throw new ValidationError("Cannot duplicate invoice for an archived business");
    }

    // 5. Customer reference check (if referenced)
    if (sourceInvoice.customerId) {
      await assertCustomerReference(tx, sourceInvoice.businessId, sourceInvoice.customerId);
    }

    // 6. Product references check (if referenced by line items)
    await assertProductReferences(tx, sourceInvoice.businessId, sourceInvoice.items);

    if (!sourceInvoice.items || sourceInvoice.items.length === 0) {
      throw new ValidationError("Cannot duplicate an invoice with no line items");
    }

    const sourceItems = sourceInvoice.items as unknown as InvoiceItemRecord[];

    // 7. Authoritative calculation
    const calculationInput: InvoiceCalculationInput = {
      items: sourceItems.map((item) => ({
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discountPercent: item.discountPercent,
      })),
      globalDiscountPercent: sourceInvoice.globalDiscountPercent,
      taxPercent: sourceInvoice.taxPercent,
    };

    const calcResult = calculateInvoice(calculationInput);

    // 8. Generate safe unique draft placeholder
    const draftInvoiceNumber = generateDraftInvoiceNumber();

    // 9. Persist new DRAFT invoice + items atomically
    const newInvoice = await tx.invoice.create({
      data: {
        businessId: sourceInvoice.businessId,
        customerId: sourceInvoice.customerId ?? null,
        invoiceNumber: draftInvoiceNumber,
        invoiceType: sourceInvoice.invoiceType,
        issueDate: now,
        dueDate: null,
        status: "DRAFT",
        subtotal: calcResult.subtotal,
        itemDiscountAmount: calcResult.itemDiscountAmount,
        globalDiscountPercent: calcResult.globalDiscountPercent,
        globalDiscountAmount: calcResult.globalDiscountAmount,
        taxPercent: calcResult.taxPercent,
        taxAmount: calcResult.taxAmount,
        taxableAmount: calcResult.taxableAmount,
        total: calcResult.total,
        paidAmount: new Decimal(0),
        remainingAmount: calcResult.total,
        notes: sourceInvoice.notes ?? null,
        items: {
          create: sourceItems.map((item, index) => {
            const lineCalc = calcResult.items[index]!;
            return {
              productId: item.productId ?? null,
              title: item.title,
              description: item.description ?? null,
              itemDate: item.itemDate,
              unitPrice: new Decimal(item.unitPrice),
              quantity: new Decimal(item.quantity),
              unit: item.unit ?? null,
              discountPercent: new Decimal(item.discountPercent),
              discountAmount: lineCalc.discountAmount,
              subtotal: lineCalc.subtotal,
              total: lineCalc.total,
              sortOrder: item.sortOrder ?? index,
            };
          }),
        },
      },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
      },
    });

    // 10. AuditLog record
    await tx.auditLog.create({
      data: {
        accountId: session.accountId,
        userId: session.userId,
        action: "INVOICE_DUPLICATED",
        entityType: "Invoice",
        entityId: newInvoice.id,
        metadata: {
          sourceInvoiceId: sourceInvoice.id,
          businessId: sourceInvoice.businessId,
        },
      },
    });

    return newInvoice as unknown as InvoiceRecord;
  };

  if (options.client) {
    return runWithTx(options.client);
  }

  return prisma.$transaction(runWithTx);
}
