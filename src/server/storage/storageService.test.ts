import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FileStorageNotConfiguredError,
  FileStorageUploadFailedError,
  ValidationError,
} from "@/server/errors";

/**
 * Tests for the REAL S3-compatible storage adapter.
 *
 * The AWS SDK is fully mocked (no real S3/R2 credentials or network needed):
 * `S3Client` constructor arguments are captured so we can assert the
 * env→client mapping (region default, endpoint + forcePathStyle), and every
 * `PutObjectCommand` / `DeleteObjectCommand` input is captured so we can
 * assert bucket/key/content-type and prove that neither credentials nor raw
 * AWS error bodies ever leak out of the adapter.
 */
const s3Mock = vi.hoisted(() => {
  const clientConfigs: Array<Record<string, unknown>> = [];
  const putInputs: Array<Record<string, unknown>> = [];
  const deleteInputs: Array<Record<string, unknown>> = [];
  const send = vi.fn();

  class MockS3Client {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }

    send(command: unknown): Promise<unknown> {
      return send(command);
    }
  }

  class MockPutObjectCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
      putInputs.push(input);
    }
  }

  class MockDeleteObjectCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
      deleteInputs.push(input);
    }
  }

  return { clientConfigs, putInputs, deleteInputs, send, MockS3Client, MockPutObjectCommand, MockDeleteObjectCommand };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: s3Mock.MockS3Client,
  PutObjectCommand: s3Mock.MockPutObjectCommand,
  DeleteObjectCommand: s3Mock.MockDeleteObjectCommand,
}));

import {
  IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MIME_TYPES,
  buildBusinessImageStorageKey,
  buildStorageClientConfig,
  deleteStoredObject,
  isFileUploadsEnabled,
  putBusinessImage,
  readStorageConfig,
  resolveFilePublicUrl,
  sniffImageMimeType,
  validateImageUpload,
  type BusinessImageCategory,
} from "./storageService";

const STORAGE_ENV_KEYS = [
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_ACCESS_KEY",
  "STORAGE_SECRET_KEY",
  "STORAGE_BUCKET",
  "STORAGE_PUBLIC_BASE_URL",
] as const;

function setStorageEnv(overrides: Partial<Record<(typeof STORAGE_ENV_KEYS)[number], string>> = {}) {
  process.env.STORAGE_ACCESS_KEY = "test-access-key";
  process.env.STORAGE_SECRET_KEY = "test-secret-key";
  process.env.STORAGE_BUCKET = "test-bucket";
  process.env.STORAGE_ENDPOINT = "";
  process.env.STORAGE_REGION = "";
  process.env.STORAGE_PUBLIC_BASE_URL = "";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearStorageEnv() {
  for (const key of STORAGE_ENV_KEYS) {
    delete process.env[key];
  }
}

// --- Real byte fixtures ----------------------------------------------------

function pngBytes(size = 64): Uint8Array {
  const full = new Uint8Array(Math.max(size, 8));
  full.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return full.subarray(0, size);
}

function jpegBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

function webpBytes(size = 64): Uint8Array {
  const full = new Uint8Array(Math.max(size, 12));
  full.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  full.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return full.subarray(0, size);
}

function textBytes(text = "<html>not an image</html>", size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < text.length && i < size; i += 1) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}

beforeEach(() => {
  setStorageEnv();
  s3Mock.send.mockReset();
  s3Mock.send.mockResolvedValue({ ETag: '"test-etag"' });
  s3Mock.clientConfigs.length = 0;
  s3Mock.putInputs.length = 0;
  s3Mock.deleteInputs.length = 0;
});

afterEach(() => {
  clearStorageEnv();
});

// ---------------------------------------------------------------------------
// validateImageUpload (declared-type/size pre-filter)
// ---------------------------------------------------------------------------

describe("validateImageUpload", () => {
  it("accepts the allow-listed image types within the size limit", () => {
    for (const type of IMAGE_UPLOAD_MIME_TYPES) {
      expect(() =>
        validateImageUpload({ name: "x", type, size: 1024 }),
      ).not.toThrow();
    }
  });

  it("rejects non-image and non-allow-listed mime types (including SVG)", () => {
    for (const type of ["application/pdf", "image/gif", "image/svg+xml", "text/html"]) {
      expect(() => validateImageUpload({ name: "x", type, size: 1024 })).toThrow(
        ValidationError,
      );
    }
  });

  it("rejects empty and oversized files", () => {
    expect(() => validateImageUpload({ name: "x", type: "image/png", size: 0 })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateImageUpload({ name: "x", type: "image/png", size: IMAGE_UPLOAD_MAX_BYTES + 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateImageUpload({ name: "x", type: "image/png", size: IMAGE_UPLOAD_MAX_BYTES }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Magic-byte content sniffing
// ---------------------------------------------------------------------------

describe("sniffImageMimeType (content sniffing, not the browser claim)", () => {
  it("recognizes real PNG / JPEG / WebP signatures", () => {
    expect(sniffImageMimeType(pngBytes())).toBe("image/png");
    expect(sniffImageMimeType(jpegBytes())).toBe("image/jpeg");
    expect(sniffImageMimeType(webpBytes())).toBe("image/webp");
  });

  it("returns null for text/HTML/script and unknown content", () => {
    expect(sniffImageMimeType(textBytes())).toBeNull();
    expect(sniffImageMimeType(new Uint8Array(64))).toBeNull();
    // A WebP RIFF box without the WEBP tag is not a WebP.
    const fakeRiff = new Uint8Array(64);
    fakeRiff.set([0x52, 0x49, 0x46, 0x46], 0);
    expect(sniffImageMimeType(fakeRiff)).toBeNull();
  });

  it("returns null for truncated / empty buffers", () => {
    expect(sniffImageMimeType(new Uint8Array(0))).toBeNull();
    expect(sniffImageMimeType(pngBytes(4))).toBeNull();
    expect(sniffImageMimeType(webpBytes(11))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Storage configuration (environment contract)
// ---------------------------------------------------------------------------

describe("storage configuration", () => {
  it("is complete only when access key, secret and bucket are all set", () => {
    expect(isFileUploadsEnabled()).toBe(true);
    expect(readStorageConfig()).toMatchObject({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      bucket: "test-bucket",
    });

    delete process.env.STORAGE_SECRET_KEY;
    expect(isFileUploadsEnabled()).toBe(false);
    expect(readStorageConfig()).toBeNull();

    setStorageEnv();
    delete process.env.STORAGE_BUCKET;
    expect(isFileUploadsEnabled()).toBe(false);

    setStorageEnv();
    delete process.env.STORAGE_ACCESS_KEY;
    expect(isFileUploadsEnabled()).toBe(false);
  });

  it("defaults region to us-east-1 and treats endpoint as optional", () => {
    const config = readStorageConfig();
    expect(config?.region).toBe("us-east-1");
    expect(config?.endpoint).toBeNull();

    setStorageEnv({ STORAGE_REGION: "eu-central-1", STORAGE_ENDPOINT: "https://s3.example.test" });
    expect(readStorageConfig()).toMatchObject({
      region: "eu-central-1",
      endpoint: "https://s3.example.test",
    });
  });

  it("maps the config onto the AWS SDK client options", () => {
    setStorageEnv();
    expect(buildStorageClientConfig(readStorageConfig()!)).toEqual({
      region: "us-east-1",
      credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
    });

    // Custom endpoints (R2/MinIO/...) use path-style addressing.
    setStorageEnv({ STORAGE_ENDPOINT: "https://minio.example.test" });
    expect(buildStorageClientConfig(readStorageConfig()!)).toMatchObject({
      endpoint: "https://minio.example.test",
      forcePathStyle: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Server-controlled object keys
// ---------------------------------------------------------------------------

describe("buildBusinessImageStorageKey", () => {
  it("generates business-scoped uuid keys with the category slug", () => {
    const key = buildBusinessImageStorageKey("BUSINESS_LOGO", "biz-1", "image/png");
    expect(key).toMatch(/^business\/biz-1\/logo\/[0-9a-f-]{36}\.png$/);
    expect(buildBusinessImageStorageKey("SELLER_STAMP", "biz-1", "image/jpeg")).toMatch(
      /^business\/biz-1\/stamp\/[0-9a-f-]{36}\.jpg$/,
    );
    expect(buildBusinessImageStorageKey("SELLER_SIGNATURE", "biz-1", "image/webp")).toMatch(
      /^business\/biz-1\/signature\/[0-9a-f-]{36}\.webp$/,
    );
  });

  it("generates a fresh key per call (never reuses a user filename)", () => {
    const a = buildBusinessImageStorageKey("BUSINESS_LOGO", "biz-1", "image/png");
    const b = buildBusinessImageStorageKey("BUSINESS_LOGO", "biz-1", "image/png");
    expect(a).not.toBe(b);
  });

  it("rejects identifiers that could escape the business prefix", () => {
    for (const evil of ["../other-biz", "a/b", "..", "", "biz one", "biz\u0000one"]) {
      expect(() =>
        buildBusinessImageStorageKey("BUSINESS_LOGO", evil, "image/png"),
      ).toThrow(ValidationError);
    }
  });

  it("rejects unknown categories and mime types", () => {
    expect(() =>
      buildBusinessImageStorageKey("GENERATED_PDF" as never, "biz-1", "image/png"),
    ).toThrow(ValidationError);
    expect(() =>
      buildBusinessImageStorageKey("BUSINESS_LOGO", "biz-1", "image/gif" as never),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// putBusinessImage — real adapter behaviour
// ---------------------------------------------------------------------------

describe("putBusinessImage", () => {
  function uploadInput(
    overrides: Partial<{
      category: BusinessImageCategory;
      businessId: string;
      fileName: string;
      mimeType: string;
      bytes: Uint8Array;
    }> = {},
  ) {
    return {
      category: "BUSINESS_LOGO" as const,
      businessId: "biz-1",
      fileName: "logo.png",
      mimeType: "image/png",
      bytes: pngBytes(),
      ...overrides,
    };
  }

  it("uploads to the configured bucket with a server-controlled key", async () => {
    const stored = await putBusinessImage(uploadInput());

    expect(stored.mimeType).toBe("image/png");
    expect(stored.storageKey).toMatch(/^business\/biz-1\/logo\/[0-9a-f-]{36}\.png$/);
    expect(stored.storageKey).not.toContain("logo.png"); // raw filename never used

    expect(s3Mock.putInputs).toHaveLength(1);
    expect(s3Mock.putInputs[0]).toMatchObject({
      Bucket: "test-bucket",
      Key: stored.storageKey,
      ContentType: "image/png",
    });
    expect(s3Mock.putInputs[0]!.Metadata).toBeUndefined();
    expect(s3Mock.clientConfigs).toHaveLength(1);
    expect(s3Mock.clientConfigs[0]).toMatchObject({
      region: "us-east-1",
      credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
    });
    expect(s3Mock.clientConfigs[0]!.endpoint).toBeUndefined();
    expect(s3Mock.clientConfigs[0]!.forcePathStyle).toBeUndefined();
  });

  it("uses the configured endpoint with path-style addressing", async () => {
    setStorageEnv({
      STORAGE_ENDPOINT: "https://r2.example.test",
      STORAGE_REGION: "auto",
    });

    await putBusinessImage(uploadInput());

    expect(s3Mock.clientConfigs[0]).toMatchObject({
      endpoint: "https://r2.example.test",
      forcePathStyle: true,
      region: "auto",
    });
  });

  it("refuses with FILE_STORAGE_NOT_CONFIGURED when the env contract is incomplete", async () => {
    setStorageEnv({ STORAGE_BUCKET: undefined });

    await expect(putBusinessImage(uploadInput())).rejects.toBeInstanceOf(
      FileStorageNotConfiguredError,
    );
    expect(s3Mock.clientConfigs).toHaveLength(0);
    expect(s3Mock.send).not.toHaveBeenCalled();

    // The error surfaces as the stable not-configured action code.
    await expect(putBusinessImage(uploadInput())).rejects.toMatchObject({
      code: "FILE_STORAGE_NOT_CONFIGURED",
    });
  });

  it("rejects a spoofed MIME type: HTML bytes claimed as image/png", async () => {
    await expect(
      putBusinessImage(uploadInput({ bytes: textBytes() })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(s3Mock.send).not.toHaveBeenCalled();
    expect(s3Mock.putInputs).toHaveLength(0);
  });

  it("canonicalizes the stored type from the real content when declared type is misleading", async () => {
    // Declared jpeg but real PNG bytes: the sniffed type wins everywhere.
    const stored = await putBusinessImage(
      uploadInput({ mimeType: "image/jpeg", bytes: pngBytes() }),
    );
    expect(stored.mimeType).toBe("image/png");
    expect(stored.storageKey).toMatch(/\.png$/);
    expect(s3Mock.putInputs[0]!.ContentType).toBe("image/png");
  });

  it("rejects unsupported declared types before any provider call", async () => {
    await expect(
      putBusinessImage(uploadInput({ mimeType: "application/pdf", bytes: pngBytes() })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(s3Mock.send).not.toHaveBeenCalled();
  });

  it("rejects oversized images before any provider call", async () => {
    const oversized = pngBytes(IMAGE_UPLOAD_MAX_BYTES + 1);
    await expect(
      putBusinessImage(uploadInput({ bytes: oversized })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(s3Mock.send).not.toHaveBeenCalled();
  });

  it("never lets a malicious filename reach the key or the object metadata", async () => {
    const stored = await putBusinessImage(
      uploadInput({ fileName: "../../../etc/passwd.png", mimeType: "image/png", bytes: pngBytes() }),
    );

    expect(stored.storageKey).toMatch(/^business\/biz-1\/logo\/[0-9a-f-]{36}\.png$/);
    expect(stored.storageKey).not.toContain("..");
    expect(stored.storageKey).not.toContain("passwd");
    expect(s3Mock.putInputs[0]!.Key).toBe(stored.storageKey);
    // No user-controlled metadata on the object at all.
    expect(s3Mock.putInputs[0]!.Metadata).toBeUndefined();
  });

  it("scopes every key under the ownership-verified business id", async () => {
    const logo = await putBusinessImage(uploadInput({ category: "BUSINESS_LOGO" }));
    expect(logo.storageKey.startsWith("business/biz-1/logo/")).toBe(true);

    const stamp = await putBusinessImage(
      uploadInput({ category: "SELLER_STAMP", businessId: "biz-42" }),
    );
    expect(stamp.storageKey.startsWith("business/biz-42/stamp/")).toBe(true);
  });

  it("turns an SDK failure into a stable safe error that hides provider details", async () => {
    const rawSdkError = new Error(
      "AccessDenied: The AWS Access Key Id you provided (AKIAIOSFODNN7EXAMPLE) does not exist in our records",
    );
    (rawSdkError as Error & { requestId?: string }).requestId = "req-12345";
    s3Mock.send.mockRejectedValueOnce(rawSdkError);

    const failure = putBusinessImage(uploadInput());
    await expect(failure).rejects.toBeInstanceOf(FileStorageUploadFailedError);
    await expect(failure).rejects.toMatchObject({ code: "FILE_STORAGE_UPLOAD_FAILED" });

    const error = (await failure.catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain("AccessDenied");
    expect(error.message).not.toContain("AKIA");
    expect(error.message).not.toContain("test-access-key");
    expect(error.message).not.toContain("test-secret-key");
    expect(error.message).not.toContain("test-bucket");
  });

  it("never reports success without a confirmed provider response", async () => {
    s3Mock.send.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(putBusinessImage(uploadInput())).rejects.toBeInstanceOf(
      FileStorageUploadFailedError,
    );
  });
});

// ---------------------------------------------------------------------------
// deleteStoredObject (post-replacement cleanup)
// ---------------------------------------------------------------------------

describe("deleteStoredObject", () => {
  it("deletes the exact storage key from the configured bucket", async () => {
    await deleteStoredObject("business/biz-1/logo/old.png");

    expect(s3Mock.deleteInputs).toEqual([
      { Bucket: "test-bucket", Key: "business/biz-1/logo/old.png" },
    ]);
  });

  it("refuses when storage is not configured and on unsafe keys", async () => {
    setStorageEnv({ STORAGE_ACCESS_KEY: undefined });
    await expect(deleteStoredObject("business/biz-1/logo/old.png")).rejects.toBeInstanceOf(
      FileStorageNotConfiguredError,
    );

    setStorageEnv();
    await expect(deleteStoredObject("../escaped/old.png")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(deleteStoredObject("")).rejects.toBeInstanceOf(ValidationError);
    expect(s3Mock.send).not.toHaveBeenCalled();
  });

  it("maps SDK failures to the safe upload-failed error", async () => {
    s3Mock.send.mockRejectedValueOnce(
      new Error("NoSuchKey: The specified key does not exist (Key: secret-path)"),
    );
    await expect(deleteStoredObject("business/biz-1/logo/old.png")).rejects.toMatchObject({
      code: "FILE_STORAGE_UPLOAD_FAILED",
    });
  });
});

describe("resolveFilePublicUrl", () => {
  beforeEach(() => {
    delete process.env.STORAGE_PUBLIC_BASE_URL;
  });

  afterEach(() => {
    setStorageEnv();
  });

  it("returns null when no public base URL is configured (no credentials leak)", () => {
    expect(resolveFilePublicUrl("business/biz-1/logo/abc.png")).toBeNull();
  });

  it("builds a public URL from the configured base and the storage key", () => {
    process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.com/files/";
    expect(resolveFilePublicUrl("business/biz-1/logo/abc.png")).toBe(
      "https://cdn.example.com/files/business/biz-1/logo/abc.png",
    );
  });

  it("never exposes anything but the public base URL and key", () => {
    process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.com";
    const url = resolveFilePublicUrl("k.png") ?? "";
    expect(url).not.toMatch(/ACCESS|SECRET|KEY_/i);
  });
});

