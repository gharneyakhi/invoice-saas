import type { Business } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError, NotFoundError, requireSession } from "@/server/auth/requireSession";

/**
 * Server-side business isolation guard (Phase 3).
 *
 * `businessId` is always treated as an untrusted caller-supplied identifier.
 * Ownership is proven only by comparing the Business row's `accountId` to the
 * Account loaded by `requireSession()` from the server session — never from
 * a client/JWT claim about which business is "current".
 *
 * Distinct errors: missing row → NotFoundError; row exists but belongs to
 * another Account → ForbiddenError. Callers must not collapse these into a
 * single "not found" unless a later hardening pass explicitly chooses that.
 */
export async function requireBusinessOwnership(businessId: string): Promise<Business> {
  const session = await requireSession();

  const business = await prisma.business.findUnique({
    where: { id: businessId },
  });

  if (!business) {
    throw new NotFoundError("Business not found");
  }

  if (business.accountId !== session.accountId) {
    throw new ForbiddenError("Business does not belong to this account");
  }

  return business;
}
