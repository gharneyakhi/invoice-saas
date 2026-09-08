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
`src/server/auth/requireBusinessOwnership.ts` (the guard) and
`src/lib/entitlements.ts` + `src/server/entitlements/` (what the account's plan
allows).

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

## 2b. Invoice List V1 (`/dashboard/invoices`)

The invoice list is a **server component** rendering real rows only — there is
no mock data and no client-side filtering of a pre-fetched set.

```
/dashboard/invoices?search=&lifecycle=&status=&type=&customerId=&from=&to=&sortBy=&sortDir=&page=
        │
        ├─ parseInvoiceListQuery()          zod .strict() allow-list of every knob
        ├─ invoiceService.queryInvoices()   requireBusinessOwnership + bounded query
        └─ toInvoiceListDTO()               Decimal→string, Date→ISO
```

- **Isolation / authorization** — `queryInvoices` proves ownership with
  `requireBusinessOwnership(businessId)` and scopes the query to the *verified*
  Business row's id. A foreign `businessId` or `customerId` can never widen the
  result set.
- **Bounded results** — `pageSize` is clamped to `INVOICE_LIST_MAX_PAGE_SIZE`
  (100, default 20) and sort keys are matched against `INVOICE_SORT_KEYS`, so
  the list can never degrade into an unbounded or arbitrary query.
- **Search** — invoice number, notes and the customer's name (case-insensitive).
- **Filters** — lifecycle tabs (all / draft / finalized / cancelled), payment
  status, invoice type, customer, and an issue-date range.
- **Sorting** — created/issue/due date, total, invoice number; `id` is always
  the final tie-breaker so rows never swap places between pages.
- **Row actions follow the lifecycle rule** — `DRAFT` → «ادامه ویرایش» (reopens
  the editor at `/dashboard/invoices/new?invoiceId=…`), everything else →
  «مشاهده» (read-only `/dashboard/invoices/[invoiceId]`, since finalized
  invoices are immutable).
- **States** — `loading.tsx` skeleton, `error.tsx` boundary, an inline error
  notice for a failed query, and distinct empty states for "no business",
  "no invoices yet" and "no matches for these filters".
- **RTL & responsive** — table on desktop, stacked cards below `md`.

Out of scope for V1 (unchanged): PDF, Excel, Gmail, Telegram, billing and
finalization actions.

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

## 7. Phase 3 (in progress) — Business domain layer (server-side only)

The server-side Business CRUD/domain layer. No UI, no API routes, no invoice
logic — just the authorized domain functions the next phases will call.

### Files created
| File | Purpose |
|---|---|
| `src/server/business/businessService.ts` | `listBusinesses`, `getBusiness`, `createBusiness`, `updateBusiness`, `archiveBusiness` |
| `src/server/business/schema.ts` | Zod create/update contracts + `ValidationError` translation |
| `src/server/business/planContext.ts` | Pure mappers: Plan/Subscription rows → the `PlanContext`/`SubscriptionContext` shapes `src/lib/entitlements.ts` expects |
| `src/server/business/businessService.test.ts` | 32 tests (Prisma + session mocked, real ownership guard) |
| `src/server/business/planContext.test.ts` | 5 tests for the entitlement-context mappers |

### Authorization
Every function starts from `requireSession()`; `businessId` is only ever an
identifier, resolved through `requireBusinessOwnership()` (404 when the row is
missing, 403 when it belongs to another Account). No function accepts an
`accountId` argument, and both Zod schemas are `.strict()`, so a payload
carrying `accountId`/`id`/`isPrimary`/`isLocked`/`archivedAt` is rejected with
`ValidationError` rather than silently ignored. Writes always use the
session-derived `accountId` and the *verified* row's `id`.

### Plan limits (via `src/lib/entitlements.ts`, never inline)
`createBusiness` reads the account's newest Subscription + Plan and the FREE
plan from the DB, maps them with `planContext.ts`, counts only that account's
non-archived businesses, and calls `canCreateBusiness()`: FREE = 1, BASIC = 1,
PRO = 3, with a non-ACTIVE subscription falling back to FREE limits
(`effectivePlan`). Exceeding the limit throws `BusinessLimitReachedError`.

### Conventions preserved from `bootstrap.ts`
Business + BusinessProfile + InvoiceSettings are created in one transaction;
exactly one Business per Account carries `isPrimary` (assigned server-side —
the first live business, and re-assigned to the oldest remaining business when
the primary one is archived).

### Deletion is archiving
`Business.archivedAt` already exists, so `archiveBusiness()` stamps it and
returns the row; archived businesses drop out of `listBusinesses()` unless
`{ includeArchived: true }` is passed. There is no hard-delete path anywhere in
the module — Customers, Products, Invoices, snapshots and Files under an
archived Business are untouched, and archiving is idempotent.

### Verification
- `npx vitest run` → **70/70 tests passing** (33 pre-existing + 37 new).
- `npx tsc --noEmit` → **5 errors, exactly the pre-existing baseline** (none in
  `src/server/business/`). The `$transaction` callbacks are annotated
  `Prisma.TransactionClient`, so `tx` is strictly typed rather than inferred.
  The 5 remaining errors all predate Phase 3 and share one root cause,
  documented in section 6: this sandbox cannot reach `binaries.prisma.sh`, so
  `node_modules/.prisma/client/default.d.ts` is still the shipped stub
  (`export declare const PrismaClient: any`, line 19), which leaves model types
  like `PlanKey`/`Business` unexported. They disappear once `prisma generate`
  runs for real.
- Mutation-checked: deliberately breaking the plan-limit gate, the account
  scoping of the business count, the list filter, the archive-vs-delete
  behaviour and the ownership guard each fails the suite, so the assertions are
  load-bearing rather than vacuous.

## 8. Phase 3 (continued) — Entitlement & usage-period server layer

Server-side only, like section 7: no UI, no API routes, no invoice CRUD, no
payments. This is the layer future services call to answer "what may this
account do right now?".

### Files created
| File | Purpose |
|---|---|
| `src/server/entitlements/entitlementService.ts` | `resolveEntitlements()` → a typed `EntitlementContext`; plus `entitlementCanCreateBusiness()` / `entitlementHasFeature()` wrappers that route through the pure helpers |
| `src/server/entitlements/subscriptionSelection.ts` | Pure "which subscription is current, and does it grant anything?" rule — `selectCurrentSubscription()`, `evaluateSubscriptionRow()`, `enforcedSubscriptionContext()`, `SUBSCRIPTION_ORDER_BY`, `EntitlementFallbackReason` |
| `src/server/entitlements/usagePeriodService.ts` | `getCurrentUsagePeriod()` (read-only) and `ensureCurrentUsagePeriod()` (idempotent, race-safe); `currentUsagePeriodWhere()` key builder |
| `src/server/entitlements/invoiceQuota.ts` | `getInvoiceQuotaStatus()` — read-only "may this account finalize one more invoice this month?" |
| `src/lib/entitlements.test.ts` | 49 tests: `effectivePlan`, Free fallback, `canCreateBusiness`, `canFinalizeInvoice`, `hasFeature`, all five feature wrappers, `invoiceQuotaWarningLevel` (0% / below 80% / exactly 80% / at limit / zero limit), `evaluateSubscription` |
| `src/server/entitlements/subscriptionSelection.test.ts` | 25 tests for the pure selection rule |
| `src/server/entitlements/entitlementService.test.ts` | 23 tests (Prisma + session mocked, real pure logic) |
| `src/server/entitlements/usagePeriodService.test.ts` | 20 tests incl. race, isolation and never-write assertions |
| `src/server/entitlements/invoiceQuota.test.ts` | 17 tests incl. the read-only contract |

### Files modified (all additive except one line)
| File | Change |
|---|---|
| `src/lib/entitlements.ts` | **Added** the pure `evaluateSubscription()` + `SubscriptionWindow`/`SubscriptionLapse`/`SubscriptionEffectiveness`. No existing function changed behaviour: `effectivePlan`, `canCreateBusiness`, `canFinalizeInvoice`, `hasFeature`, the wrappers and `invoiceQuotaWarningLevel` are untouched. |
| `src/server/business/planContext.ts` | **Added** `toStoredSubscriptionStatus()`; `toSubscriptionContext()` gained two *optional* params (`window`, `now`). Called with one argument it behaves exactly as before. |
| `src/server/business/businessService.ts` | **One line**: `toSubscriptionContext(subscriptionRow.status, subscriptionRow)` so `createBusiness` applies the same date-lapse rule as the resolver. Nothing else in Task 2 changed. |
| `src/server/errors.ts` | **Added** `EntitlementDataError` (with a `code`), matching the existing `BusinessLimitReachedError` style. |

`src/server/auth/requireBusinessOwnership.ts` (Task 1) was not touched.

### Plan limits stay in one place
No limit appears anywhere in the new code. `FREE 1/3`, `BASIC 1/10`, `PRO 3/50`
live only in `prisma/seed.ts`, are read from the `Plan` rows at runtime, and are
compared only by the pure functions in `src/lib/entitlements.ts`. The resolver
test uses deliberately un-seeded numbers (limit 7 businesses / 42 invoices) to
prove nothing is hard-coded.

### Subscription effective state
`evaluateSubscription(status, window, now)` decides, and it can only ever narrow
an entitlement:

| Stored row | Enforced as | `fallbackReason` |
|---|---|---|
| `ACTIVE`, window covers now, plan active | that plan | `NONE` |
| `ACTIVE`, `endDate` already passed | **Free** | `ENDED` |
| `ACTIVE`, `endDate` exactly now | **Free** (boundary is exclusive) | `ENDED` |
| `ACTIVE`, `startDate` in the future | **Free** | `NOT_STARTED` |
| `ACTIVE`, `endDate <= startDate` (impossible window) | **Free** | `INCONSISTENT_WINDOW` |
| `ACTIVE` in window, but `plans.isActive = false` | **Free** | `PLAN_INACTIVE` |
| `PENDING` / `EXPIRED` / `CANCELLED` / `PAYMENT_FAILED` | **Free** | `STATUS_*` |
| no subscription row at all | **Free** | `NO_SUBSCRIPTION` |
| unknown status string | throws | — |

Rows are loaded newest-first (`startDate desc, createdAt desc, id desc`) and the
**newest genuinely in-force** one wins, so an account whose latest subscription
lapsed keeps the older one that is still valid instead of being dropped to Free
by an unlucky sort. The demotion is expressed as a `SubscriptionContext.status`
handed to the existing `effectivePlan()`, so the fallback comparison itself is
still the one in `src/lib/entitlements.ts`.

`EntitlementContext` reports both views: `subscriptionRecord.storedStatus` (what
the row says) and `subscriptionRecord.enforcedStatus` (what was enforced).

### Usage periods
`bootstrap.ts` created the first `UsagePeriod` and nothing ever rolled it
forward. `ensureCurrentUsagePeriod()` is that missing step:

- account-scoped — `accountId` only ever comes from `requireSession()`;
- month bounds always from the existing `getUsagePeriodBounds()`, so rows line
  up with the ones bootstrap wrote;
- an existing period is **returned as found**: no `update`, no `delete`, so
  `invoiceCount` is never reset and historical periods are never touched;
- idempotent, and race-safe through the existing
  `@@unique([accountId, periodStart, periodEnd])` constraint — the loser of a
  concurrent create catches `P2002` (detected structurally, so it works with or
  without a generated client) and re-reads the winner's row instead of retrying.

**Subscription association:** `UsagePeriod.subscriptionId` is NOT NULL, so a new
bucket points at the account's in-force subscription if it has one, otherwise at
its newest row of any status (a Free-fallback account still needs a counter).
Both are always rows of *this* account. The link is bookkeeping only —
**entitlements are never derived from `UsagePeriod.subscriptionId`**, so a
period still pointing at a since-lapsed PRO subscription grants nothing.
An account with no subscription row at all raises `EntitlementDataError` rather
than inventing a period.

### Invoice quota
`getInvoiceQuotaStatus()` returns `{ planKey, invoiceLimit, usedInvoices,
remainingInvoices, canFinalize, warningLevel, periodStart, periodEnd,
usagePeriodId, fallbackReason }`. `canFinalize` comes from the existing
`canFinalizeInvoice()` and `warningLevel` from `invoiceQuotaWarningLevel()` —
neither comparison is re-implemented.

It is **deliberately read-only**: it creates no invoice, opens no period and
increments nothing. A month with no bucket yet simply counts as 0 used. The
atomic increment belongs to the finalize transaction (Phase 4), which will call
`ensureCurrentUsagePeriod()` and bump `invoiceCount` in the same transaction.

### Trust boundary
None of the three entry points accepts an `accountId`, `subscriptionId`,
`planKey`, `status` or limit. Their only inputs are `now` (a server-side time
source, documented as never to be taken from request input) and an optional
`Prisma.TransactionClient` for callers already inside a `$transaction`. Tests
pass smuggled `{ accountId, subscriptionId, planKey, invoiceLimit }` objects and
assert every query still uses the session account.

### Verification
- `npx vitest run` → **204/204 passing** (70 pre-existing + 134 new). Every
  Task 1/Task 2 test still passes unchanged.
- `npx tsc --noEmit` → **5 errors, exactly the pre-existing baseline**, none in
  `src/server/entitlements/` or `src/lib/entitlements.ts`. Same single root
  cause as documented in section 6: this sandbox cannot reach
  `binaries.prisma.sh`, so `@prisma/client` is still the shipped stub.
- Mutation-checked 10 ways, all caught: ignoring the `endDate` lapse, unscoping
  the subscription lookup, dropping the `P2002` re-read, making the quota check
  write, resetting `invoiceCount` on the fast path, honouring a deactivated
  `Plan`, ignoring the supplied transaction client, removing the
  `remainingInvoices` clamp, hard-coding a limit, and always preferring the
  newest subscription.

### Known divergences / deliberately deferred
- `businessService.createBusiness` still picks the newest subscription row
  (`findFirst … orderBy createdAt desc`) rather than the newest *in-force* one,
  and still ignores `plans.isActive`. It now applies the date-lapse rule, so the
  common cases agree; switching it to `resolveEntitlements()` would mean moving
  its entitlement reads out of its own `$transaction`, which is a bigger change
  than this task calls for. Noted for the phase that revisits business limits.
- No atomic `invoiceCount` increment yet (Phase 4, with finalization).
- No API routes, server actions, or UI — as instructed.

## 9. Business Management UI — Business Profile / Invoice Settings (completed)

The real Business Management area: multiple businesses per account, each with
an independent profile (letterhead info, visual identity, banking, stamp &
signature, invoice settings). No mock UI — every form posts through the
existing Server Action → service → Prisma path.

### Routes added

| Route | Purpose |
|---|---|
| `/dashboard/businesses` | List of the account's live businesses (logo/monogram, brand color, primary badge), business-limit quota card, create CTA (disabled + explained at the limit), per-card actions: settings / make primary / archive-with-confirmation |
| `/dashboard/businesses/new` | Full creation form (name + all optional `BusinessProfile` fields); server-side entitlement gate renders a limit notice instead of the form |
| `/dashboard/businesses/[businessId]` | Settings page in 5 sections (اطلاعات کسب‌وکار / هویت بصری / اطلاعات بانکی / مهر و امضا / فاکتور), live letterhead preview, unsaved-changes guard; archived businesses render read-only |

Loading skeletons and a not-found state are included; the dashboard
`BusinessSwitcher` now links to the real creation form and management hub.

### Server Actions added/modified (`src/server/actions/businessActions.ts`)

- `getBusinessSettings(businessId)` — read path for the settings page.
- `updateBusinessSettings(businessId, input)` — one payload → one transaction
  (`Business.name` + `BusinessProfile` + editable `InvoiceSettings` columns).
- `uploadBusinessImage(businessId, category, formData)` — the image-upload
  contract (see "File storage" below).
- `createBusiness` / existing actions unchanged in signature; creation simply
  accepts the extended profile payload.

### Services (all inside the existing `businessService`, no duplicates)

- `createBusiness` — now persists the optional profile fields provided by the
  creation form (name-only payloads behave exactly as before).
- `updateBusinessSettings` — ownership + archive rule + strict Zod payload +
  name-mirror + invoice-settings update in one transaction.
- `getBusinessSettings` / `listBusinessProfiles` — session-scoped reads with
  image references resolved to public URLs.
- `uploadBusinessImage` — ownership + archive rule + server-side type/size
  validation, then the real S3-compatible storage write (see "File storage"
  below); the DB reference is persisted only after the upload confirms, and
  replaced images are retired only afterwards (snapshot-safe).
- `updateBusiness` — gained the same archived-business edit guard the invoice
  service already applies (`ValidationError`), required by the archive rules.

### Security invariants preserved

- Every mutation derives the account from `requireSession()` and re-proves
  business ownership via `requireBusinessOwnership()`; no client-supplied
  `accountId`/`userId`/plan limit is ever trusted.
- Creation is gated by the centralized entitlement check
  (`entitlementCanCreateBusiness`) inside the same transaction as the write.
- Profile payloads are `.strict()` Zod objects: `logoFileId` /
  `sellerStampFileId` / `sellerSignatureFileId` (storage-owned),
  `nextInvoiceNumber` (finalization-owned) and `accountId` are all rejected.
- Changing a profile never touches `InvoiceSellerSnapshot` /
  `InvoiceCustomerSnapshot` — finalized invoices stay immutable; drafts
  continue reading the live profile exactly as before.

### File storage — REAL S3-compatible adapter

`src/server/storage/storageService.ts` implements the production
S3-compatible adapter for business images (logo / seller stamp / seller
signature) with `@aws-sdk/client-s3` (AWS S3, Cloudflare R2, MinIO, Arvan,
Liara, ... — provider is chosen purely by the documented `STORAGE_*` env
contract in `.env.example`):

- **Server-side only** — credentials are read from the environment on the
  server and never reach the browser; the UI only receives an
  `isFileUploadsEnabled()` boolean and already-resolved public URLs.
- **Validation** — declared MIME allow-list (PNG/JPEG/WebP) and a 5 MB cap,
  plus **magic-byte content sniffing**: the stored `Content-Type`, key
  extension and `File.mimeType` come from the real bytes, so a spoofed
  `image/png` header over HTML/script content is rejected.
- **Object keys** — server-generated
  `business/{businessId}/{logo|stamp|signature}/{uuid}.{ext}`. The raw user
  filename is never part of a key and no user-controlled metadata is attached
  to objects; business ids are validated against safe key segments.
- **Database safety** — the S3 `PutObject` resolves FIRST; only then is the
  `File` row created and the `BusinessProfile` link updated (one
  transaction). A failed upload leaves the database untouched; no image bytes
  or base64 are ever stored in PostgreSQL.
- **Replacement** — upload new object → persist new reference → only then
  retire the old object/row (best-effort), and only when no finalized
  invoice's `InvoiceSellerSnapshot` references it — finalized snapshots are
  never modified or orphaned.
- **Error handling** — incomplete `STORAGE_*` config keeps uploads disabled
  with the stable `FILE_STORAGE_NOT_CONFIGURED` code; provider failures map
  to the new stable `FILE_STORAGE_UPLOAD_FAILED` code. Raw AWS SDK details
  (request IDs, credential hints, error bodies) are logged server-side only
  and never cross the Server Action boundary.
- `resolveFilePublicUrl` — display URLs are built from
  `STORAGE_PUBLIC_BASE_URL` only (public-URL architecture; presigned URLs are
  intentionally not invented).

The upload UI on the business settings pages was already built for this
contract and now activates automatically when the env is configured: it
shows the server-confirmed image reference, refreshes via `router.refresh()`,
and renders explicit "storage not configured" / upload-failure notices
otherwise. Create mode stays inert until the business exists.

### Database schema

**No changes.** Every exposed field already exists on `BusinessProfile` /
`InvoiceSettings` / `File`; the initial migration is untouched.

### Verification

- `npx vitest run` → **638/639 passing**; the single failure
  (`src/lib/finalization.test.ts` — a Persian message asserting "ورود" where
  the code says "وارد حساب کاربری شوید") fails identically on pristine
  `main` and is unrelated to this task (left untouched deliberately).
  Net +30 tests: the storage adapter suite (30 — env contract, sniffing,
  key generation, mocked-SDK put/delete, safe error mapping), business
  service upload flow (replacement ordering, snapshot preservation, DB
  untouched on failure), action-boundary leak tests.
- `npx tsc --noEmit` → **zero new errors** (the 31 baseline errors all stem
  from the un-generated Prisma client stub; none are in the touched files).
- `npx eslint .` → clean.
- `npx next build` → **compiles and lints successfully**, but cannot finish
  in this sandbox: the type gate trips on the pre-existing stub errors
  (`prisma/seed.ts` — `PlanKey` missing from the stub `@prisma/client`).
  Root cause unchanged: `binaries.prisma.sh` is blocked, so `prisma generate`
  cannot run.

## 10. Running locally (once you have the above)

```bash
npm install
cp .env.example .env   # fill in real values
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
npm test                # runs the calculation-engine test suite
```
