import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { getUsagePeriodBounds } from "@/lib/usage-period";

export interface GoogleLoginInput {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  /** Present only on the OAuth handshake turn, absent on subsequent JWT refreshes. */
  accessToken?: string | null;
  refreshToken?: string | null;
  /** Unix seconds, as provided by next-auth's `account.expires_at`. */
  expiresAt?: number | null;
  scope?: string | null;
}

export interface BootstrapResult {
  userId: string;
  accountId: string;
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  /** True only the first time this User's Account/Business chain was created. */
  createdNewAccount: boolean;
}

/**
 * Implements section 7 ("Authentication") of the Master Build Prompt:
 *
 *   First login:
 *     1. Authenticate user            (done by NextAuth/Google before this runs)
 *     2. Create User
 *     3. Create Account
 *     4. Create Free subscription
 *     5. Create UsagePeriod
 *     6. Create initial Business
 *     7. Create BusinessProfile
 *
 *   Returning login: load the existing Account/Businesses — do NOT recreate.
 *
 * Runs as a single DB transaction so a failure partway through (e.g. the
 * FREE plan not being seeded yet) leaves no orphaned User/Account/Business.
 *
 * Idempotency: `User.googleId` is unique, and `Account.ownerUserId` is now
 * unique at the DB level too (Phase 2 schema change), so upserting the User
 * and then checking for an existing Account before creating one guarantees
 * a returning login can never create a second Account or Business chain —
 * even under concurrent requests, the second transaction's `account.create`
 * would violate the unique constraint and fail loudly rather than silently
 * duplicating data.
 */

/**
 * Unions two space-separated OAuth scope strings (deduped, trimmed).
 *
 * Export V1 Gmail scope preservation: Google login requests only
 * `openid email profile`, while the separate Gmail connect flow adds
 * `gmail.send` to the SAME `OAuthConnection` row (see
 * `gmailService.saveGmailConnection`, which merges identically). A
 * returning login must UNION the scopes, never overwrite, otherwise the
 * stored `gmail.send` grant would be wiped on every login and Gmail would
 * falsely appear disconnected.
 *
 * Kept local (instead of importing from `export/gmailOAuth`) so the auth
 * boundary stays independent of the export module; behavior is identical
 * to `mergeOAuthScope` (existing tokens first, new tokens appended).
 */
function mergeLoginScopePreservingGmail(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const tokens = new Set<string>();
  for (const scope of [existing, incoming]) {
    if (typeof scope !== "string") continue;
    for (const token of scope.split(/\s+/)) {
      const trimmed = token.trim();
      if (trimmed !== "") tokens.add(trimmed);
    }
  }
  if (tokens.size === 0) return existing ?? incoming ?? null;
  return [...tokens].join(" ");
}
export async function bootstrapUserOnGoogleLogin(input: GoogleLoginInput): Promise<BootstrapResult> {
  if (!input.googleId || !input.email) {
    throw new Error("googleId and email are required to bootstrap a user");
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const user = await tx.user.upsert({
      where: { googleId: input.googleId },
      update: {
        name: input.name,
        avatarUrl: input.avatarUrl,
        lastLoginAt: new Date(),
      },
      create: {
        googleId: input.googleId,
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl,
        lastLoginAt: new Date(),
      },
    });

    // Persist/refresh the encrypted OAuth connection whenever Google hands
    // us tokens (only on the actual OAuth handshake, not on later JWT
    // refreshes where next-auth doesn't re-supply them).
    //
    // Gmail scope preservation: login-only scopes (`openid email profile`)
    // must never wipe a previously granted `gmail.send` scope stored on
    // the same row by the Gmail connect flow. Merge (union) instead of
    // overwriting; refresh-token behavior is unchanged (only overwritten
    // when Google supplies a new one, so the Gmail refresh token survives
    // logins that don't return one).
    if (input.accessToken || input.refreshToken) {
      const existingOAuth = await tx.oAuthConnection.findUnique({
        where: { userId_provider: { userId: user.id, provider: "GOOGLE" } },
        select: { scope: true },
      });
      const mergedScope = mergeLoginScopePreservingGmail(existingOAuth?.scope, input.scope);
      await tx.oAuthConnection.upsert({
        where: { userId_provider: { userId: user.id, provider: "GOOGLE" } },
        update: {
          ...(input.accessToken ? { accessTokenEncrypted: encrypt(input.accessToken) } : {}),
          ...(input.refreshToken ? { refreshTokenEncrypted: encrypt(input.refreshToken) } : {}),
          expiresAt: input.expiresAt ? new Date(input.expiresAt * 1000) : null,
          scope: mergedScope,
        },
        create: {
          userId: user.id,
          provider: "GOOGLE",
          accessTokenEncrypted: input.accessToken ? encrypt(input.accessToken) : null,
          refreshTokenEncrypted: input.refreshToken ? encrypt(input.refreshToken) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt * 1000) : null,
          scope: mergedScope,
        },
      });
    }

    const existingAccount = await tx.account.findUnique({ where: { ownerUserId: user.id } });

    if (existingAccount) {
      await tx.auditLog.create({
        data: {
          accountId: existingAccount.id,
          userId: user.id,
          action: "LOGIN",
          entityType: "User",
          entityId: user.id,
        },
      });

      return {
        userId: user.id,
        accountId: existingAccount.id,
        status: existingAccount.status,
        createdNewAccount: false,
      };
    }

    // ---- First login: build the full chain ----------------------------

    const freePlan = await tx.plan.findUnique({ where: { key: "FREE" } });
    if (!freePlan) {
      throw new Error(
        "Cannot bootstrap a new account: the FREE plan is not seeded. Run `npm run prisma:seed` first.",
      );
    }

    const account = await tx.account.create({
      data: {
        ownerUserId: user.id,
        name: input.name || input.email,
        status: "ACTIVE",
      },
    });

    const now = new Date();
    const subscription = await tx.subscription.create({
      data: {
        accountId: account.id,
        planId: freePlan.id,
        status: "ACTIVE",
        startDate: now,
      },
    });

    const { periodStart, periodEnd } = getUsagePeriodBounds(now);
    await tx.usagePeriod.create({
      data: {
        accountId: account.id,
        subscriptionId: subscription.id,
        periodStart,
        periodEnd,
        invoiceCount: 0,
      },
    });

    const businessName = input.name ? `کسب‌وکار ${input.name}` : "کسب‌وکار من";
    const business = await tx.business.create({
      data: {
        accountId: account.id,
        name: businessName,
        isPrimary: true,
      },
    });

    await tx.businessProfile.create({
      data: {
        businessId: business.id,
        businessName,
      },
    });

    // Not one of the 7 numbered steps in section 7, but InvoiceSettings is
    // unique-per-business and required before any invoice can be numbered
    // (section 14). Creating it now avoids a nullable-settings check
    // scattered across every future invoice-numbering call site.
    await tx.invoiceSettings.create({
      data: {
        businessId: business.id,
        nextInvoiceNumber: 1,
      },
    });

    await tx.auditLog.create({
      data: {
        accountId: account.id,
        userId: user.id,
        action: "ACCOUNT_BOOTSTRAPPED",
        entityType: "Account",
        entityId: account.id,
        metadata: { businessId: business.id } as Prisma.InputJsonValue,
      },
    });

    return {
      userId: user.id,
      accountId: account.id,
      status: account.status,
      createdNewAccount: true,
    };
  });
}
