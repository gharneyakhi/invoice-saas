import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import {
  FileStorageNotConfiguredError,
  FileStorageUploadFailedError,
  ValidationError,
} from "@/server/errors";

/**
 * File-storage boundary for business images (logo / stamp / signature) —
 * a REAL S3-compatible adapter (AWS S3, Cloudflare R2, MinIO, Arvan, Liara,
 * ...) implemented with `@aws-sdk/client-s3`.
 *
 * Environment contract (documented in `.env.example`, read lazily at call
 * time so tests and config changes are predictable):
 *
 *   STORAGE_ACCESS_KEY        required — provider access key id
 *   STORAGE_SECRET_KEY        required — provider secret access key
 *   STORAGE_BUCKET            required — bucket name
 *   STORAGE_ENDPOINT          optional — custom endpoint (R2/MinIO/...);
 *                             absent = AWS S3
 *   STORAGE_REGION            optional — default "us-east-1"
 *   STORAGE_PUBLIC_BASE_URL   optional — public base URL of the bucket used
 *                             ONLY to build display URLs (never credentials)
 *
 * Non-negotiables enforced here:
 *   - Credentials are read from the environment on the server and NEVER
 *     exported to the client; the UI only receives the `isFileUploadsEnabled`
 *     boolean and already-resolved public URLs.
 *   - Object keys are server-generated (`business/{businessId}/{slug}/{uuid}`
 *     with an extension derived from sniffed content). The raw user filename
 *     is never used as a key, and no user-controlled metadata is attached to
 *     the object.
 *   - Files are validated by magic bytes (content sniffing), never by the
 *     browser-declared MIME type alone.
 *   - Failures are mapped to stable safe application errors; raw AWS SDK
 *     error details stay server-side (logged only).
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

/** The concrete image types the sniffing supports (matches the UI contract). */
export type ImageUploadMimeType = "image/png" | "image/jpeg" | "image/webp";

/**
 * Whether the image-upload path is active: true only when the S3-compatible
 * credentials are fully configured (access key + secret + bucket). Read at
 * call time from the environment — never a hard-coded constant — so flipping
 * `.env` values is what enables/disables uploads.
 */
export function isFileUploadsEnabled(): boolean {
  return readStorageConfig() !== null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Server-side S3 client configuration read from `STORAGE_*` env vars. */
export interface StorageS3Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Custom S3-compatible endpoint (R2/MinIO/...); `null` = AWS S3. */
  endpoint: string | null;
  region: string;
}

/**
 * Reads + validates the storage environment contract.
 *
 * Required: `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`.
 * Optional: `STORAGE_ENDPOINT`, `STORAGE_REGION` (default `us-east-1`).
 * `STORAGE_PUBLIC_BASE_URL` is display-only and handled by
 * `resolveFilePublicUrl`, so it is intentionally not part of "upload
 * readiness".
 *
 * Returns `null` (never throws) when the mandatory variables are missing —
 * callers turn that into the `FileStorageNotConfiguredError` contract.
 */
export function readStorageConfig(): StorageS3Config | null {
  const accessKeyId = process.env.STORAGE_ACCESS_KEY?.trim();
  const secretAccessKey = process.env.STORAGE_SECRET_KEY?.trim();
  const bucket = process.env.STORAGE_BUCKET?.trim();
  if (!accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }
  const endpoint = process.env.STORAGE_ENDPOINT?.trim();
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint: endpoint || null,
    region: process.env.STORAGE_REGION?.trim() || "us-east-1",
  };
}

/**
 * Maps the validated env config onto `@aws-sdk/client-s3` constructor options.
 *
 * Custom endpoints (R2, MinIO, ...) use path-style addressing
 * (`forcePathStyle: true`); plain AWS S3 uses the default virtual-hosted
 * style. The caller (`S3Client`) is constructed per operation — no client is
 * cached or shared, so credentials always come from the request-time env.
 */
export function buildStorageClientConfig(config: StorageS3Config): {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  endpoint?: string;
  forcePathStyle?: boolean;
} {
  return {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
  };
}

function createStorageClient(config: StorageS3Config): S3Client {
  return new S3Client(buildStorageClientConfig(config));
}

// ---------------------------------------------------------------------------
// Public URL resolution (display only)
// ---------------------------------------------------------------------------

/**
 * Resolves the public URL of a stored file, or `null` when no public base URL
 * is configured (the display then degrades to the stored reference only —
 * private buckets are out of scope: the architecture expects public URLs, and
 * this adapter deliberately does not invent presigned URLs). Reads env at
 * call time, never exposes credentials.
 */
export function resolveFilePublicUrl(storageKey: string): string | null {
  const base = process.env.STORAGE_PUBLIC_BASE_URL;
  if (!base || !storageKey) return null;
  return `${base.replace(/\/+$/, "")}/${storageKey.replace(/^\/+/, "")}`;
}

// ---------------------------------------------------------------------------
// Upload validation (type / size / content sniffing)
// ---------------------------------------------------------------------------

export interface ImageUploadCandidate {
  name: string;
  type: string;
  size: number;
}

/**
 * Server-side validation of an upload candidate: the browser-declared MIME
 * type must be in the allow-list and the size within the limit. Runs *before*
 * any storage call; the declared type is a *pre-filter* only — the actual
 * stored type is decided by magic-byte sniffing (`sniffImageMimeType`).
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasByteSignature(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Magic-byte content sniffing for the supported image formats:
 *
 *   - PNG:  89 50 4E 47 0D 0A 1A 0A
 *   - JPEG: FF D8 FF
 *   - WebP: "RIFF" .... "WEBP" (container signature at bytes 0-3 / 8-11)
 *
 * Returns `null` when the bytes do not prove any supported image type — the
 * caller must then reject the upload regardless of the browser's declared
 * MIME type (a spoofed `image/png` header over HTML/script bytes never
 * reaches storage).
 */
export function sniffImageMimeType(bytes: Uint8Array): ImageUploadMimeType | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12) return null;
  if (hasByteSignature(bytes, PNG_SIGNATURE)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (isRiff && isWebp) return "image/webp";
  return null;
}

// ---------------------------------------------------------------------------
// Object keys (server-controlled)
// ---------------------------------------------------------------------------

/** Key path segment per category: `business/{businessId}/{segment}/{uuid}.{ext}`. */
const IMAGE_CATEGORY_KEY_SEGMENT: Record<BusinessImageCategory, string> = {
  BUSINESS_LOGO: "logo",
  SELLER_STAMP: "stamp",
  SELLER_SIGNATURE: "signature",
};

const EXTENSION_BY_MIME_TYPE: Record<ImageUploadMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Segments that end up inside an object key allow only safe characters; a
 * value with `/`, `\`, `..` or anything else is rejected instead of being
 * silently escaped into a different prefix. (`businessId` always comes from
 * an ownership-verified DB row, but the key builder never assumes that.)
 */
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeKeySegment(value: string, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!SAFE_KEY_SEGMENT.test(trimmed)) {
    throw new ValidationError(`Unsupported ${label}`);
  }
  return trimmed;
}

/**
 * Builds the server-controlled object key for a business image:
 *
 *   business/{businessId}/logo|stamp|signature/{uuid}.{ext}
 *
 * The UUID is generated here (never client-supplied) and the extension comes
 * from the sniffed MIME type, so a user cannot influence the key — the raw
 * filename is never part of it, and no input can escape the business prefix
 * or reach another business's objects.
 */
export function buildBusinessImageStorageKey(
  category: BusinessImageCategory,
  businessId: string,
  mimeType: ImageUploadMimeType,
): string {
  const segment = IMAGE_CATEGORY_KEY_SEGMENT[category];
  if (!segment) {
    throw new ValidationError("Unsupported image category");
  }
  const extension = EXTENSION_BY_MIME_TYPE[mimeType];
  if (!extension) {
    throw new ValidationError(`Unsupported image type: ${mimeType}`);
  }
  const safeBusinessId = assertSafeKeySegment(businessId, "business identifier");
  return `business/${safeBusinessId}/${segment}/${randomUUID()}.${extension}`;
}

// ---------------------------------------------------------------------------
// Real object-storage operations (AWS SDK)
// ---------------------------------------------------------------------------

export interface PutBusinessImageInput {
  category: BusinessImageCategory;
  /** Ownership-verified business id (server-derived, never client proof). */
  businessId: string;
  /** Raw client filename — display metadata only, never used for keys. */
  fileName: string;
  /** Browser-declared MIME type — cross-checked against real content. */
  mimeType: string;
  bytes: Uint8Array;
}

/** What the adapter returns after a CONFIRMED provider write. */
export interface StoredFileRef {
  storageKey: string;
  /** Canonical MIME type decided by content sniffing (not the client claim). */
  mimeType: ImageUploadMimeType;
}

/**
 * Uploads one business image to the configured S3-compatible bucket.
 *
 * Order of checks:
 *   1. configuration present, else `FileStorageNotConfiguredError`;
 *   2. declared type + size against the server allow-list/cap;
 *   3. magic-byte sniffing (rejects spoofed content; the sniffed type is the
 *      canonical type used for Content-Type, key extension and the DB row);
 *   4. `PutObject` with a server-generated business-scoped key and NO
 *      user-controlled metadata.
 *
 * Only a resolved provider response returns `{ storageKey }` — the caller
 * persists the DB reference AFTER this resolves. Any SDK failure is logged
 * server-side and re-thrown as a safe `FileStorageUploadFailedError` that
 * carries none of the AWS error details.
 */
export async function putBusinessImage(input: PutBusinessImageInput): Promise<StoredFileRef> {
  const config = readStorageConfig();
  if (!config) {
    throw new FileStorageNotConfiguredError(
      "Image uploads are disabled: STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY and STORAGE_BUCKET must be configured.",
    );
  }

  // Browser-declared type/size pre-filter (the declared type alone is never
  // sufficient — content sniffing below is authoritative).
  validateImageUpload({
    name: input.fileName,
    type: input.mimeType,
    size: input.bytes.byteLength,
  });

  const mimeType = sniffImageMimeType(input.bytes);
  if (!mimeType) {
    throw new ValidationError(
      "file: the file content is not a supported image (PNG, JPEG or WebP)",
    );
  }

  const storageKey = buildBusinessImageStorageKey(input.category, input.businessId, mimeType);

  const client = createStorageClient(config);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: storageKey,
        Body: new Uint8Array(input.bytes),
        ContentType: mimeType,
        CacheControl: "public, max-age=31536000, immutable",
        // Deliberately no user metadata: the client filename and any other
        // client-controlled value never become object metadata.
      }),
    );
  } catch (error) {
    // Server-side log only: AWS error bodies may contain request IDs or
    // credential hints that must never reach the browser.
    console.error("[storage] PutObjectCommand failed", error);
    throw new FileStorageUploadFailedError();
  }

  return { storageKey, mimeType };
}

/** Keys the adapter will delete are validated to stay within known shapes. */
const DELETABLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;

function assertDeletableStorageKey(storageKey: string): string {
  const key = typeof storageKey === "string" ? storageKey.trim() : "";
  if (!DELETABLE_KEY.test(key) || key.includes("..")) {
    throw new ValidationError("Unsupported storage key");
  }
  return key;
}

/**
 * Best-effort removal of an object the adapter previously stored (used for
 * old-image cleanup AFTER a replacement reference is safely persisted).
 * Failures are surfaced as the safe `FileStorageUploadFailedError`; callers
 * that treat cleanup as non-critical should catch it.
 */
export async function deleteStoredObject(storageKey: string): Promise<void> {
  const config = readStorageConfig();
  if (!config) {
    throw new FileStorageNotConfiguredError(
      "Image cleanup is disabled: STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY and STORAGE_BUCKET must be configured.",
    );
  }
  const key = assertDeletableStorageKey(storageKey);

  const client = createStorageClient(config);
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );
  } catch (error) {
    console.error("[storage] DeleteObjectCommand failed", error);
    throw new FileStorageUploadFailedError();
  }
}
