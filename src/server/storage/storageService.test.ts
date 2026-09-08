import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  FILE_UPLOADS_ENABLED,
  IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MIME_TYPES,
  putBusinessImage,
  resolveFilePublicUrl,
  validateImageUpload,
} from "./storageService";
import {
  FileStorageNotConfiguredError,
  ValidationError,
} from "@/server/errors";

/**
 * Tests for the storage boundary. The S3-compatible adapter is deliberately
 * not implemented (see the module docs), so these pin down the contract that
 * *is* in force today: server-side upload validation, public-URL resolution
 * and the honest not-configured refusal.
 */

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

describe("resolveFilePublicUrl", () => {
  const ORIGINAL_BASE = process.env.STORAGE_PUBLIC_BASE_URL;

  beforeEach(() => {
    delete process.env.STORAGE_PUBLIC_BASE_URL;
  });

  afterEach(() => {
    if (ORIGINAL_BASE === undefined) {
      delete process.env.STORAGE_PUBLIC_BASE_URL;
    } else {
      process.env.STORAGE_PUBLIC_BASE_URL = ORIGINAL_BASE;
    }
  });

  it("returns null when no public base URL is configured (no credentials leak)", () => {
    expect(resolveFilePublicUrl("logos/abc.png")).toBeNull();
  });

  it("builds a public URL from the configured base and the storage key", () => {
    process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.com/files/";
    expect(resolveFilePublicUrl("logos/abc.png")).toBe(
      "https://cdn.example.com/files/logos/abc.png",
    );
  });

  it("never exposes anything but the public base URL and key", () => {
    process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.com";
    const url = resolveFilePublicUrl("k.png") ?? "";
    expect(url).not.toMatch(/ACCESS|SECRET|KEY_/i);
  });
});

describe("putBusinessImage (deferred adapter)", () => {
  it("is disabled until the S3-compatible adapter is wired", () => {
    expect(FILE_UPLOADS_ENABLED).toBe(false);
  });

  it("refuses honestly with FileStorageNotConfiguredError instead of faking storage", async () => {
    await expect(
      putBusinessImage({
        category: "BUSINESS_LOGO",
        businessId: "biz-1",
        fileName: "logo.png",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toBeInstanceOf(FileStorageNotConfiguredError);
  });
});
