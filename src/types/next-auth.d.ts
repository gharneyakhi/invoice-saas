import type { DefaultSession } from "next-auth";

/**
 * We intentionally expose ONLY internal identifiers and status flags on the
 * session — never OAuth access/refresh tokens (section 36: "Never expose
 * OAuth access tokens... to the client"). Anything token-related stays
 * server-side in `OAuthConnection.accessTokenEncrypted` /
 * `refreshTokenEncrypted`, decrypted only when a server action needs to
 * call Google APIs (e.g. Gmail send, in a later phase).
 */
declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
    accountId: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    accountId?: string;
    status?: "ACTIVE" | "SUSPENDED" | "DELETED";
  }
}
