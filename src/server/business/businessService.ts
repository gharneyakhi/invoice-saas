import type { Prisma } from "@prisma/client";
import type { UsageContext } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { requireBusinessOwnership } from "@/server/auth/requireBusinessOwnership";
import { requireSession } from "@/server/auth/requireSession";
import { BusinessLimitReachedError, EntitlementDataError, ValidationError } from "@/server/errors";
import { entitlementCanCreateBusiness, resolveEntitlements } from "@/server/entitlements/entitlementService";
import {
  parseCreateBusinessInput,
  parseUpdateBusinessInput,
  parseUpdateBusinessSettingsInput,
} from "@/server/business/schema";
import {
  deleteStoredObject,
  isBusinessImageCategory,
  putBusinessImage,
  resolveFilePublicUrl,
  validateImageUpload,
  type BusinessImageCategory,
} from "@/server/storage/storageService";

/**
 * Business CRUD domain layer (Phase 3, server-side only).
 *
 * Authorization rules applied by *every* function here (section 37 + the
 * isolation rule in the README):
 *
 *   1. `requireSession()` is the only source of truth for "who is calling";
 *      the resulting `accountId` is the only value ever written to
 *      `Business.accountId` or used in a `where` clause.
 *   2. `businessId` supplied by a caller is an *identifier*, never proof of
 *      ownership — `requireBusinessOwnership()` re-reads the row and compares
 *      it to the session account (404 when missing, 403 when it belongs to
 *      somebody else).
 *   3. No function in this module accepts an `accountId` argument. There is
 *      nothing for a client to spoof.
 *
 * Nothing is hard-deleted anywhere in this module: `Business` carries
 * `archivedAt`, so deletion is an archive stamp and every Customer, Product,
 * Invoice and File underneath the Business is preserved.
 */

/**
 * Row shape of the `businesses` table (mirrors `model Business` in
 * `prisma/schema.prisma`). Declared locally instead of importing the `Business`
 * *model* type from `@prisma/client`, which only exists after `prisma generate`
 * has run (importing it would add a compile error in any environment without a
 * generated client). `Prisma.TransactionClient`, used below for the `$transaction`
 * callbacks, is the exception: it is part of the client's shipped type surface,
 * so importing it is safe and precise everywhere.
 */
export interface BusinessRecord {
  id: string;
  accountId: string;
  name: string;
  isActive: boolean;
  isLocked: boolean;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ListBusinessesOptions {
  /** Archived businesses are hidden by default — archiving is a soft delete. */
  includeArchived?: boolean;
}

/**
 * Row shape of the `business_profiles` table (mirrors `model BusinessProfile`
 * in `prisma/schema.prisma`). Declared locally for the same reason as
 * `BusinessRecord`: the generated Prisma model types only exist after
 * `prisma generate`, which not every environment can run.
 */
export interface BusinessProfileRow {
  id: string;
  businessId: string;
  businessName: string;
  slogan: string | null;
  ownerName: string | null;
  address: string | null;
  email: string | null;
  mobile: string | null;
  landline: string | null;
  cardNumber: string | null;
  accountNumber: string | null;
  iban: string | null;
  logoFileId: string | null;
  sellerStampFileId: string | null;
  sellerSignatureFileId: string | null;
  primaryColor: string | null;
  footerText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Row shape of a business' `invoice_settings` row. `defaultVatPercent` is a
 * Prisma `Decimal` — represented structurally (like `dashboardService` does)
 * so no generated-client type is needed and money never becomes a JS float.
 */
export interface BusinessInvoiceSettingsRow {
  id: string;
  businessId: string;
  invoicePrefix: string | null;
  nextInvoiceNumber: number;
  defaultVatPercent: { toString(): string };
  currency: string;
  calendar: "JALALI" | "GREGORIAN";
  defaultTemplate: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A stored image of the business profile, with its resolved public URL. */
export interface BusinessImageRef {
  fileId: string;
  originalName: string;
  url: string | null;
}

/**
 * The full settings payload of one business: the verified `Business` row, its
 * `BusinessProfile`, its `InvoiceSettings` and the three profile images
 * resolved through the storage layer. Reads include archived businesses
 * (ownership does not stop at the archive flag; the settings page renders
 * them read-only instead).
 */
export interface BusinessSettingsRecord {
  business: BusinessRecord;
  profile: BusinessProfileRow | null;
  invoiceSettings: BusinessInvoiceSettingsRow | null;
  images: {
    logo: BusinessImageRef | null;
    sellerStamp: BusinessImageRef | null;
    sellerSignature: BusinessImageRef | null;
  };
}

/** Minimal `File` row projection the profile loaders need. */
interface FileRowProjection {
  id: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
}

/** Result of `listBusinessProfiles`: account-scoped profiles + their files. */
export interface BusinessProfileListResult {
  profiles: BusinessProfileRow[];
  filesById: Record<string, { id: string; url: string | null }>;
}

/** Maps a `FileCategory` to the `BusinessProfile` column that references it. */
const IMAGE_CATEGORY_PROFILE_FIELD: Record<
  BusinessImageCategory,
  "logoFileId" | "sellerStampFileId" | "sellerSignatureFileId"
> = {
  BUSINESS_LOGO: "logoFileId",
  SELLER_STAMP: "sellerStampFileId",
  SELLER_SIGNATURE: "sellerSignatureFileId",
};

function profileImageFileIds(profile: BusinessProfileRow | null): string[] {
  if (!profile) return [];
  return [profile.logoFileId, profile.sellerStampFileId, profile.sellerSignatureFileId].filter(
    (fileId): fileId is string => typeof fileId === "string" && fileId.length > 0,
  );
}

/** Profile-field keys shared by the create and settings-update payloads. */
const PROFILE_FIELD_KEYS = [
  "slogan",
  "ownerName",
  "address",
  "email",
  "mobile",
  "landline",
  "cardNumber",
  "accountNumber",
  "iban",
  "primaryColor",
  "footerText",
] as const;

type ProfileFieldsSource = Partial<
  Record<(typeof PROFILE_FIELD_KEYS)[number], string | null>
>;

/**
 * Builds a `BusinessProfile` write payload from parsed input. Only *provided*
 * keys are included (Prisma would treat `undefined` as "not set" anyway, but
 * omitting absent keys keeps the write payloads — and their test assertions —
 * exact), and `businessName` always mirrors `Business.name`.
 */
function buildProfileCreateData(
  businessId: string,
  businessName: string,
  source: ProfileFieldsSource,
): Record<string, string | null> & { businessId: string } {
  return { businessId, ...buildProfileUpdateData(businessName, source) };
}

function buildProfileUpdateData(
  businessName: string,
  source: ProfileFieldsSource,
): Record<string, string | null> {
  const data: Record<string, string | null> = { businessName };
  for (const key of PROFILE_FIELD_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      data[key] = value;
    }
  }
  return data;
}

/**
 * Loads the profile / invoice-settings / image-reference rows of an *already
 * ownership-verified* business. Shared by every reader so the settings page,
 * the action layer and the update path all see the same shape.
 */
async function loadBusinessSettings(
  business: BusinessRecord,
  client: Prisma.TransactionClient,
): Promise<BusinessSettingsRecord> {
  const profile = (await client.businessProfile.findUnique({
    where: { businessId: business.id },
  })) as unknown as BusinessProfileRow | null;

  const invoiceSettings = (await client.invoiceSettings.findUnique({
    where: { businessId: business.id },
  })) as unknown as BusinessInvoiceSettingsRow | null;

  const fileIds = profileImageFileIds(profile);
  const files: FileRowProjection[] =
    fileIds.length > 0
      ? ((await client.file.findMany({
          where: { id: { in: fileIds }, deletedAt: null },
        })) as unknown as FileRowProjection[])
      : [];
  const filesById = new Map(files.map((file) => [file.id, file]));

  const toImageRef = (fileId: string | null): BusinessImageRef | null => {
    if (!fileId) return null;
    const file = filesById.get(fileId);
    if (!file) return null;
    return {
      fileId: file.id,
      originalName: file.originalName,
      url: resolveFilePublicUrl(file.storageKey),
    };
  };

  return {
    business,
    profile: profile ?? null,
    invoiceSettings: invoiceSettings ?? null,
    images: {
      logo: toImageRef(profile?.logoFileId ?? null),
      sellerStamp: toImageRef(profile?.sellerStampFileId ?? null),
      sellerSignature: toImageRef(profile?.sellerSignatureFileId ?? null),
    },
  };
}

/**
 * Stable, meaningful order for business lists/switchers: the primary business
 * first, then oldest-first, with `id` as a final tie-breaker so pagination
 * never re-shuffles rows created in the same millisecond.
 */
export const BUSINESS_LIST_ORDER_BY = [
  { isPrimary: "desc" as const },
  { createdAt: "asc" as const },
  { id: "asc" as const },
];

/**
 * Lists the businesses of the *authenticated* account.
 *
 * There is no `accountId` parameter on purpose: the filter comes from the
 * session, so a client cannot ask for somebody else's list.
 */
export async function listBusinesses(options: ListBusinessesOptions = {}): Promise<BusinessRecord[]> {
  const { accountId } = await requireSession();

  return prisma.business.findMany({
    where: {
      accountId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: BUSINESS_LIST_ORDER_BY,
  });
}

/**
 * Returns a single business the caller owns, including an archived one
 * (ownership does not stop at the archive flag; list views filter instead).
 *
 * Delegates entirely to `requireBusinessOwnership()`, so a nonexistent
 * business propagates `NotFoundError` (404) and a business owned by another
 * account propagates `ForbiddenError` (403) — this function never widens or
 * narrows those semantics.
 */
export async function getBusiness(businessId: string): Promise<BusinessRecord> {
  return requireBusinessOwnership(businessId);
}

/**
 * Creates a Business for the authenticated account, gated by the centralized
 * entitlement system (section 45): FREE = 1, BASIC = 1, PRO = 3 businesses,
 * using the genuinely in-force subscription on an active plan, or FREE limits
 * when none grants access.
 *
 * The whole write happens in one transaction so a failure partway through
 * cannot leave a Business without its BusinessProfile/InvoiceSettings.
 */
export async function createBusiness(input: unknown): Promise<BusinessRecord> {
  // Preserve authentication before validation; the resolver revalidates the
  // session and supplies the account used for all transactional reads/writes.
  await requireSession();
  const data = parseCreateBusinessInput(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Resolve on this transaction's client: subscription selection, plan
    // validity and Free fallback must match every other entitlement check
    // without moving any entitlement reads outside the transaction.
    const entitlements = await resolveEntitlements({ client: tx }).catch((error: unknown) => {
      if (error instanceof EntitlementDataError) {
        // Preserve createBusiness's existing unseeded-FREE error contract.
        throw new Error(
          "Cannot evaluate the business limit: the FREE plan is not seeded. Run `npm run prisma:seed` first.",
        );
      }
      throw error;
    });
    const { accountId, plan } = entitlements;

    // Only this account's live businesses count toward the limit. Archived
    // ones are excluded because archiving is how a Business is retired —
    // otherwise a FREE account that archives its single business could never
    // create another one.
    const existingBusinesses: Array<{ id: string; isPrimary: boolean }> = await tx.business.findMany({
      where: { accountId, archivedAt: null },
      select: { id: true, isPrimary: true },
    });

    const usage: UsageContext = {
      currentBusinessCount: existingBusinesses.length,
      // Invoice quota is irrelevant to this check; it is enforced at
      // finalization time (Phase 4) against the current UsagePeriod.
      currentPeriodInvoiceCount: 0,
    };

    if (!entitlementCanCreateBusiness(entitlements, usage)) {
      throw new BusinessLimitReachedError(
        `Business limit reached: the ${plan.planKey} plan allows ${plan.businessLimit} active business(es).`,
      );
    }

    // Primary-business convention (see bootstrap.ts): one Business per Account
    // carries `isPrimary`, and it is assigned by the server, never requested
    // by the client.
    const isPrimary = !existingBusinesses.some((business) => business.isPrimary);

    const business: BusinessRecord = await tx.business.create({
      data: {
        accountId, // session-derived; the payload cannot override it (schema is strict)
        name: data.name,
        isPrimary,
      },
    });

    // Optional profile fields provided by the creation form. Absent keys stay
    // absent from the payload (never `undefined` keys), so a bare
    // `{ name }` creation behaves exactly as before.
    await tx.businessProfile.create({
      data: buildProfileCreateData(business.id, data.name, data),
    });

    // Not strictly a "business" field, but bootstrap.ts establishes that a
    // Business is created together with its unique InvoiceSettings — invoice
    // numbering (section 14) assumes the row exists for every Business.
    await tx.invoiceSettings.create({
      data: { businessId: business.id, nextInvoiceNumber: 1 },
    });

    return business;
  });
}

/**
 * Updates a business the caller owns. `accountId`, `id`, `isPrimary`,
 * `isLocked` and `archivedAt` are not updatable here — the update schema is
 * strict, so attempting it raises `ValidationError` instead of being ignored.
 *
 * Archived businesses are not editable (their history is preserved read-only);
 * the same rule is enforced by `updateBusinessSettings` and
 * `uploadBusinessImage` below.
 */
export async function updateBusiness(businessId: string, input: unknown): Promise<BusinessRecord> {
  // Ownership is proven before the payload is even looked at, so an
  // unauthorized caller learns nothing about validation rules.
  const owned = await requireBusinessOwnership(businessId);
  if (owned.archivedAt) {
    throw new ValidationError("Cannot edit an archived business");
  }
  const data = parseUpdateBusinessInput(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated: BusinessRecord = await tx.business.update({
      where: { id: owned.id }, // the verified row's id, not the raw client value
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    // `BusinessProfile.businessName` mirrors `Business.name` (bootstrap.ts
    // writes both). Keeping them in sync in the same transaction means a
    // rename can never leave the invoice letterhead showing the old name.
    if (data.name !== undefined) {
      await tx.businessProfile.updateMany({
        where: { businessId: owned.id },
        data: { businessName: data.name },
      });
    }

    return updated;
  });
}

/**
 * Archives (soft-deletes) a business the caller owns.
 *
 * `Business.archivedAt` exists in the schema, so this is the delete path:
 * the row and everything hanging off it (Customers, Products, Invoices,
 * snapshots, Files) stay intact for historical/audit purposes. There is
 * deliberately no hard-delete function in this module.
 *
 * Idempotent — archiving an already archived business is a no-op that returns
 * the current row rather than moving the archive timestamp.
 */
export async function archiveBusiness(businessId: string): Promise<BusinessRecord> {
  const owned = await requireBusinessOwnership(businessId);

  if (owned.archivedAt) {
    return owned;
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const archived: BusinessRecord = await tx.business.update({
      where: { id: owned.id },
      data: { archivedAt: new Date() },
    });

    // Keep the primary-business convention intact: an account that still has
    // live businesses must keep exactly one primary (the oldest remaining).
    if (owned.isPrimary) {
      const nextPrimary: { id: string } | null = await tx.business.findFirst({
        where: { accountId: owned.accountId, archivedAt: null },
        orderBy: { createdAt: "asc" },
      });

      if (nextPrimary) {
        await tx.business.update({
          where: { id: nextPrimary.id },
          data: { isPrimary: true },
        });
      }
    }

    return archived;
  });
}

/**
 * Sets an owned business as the primary business for the authenticated account.
 * Atomically marks all other businesses of the account as `isPrimary: false`
 * and the target business as `isPrimary: true`.
 *
 * Idempotent: setting an already primary business returns the current record.
 * Rejects archived businesses with `ValidationError`.
 */
export async function setPrimaryBusiness(businessId: string): Promise<BusinessRecord> {
  const owned = await requireBusinessOwnership(businessId);

  if (owned.archivedAt) {
    throw new ValidationError("Cannot set an archived business as primary");
  }

  if (owned.isPrimary) {
    return owned;
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.business.updateMany({
      where: { accountId: owned.accountId, isPrimary: true },
      data: { isPrimary: false },
    });

    const updated: BusinessRecord = await tx.business.update({
      where: { id: owned.id },
      data: { isPrimary: true },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Business profile / settings management (Business Management phase)
// ---------------------------------------------------------------------------

/**
 * Lists the BusinessProfile rows of the authenticated account's *live*
 * businesses (archived businesses are excluded — archiving hides a business
 * from active lists), together with the referenced image files resolved to
 * public URLs. Scoped by the session account only: the `where` filter goes
 * through the `business` relation, so the query can never widen to another
 * account.
 */
export async function listBusinessProfiles(): Promise<BusinessProfileListResult> {
  const { accountId } = await requireSession();

  const profiles = (await prisma.businessProfile.findMany({
    where: { business: { accountId, archivedAt: null } },
    orderBy: { businessId: "asc" },
  })) as unknown as BusinessProfileRow[];

  const fileIds = profiles.flatMap((profile) => profileImageFileIds(profile));
  const files: FileRowProjection[] =
    fileIds.length > 0
      ? ((await prisma.file.findMany({
          where: { id: { in: fileIds }, deletedAt: null },
        })) as unknown as FileRowProjection[])
      : [];

  const filesById: BusinessProfileListResult["filesById"] = {};
  for (const file of files) {
    filesById[file.id] = { id: file.id, url: resolveFilePublicUrl(file.storageKey) };
  }

  return { profiles, filesById };
}

/**
 * Returns the full settings record (business + profile + invoice settings +
 * resolved images) of a business the caller owns. Archived businesses are
 * included: ownership does not stop at the archive flag, and the settings
 * page renders them read-only instead of hiding them.
 */
export async function getBusinessSettings(businessId: string): Promise<BusinessSettingsRecord> {
  const owned = await requireBusinessOwnership(businessId);
  return loadBusinessSettings(owned, prisma);
}

/**
 * Saves the settings page of a business the caller owns: the business name,
 * the client-writable `BusinessProfile` columns and (when provided) the
 * editable `InvoiceSettings` columns — all in ONE transaction, so a failure
 * cannot leave the name mirrored on one row only.
 *
 * Rules:
 *   - Ownership is proven by `requireBusinessOwnership` before the payload is
 *     parsed; cross-account ids propagate 404/403 untouched.
 *   - Archived businesses are not editable (ValidationError).
 *   - `nextInvoiceNumber` is never writable — official numbering stays owned
 *     by the finalization transaction (see invoiceService.finalizeInvoice).
 *   - Finalized-invoice snapshots (`InvoiceSellerSnapshot`) are NEVER touched:
 *     profile edits only affect the current profile, which drafts read and
 *     future finalizations snapshot.
 *   - `Business.name` and `BusinessProfile.businessName` move together (the
 *     same mirror convention as `updateBusiness` / `bootstrap.ts`).
 */
export async function updateBusinessSettings(
  businessId: string,
  input: unknown,
): Promise<BusinessSettingsRecord> {
  const owned = await requireBusinessOwnership(businessId);

  if (owned.archivedAt) {
    throw new ValidationError("Cannot edit an archived business");
  }

  const data = parseUpdateBusinessSettingsInput(input);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let current: BusinessRecord = owned;
    if (data.name !== owned.name) {
      current = await tx.business.update({
        where: { id: owned.id }, // the verified row's id, not the raw client value
        data: { name: data.name },
      });
    }

    const profileData = buildProfileUpdateData(data.name, data);
    await tx.businessProfile.upsert({
      where: { businessId: owned.id },
      create: { businessId: owned.id, ...profileData },
      update: profileData,
    });

    if (data.invoiceSettings) {
      const settingsData: Record<string, string | null> = {};
      if (data.invoiceSettings.defaultVatPercent !== undefined) {
        settingsData.defaultVatPercent = data.invoiceSettings.defaultVatPercent;
      }
      if (data.invoiceSettings.currency !== undefined) {
        settingsData.currency = data.invoiceSettings.currency;
      }
      if (data.invoiceSettings.calendar !== undefined) {
        settingsData.calendar = data.invoiceSettings.calendar;
      }
      if (data.invoiceSettings.invoicePrefix !== undefined) {
        settingsData.invoicePrefix = data.invoiceSettings.invoicePrefix;
      }

      // bootstrap.ts / createBusiness establish one InvoiceSettings row per
      // business; the create branch below is defensive repair, not a second
      // numbering architecture.
      const existing = await tx.invoiceSettings.findUnique({
        where: { businessId: owned.id },
        select: { id: true },
      });
      if (existing) {
        await tx.invoiceSettings.update({
          where: { businessId: owned.id },
          data: settingsData,
        });
      } else {
        await tx.invoiceSettings.create({
          data: { businessId: owned.id, ...settingsData },
        });
      }
    }

    return loadBusinessSettings(current, tx);
  });
}

/** Strips control characters / surrounding whitespace and caps length. */
function sanitizeDisplayFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return "image";
  return cleaned.length > 255 ? cleaned.slice(0, 255) : cleaned;
}

/**
 * Best-effort retirement of a replaced image, run ONLY after the new
 * reference is safely persisted:
 *
 *   1. re-verifies the old File row belongs to this business and is not
 *      already deleted (a cross-business cleanup is impossible);
 *   2. skips everything when a finalized invoice's `InvoiceSellerSnapshot`
 *      still references the old file — finalized snapshots must keep their
 *      objects and rows intact;
 *   3. otherwise soft-deletes the File row and removes the old object from
 *      storage.
 *
 * Any failure is logged and swallowed: cleanup must never turn a successful
 * replacement into a failed upload (the orphan is at worst reclaimable
 * storage, while the new reference is already durable).
 */
async function retireReplacedImageFile(input: {
  fileId: string;
  businessId: string;
  category: BusinessImageCategory;
}): Promise<void> {
  try {
    const file = (await prisma.file.findFirst({
      where: { id: input.fileId, businessId: input.businessId, deletedAt: null },
      select: { id: true, storageKey: true },
    })) as unknown as { id: string; storageKey: string } | null;
    if (!file) return;

    // The snapshot table mirrors the profile's three business-image columns.
    const snapshotField = IMAGE_CATEGORY_PROFILE_FIELD[input.category];
    const referencedBySnapshot = await prisma.invoiceSellerSnapshot.findFirst({
      where: { [snapshotField]: file.id },
      select: { id: true },
    });
    if (referencedBySnapshot) {
      // A finalized invoice shows this image — keep both the object and row.
      return;
    }

    await prisma.file.update({
      where: { id: file.id },
      data: { deletedAt: new Date() },
    });
    await deleteStoredObject(file.storageKey);
  } catch (error) {
    // Best-effort cleanup after a durable persist — never fail the upload.
    console.error("[business] replaced-image cleanup skipped", error);
  }
}

/**
 * Uploads one business image (logo / stamp / signature) for a business the
 * caller owns.
 *
 * The full server-side contract is implemented here: session + ownership are
 * proven first (the `businessId` used for storage scoping is the verified row
 * id, never a client claim), the archive rule is enforced, and the file is
 * validated server-side by declared type/size AND magic-byte content
 * sniffing (performed by the storage adapter — the browser is never trusted).
 *
 * Database safety:
 *   - The S3 write happens FIRST; only a confirmed `PutObject` is followed by
 *     the `File` row + `BusinessProfile` link (one transaction). A failed
 *     upload therefore leaves the profile reference and the File ledger
 *     untouched — no dangling rows, no base64/image bytes in PostgreSQL.
 *   - The stored `File.mimeType`/extension come from the adapter's sniffed
 *     content type; `originalName` is sanitized display metadata only.
 *   - Replacing an existing image uploads the new object, persists the new
 *     reference, and only then retires the old object/row — and only when no
 *     finalized invoice snapshot references it. `logoFileId` /
 *     `sellerStampFileId` / `sellerSignatureFileId` can never be set from a
 *     profile payload instead.
 */
export async function uploadBusinessImage(
  businessId: string,
  category: BusinessImageCategory,
  formData: FormData,
): Promise<BusinessSettingsRecord> {
  const owned = await requireBusinessOwnership(businessId);

  if (owned.archivedAt) {
    throw new ValidationError("Cannot upload files for an archived business");
  }
  if (!isBusinessImageCategory(category)) {
    throw new ValidationError("Unsupported image category");
  }

  const candidate = formData.get("file");
  if (!(candidate instanceof File)) {
    throw new ValidationError("file: a file is required");
  }

  // Server-side pre-check of declared type and size — the client's checks are
  // UX only; content sniffing still happens inside the adapter.
  validateImageUpload({ name: candidate.name, type: candidate.type, size: candidate.size });

  const bytes = new Uint8Array(await candidate.arrayBuffer());

  // 1. REAL object-storage upload. Refuses with FileStorageNotConfiguredError
  // when the STORAGE_* env contract is incomplete and throws
  // FileStorageUploadFailedError (safe, detail-free) when the provider
  // rejects the write. Nothing touches the database before this resolves.
  const stored = await putBusinessImage({
    category,
    businessId: owned.id,
    fileName: candidate.name,
    mimeType: candidate.type,
    bytes,
  });

  // 2. Persist the reference ONLY after the S3 upload succeeded.
  let replacedFileId: string | null = null;
  const saved = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const profileField = IMAGE_CATEGORY_PROFILE_FIELD[category];

    // Read the current reference first so a replacement can retire the old
    // image after the new one is durably persisted.
    const profile = (await tx.businessProfile.findUnique({
      where: { businessId: owned.id },
    })) as unknown as BusinessProfileRow | null;
    const previousFileId = profile ? profile[profileField] : null;
    if (previousFileId) {
      replacedFileId = previousFileId;
    }

    const file = await tx.file.create({
      data: {
        accountId: owned.accountId, // session-derived, never client-supplied
        businessId: owned.id,
        storageKey: stored.storageKey,
        originalName: sanitizeDisplayFileName(candidate.name),
        mimeType: stored.mimeType, // canonical sniffed type, not the client claim
        size: candidate.size,
        category,
      },
    });

    await tx.businessProfile.update({
      where: { businessId: owned.id },
      data: { [profileField]: file.id },
    });

    const reloaded = await tx.business.findUnique({ where: { id: owned.id } });
    return loadBusinessSettings(reloaded ?? owned, tx);
  });

  // 3. Replacement cleanup — only now that the new reference is safely stored.
  if (replacedFileId) {
    await retireReplacedImageFile({
      fileId: replacedFileId,
      businessId: owned.id,
      category,
    });
  }

  return saved;
}
