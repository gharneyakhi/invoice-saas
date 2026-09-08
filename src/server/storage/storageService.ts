import { ValidationError, FileStorageNotConfiguredError } from "@/server/errors";

/**
 * File-storage boundary for business images (logo / stamp / signature).
 *
 * ⚠️ INTENTIONALLY DEFERRED — the real S3-compatible adapter is NOT wired yet.
 *
 * The architecture planned for this is already fixed elsewhere and nothing
 * here re-invents it:
 *   - `.env.example` documents the S3-compatible credentials contract
 *     (`STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`,
 *     `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_PUBLIC_BASE_URL`).
 *   - `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` are already
 *     project dependencies.
 *   - `model File` (prisma) is the storage ledger: `storageKey`,
 *     `originalName`, `mimeType`, `size`, `category` — only safe file
 *     references/keys are ever stored, never image bytes.
 *   - `BusinessProfile.logoFileId` / `sellerStampFileId` /
 *     `sellerSignatureFileId` point at `File` rows.
 *
 * What is deliberately NOT done here (and must not be faked):
 *   - No fake S3 implementation (no local-disk store pretending to be object
 *     storage, no base64 blobs in the database).
 *   - No storage credentials ever reach the client; the UI only receives the
 *     `FILE_UPLOADS_ENABLED` boolean and already-resolved public URLs.
 *
 * To activate uploads later: implement `putBusinessImage` with a real
 * `PutObjectCommand` against the env vars above, flip `FILE_UPLOADS_ENABLED`
 * to consult the configuration, and the UI + Server Action + validation below
 * connect without any further changes.
 */

/** `FileCategory` values that a business image upload may create. */
export type BusinessImageCategory = "BUSINESS_LOGO" | "SELLER_STAMP" | "SELLER_SIGNATURE";

export const BUSINESS_IMAGE_CATEGORIES: readonly BusinessImageCategory[] = [
  "BUSINESS_LOGO",
  "SELLER_STAMP",
  "SELLER_SIGNATURE",
];

export function isBusinessImageCategory(value: unknown): value is BusinessImageCategory {
  return (
    typeof value === "string" &&
    (BUSINESS_IMAGE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Upload constraints, enforced server-side before anything is stored. */
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per image
export const IMAGE_UPLOAD_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/**
 * Whether the image-upload UI is active. Kept as an explicit `false` constant
 * (not an env probe) so it can only become `true` together with a real
 * `putBusinessImage` implementation — flipping it by merely setting env vars
 * would advertise an upload path that still refuses to store anything.
 */
export const FILE_UPLOADS_ENABLED = false as const;

/**
 * Resolves the public URL of a stored file, or `null` when no public base URL
 * is configured (private buckets would instead need presigned URLs — part of
 * the deferred adapter). Reads env at call time, never exposes credentials.
 */
export function resolveFilePublicUrl(storageKey: string): string | null {
  const base = process.env.STORAGE_PUBLIC_BASE_URL;
  if (!base || !storageKey) return null;
  return `${base.replace(/\/+$/, "")}/${storageKey.replace(/^\/+/, "")}`;
}

export interface ImageUploadCandidate {
  name: string;
  type: string;
  size: number;
}

/**
 * Server-side validation of an image upload: MIME type must be in the
 * allow-list and the size within the limit. Runs *before* any storage call so
 * the rules hold no matter when the adapter lands.
 *
 * @throws ValidationError with a field-scoped English message (the client
 *   maps the stable VALIDATION_ERROR code to a Persian message).
 */
export function validateImageUpload(file: ImageUploadCandidate): void {
  if (!file || typeof file !== "object") {
    throw new ValidationError("file: a file is required");
  }
  if (!IMAGE_UPLOAD_MIME_TYPES.includes(file.type)) {
    throw new ValidationError(
      `file: only ${IMAGE_UPLOAD_MIME_TYPES.join(", ")} images are allowed`,
    );
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new ValidationError("file: the file is empty");
  }
  if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
    throw new ValidationError(
      `file: the image must be at most ${Math.floor(IMAGE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB`,
    );
  }
}

export interface PutBusinessImageInput {
  category: BusinessImageCategory;
  businessId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface StoredFileRef {
  storageKey: string;
}

/**
 * THE DEFERRED INTEGRATION POINT. When the S3-compatible adapter is
 * implemented, this performs the real `PutObject` (using the env contract
 * documented at the top of this module) and returns the storage key; the
 * business upload service then creates the `File` row and links it into
 * `BusinessProfile` inside its transaction. Until then it refuses honestly:
 * every upload fails with a single, predictable error instead of pretending
 * to succeed or falling back to an unsafe storage location.
 */
export async function putBusinessImage(_input: PutBusinessImageInput): Promise<StoredFileRef> {
  throw new FileStorageNotConfiguredError(
    "Image uploads are not available yet: the S3-compatible file storage adapter is not configured.",
  );
}
