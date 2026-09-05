import { getServerSession } from "next-auth";
import { authOptions } from "@/server/auth/auth-options";
import { prisma } from "@/lib/prisma";

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface AuthenticatedContext {
  userId: string;
  accountId: string;
}

/**
 * The mandatory first call in every protected API route / server action
 * (section 37: "Every protected API/action must verify: 1. authenticated
 * user, 2. account..."). Deliberately re-reads User/Account status fresh
 * from the database on every call rather than trusting whatever the JWT
 * said at login time — a session token issued before a suspension must
 * stop working immediately, not just at next login.
 *
 * Never trust a userId/accountId passed in from the client for this check;
 * the only source of truth for "who is calling" is the server-side
 * session cookie.
 */
export async function requireSession(): Promise<AuthenticatedContext> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.accountId) {
    throw new UnauthorizedError();
  }

  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    include: { owner: true },
  });

  if (!account || account.ownerUserId !== session.user.id) {
    // Should be unreachable given how the JWT is populated, but treated as
    // a hard authorization failure rather than assumed impossible.
    throw new ForbiddenError("Session account mismatch");
  }

  if (account.status !== "ACTIVE" || account.owner.status !== "ACTIVE") {
    throw new ForbiddenError("Account is not active");
  }

  return { userId: session.user.id, accountId: account.id };
}
