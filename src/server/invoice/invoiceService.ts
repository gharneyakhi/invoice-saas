import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import {
  calculateInvoice,
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
  type CreateDraftInvoiceInput,
} from "@/server/invoice/schema";

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

function assertInvoiceId(invoiceId: unknown): string {
  if (typeof invoiceId !== "string" || invoiceId.trim() === "") {
    throw new ValidationError("Invoice ID is required");
  }
  return invoiceId;
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
      const customer = await tx.customer.findUnique({
        where: { id: data.customerId },
      });

      if (!customer) {
        throw new NotFoundError("Customer not found");
      }

      if (customer.businessId !== business.id) {
        throw new ForbiddenError("Customer does not belong to this business");
      }

      if (customer.archivedAt !== null) {
        throw new ValidationError("Cannot reference an archived customer");
      }
    }

    // 3. Verify products (if referenced by line items)
    const productIds = Array.from(
      new Set(data.items.map((item) => item.productId).filter((id): id is string => Boolean(id))),
    );

    if (productIds.length > 0) {
      const products = await tx.product.findMany({
        where: { id: { in: productIds } },
      });

      if (products.length !== productIds.length) {
        throw new NotFoundError("One or more referenced products were not found");
      }

      for (const product of products) {
        if (product.businessId !== business.id) {
          throw new ForbiddenError("Product does not belong to this business");
        }
        if (product.archivedAt !== null) {
          throw new ValidationError("Cannot reference an archived product");
        }
      }
    }

    // 4. Resolve tax rate (explicit taxPercent > business defaultVatPercent > 0)
    let taxPercent: Decimal.Value;
    if (data.taxPercent !== undefined) {
      taxPercent = data.taxPercent;
    } else {
      const settings = await tx.invoiceSettings.findUnique({
        where: { businessId: business.id },
      });
      taxPercent = settings?.defaultVatPercent ?? 0;
    }

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
              discountAmount: lineCalc.discountAmount,
              subtotal: lineCalc.subtotal,
              total: lineCalc.total,
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
        invoice.items
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
      items: invoice.items.map((item) => ({
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

    const paidAmount = payments.reduce(
      (acc, p) => acc.plus(new Decimal(p.amount)),
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
    for (let i = 0; i < invoice.items.length; i++) {
      const item = invoice.items[i];
      const lineCalc = calcResult.items[i];
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
