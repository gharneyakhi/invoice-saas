import { prisma } from "@/lib/prisma";

export interface UserAuthContext {
  userId: string;
  accountId: string;
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
}

/**
 * Looks up the authoritative (userId, accountId, status) triple for a
 * freshly-authenticated email. Used only at the moment of sign-in to seed
 * the JWT — see `src/server/auth/requireSession.ts` for the *per-request*
 * re-verification used by protected API routes/actions, which re-reads
 * status from the DB on every call rather than trusting the JWT claim
 * indefinitely (section 11/37: authorization must be server-side).
 */
export async function loadUserAuthContext(email: string): Promise<UserAuthContext | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { accounts: { take: 1 } },
  });

  if (!user) return null;
  const account = user.accounts[0];
  if (!account) return null;

  return {
    userId: user.id,
    accountId: account.id,
    // If either the User or the Account has been suspended/deleted, the
    // combined status must reflect that — ACTIVE only when both are.
    status: user.status === "ACTIVE" && account.status === "ACTIVE" ? "ACTIVE" : "SUSPENDED",
  };
}
