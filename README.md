# Invoice SaaS — Persian RTL Invoicing Platform

## 1. Architecture Map

```
User ──▶ Account ──▶ Business ──▶ Business-owned data
                │                  (Customers, Products, Invoices, Files, InvoiceSettings)
                ├─▶ Subscription ──▶ Plan ──▶ PlanFeature ──▶ Feature
                ├─▶ UsagePeriod (invoice quota, scoped to Account, per month)
                └─▶ SubscriptionPayment (SaaS billing, separate from InvoicePayment)

Invoice ──▶ InvoiceItem[]
        ──▶ InvoicePayment[]
        ──▶ InvoiceSellerSnapshot (immutable, written at finalization)
        ──▶ InvoiceCustomerSnapshot (immutable, written at finalization)
```

Key isolation rule: **Business is the data-isolation boundary.** Every
query touching Customer/Product/Invoice/File must verify
`business.accountId === session.accountId` server-side. `businessId` from
the client is never trusted as proof of authorization — see
`src/lib/entitlements.ts` and the (to-be-built) `requireBusinessOwnership()`
guard in Phase 3.

Subscription lives on `Account`, not `Business`, so plan limits apply
across all of a user's businesses combined (business count) and per
Account for invoice quota (`UsagePeriod`).

## 2. What's implemented in this delivery (Phase 1 — Foundation)

- `prisma/schema.prisma` — the **complete** data model from the JSON spec:
  all 20 entities, UUID PKs, `Decimal` for every monetary field, composite
  unique constraint on `(businessId, invoiceNumber)`, indexes on
  `accountId`, `businessId`, `customerId`, `status`, `issueDate`, `dueDate`,
  `createdAt` as required by section 5.
- `prisma/seed.ts` — seeds Plans/Features/PlanFeatures from the spec's
  `subscription_plans`. Prices are read from env vars, never hard-coded.
- `src/lib/invoice-calculation.ts` — the **authoritative, server-only**
  money engine (section 13): line subtotal → line discount → global
  discount → VAT → total, using `decimal.js`, never floating point.
  Includes `derivePaymentStatus()` for section 17's payment-status rules.
- `src/lib/invoice-calculation.test.ts` — 17 passing tests covering the
  mandatory edge cases from section 53: zero quantity, negative price,
  100% and >100% discount, zero VAT, overpayment, overdue-vs-paid
  precedence, negative payment rejection.
- `src/lib/entitlements.ts` — the centralized entitlement system from
  section 45 (`canCreateBusiness`, `canFinalizeInvoice`, `canSendEmail`,
  etc.), including the "expired subscription falls back to Free rules"
  behavior from the business rules.
- `.env.example` — every external credential documented (Google OAuth,
  S3-compatible storage, payment gateway, plan pricing), nothing committed.
- `package.json` / `tsconfig.json` / `tailwind.config.ts` /
  `next.config.js` — the exact stack from the spec (Next.js, TypeScript,
  Tailwind, Prisma, NextAuth, Zod, React Hook Form, googleapis, AWS S3 SDK,
  ExcelJS, pdf-lib, decimal.js, jalaali-js).

**Verified, not just written:** `npx vitest run` → 17/17 tests pass.

## 3. What's explicitly NOT built yet (by design — see roadmap)

Per the Master Build Prompt's own instruction (section 55/56): don't
generate the whole app in one blind step. Phases 2–9 below are the plan;
say "continue to Phase 2" (or name a phase) and I'll implement it against
this foundation, verifying previous functionality still works each time.

## 4. Roadmap

| Phase | Scope |
|---|---|
| 1 ✅ | Foundation: schema, seed, calculation engine, entitlements, config |
| 2 | Google OAuth (NextAuth), Account/User creation on first login, Free subscription + initial Business + UsagePeriod bootstrap |
| 3 | Business management: switcher, `requireBusinessOwnership()` server guard, BusinessProfile CRUD, file upload abstraction (S3-compatible) for logo/stamp/signature |
| 4 | Customers + Products CRUD, Invoice editor (two-column desktop / accordion mobile), transactional invoice numbering, draft/proforma/final lifecycle, finalize transaction wired to the calculation engine + snapshots |
| 5 | Exports: server-side PDF (Persian RTL), Print view, Image export, real XLSX via ExcelJS |
| 6 | Gmail send (separate OAuth scope from login), Telegram deep-link sharing (honest, no false "sent" claims) |
| 7 | Subscription engine: pricing page, payment-provider abstraction, webhook idempotency, upgrade/downgrade + business locking/restoration |
| 8 | Dashboard metrics, reports (basic + Pro advanced/cross-business) |
| 9 | Security hardening, rate limiting, audit logging, load/perf pass, full test suite from section 53 |

## 5. Requires your own credentials before going live

These cannot be faked and are documented in `.env.example`:

1. **Google Cloud OAuth Client** (login) + a **separate Gmail send scope**
   consent (email sending) — Google login and Gmail permission are kept
   architecturally distinct per section 25/8.
2. **S3-compatible bucket** (AWS S3, MinIO, Arvan Cloud, Liara, etc.) for
   logo/stamp/signature/generated-file storage.
3. **A payment gateway account** (e.g. ZarinPal, IDPay, or similar for IRR)
   — `src/server/payments/PaymentProvider.ts` (Phase 7) will define the
   interface (`createPayment`, `verifyPayment`, `getPaymentStatus`,
   `refundPayment`) so the provider is swappable without touching business
   logic.
4. **A real PostgreSQL instance** — `prisma generate`/`migrate` need
   network access to `binaries.prisma.sh` for engine binaries, which this
   sandbox's egress allowlist blocks; this will work normally in your own
   dev/CI/production environment.

## 6. Phase 2 — Authentication (completed)

### Architecture decision
NextAuth is wired **without** `@auth/prisma-adapter`. Our domain schema
already has an `Account` model meaning "billing account," which collides
with NextAuth's own adapter-managed `Account` table (meaning "one row per
OAuth provider connection"). Using the adapter would either corrupt the
domain model or force an ugly rename. Instead: `session: { strategy: "jwt" }`
with no adapter, and the entire section-7 bootstrap sequence is handled by
hand in the `signIn` callback, using the `OAuthConnection` model (already
in the Phase 1 schema) to store encrypted tokens per user+provider.

### Schema change
Added `@@unique([ownerUserId])` to `Account` — a DB-level backstop (in
addition to the application-level check in `bootstrap.ts`) guaranteeing a
User can never end up with two Accounts, even under a race condition.

### Files created
| File | Purpose |
|---|---|
| `src/lib/prisma.ts` | Prisma Client singleton (dev hot-reload safe) |
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt for OAuth tokens at rest |
| `src/lib/crypto.test.ts` | Round-trip + tamper-detection tests |
| `src/lib/usage-period.ts` | Pure helper: calendar-month bounds for `UsagePeriod` |
| `src/lib/usage-period.test.ts` | Tests incl. leap-year Feb |
| `src/server/auth/bootstrap.ts` | The section-7 transaction: User→Account→Subscription→UsagePeriod→Business→BusinessProfile→InvoiceSettings, idempotent for returning logins |
| `src/server/auth/bootstrap.test.ts` | 5 tests: full chain creation, returning-login idempotency, no-OAuthConnection-without-tokens, missing-FREE-plan failure, invalid-input rejection |
| `src/server/auth/loadUserAuthContext.ts` | Loads authoritative (userId, accountId, status) at sign-in time |
| `src/server/auth/requireSession.ts` | Per-request auth guard — re-reads Account/User status from the DB on **every** call, never trusts the JWT claim alone |
| `src/server/auth/auth-options.ts` | NextAuth config: Google provider, JWT session, callbacks wiring bootstrap + session shaping |
| `src/types/next-auth.d.ts` | Module augmentation — session/JWT typed to expose only `id`/`accountId`/`status`, never tokens |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth route handler |
| `src/app/layout.tsx`, `src/app/providers.tsx`, `src/app/globals.css` | Root RTL shell + `SessionProvider` (didn't exist yet after Phase 1) |
| `src/app/login/page.tsx`, `src/app/login/SignInButton.tsx` | Minimal Persian login screen |
| `src/app/dashboard/page.tsx`, `src/app/dashboard/SignOutButton.tsx` | Protected page proving `requireSession()` + bootstrap data are real and wired end-to-end; sign-out only calls NextAuth's `signOut()` (session-only, no data deletion) |
| `middleware.ts` | Coarse route-level redirect for unauthenticated visits — explicitly documented as UX only, not the authorization boundary |
| `vitest.config.ts` | Added `@` path alias so tests can import server modules the same way app code does |

### Requirements checklist (as given)
1. Real Google OAuth via NextAuth ✅ (`auth-options.ts`, needs your `GOOGLE_CLIENT_ID`/`SECRET`)
2–7. User→Account→Free Subscription→UsagePeriod→Business→BusinessProfile ✅ (`bootstrap.ts`, transactional)
8. Relations/constraints respected ✅ (uses the exact FKs from the Phase 1 schema; added the new unique constraint)
9. Returning login creates nothing new ✅ (tested: `bootstrap.test.ts` → "does NOT create a new Account or Business on a returning login")
10. Logout ends session only ✅ (`signOut()` client call only; no server-side delete path exists)
11. Server-side auth/authz from this stage ✅ (`requireSession.ts` re-verifies DB state every call; middleware is explicitly secondary)
12. OAuth secrets never sent to client ✅ (`next-auth.d.ts` augmentation restricts session shape; tokens live only in encrypted `OAuthConnection` rows)
13. Uses `.env.example` vars ✅ (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `OAUTH_TOKEN_ENCRYPTION_KEY`)
14. No mock auth ✅ (real `GoogleProvider`, real DB-backed bootstrap)

### Verification performed
- `npx vitest run` → **29/29 tests passing** (17 from Phase 1 + 4 crypto + 3 usage-period + 5 bootstrap, all new this phase).
- `npx tsc --noEmit` → **4 errors, all attributable to one root cause**: this sandbox cannot reach `binaries.prisma.sh`, so `@prisma/client`'s shipped placeholder types `PrismaClient` as `any` (confirmed by inspecting `node_modules/.prisma/client/default.d.ts` — it's the package's built-in stub, not output generated from our schema). The 4 errors (`Prisma.InputJsonValue` missing, `PlanKey` missing, two implicit-`any` params) all vanish once you run `prisma generate` for real. No other type errors exist anywhere in the codebase.

### What you must supply before this runs for real
1. **Google Cloud OAuth Client** — Authorized redirect URI: `{NEXTAUTH_URL}/api/auth/callback/google`. Fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. **`NEXTAUTH_SECRET`** — `openssl rand -base64 32`.
3. **`OAUTH_TOKEN_ENCRYPTION_KEY`** — `openssl rand -hex 32`.
4. **A real PostgreSQL instance** + running `npx prisma generate && npx prisma migrate dev && npx prisma db seed` (the FREE plan must exist before anyone's first login, or `bootstrap.ts` throws by design rather than silently creating an unsubscribed account).

### Not in scope for Phase 2 (deferred, as planned)
Business switching UI, the entitlements module actually gating any real route, file uploads, and the rest of the dashboard — these are Phase 3+.

## 7. Running locally (once you have the above)

```bash
npm install
cp .env.example .env   # fill in real values
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
npm test                # runs the calculation-engine test suite
```
