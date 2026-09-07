"use server";

import { requireSession } from "@/server/auth/requireSession";
import {
  archiveCustomer as archiveCustomerService,
  createCustomer as createCustomerService,
  getCustomer as getCustomerService,
  listCustomers as listCustomersService,
  updateCustomer as updateCustomerService,
} from "@/server/customer/customerService";
import { runAction, type ActionResult } from "@/server/actions/actionResult";
import { toCustomerDTO, type CustomerDTO } from "@/server/actions/dto";

/**
 * Customer Server Actions — thin application boundary over `customerService`.
 *
 * `businessId` is an untrusted *identifier*: ownership is proven server-side by
 * `customerService` via `requireBusinessOwnership`, so a caller can never list,
 * read, create, update or archive another account's customers by guessing an
 * id. Nothing here duplicates customer validation (strict Zod schemas live in
 * the service) or archive semantics.
 */

/** Lists the live customers of a business the caller owns. */
export async function listCustomers(businessId: string): Promise<ActionResult<CustomerDTO[]>> {
  return runAction(async () => {
    await requireSession();
    const records = await listCustomersService(businessId);
    return records.map(toCustomerDTO);
  });
}

/** Returns one customer (including archived) of a business the caller owns. */
export async function getCustomer(
  businessId: string,
  customerId: string,
): Promise<ActionResult<CustomerDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await getCustomerService(businessId, customerId);
    return toCustomerDTO(record);
  });
}

export async function createCustomer(
  businessId: string,
  input: unknown,
): Promise<ActionResult<CustomerDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await createCustomerService(businessId, input);
    return toCustomerDTO(record);
  });
}

export async function updateCustomer(
  businessId: string,
  customerId: string,
  input: unknown,
): Promise<ActionResult<CustomerDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await updateCustomerService(businessId, customerId, input);
    return toCustomerDTO(record);
  });
}

export async function archiveCustomer(
  businessId: string,
  customerId: string,
): Promise<ActionResult<CustomerDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await archiveCustomerService(businessId, customerId);
    return toCustomerDTO(record);
  });
}
