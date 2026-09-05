import { withAuth } from "next-auth/middleware";

/**
 * Coarse-grained route protection. This is a UX convenience (redirect
 * unauthenticated visitors to /login before they see a protected page at
 * all) — it is NOT the authorization boundary. The real authorization
 * check is `requireSession()` (src/server/auth/requireSession.ts), called
 * server-side inside every protected page/API route, which re-verifies
 * Account/User status against the database on every request. Per section
 * 37: "Do not rely on frontend route protection alone."
 */
export default withAuth({
  pages: {
    signIn: "/login",
  },
});

export const config = {
  matcher: ["/dashboard/:path*", "/invoices/:path*", "/customers/:path*", "/products/:path*", "/settings/:path*"],
};
