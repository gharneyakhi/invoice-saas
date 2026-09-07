"use server";

import { requireSession } from "@/server/auth/requireSession";
import {
  archiveBusiness as archiveBusinessService,
  createBusiness as createBusinessService,
  getBusiness as getBusinessService,
  listBusinesses as listBusinessesService,
  updateBusiness as updateBusinessService,
  type ListBusinessesOptions,
} from "@/server/business/businessService";
import { runAction, type ActionResult } from "@/server/actions/actionResult";
import { toBusinessDTO, type BusinessDTO } from "@/server/actions/dto";

/**
 * Business Server Actions — the application boundary between the React UI and
 * the existing `businessService` domain layer.
 *
 * Each action authenticates server-side first, then delegates to the domain
 * service (the single source of truth for business rules / ownership / quota),
 * then maps the service result onto a safe serializable DTO — or maps any
 * thrown domain error onto a `{ code, message }` payload. No Prisma, no client
 * ownership claims: `businessService` derives the account exclusively from the
 * session, so a client-supplied `accountId`/`businessId` can never cross an
 * account boundary.
 */

export interface ListBusinessesActionArgs {
  includeArchived?: boolean;
}

/** Lists the authenticated account's businesses (primary-first, live by default). */
export async function listBusinesses(
  args: ListBusinessesActionArgs = {},
): Promise<ActionResult<BusinessDTO[]>> {
  return runAction(async () => {
    await requireSession();
    const options: ListBusinessesOptions = {
      ...(args.includeArchived ? { includeArchived: true } : {}),
    };
    const records = await listBusinessesService(options);
    return records.map(toBusinessDTO);
  });
}

/** Returns one business the caller owns (including an archived one). */
export async function getBusiness(businessId: string): Promise<ActionResult<BusinessDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await getBusinessService(businessId);
    return toBusinessDTO(record);
  });
}

/**
 * Creates a business for the authenticated account. `name` only — entitlement
 * (business limit) and primary assignment are enforced by `businessService`.
 */
export async function createBusiness(input: unknown): Promise<ActionResult<BusinessDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await createBusinessService(input);
    return toBusinessDTO(record);
  });
}

/** Updates `name`/`isActive` of an owned business. Server-owned fields are rejected by the service schema. */
export async function updateBusiness(
  businessId: string,
  input: unknown,
): Promise<ActionResult<BusinessDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await updateBusinessService(businessId, input);
    return toBusinessDTO(record);
  });
}

/** Archives (soft-deletes) an owned business, preserving its history. */
export async function archiveBusiness(businessId: string): Promise<ActionResult<BusinessDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await archiveBusinessService(businessId);
    return toBusinessDTO(record);
  });
}
