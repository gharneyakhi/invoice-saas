"use server";

import { requireSession } from "@/server/auth/requireSession";
import {
  createInvoicePayment as createInvoicePaymentService,
  deleteInvoicePayment as deleteInvoicePaymentService,
  listInvoicePayments as listInvoicePaymentsService,
  updateInvoicePayment as updateInvoicePaymentService,
} from "@/server/payment/paymentService";
import { runAction, type ActionResult } from "@/server/actions/actionResult";
import { toInvoicePaymentDTO, type InvoicePaymentDTO } from "@/server/actions/dto";

/**
 * Payment Server Actions — thin application boundary over `paymentService`.
 *
 * No gateway integration here (out of scope). `invoiceId`/`paymentId` are
 * untrusted identifiers: ownership is proven server-side by `paymentService`
 * (invoice → business → session account). Amounts are validated and re-derived
 * with Decimal inside the service; a client-supplied status / paidAmount /
 * remainingAmount is never accepted.
 */

/** Lists the payments of an invoice the caller owns, newest first. */
export async function listInvoicePayments(
  invoiceId: string,
): Promise<ActionResult<InvoicePaymentDTO[]>> {
  return runAction(async () => {
    await requireSession();
    const records = await listInvoicePaymentsService(invoiceId);
    return records.map(toInvoicePaymentDTO);
  });
}

/** Records a payment against a finalized, non-cancelled invoice the caller owns. */
export async function createInvoicePayment(
  invoiceId: string,
  input: unknown,
): Promise<ActionResult<InvoicePaymentDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await createInvoicePaymentService(invoiceId, input);
    return toInvoicePaymentDTO(record);
  });
}

/** Updates a payment of a finalized, non-cancelled invoice the caller owns. */
export async function updateInvoicePayment(
  paymentId: string,
  input: unknown,
): Promise<ActionResult<InvoicePaymentDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await updateInvoicePaymentService(paymentId, input);
    return toInvoicePaymentDTO(record);
  });
}

/** Deletes a payment of a finalized, non-cancelled invoice the caller owns. */
export async function deleteInvoicePayment(
  paymentId: string,
): Promise<ActionResult<InvoicePaymentDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await deleteInvoicePaymentService(paymentId);
    return toInvoicePaymentDTO(record);
  });
}
