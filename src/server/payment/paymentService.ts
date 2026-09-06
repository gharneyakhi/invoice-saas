import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import {
  calculateRemainingAmount,
  derivePaymentStatus,
} from "@/lib/invoice-calculation";
import {
  ForbiddenError,
  NotFoundError,
  requireSession,
  type AuthenticatedContext,
} from "@/server/auth/requireSession";
import { ValidationError } from "@/server/errors";
import {
  parseCreateInvoicePaymentInput,
  parseUpdateInvoicePaymentInput,
  type CreateInvoicePaymentInput,
  type UpdateInvoicePaymentInput,
} from "@/server/payment/schema";

/**
 * InvoicePayment CRUD domain layer (server-side only).
 *
 * Authorization rules applied by *every* function in this module:
 *
 *   1. `requireSession()` runs first — the only source of truth for "who is
 *      calling". No function accepts an `accountId` or a `businessId`: the
 *      account boundary is proven by loading the owning Invoice together with
 *      its Business and comparing `business.accountId` against the session
 *      account, exactly as `invoiceService` does. A payment can therefore
 *      never be addressed across an account boundary, and it can never be
 *      re-parented to another invoice/business (the payload schema is strict,
 *      so `invoiceId` in a payload is an unknown-field rejection).
 *   2. Distinct errors, matching `requireBusinessOwnership()`:
 *      missing Invoice/Payment row → `NotFoundError`; row exists but belongs
 *      to another Account → `ForbiddenError`.
 *   3. Mutations (create / update / delete) are refused for DRAFT (or otherwise
 *      non-finalized) invoices, for cancelled invoices, and for archived
 *      businesses. Reads stay available for cancelled invoice history and
 *      archived businesses — history must remain visible even though writes
 *      are closed.
 *
 * Money rules:
 *
 *   4. All monetary arithmetic uses decimal.js (`Decimal`), never JavaScript
 *      floating point. Amounts arrive pre-validated by the strict Zod schema
 *      (> 0, ≤ 2 decimal places, within `Decimal(14, 2)`), but the balance
 *      checks below still run against authoritative database values.
 *   5. Client-supplied `status` / `paidAmount` / `remainingAmount` are never
 *      trusted — they are not even accepted by the schema. After every
 *      mutation the invoice's denormalized payment state is recomputed from
 *      the authoritative payment rows via the shared `derivePaymentStatus()`
 *      engine and persisted.
 *   6. Total paid can never exceed `invoice.total`: each mutation sums the
 *      invoice's payments inside a transaction and rejects the write when the
 *      resulting paid amount would overshoot.
 *
 * Concurrency:
 *
 *   7. Every mutation runs inside `prisma.$transaction` and first locks the
 *      invoice row with `SELECT id FROM "invoices" WHERE id = $1 FOR UPDATE`
 *      (the minimal PostgreSQL lock) BEFORE any payment of that invoice is
 *      read or summed. Concurrent payment writers on the same invoice
 *      serialize at that lock until the earlier transaction commits, which
 *      makes the lock → load → authorize → validate → sum → mutate →
 *      recalculate → update sequence atomic. Two simultaneous "pay the rest"
 *      requests cannot both succeed: the loser re-reads the summed payments
 *      after acquiring the lock and is rejected as an overpayment.
 *
 * Protected invariants (never touched by this module):
 *
 *   8. `invoice.total` and every other financial field (subtotal, discounts,
 *      tax), the immutable seller/customer snapshots, `invoiceNumber`,
 *      `finalizedAt` — payment CRUD writes ONLY the denormalized
 *      `paidAmount`, `remainingAmount` and `status` columns.
 *   9. The `UsagePeriod` quota is never restored or otherwise modified when a
 *      payment is deleted: quota counts finalized invoices, not payments.
 */

/** Row shape of an invoice as needed for payment authorization & balance math. */
export interface PaymentRelatedInvoice {
  id: string;
  businessId: string;
  status:
    | "DRAFT"
    | "ISSUED"
    | "SENT"
    | "PENDING_PAYMENT"
    | "PARTIALLY_PAID"
    | "PAID"
    | "OVERDUE"
    | "CANCELLED";
  total: Decimal;
  paidAmount: Decimal;
  remainingAmount: Decimal;
  dueDate: Date | null;
  finalizedAt: Date | null;
  cancelledAt: Date | null;
  business: {
    id: string;
    accountId: string;
    archivedAt: Date | null;
  };
}

/**
 * Row shape of the `invoice_payments` table (mirrors `model InvoicePayment`
 * in `prisma/schema.prisma`). Declared locally rather than importing the
 * model type from `@prisma/client`, which only exists after `prisma generate`
 * has run — the same convention as `InvoiceRecord` in `invoiceService.ts`.
 */
export interface InvoicePaymentRecord {
  id: string;
  invoiceId: string;
  amount: Decimal;
  paymentDate: Date;
  method: "CASH" | "CARD" | "BANK_TRANSFER" | "ONLINE" | "OTHER";
  referenceNumber: string | null;
  notes: string | null;
  createdAt: Date;
}

/**
 * Stable order for payment history views: newest payment first, with
 * `createdAt` and `id` as tie-breakers so two payments on the same instant
 * never swap places between requests.
 */
export const INVOICE_PAYMENT_LIST_ORDER_BY = [
  { paymentDate: "desc" as const },
  { createdAt: "desc" as const },
  { id: "asc" as const },
];

function assertInvoiceId(invoiceId: unknown): string {
  if (typeof invoiceId !== "string" || invoiceId.trim() === "") {
    throw new ValidationError("Invoice ID is required");
  }
  return invoiceId;
}

function assertPaymentId(paymentId: unknown): string {
  if (typeof paymentId !== "string" || paymentId.trim() === "") {
    throw new ValidationError("Payment ID is required");
  }
  return paymentId;
}

/**
 * The account boundary. `business.accountId` is compared against the
 * session-derived account — never against anything a caller sent.
 */
function assertInvoiceAccess(invoice: PaymentRelatedInvoice, session: AuthenticatedContext): void {
  if (invoice.business.accountId !== session.accountId) {
    throw new ForbiddenError("Invoice does not belong to this account");
  }
}

/**
 * An archived Business is retired: its historical payment data stays readable,
 * but it accepts no new payment writes. Mirrors the guard `invoiceService` and
 * `customerService` apply before mutating.
 */
function assertBusinessAcceptsPaymentMutations(
  business: PaymentRelatedInvoice["business"],
  action: string,
): void {
  if (business.archivedAt !== null) {
    throw new ValidationError(`Cannot ${action} for an archived business`);
  }
}

/**
 * Payments exist only against finalized, non-cancelled invoices. A DRAFT (or
 * otherwise non-finalized) invoice has no authoritative total yet, and a
 * cancelled invoice must keep its history frozen — both refuse mutations.
 * Reads deliberately skip this guard.
 */
function assertInvoiceAcceptsPaymentMutations(invoice: PaymentRelatedInvoice): void {
  if (invoice.status === "DRAFT" || invoice.finalizedAt === null) {
    throw new ValidationError("Payments are only allowed on finalized invoices");
  }

  if (invoice.cancelledAt !== null || invoice.status === "CANCELLED") {
    throw new ValidationError("Cannot modify payments of a cancelled invoice");
  }
}

/**
 * The overpayment guard: the resulting paid amount may reach the invoice
 * total exactly (that is "PAID") but never exceed it.
 */
function assertWithinRemainingBalance(invoice: PaymentRelatedInvoice, newPaidAmount: Decimal): void {
  if (newPaidAmount.greaterThan(invoice.total)) {
    throw new ValidationError(
      `Payment exceeds the invoice remaining balance: total paid ${newPaidAmount.toFixed(2)} would exceed the invoice total ${invoice.total.toFixed(2)}`,
    );
  }
}

/**
 * Sums payment amounts with Decimal arithmetic only. Accepts a projection of
 * `{ amount }` rows so the caller can avoid loading whole payment rows.
 */
function sumPaymentAmounts(payments: ReadonlyArray<{ amount: Decimal.Value }>): Decimal {
  return payments.reduce((acc, payment) => acc.plus(new Decimal(payment.amount)), new Decimal(0));
}

/**
 * Loads the owning invoice together with its business, used for authorization.
 * Kept narrow on purpose (no items/snapshots): payment operations must never
 * give the impression they read or rewrite invoice financial detail.
 */
async function loadInvoiceForPayment(
  db: Prisma.TransactionClient,
  invoiceId: string,
): Promise<PaymentRelatedInvoice | null> {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { business: true },
  });

  return invoice as unknown as PaymentRelatedInvoice | null;
}

/**
 * The minimal PostgreSQL row lock, taken as the FIRST statement of every
 * mutation transaction: `SELECT id FROM "invoices" WHERE id = $1 FOR UPDATE`
 * (the table is `@@map("invoices")`). Locking the single invoice row before
 * any of its payments is read or summed serializes concurrent payment writers
 * on that invoice; everyone else waits at this statement until the lock holder
 * commits or rolls back, then re-reads fresh authoritative data. Prisma
 * parameterizes the tagged template, so the id is never interpolated into the
 * SQL text.
 */
async function lockInvoiceRow(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${invoiceId} FOR UPDATE`;
}

/**
 * Recomputes the denormalized payment state from authoritative data and
 * persists it. This is the ONLY place a payment mutation touches the Invoice
 * row, and these are the ONLY three columns it writes:
 *
 *   - `paidAmount`        — sum of the invoice's payments (Decimal)
 *   - `remainingAmount`   — shared `calculateRemainingAmount()` (total − paid)
 *   - `status`            — shared `derivePaymentStatus()`:
 *     PENDING_PAYMENT / PARTIALLY_PAID / PAID / OVERDUE, exactly the existing
 *     application vocabulary.
 *
 * `total`, discounts, tax, snapshots, `invoiceNumber`, `finalizedAt` and the
 * `UsagePeriod` quota are all left untouched by construction.
 */
async function syncInvoicePaymentState(
  tx: Prisma.TransactionClient,
  invoice: PaymentRelatedInvoice,
  paidAmount: Decimal,
): Promise<void> {
  const remainingAmount = calculateRemainingAmount(invoice.total, paidAmount);
  const status = derivePaymentStatus({
    total: invoice.total,
    paidAmount,
    dueDate: invoice.dueDate,
    now: new Date(),
  });

  await tx.invoice.update({
    where: { id: invoice.id },
    data: { paidAmount, remainingAmount, status },
  });
}

/**
 * Records a payment against a finalized, non-cancelled invoice of a business
 * the caller owns.
 *
 * `invoiceId` is an untrusted identifier: ownership is proven inside the
 * transaction from the loaded Invoice → Business → `accountId` chain. The
 * business on the created row is never named by the caller — the payment is
 * attached to the verified invoice and nothing else.
 *
 * @throws UnauthorizedError                  no valid session
 * @throws ValidationError                    invalid payload / draft invoice / archived business
 * @throws NotFoundError                      invoice does not exist
 * @throws ForbiddenError                     invoice belongs to another account
 * @throws ValidationError                    payment would overpay the invoice
 */
export async function createInvoicePayment(
  invoiceId: unknown,
  input: unknown,
): Promise<InvoicePaymentRecord> {
  // Preserve authentication before validation (matches invoiceService convention)
  const session = await requireSession();
  const id = assertInvoiceId(invoiceId);
  const data: CreateInvoicePaymentInput = parseCreateInvoicePaymentInput(input);
  const amount = new Decimal(data.amount);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Lock the invoice row BEFORE reading/summing payments (see module doc).
    await lockInvoiceRow(tx, id);

    // 2. Load the authoritative invoice and authorize.
    const invoice = await loadInvoiceForPayment(tx, id);
    if (!invoice) {
      throw new NotFoundError("Invoice not found");
    }
    assertInvoiceAccess(invoice, session);
    assertBusinessAcceptsPaymentMutations(invoice.business, "create a payment");
    assertInvoiceAcceptsPaymentMutations(invoice);

    // 3. Sum existing payments (post-lock) and validate the new balance.
    const payments = await tx.invoicePayment.findMany({
      where: { invoiceId: id },
      select: { amount: true },
    });
    const newPaidAmount = sumPaymentAmounts(payments).plus(amount);
    assertWithinRemainingBalance(invoice, newPaidAmount);

    // 4. Mutate the payment row.
    const created: InvoicePaymentRecord = await tx.invoicePayment.create({
      data: {
        invoiceId: id,
        amount,
        paymentDate: data.paymentDate ? new Date(data.paymentDate) : new Date(),
        method: data.method,
        referenceNumber: data.referenceNumber ?? null,
        notes: data.notes ?? null,
      },
    });

    // 5. Recalculate and persist the denormalized payment state, then commit.
    await syncInvoicePaymentState(tx, invoice, newPaidAmount);

    return created as unknown as InvoicePaymentRecord;
  });
}

/**
 * Lists the payments of an invoice the caller owns, newest first.
 *
 * Read path: available for cancelled invoices and archived businesses so
 * payment history survives both.
 *
 * @throws UnauthorizedError / NotFoundError / ForbiddenError (same rules as create)
 */
export async function listInvoicePayments(invoiceId: unknown): Promise<InvoicePaymentRecord[]> {
  const session = await requireSession();
  const id = assertInvoiceId(invoiceId);

  const invoice = await loadInvoiceForPayment(prisma, id);
  if (!invoice) {
    throw new NotFoundError("Invoice not found");
  }
  assertInvoiceAccess(invoice, session);

  return prisma.invoicePayment.findMany({
    where: { invoiceId: id },
    orderBy: INVOICE_PAYMENT_LIST_ORDER_BY,
  });
}

/**
 * Returns a single payment of an invoice the caller owns. The payment's owning
 * invoice (and through it the business/account boundary) is resolved
 * server-side; a payment can never be reached across an account.
 *
 * Read path: available for cancelled invoices and archived businesses.
 *
 * @throws UnauthorizedError / NotFoundError / ForbiddenError (same rules as create)
 */
export async function getInvoicePayment(paymentId: unknown): Promise<InvoicePaymentRecord> {
  const session = await requireSession();
  const id = assertPaymentId(paymentId);

  const payment = await prisma.invoicePayment.findUnique({
    where: { id },
    include: { invoice: { include: { business: true } } },
  });

  if (!payment) {
    throw new NotFoundError("Payment not found");
  }

  const paymentWithInvoice = payment as unknown as InvoicePaymentRecord & {
    invoice: PaymentRelatedInvoice;
  };
  assertInvoiceAccess(paymentWithInvoice.invoice, session);

  const { invoice: _invoice, ...record } = paymentWithInvoice;
  return record;
}

/**
 * Updates a payment of a finalized, non-cancelled invoice of a business the
 * caller owns.
 *
 * The payment's owning invoice is located from the payment row itself, so the
 * update is always evaluated against the payment's real parent — a payload can
 * neither name another invoice nor move the payment to one (strict schema).
 *
 * The balance check treats the update as replace: existing payments minus this
 * payment plus its new amount. Overshooting the invoice total is rejected
 * before anything is written.
 *
 * @throws UnauthorizedError / ValidationError / NotFoundError / ForbiddenError
 * @throws ValidationError                    update would overpay the invoice
 */
export async function updateInvoicePayment(
  paymentId: unknown,
  input: unknown,
): Promise<InvoicePaymentRecord> {
  const session = await requireSession();
  const id = assertPaymentId(paymentId);
  const data: UpdateInvoicePaymentInput = parseUpdateInvoicePaymentInput(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Locate the real parent from the row itself (server-side, never the
    // payload). This pre-lock read only resolves the lock key (the owning
    // invoice); the authoritative payment row is re-read under the lock below.
    const located = await tx.invoicePayment.findUnique({ where: { id } });
    if (!located) {
      throw new NotFoundError("Payment not found");
    }

    // 1. Lock the invoice row BEFORE reading/summing payments (see module doc).
    await lockInvoiceRow(tx, located.invoiceId);

    // 2. Load the authoritative invoice and authorize.
    const invoice = await loadInvoiceForPayment(tx, located.invoiceId);
    if (!invoice) {
      throw new NotFoundError("Invoice not found");
    }
    assertInvoiceAccess(invoice, session);
    assertBusinessAcceptsPaymentMutations(invoice.business, "update a payment");
    assertInvoiceAcceptsPaymentMutations(invoice);

    // 3. Authoritative payment row under the lock. A concurrent transaction
    //    may have changed or deleted the payment between the pre-lock lookup
    //    and lock acquisition; what exists now is the only truth.
    const existing = await tx.invoicePayment.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError("Payment not found");
    }

    // 4. Sum the OTHER payments (post-lock) plus the replacement amount.
    const otherPayments = await tx.invoicePayment.findMany({
      where: { invoiceId: invoice.id, NOT: { id: existing.id } },
      select: { amount: true },
    });
    const replacementAmount =
      data.amount !== undefined ? new Decimal(data.amount) : new Decimal(existing.amount);
    const newPaidAmount = sumPaymentAmounts(otherPayments).plus(replacementAmount);
    assertWithinRemainingBalance(invoice, newPaidAmount);

    // 5. Mutate the payment row — only the fields actually present, so a
    //    partial update cannot blank columns it never mentioned.
    const updated: InvoicePaymentRecord = await tx.invoicePayment.update({
      where: { id: existing.id },
      data: {
        ...(data.amount !== undefined ? { amount: replacementAmount } : {}),
        ...(data.paymentDate !== undefined ? { paymentDate: new Date(data.paymentDate) } : {}),
        ...(data.method !== undefined ? { method: data.method } : {}),
        ...(data.referenceNumber !== undefined ? { referenceNumber: data.referenceNumber } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });

    // 6. Recalculate and persist the denormalized payment state, then commit.
    await syncInvoicePaymentState(tx, invoice, newPaidAmount);

    return updated as unknown as InvoicePaymentRecord;
  });
}

/**
 * Deletes a payment of a finalized, non-cancelled invoice of a business the
 * caller owns.
 *
 * Deleting a payment reduces the invoice's paid amount and re-derives its
 * status (PAID → PARTIALLY_PAID / PENDING_PAYMENT as applicable). The
 * `UsagePeriod` quota is deliberately NOT restored: quota counts finalized
 * invoices, not payments.
 *
 * @throws UnauthorizedError / ValidationError / NotFoundError / ForbiddenError
 */
export async function deleteInvoicePayment(paymentId: unknown): Promise<InvoicePaymentRecord> {
  const session = await requireSession();
  const id = assertPaymentId(paymentId);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Locate the real parent from the row itself (server-side, never the
    // payload). Pre-lock lookup for the lock key only — see updateInvoicePayment.
    const located = await tx.invoicePayment.findUnique({ where: { id } });
    if (!located) {
      throw new NotFoundError("Payment not found");
    }

    // 1. Lock the invoice row BEFORE reading/summing payments (see module doc).
    await lockInvoiceRow(tx, located.invoiceId);

    // 2. Load the authoritative invoice and authorize.
    const invoice = await loadInvoiceForPayment(tx, located.invoiceId);
    if (!invoice) {
      throw new NotFoundError("Invoice not found");
    }
    assertInvoiceAccess(invoice, session);
    assertBusinessAcceptsPaymentMutations(invoice.business, "delete a payment");
    assertInvoiceAcceptsPaymentMutations(invoice);

    // 3. Authoritative payment row under the lock (a concurrent transaction
    //    may have deleted it in the meantime).
    const existing = await tx.invoicePayment.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError("Payment not found");
    }

    // 4. The balance after deletion is the sum of all remaining payments.
    const remainingPayments = await tx.invoicePayment.findMany({
      where: { invoiceId: invoice.id, NOT: { id: existing.id } },
      select: { amount: true },
    });
    const newPaidAmount = sumPaymentAmounts(remainingPayments);

    // 5. Mutate the payment row.
    const deleted: InvoicePaymentRecord = await tx.invoicePayment.delete({
      where: { id: existing.id },
    });

    // 6. Recalculate and persist the denormalized payment state, then commit.
    //    Deliberately no UsagePeriod write here: deleting a payment never
    //    restores invoice quota.
    await syncInvoicePaymentState(tx, invoice, newPaidAmount);

    return deleted as unknown as InvoicePaymentRecord;
  });
}
