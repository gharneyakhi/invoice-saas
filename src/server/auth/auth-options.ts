import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { bootstrapUserOnGoogleLogin } from "@/server/auth/bootstrap";
import { loadUserAuthContext } from "@/server/auth/loadUserAuthContext";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const authOptions: NextAuthOptions = {
  // No PrismaAdapter: our domain model already owns "Account" with a
  // different meaning (billing account, see README architecture map), so
  // we manage the User/Account/Business bootstrap ourselves in the
  // signIn callback instead of letting an adapter write its own tables.
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  secret: process.env.NEXTAUTH_SECRET,
  useSecureCookies: process.env.NODE_ENV === "production",
  providers: [
    GoogleProvider({
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      // Only the base login scopes here. Gmail-send scope is requested
      // separately, later, only when the user opts into email sending
      // (section 25: "Google Login and Gmail sending permission are
      // separate concepts") — implemented in the Communication phase.
      authorization: {
        params: {
          scope: "openid email profile",
          prompt: "select_account",
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    /**
     * Runs on every OAuth handshake. This is where the section-7 bootstrap
     * sequence happens, inside one DB transaction. Returning `false` here
     * denies the login outright (e.g. a non-Google provider, which can't
     * happen given our single provider, but guarded defensively).
     */
    async signIn({ account, profile }) {
      if (!account || account.provider !== "google") return false;
      if (!profile?.email) return false;

      const googleProfile = profile as typeof profile & { picture?: string };

      const result = await bootstrapUserOnGoogleLogin({
        googleId: account.providerAccountId,
        email: profile.email,
        name: profile.name ?? profile.email,
        avatarUrl: googleProfile.picture ?? null,
        accessToken: account.access_token,
        refreshToken: account.refresh_token,
        expiresAt: account.expires_at,
        scope: account.scope,
      });

      // A suspended/deleted account is denied at sign-in time, not just
      // hidden in the UI (section 37: server-side authorization).
      if (result.status !== "ACTIVE") return false;

      return true;
    },

    /**
     * Populates the JWT with internal identifiers ONLY (never tokens/secrets)
     * on the initial sign-in turn. On subsequent requests, next-auth reuses
     * this JWT without calling bootstrap again — so a returning user's
     * Account/Business are simply loaded once at login and then trusted
     * for the session lifetime, same as any other JWT-session app.
     */
    async jwt({ token, account, profile }) {
      if (account && profile?.email) {
        const ctx = await loadUserAuthContext(profile.email);
        if (ctx) {
          token.userId = ctx.userId;
          token.accountId = ctx.accountId;
          token.status = ctx.status;
        }
      }
      return token;
    },

    /**
     * Shapes what the browser actually receives. Only non-secret,
     * non-sensitive identifiers are exposed (section 36).
     */
    async session({ session, token }) {
      if (session.user && token.userId && token.accountId) {
        session.user.id = token.userId;
        session.user.status = token.status ?? "ACTIVE";
        session.accountId = token.accountId;
      }
      return session;
    },
  },
};
