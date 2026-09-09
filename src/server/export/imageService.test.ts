import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  IMAGE_JPEG_QUALITY,
  IMAGE_OUTPUT_WIDTH,
  IMAGE_SVG_MIN_HEIGHT,
  IMAGE_SVG_WIDTH,
  buildInvoiceSvg,
  renderInvoiceImage,
} from "./imageService";
import { TINY_PNG, draftPreviewModel, finalizedPreviewModel } from "./testFixtures";

/**
 * Image export tests (PNG / JPG).
 *
 * `buildInvoiceSvg` (pure) pins the data law — finalized rows render their
 * immutable snapshots + currency snapshot + stored payment values, drafts
 * render the current profile with a draft banner, branding is embedded,
 * and every interpolated string is XML-escaped.
 *
 * `renderInvoiceImage` pins the raster contract: real PNG/JPEG bytes (not
 * renamed SVGs), A4 geometry for single-page invoices, high output
 * resolution, and graceful image handling.
 */

describe("buildInvoiceSvg data law", () => {
  it("renders finalized snapshots verbatim", () => {
    const svg = buildInvoiceSvg(finalizedPreviewModel(), {
      logo: null,
      sellerStamp: null,
      sellerSignature: null,
    });
    expect(svg).toContain("فروشگاه البرز (snapshot)");
    expect(svg).toContain("مشتری snapshot");
    expect(svg).toContain("تومان");
    expect(svg).toContain("۱۰۲۴");
    expect(svg).toContain("پانوشت snapshot");
    expect(svg).toContain("#0055ff");
    expect(svg).toContain("۵۰,۰۰۰ تومان");
    expect(svg).not.toContain("پیش‌نویس");
  });

  it("renders drafts from the profile with a draft banner", () => {
    const svg = buildInvoiceSvg(draftPreviewModel(), {
      logo: null,
      sellerStamp: null,
      sellerSignature: null,
    });
    expect(svg).toContain("فروشگاه البرز (profile)");
    expect(svg).toContain("پیش‌نویس");
    expect(svg).toContain("جنبه رسمی ندارد");
    expect(svg).not.toContain("DRAFT-xyz");
  });

  it("embeds the Persian font and escapes interpolated strings", () => {
    const model = finalizedPreviewModel();
    const item = model.invoice.items[0] as (typeof model.invoice.items)[number];
    item.title = 'قلم <ویژه> & "تستی"';
    const svg = buildInvoiceSvg(model, { logo: null, sellerStamp: null, sellerSignature: null });
    expect(svg).toContain("@font-face");
    expect(svg).toContain("Vazirmatn");
    expect(svg).toContain("قلم &lt;ویژه&gt; &amp; &quot;تستی&quot;");
    expect(svg).not.toContain("<ویژه>");
  });

  it("embeds provided assets as data URIs", () => {
    const uri = `data:image/png;base64,${TINY_PNG.toString("base64")}`;
    const svg = buildInvoiceSvg(finalizedPreviewModel(), {
      logo: uri,
      sellerStamp: null,
      sellerSignature: uri,
    });
    expect(svg).toContain(`<image href="${uri}"`);
  });

  it("backs the logo with white unless the asset opts out", () => {
    const uri = `data:image/png;base64,${TINY_PNG.toString("base64")}`;
    const logoRect = 'width="76" height="76" rx="10" fill="#ffffff"';
    const backed = buildInvoiceSvg(finalizedPreviewModel(), {
      logo: uri,
      sellerStamp: null,
      sellerSignature: null,
    });
    expect(backed).toContain(logoRect);
    expect(backed).toContain(`<image href="${uri}"`);

    // Near-white logos skip the backing rect (it would read as the logo).
    const unbacked = buildInvoiceSvg(finalizedPreviewModel(), {
      logo: uri,
      sellerStamp: null,
      sellerSignature: null,
      logoNeedsBacking: false,
    });
    expect(unbacked).not.toContain(logoRect);
    expect(unbacked).toContain(`<image href="${uri}"`);
  });

  it("is exactly A4 for single-page invoices and grows for long ones", () => {
    const minimal = finalizedPreviewModel({
      seller: {
        ...finalizedPreviewModel().seller!,
        ownerName: null,
        address: null,
        email: null,
        mobile: null,
        landline: null,
        cardNumber: null,
        accountNumber: null,
        iban: null,
      },
      customer: null,
    });
    minimal.invoice.notes = null;
    const item = minimal.invoice.items[0] as (typeof minimal.invoice.items)[number];
    item.description = null;
    const single = buildInvoiceSvg(minimal, {
      logo: null,
      sellerStamp: null,
      sellerSignature: null,
    });
    expect(single).toContain(`width="${IMAGE_SVG_WIDTH}" height="${IMAGE_SVG_MIN_HEIGHT}"`);

    // The rich fixture needs more room: it grows vertically by design.
    const rich = buildInvoiceSvg(finalizedPreviewModel(), {
      logo: null,
      sellerStamp: null,
      sellerSignature: null,
    });
    const richHeight = Number((rich.match(/height="(\d+)"/) as RegExpMatchArray)[1]);
    expect(richHeight).toBeGreaterThan(IMAGE_SVG_MIN_HEIGHT);

    const long = finalizedPreviewModel();
    const first = long.invoice.items[0] as (typeof long.invoice.items)[number];
    long.invoice.items = Array.from({ length: 40 }, (_, i) => ({
      ...first,
      id: `item-${i}`,
      title: `قلم شماره ${i + 1}`,
    }));
    const tall = buildInvoiceSvg(long, { logo: null, sellerStamp: null, sellerSignature: null });
    const height = Number((tall.match(/height="(\d+)"/) as RegExpMatchArray)[1]);
    expect(height).toBeGreaterThan(IMAGE_SVG_MIN_HEIGHT);
    // Width (the A4 look) never changes.
    expect(tall).toContain(`width="${IMAGE_SVG_WIDTH}"`);
  });
});

describe("renderInvoiceImage raster contract", () => {
  it("renders a real high-resolution PNG at A4 ratio", async () => {
    const minimal = finalizedPreviewModel({ customer: null });
    minimal.invoice.notes = null;
    const png = await renderInvoiceImage(minimal, "png", {
      fetchImage: async () => null,
    });
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50); // P
    expect(png[2]).toBe(0x4e); // N
    expect(png[3]).toBe(0x47); // G

    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(IMAGE_OUTPUT_WIDTH);
    // A fitting invoice keeps the exact A4 ratio.
    const svg = buildInvoiceSvg(minimal, { logo: null, sellerStamp: null, sellerSignature: null });
    const svgHeight = Number((svg.match(/height="(\d+)"/) as RegExpMatchArray)[1]);
    expect(meta.height).toBe(Math.round((IMAGE_OUTPUT_WIDTH * svgHeight) / IMAGE_SVG_WIDTH));
  });

  it("renders a real high-quality JPG", async () => {
    const jpg = await renderInvoiceImage(finalizedPreviewModel(), "jpg", {
      fetchImage: async () => null,
    });
    expect(jpg[0]).toBe(0xff);
    expect(jpg[1]).toBe(0xd8); // SOI
    expect(jpg[2]).toBe(0xff);

    const meta = await sharp(jpg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(IMAGE_OUTPUT_WIDTH);
    expect(IMAGE_JPEG_QUALITY).toBeGreaterThanOrEqual(85);
  });

  it("embeds fetched business images and omits failures", async () => {
    const fetchImage = vi.fn(async () => TINY_PNG);
    const png = await renderInvoiceImage(finalizedPreviewModel(), "png", { fetchImage });
    // Logo + signature have urls; the stamp is null and must not be fetched.
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(png.length).toBeGreaterThan(10_000);

    const failing = vi.fn(async (): Promise<Buffer | null> => {
      throw new Error("network down");
    });
    const degraded = await renderInvoiceImage(finalizedPreviewModel(), "png", {
      fetchImage: failing,
    });
    expect(degraded.length).toBeGreaterThan(10_000);
  });
});
