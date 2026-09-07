"use server";

import { requireSession } from "@/server/auth/requireSession";
import {
  createDraftInvoice as createDraftInvoiceService,
  finalizeInvoice as finalizeInvoiceService,
  getInvoice as getInvoiceService,
  listInvoices as listInvoicesService,
  queryInvoices as queryInvoicesService,
  updateDraftInvoice as updateDraftInvoiceService,
} from "@/server/invoice/invoiceService";
import { runAction, type ActionResult } from "@/server/actions/actionResult";
import { parseInvoiceListQuery } from "@/server/invoice/schema";
import {
  toInvoiceDTO,
  toInvoiceListDTO,
  type InvoiceListDTO,
  toInvoiceDetailDTO,
  type InvoiceDetailDTO,
  type InvoiceDTO,
} from "@/server/actions/dto";

/**
 * Invoice Server Actions — the application boundary over `invoiceService`.
 *
 * Implemented here (only the milestone-needed surface):
 *   - listInvoices / getInvoice
 *   - createDraftInvoice
 *   - finalizeInvoice
 * (cancel, exports, PDF, payment-gateway flows are intentionally out of scope.)
 *
 * `businessId` / `invoiceId` are untrusted identifiers — ownership is proven
 * server-side by `invoiceService` (session-derived account vs the row's owning
 * business). All quota, numbering, snapshot and money calculations stay in the
 * service; nothing here trusts client totals, paid/remaining amounts, status,
 * invoice numbers or finalizedAt.
 */

export interface ListInvoicesActionArgs {
  businessId: string;
  status?: "DRAFT" | "ISSUED" | "SENT" | "PENDING_PAYMENT" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "CANCELLED";
  limit?: number;
}

/** Lists the invoices of a business the caller owns, newest first (summary rows). */
export async function listInvoices(
  args: ListInvoicesActionArgs,
): Promise<ActionResult<InvoiceDTO[]>> {
  return runAction(async () => {
    await requireSession();
    const records = await listInvoicesService(args.businessId, {
      ...(args.status ? { status: args.status } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    return records.map(toInvoiceDTO);
  });
}

/**
 * Search / filter / sort / paginate the invoices of a business the caller owns.
 *
 * The raw query object (typically built from the URL search params) is parsed
 * by `parseInvoiceListQuery` before it reaches the service, so unknown keys,
 * unsupported sort columns and oversized page sizes are rejected at the
 * boundary. Ownership and business isolation remain server-side in
 * `invoiceService.queryInvoices`.
 */
/** `issuedFrom`/`issuedTo` arrive as an ISO string or a Date; normalise to Date. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function queryInvoices(
  businessId: string,
  query: unknown,
): Promise<ActionResult<InvoiceListDTO>> {
  return runAction(async () => {
    await requireSession();
    const parsed = parseInvoiceListQuery(query);
    const result = await queryInvoicesService(businessId, {
      ...(parsed.search ? { search: parsed.search } : {}),
      ...(parsed.statuses ? { statuses: parsed.statuses } : {}),
      lifecycle: parsed.lifecycle,
      ...(parsed.invoiceType ? { invoiceType: parsed.invoiceType } : {}),
      ...(parsed.customerId ? { customerId: parsed.customerId } : {}),
      ...(parsed.issuedFrom ? { issuedFrom: toDate(parsed.issuedFrom) } : {}),
      ...(parsed.issuedTo ? { issuedTo: toDate(parsed.issuedTo) } : {}),
      sortBy: parsed.sortBy,
      sortDirection: parsed.sortDirection,
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
    return toInvoiceListDTO(result);
  });
}

/** Returns one invoice of a business the caller owns, with its line items. */
export async function getInvoice(
  businessId: string,
  invoiceId: string,
): Promise<ActionResult<InvoiceDetailDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await getInvoiceService(businessId, invoiceId);
    return toInvoiceDetailDTO(record);
  });
}

/**
 * Creates a DRAFT invoice for a business the caller owns. The payload may only
 * carry line-item inputs, dates and percent fields; money is recalculated
 * server-side and quota is not consumed for drafts.
 */
export async function createDraftInvoice(
  businessId: string,
  input: unknown,
): Promise<ActionResult<InvoiceDetailDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await createDraftInvoiceService(businessId, input);
    return toInvoiceDetailDTO(record);
  });
}

/**
 * Replaces the editable content of an existing DRAFT invoice the caller owns.
 * The payload may only carry line-item inputs, dates and percent fields;
 * ownership, the draft-only lifecycle rule and the authoritative money
 * recalculation all live in `invoiceService`. Server-owned fields (status,
 * invoice number, totals, paid/remaining amounts) can never be supplied here.
 */
export async function updateDraftInvoice(
  businessId: string,
  invoiceId: string,
  input: unknown,
): Promise<ActionResult<InvoiceDetailDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await updateDraftInvoiceService(businessId, invoiceId, input);
    return toInvoiceDetailDTO(record);
  });
}

/**
 * Finalizes a DRAFT invoice the caller owns. Quota enforcement, atomic official
 * numbering and immutable snapshot creation all run inside `invoiceService`.
 */
export async function finalizeInvoice(invoiceId: string): Promise<ActionResult<InvoiceDetailDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await finalizeInvoiceService(invoiceId);
    return toInvoiceDetailDTO(record);
  });
}
