import { prisma } from "@/lib/prisma";
import { requireBusinessOwnership } from "@/server/auth/requireBusinessOwnership";
import { ForbiddenError, NotFoundError } from "@/server/auth/requireSession";
import { ValidationError } from "@/server/errors";
import {
  parseCreateCustomerInput,
  parseUpdateCustomerInput,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from "@/server/customer/schema";

/**
 * Customer CRUD domain layer (server-side only) — the minimum surface the
 * invoice editor needs to pick, create and correct a customer.
 *
 * Authorization rules applied by *every* function in this module:
 *
 *   1. `requireBusinessOwnership(businessId)` runs first. It calls
 *      `requireSession()` internally (the only source of truth for "who is
 *      calling") and re-reads the Business row to compare its `accountId`
 *      against the session account — 404 when the Business is missing, 403
 *      when it belongs to another Account.
 *   2. No function accepts an `accountId`, and `businessId` is treated as an
 *      untrusted *identifier*, never as proof of ownership. The value written
 *      to `Customer.businessId` and used in every `where` clause is the
 *      verified row's `id`, not the raw client string.
 *   3. A Customer is only ever reachable through its own Business: a row whose
 *      `businessId` differs from the verified Business is refused with
 *      `ForbiddenError`, exactly as `invoiceService` refuses a cross-business
 *      customer reference.
 *
 * Nothing is hard-deleted here. `Customer.archivedAt` exists in the schema, so
 * "delete" is an archive stamp; invoices, and the immutable
 * `InvoiceCustomerSnapshot` rows written at finalization time, keep pointing at
 * a row that still exists.
 *
 * Historical integrity: no function in this module reads or writes
 * `InvoiceCustomerSnapshot`. A snapshot is taken once, at finalization, from
 * the customer as it was then; editing the Customer afterwards changes the
 * living record only and can never rewrite a finalized invoice.
 */

/**
 * Row shape of the `customers` table (mirrors `model Customer` in
 * `prisma/schema.prisma`). Declared locally rather than importing the
 * `Customer` model type from `@prisma/client`, which only exists after
 * `prisma generate` has run — the same convention as `BusinessRecord` in
 * `src/server/business/businessService.ts`.
 */
export interface CustomerRecord {
  id: string;
  businessId: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationalId: string | null;
  economicCode: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/**
 * Stable order for customer pickers: by name, with `id` as a final
 * tie-breaker so two customers sharing a name never swap places between
 * requests.
 */
export const CUSTOMER_LIST_ORDER_BY = [{ name: "asc" }, { id: "asc" }];

function assertCustomerId(customerId: unknown): string {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    throw new ValidationError("Customer ID is required");
  }
  return customerId;
}

/**
 * An archived Business is retired: its historical data stays readable, but it
 * accepts no new writes. Mirrors the guard `invoiceService` applies before
 * creating or finalizing an invoice.
 */
function assertBusinessIsMutable(business: { archivedAt: Date | null }, action: string): void {
  if (business.archivedAt !== null) {
    throw new ValidationError(`Cannot ${action} for an archived business`);
  }
}

/**
 * Loads a Customer strictly inside the already-verified Business.
 *
 * Missing row → `NotFoundError`. Row that exists but lives in another Business
 * (including another account's business) → `ForbiddenError`. The two are kept
 * distinct on purpose, matching `requireBusinessOwnership()`.
 */
async function loadCustomerInBusiness(
  businessId: string,
  customerId: string,
): Promise<CustomerRecord> {
  const customer: CustomerRecord | null = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  if (!customer) {
    throw new NotFoundError("Customer not found");
  }

  if (customer.businessId !== businessId) {
    throw new ForbiddenError("Customer does not belong to this business");
  }

  return customer;
}

/**
 * Lists the customers of a business the caller owns.
 *
 * Archived customers are excluded — archiving is the soft delete, so they must
 * not show up in the invoice editor's picker.
 */
export async function listCustomers(businessId: string): Promise<CustomerRecord[]> {
  const owned = await requireBusinessOwnership(businessId);

  return prisma.customer.findMany({
    where: { businessId: owned.id, archivedAt: null },
    orderBy: CUSTOMER_LIST_ORDER_BY,
  });
}

/**
 * Returns a single customer of a business the caller owns, including an
 * archived one — an invoice that already references a customer must still be
 * able to display it after archiving (list views filter instead).
 */
export async function getCustomer(
  businessId: string,
  customerId: string,
): Promise<CustomerRecord> {
  const owned = await requireBusinessOwnership(businessId);
  const id = assertCustomerId(customerId);

  return loadCustomerInBusiness(owned.id, id);
}

/**
 * Creates a customer under a business the caller owns.
 *
 * `businessId` on the created row comes from the verified Business, and the
 * payload schema is strict, so a client cannot re-parent the customer or set
 * any server-owned column.
 */
export async function createCustomer(
  businessId: string,
  input: unknown,
): Promise<CustomerRecord> {
  const owned = await requireBusinessOwnership(businessId);
  assertBusinessIsMutable(owned, "create a customer");
  const data: CreateCustomerInput = parseCreateCustomerInput(input);

  const created: CustomerRecord = await prisma.customer.create({
    data: {
      businessId: owned.id,
      name: data.name,
      mobile: data.mobile ?? null,
      phone: data.phone ?? null,
      email: data.email ?? null,
      address: data.address ?? null,
      nationalId: data.nationalId ?? null,
      economicCode: data.economicCode ?? null,
      notes: data.notes ?? null,
    },
  });

  return created;
}

/**
 * Updates a customer of a business the caller owns.
 *
 * Only fields actually present in the payload are written, so a partial update
 * cannot blank out columns it never mentioned. An explicit `null` clears a
 * nullable column.
 *
 * This touches the `customers` row and nothing else: any
 * `InvoiceCustomerSnapshot` already written by `finalizeInvoice` is left
 * exactly as it was, which is what keeps finalized invoices historically
 * correct after a customer is renamed or corrected.
 */
export async function updateCustomer(
  businessId: string,
  customerId: string,
  input: unknown,
): Promise<CustomerRecord> {
  const owned = await requireBusinessOwnership(businessId);
  assertBusinessIsMutable(owned, "update a customer");
  const id = assertCustomerId(customerId);
  const existing = await loadCustomerInBusiness(owned.id, id);

  if (existing.archivedAt !== null) {
    throw new ValidationError("Cannot update an archived customer");
  }

  const data: UpdateCustomerInput = parseUpdateCustomerInput(input);

  const updated: CustomerRecord = await prisma.customer.update({
    where: { id: existing.id }, // the verified row's id, not the raw client value
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.mobile !== undefined ? { mobile: data.mobile } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.address !== undefined ? { address: data.address } : {}),
      ...(data.nationalId !== undefined ? { nationalId: data.nationalId } : {}),
      ...(data.economicCode !== undefined ? { economicCode: data.economicCode } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  return updated;
}

/**
 * Archives (soft-deletes) a customer of a business the caller owns.
 *
 * `Customer.archivedAt` exists in the schema, so this is the delete path and
 * there is deliberately no hard-delete function in this module: a customer may
 * be referenced by `Invoice.customerId`, and removing the row would orphan
 * finalized invoices.
 *
 * Idempotent — archiving an already archived customer returns the current row
 * rather than moving the archive timestamp.
 */
export async function archiveCustomer(
  businessId: string,
  customerId: string,
): Promise<CustomerRecord> {
  const owned = await requireBusinessOwnership(businessId);
  assertBusinessIsMutable(owned, "archive a customer");
  const id = assertCustomerId(customerId);
  const existing = await loadCustomerInBusiness(owned.id, id);

  if (existing.archivedAt !== null) {
    return existing;
  }

  const archived: CustomerRecord = await prisma.customer.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  });

  return archived;
}
