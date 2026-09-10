import { describe, expect, it } from "vitest";
import {
  buildContentDisposition,
  buildInvoiceExportFilenames,
  exportMimeType,
  isExportFileFormat,
  normalizeExportFileFormat,
  sanitizeFilenameSegment,
  toAsciiFilenameSegment,
} from "./filename";

describe("export formats", () => {
  it("recognizes the four supported formats", () => {
    expect(isExportFileFormat("pdf")).toBe(true);
    expect(isExportFileFormat("png")).toBe(true);
    expect(isExportFileFormat("jpg")).toBe(true);
    expect(isExportFileFormat("xlsx")).toBe(true);
    expect(isExportFileFormat("csv")).toBe(false);
    expect(isExportFileFormat("PDF")).toBe(true);
    expect(isExportFileFormat(null)).toBe(false);
  });

  it("normalizes aliases", () => {
    expect(normalizeExportFileFormat("jpeg")).toBe("jpg");
    expect(normalizeExportFileFormat("PDF")).toBe("pdf");
    expect(normalizeExportFileFormat("exe")).toBeNull();
  });

  it("maps real MIME types (never a renamed fake)", () => {
    expect(exportMimeType("pdf")).toBe("application/pdf");
    expect(exportMimeType("png")).toBe("image/png");
    expect(exportMimeType("jpg")).toBe("image/jpeg");
    expect(exportMimeType("xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });
});

describe("sanitizeFilenameSegment", () => {
  it("keeps Persian invoice names intact", () => {
    expect(sanitizeFilenameSegment("فاکتور-1024")).toBe("فاکتور-1024");
  });

  it("strips path separators and header-breaking characters", () => {
    expect(sanitizeFilenameSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
    expect(sanitizeFilenameSegment("a\r\nb: injected")).toBe("ab injected");
    expect(sanitizeFilenameSegment("../../etc/passwd")).toBe("etcpasswd");
  });

  it("collapses whitespace and caps length with a fallback", () => {
    expect(sanitizeFilenameSegment("  a   b  ")).toBe("a b");
    expect(sanitizeFilenameSegment("")).toBe("invoice");
    expect(sanitizeFilenameSegment("...")).toBe("invoice");
    expect(sanitizeFilenameSegment("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("toAsciiFilenameSegment", () => {
  it("produces ASCII-only fallbacks", () => {
    const ascii = toAsciiFilenameSegment("فاکتور-1024");
    expect(/^[\x20-\x7e]+$/.test(ascii)).toBe(true);
    expect(ascii).toContain("1024");
    expect(toAsciiFilenameSegment("INV-101")).toBe("INV-101");
    expect(toAsciiFilenameSegment("!!!")).toBe("invoice");
  });
});

describe("buildInvoiceExportFilenames", () => {
  it("names finalized exports after the official number", () => {
    const names = buildInvoiceExportFilenames({
      officialNumber: "1024",
      invoiceId: "inv-123456789",
      isDraft: false,
      format: "pdf",
    });
    expect(names.filename).toBe("فاکتور-1024.pdf");
    expect(names.asciiFallback).toBe("invoice-1024.pdf");
    expect(names.mimeType).toBe("application/pdf");
  });

  it("never leaks the DRAFT-<uuid> placeholder into filenames", () => {
    const names = buildInvoiceExportFilenames({
      officialNumber: null,
      invoiceId: "abcdef123456",
      isDraft: true,
      format: "xlsx",
    });
    expect(names.filename).toBe("پیش‌نویس-abcdef12.xlsx");
    expect(names.asciiFallback).toBe("draft-abcdef12.xlsx");
  });

  it("sanitizes hostile official numbers", () => {
    const names = buildInvoiceExportFilenames({
      officialNumber: '../x"y\r\nz',
      invoiceId: "inv-1",
      isDraft: false,
      format: "png",
    });
    expect(names.filename).not.toContain("/");
    expect(names.filename).not.toContain('"');
    expect(names.filename).not.toContain("\r");
    expect(names.filename.endsWith(".png")).toBe(true);
  });
});

describe("buildContentDisposition", () => {
  it("carries both the ASCII fallback and the RFC 5987 Persian name", () => {
    const header = buildContentDisposition({
      filename: "فاکتور-1024.pdf",
      asciiFallback: "invoice-1024.pdf",
      mimeType: "application/pdf",
    });
    expect(header.startsWith("attachment; ")).toBe(true);
    expect(header).toContain('filename="invoice-1024.pdf"');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    // The encoded name must round-trip.
    const encoded = header.split("filename*=UTF-8''")[1] as string;
    expect(decodeURIComponent(encoded)).toBe("فاکتور-1024.pdf");
  });
});
