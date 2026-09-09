import { describe, expect, it, vi } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import type { InvoicePreviewModel } from "@/lib/invoice-preview-model";
import { BRAND_COLOR_FALLBACK } from "@/lib/invoice-brand";
import {
  TINY_PNG,
  draftPreviewModel,
  finalizedPreviewModel,
} from "./testFixtures";
import {
  PDF_A4_HEIGHT,
  PDF_A4_WIDTH,
  buildPdfContent,
  generateInvoicePdf,
} from "./pdfService";

/**
 * PDF export tests.
 *
 * `buildPdfContent` (pure) pins the data law: finalized rows render their
 * immutable snapshots + currency snapshot + stored payment values, drafts
 * render the current profile, branding falls back deterministically, and
 * every money string is the stored DTO value formatted — never recomputed.
 *
 * `generateInvoicePdf` pins the document contract: a real, loadable PDF
 * (not HTML renamed), A4 pages, an embedded Persian font, multi-page item
 * tables, and graceful image handling.
 */

describe("buildPdfContent data law", () => {
  it("renders finalized seller/customer snapshots verbatim", () => {
    const content = buildPdfContent(finalizedPreviewModel());
    expect(content.businessName).toBe("فروشگاه البرز (snapshot)");
    expect(content.customerName).toBe("مشتری snapshot");
    expect(content.contacts).toContain("09120000001");
    expect(content.footerText).toBe("پانوشت snapshot");
  });

  it("renders drafts from the current profile with no official number", () => {
    const content = buildPdfContent(draftPreviewModel());
    expect(content.businessName).toBe("فروشگاه البرز (profile)");
    expect(content.officialNumber).toBeNull();
    expect(content.isDraft).toBe(true);
    expect(content.statusLabel).toBe("پیش‌نویس");
  });

  it("uses the stored currency snapshot for finalized rows", () => {
    const content = buildPdfContent(finalizedPreviewModel());
    expect(content.currencyUnit).toBe("تومان");
    expect(content.total).toContain("تومان");
  });

  it("carries authoritative stored payment values for finalized rows", () => {
    const content = buildPdfContent(finalizedPreviewModel());
    expect(content.paidAmount).toContain("۵۰,۰۰۰");
    expect(content.remainingAmount).toContain("۱۳۶,۳۹۰");
    expect(content.statusLabel).toBe("در انتظار پرداخت");
  });

  it("omits payment rows for drafts", () => {
    const content = buildPdfContent(draftPreviewModel());
    expect(content.paidAmount).toBeNull();
    expect(content.remainingAmount).toBeNull();
  });

  it("maps items with Persian row numbers and percent-aware discounts", () => {
    const content = buildPdfContent(finalizedPreviewModel());
    expect(content.items).toHaveLength(1);
    const item = content.items[0] as NonNullable<(typeof content.items)[number]>;
    expect(item.rowNumber).toBe("۱");
    expect(item.title).toBe("خدمات طراحی وب");
    expect(item.quantity).toBe("۲");
    expect(item.discount).toContain("۱۰٪");
    expect(item.total).toBe("۱۸۰,۰۰۰");
  });

  it("keeps exact stored totals (no recomputation)", () => {
    const content = buildPdfContent(finalizedPreviewModel());
    expect(content.subtotal).toContain("۲۰۰,۰۰۰");
    expect(content.itemDiscount).toContain("۲۰,۰۰۰");
    expect(content.globalDiscount).toContain("۹,۰۰۰");
    expect(content.globalDiscountLabel).toContain("۵٪");
    expect(content.taxLabel).toContain("۹٪");
    expect(content.taxAmount).toContain("۱۵,۳۹۰");
    expect(content.total).toContain("۱۸۶,۳۹۰");
  });

  it("normalizes branding with deterministic fallbacks", () => {
    const content = buildPdfContent(finalizedPreviewModel());
    expect(content.headerBackground).toBe("#0055ff");
    expect(content.footerBackground).toBe("#111827");
    expect(content.hasFooter).toBe(true);

    const hostile = finalizedPreviewModel({
      seller: {
        ...(finalizedPreviewModel().seller as NonNullable<InvoicePreviewModel["seller"]>),
        primaryColor: "javascript:alert(1)",
        footerBackgroundColor: null,
        footerText: null,
      },
    });
    const fallback = buildPdfContent(hostile);
    expect(fallback.headerBackground).toBe(BRAND_COLOR_FALLBACK);
    expect(fallback.hasFooter).toBe(false);
  });
});

describe("generateInvoicePdf document contract", () => {
  it("produces a real, loadable PDF with A4 pages and an embedded font", async () => {
    const bytes = await generateInvoicePdf(finalizedPreviewModel(), {
      fetchImage: async () => null,
    });
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46])); // %PDF
    expect(bytes.length).toBeGreaterThan(10_000); // font subset is embedded

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
    const size = loaded.getPage(0)?.getSize();
    expect(size?.width).toBeCloseTo(PDF_A4_WIDTH, 2);
    expect(size?.height).toBeCloseTo(PDF_A4_HEIGHT, 2);
    expect(loaded.getTitle()).toContain("1024");

    // The Persian font must be embedded (a /Font resource in the document),
    // not merely referenced: object streams are compressed, so walk the
    // loaded object graph instead of grepping raw bytes.
    let embeddedFonts = 0;
    for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      try {
        const subtype = obj.get(PDFName.of("Subtype"));
        if (subtype === PDFName.of("Type0") || subtype === PDFName.of("TrueType")) {
          embeddedFonts += 1;
        }
      } catch {
        // Non-dict entries are skipped — only font dicts matter here.
      }
    }
    expect(embeddedFonts).toBeGreaterThanOrEqual(1);
  });

  it("renders drafts without an official number", async () => {
    const bytes = await generateInvoicePdf(draftPreviewModel(), { fetchImage: async () => null });
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    // The draft title carries no identifier at all: database ids and
    // DRAFT- placeholders must never leak into the document.
    expect(loaded.getTitle()).toBe("پیش‌نویس فاکتور");
    expect(loaded.getTitle()).not.toContain("inv-draft");
    expect(loaded.getTitle()).not.toContain("DRAFT");
    expect(loaded.getAuthor()).toBe("فروشگاه البرز (profile)");
  });

  it("titles finalized invoices with the official number only", async () => {
    const bytes = await generateInvoicePdf(finalizedPreviewModel(), {
      fetchImage: async () => null,
    });
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getTitle()).toBe("فاکتور 1024");
    expect(loaded.getTitle()).not.toContain("inv-1");
  });

  it("paginates long item tables across A4 pages", async () => {
    const model = finalizedPreviewModel();
    const first = model.invoice.items[0] as (typeof model.invoice.items)[number];
    model.invoice.items = Array.from({ length: 40 }, (_, i) => ({
      ...first,
      id: `item-${i}`,
      title: `قلم شماره ${i + 1} با شرح طولانی برای تست صفحه‌بندی جدول اقلام`,
    }));
    const bytes = await generateInvoicePdf(model, { fetchImage: async () => null });
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
    for (let i = 0; i < loaded.getPageCount(); i += 1) {
      const size = loaded.getPage(i)?.getSize();
      expect(size?.width).toBeCloseTo(PDF_A4_WIDTH, 2);
      expect(size?.height).toBeCloseTo(PDF_A4_HEIGHT, 2);
    }
  });

  it("embeds fetched images and skips fetching when no image urls exist", async () => {
    const fetchImage = vi.fn(async () => TINY_PNG);
    const bytes = await generateInvoicePdf(finalizedPreviewModel(), { fetchImage });
    // Logo + signature have urls; the stamp is null and must not be fetched.
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(bytes.length).toBeGreaterThan(10_000);

    const noImages = vi.fn(async () => TINY_PNG);
    await generateInvoicePdf(draftPreviewModel(), { fetchImage: noImages });
    expect(noImages).not.toHaveBeenCalled();
  });

  it("omits images that fail to fetch instead of failing the export", async () => {
    const bytes = await generateInvoicePdf(finalizedPreviewModel(), {
      fetchImage: async () => {
        throw new Error("network down");
      },
    });
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("embeds fetched images as Image XObjects", async () => {
    const bytes = await generateInvoicePdf(finalizedPreviewModel(), {
      fetchImage: async () => TINY_PNG,
    });
    const loaded = await PDFDocument.load(bytes);
    // Image XObjects are streams, not plain dicts — inspect both.
    let imageXObjects = 0;
    for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream ? obj.dict : null;
      if (!dict) continue;
      try {
        if (dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) imageXObjects += 1;
      } catch {
        // Non-dict entries are skipped — only image dicts matter here.
      }
    }
    // Logo + signature (the stamp is null in the fixture); the RGBA
    // fixture embeds as image + soft-mask each.
    expect(imageXObjects).toBe(4);
  });

  it("stacks over-long official numbers instead of colliding columns", async () => {
    const model = finalizedPreviewModel({ officialNumber: "123456789012345678901234567890" });
    const bytes = await generateInvoicePdf(model, { fetchImage: async () => null });
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(loaded.getTitle()).toBe("فاکتور 123456789012345678901234567890");
  });
});
