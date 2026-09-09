import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Font as KitFont } from "@pdf-lib/fontkit";
import { formatCurrency } from "@/lib/formatters";
import { BRAND_COLOR_FALLBACK, FOOTER_COLOR_FALLBACK } from "@/lib/invoice-brand";
import { draftModel, finalizedModel, finalizedRow, lineItem } from "./fixtures";
import { loadKitFont } from "../persianText";
import { expectedVisualForTestLine, parsePdfText, type ParsedPage } from "../pdfInspect";
import {
  exportInvoicePdf,
  makeInvoicePdfFilename,
  renderInvoicePdf,
  tintTowardWhite,
} from "../pdfService";

const getInvoicePreviewDataMock = vi.hoisted(() => vi.fn());
const resolveEntitlementsMock = vi.hoisted(() => vi.fn());
const entitlementHasFeatureMock = vi.hoisted(() => vi.fn());
const MockForbiddenError = vi.hoisted(() =>
  class MockForbiddenError extends Error {
    constructor(message = "Forbidden") {
      super(message);
      this.name = "ForbiddenError";
    }
  },
);

vi.mock("@/server/invoice/previewService", () => ({ getInvoicePreviewData: getInvoicePreviewDataMock }));
vi.mock("@/server/entitlements/entitlementService", () => ({
  resolveEntitlements: resolveEntitlementsMock,
  entitlementHasFeature: entitlementHasFeatureMock,
}));
vi.mock("@/server/auth/requireSession", () => ({ ForbiddenError: MockForbiddenError }));



// ---------------------------------------------------------------------------
// Glyph-subsequence assertion: ligature-proof "this single-line text appears
// on the page". Compares the page's glyph-chars array against the shaped
// layout's glyph chars (same call pdf-lib makes) via sliding window.
// ---------------------------------------------------------------------------

let kit: KitFont;

function pageGlyphChars(page: ParsedPage): string[] {
  return page.glyphs.map((glyph) => glyph.chars);
}

function expectGlyphSequence(page: ParsedPage, logicalSingleLine: string): void {
  const expected = expectedVisualForTestLine(logicalSingleLine, kit).glyphs.map((glyph) => glyph.chars);
  expect(expected.length).toBeGreaterThan(0);
  const actual = pageGlyphChars(page);
  const found = actual.some((_, start) =>
    expected.every((want, offset) => actual[start + offset] === want),
  );
  expect(found).toBe(true);
}

function expectNoGlyphSequence(page: ParsedPage, logicalSingleLine: string): void {
  const expected = expectedVisualForTestLine(logicalSingleLine, kit).glyphs.map((glyph) => glyph.chars);
  const actual = pageGlyphChars(page);
  const found = actual.some((_, start) =>
    expected.every((want, offset) => actual[start + offset] === want),
  );
  expect(found).toBe(false);
}

function hexToUnit(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function expectFill(page: ParsedPage, hex: string): void {
  const [r, g, b] = hexToUnit(hex);
  const found = page.fills.some(
    (fill) => Math.abs(fill.r - r) < 0.005 && Math.abs(fill.g - g) < 0.005 && Math.abs(fill.b - b) < 0.005,
  );
  expect(found).toBe(true);
}

beforeEach(() => {
  kit = loadKitFont("regular");
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// renderInvoicePdf: real bytes, real RTL, real branding.
// ---------------------------------------------------------------------------

describe("renderInvoicePdf", () => {
  it("emits a single-page PDF with header bytes", async () => {
    const bytes = await renderInvoicePdf(finalizedModel());
    expect(Buffer.from(bytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(parsePdfText(bytes).pages.length).toBe(1);
  });

  it("renders seller, customer, and item text with correct RTL order", async () => {
    const parsed = parsePdfText(await renderInvoicePdf(finalizedModel()));
    const page = parsed.pages[0];
    if (!page) throw new Error("missing page");
    expectGlyphSequence(page, "استودیو نمارو");
    expectGlyphSequence(page, "علیرضا قوایی");
    expectGlyphSequence(page, "خدمت طراحی");
    expectGlyphSequence(page, "فاکتور رسمی");
    expectGlyphSequence(page, "تحویل در محل انجام شد");
    expectGlyphSequence(page, "از خرید شما سپاسگزاریم");
  });

  it("renders money through the shared currency formatter (no PDF-side math)", async () => {
    const parsed = parsePdfText(await renderInvoicePdf(finalizedModel()));
    const page = parsed.pages[0];
    if (!page) throw new Error("missing page");
    // 98100 IRR through the SAME formatter the HTML preview uses.
    expectGlyphSequence(page, formatCurrency("98100.00", "IRR"));
    expectGlyphSequence(page, formatCurrency("100000.00", "IRR"));
    expect(pageGlyphChars(page).join("")).toContain("۹۸,۱۰۰");
  });

  it("paints brand and footer fills from the snapshot colors", async () => {
    const parsed = parsePdfText(await renderInvoicePdf(finalizedModel()));
    const page = parsed.pages[0];
    if (!page) throw new Error("missing page");
    expectFill(page, "#0055ff");
    expectFill(page, "#111827");
  });

  it("falls back to default branding when colors are absent", async () => {
    const model = finalizedModel({
      sellerSnapshot: {
        ...(finalizedRow().sellerSnapshot as unknown as Record<string, unknown>),
        primaryColor: null,
        footerBackgroundColor: null,
      },
    });
    const parsed = parsePdfText(await renderInvoicePdf(model));
    const page = parsed.pages[0];
    if (!page) throw new Error("missing page");
    expectFill(page, BRAND_COLOR_FALLBACK);
    expectFill(page, FOOTER_COLOR_FALLBACK);
  });

  it("renders the empty-items notice when the invoice has no lines", async () => {
    const parsed = parsePdfText(await renderInvoicePdf(finalizedModel({ items: [] })));
    const page = parsed.pages[0];
    if (!page) throw new Error("missing page");
    expectGlyphSequence(page, "این فاکتور قلمی ندارد.");
  });

  it("renders drafts from the live profile with draft markings and no payment rows", async () => {
    const parsed = parsePdfText(await renderInvoicePdf(draftModel()));
    const page = parsed.pages[0];
    if (!page) throw new Error("missing page");
    expectGlyphSequence(page, "استودیو نمارو");
    // The drawn title never carries a draft suffix (like the HTML preview);
    // drafts are marked by the status row and omit payment rows + numbers.
    expectGlyphSequence(page, "فاکتور رسمی");
    expectGlyphSequence(page, "پیش‌نویس");
    expectNoGlyphSequence(page, "مانده قابل پرداخت");
    expectNoGlyphSequence(page, "INV-101");
    expectNoGlyphSequence(page, "DRAFT-abcdef12");
  });

  it("paginates long item tables with the header band on every page", async () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      lineItem({ id: `item-${index}`, title: `قلم شماره ${index + 1}` }),
    );
    const parsed = parsePdfText(await renderInvoicePdf(finalizedModel({ items })));
    expect(parsed.pages.length).toBeGreaterThan(1);
    for (const page of parsed.pages) expectFill(page, "#0055ff");
    const first = parsed.pages[0];
    const last = parsed.pages[parsed.pages.length - 1];
    if (!first || !last) throw new Error("missing pages");
    // Footer text lives on the last page only; totals close the document.
    expectGlyphSequence(last, "از خرید شما سپاسگزاریم");
    expectNoGlyphSequence(first, "از خرید شما سپاسگزاریم");
    expectGlyphSequence(last, formatCurrency("98100.00", "IRR"));
  }, 60000);
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe("makeInvoicePdfFilename", () => {
  it("slugifies the official number", () => {
    expect(makeInvoicePdfFilename(finalizedModel())).toBe("invoice-INV-101.pdf");
  });

  it("falls back to the draft id for drafts", () => {
    const model = draftModel();
    model.invoice.id = "abcdef12-3456-7890-abcd-ef1234567890";
    expect(makeInvoicePdfFilename(model)).toBe("invoice-draft-abcdef12.pdf");
  });

  it("sanitizes non-ASCII numbers to an ASCII-safe fallback", () => {
    const model = finalizedModel();
    model.officialNumber = "فاکتور/۱";
    expect(makeInvoicePdfFilename(model)).toBe("invoice-invoice.pdf");
  });
});

describe("tintTowardWhite", () => {
  it("mixes toward white by ratio with clamping", () => {
    expect(tintTowardWhite("#000000", 0)).toEqual({ red: 0, green: 0, blue: 0, type: "RGB" });
    expect(tintTowardWhite("#000000", 1)).toEqual({ red: 1, green: 1, blue: 1, type: "RGB" });
    const half = tintTowardWhite("#000000", 0.5);
    expect(half.red).toBeCloseTo(0.5, 6);
    expect(tintTowardWhite("#ff0000", 5)).toEqual({ red: 1, green: 1, blue: 1, type: "RGB" });
    expect(tintTowardWhite("#ff0000", -2)).toEqual({ red: 1, green: 0, blue: 0, type: "RGB" });
  });
});

// ---------------------------------------------------------------------------
// exportInvoicePdf: loader + entitlement gate.
// ---------------------------------------------------------------------------

describe("exportInvoicePdf", () => {
  it("denies export without the PDF_EXPORT feature", async () => {
    getInvoicePreviewDataMock.mockResolvedValue(finalizedModel());
    resolveEntitlementsMock.mockResolvedValue({});
    entitlementHasFeatureMock.mockReturnValue(false);
    await expect(exportInvoicePdf("biz-1", "inv-final-1")).rejects.toThrow(
      "PDF export is not available on the current plan",
    );
    await expect(exportInvoicePdf("biz-1", "inv-final-1")).rejects.toBeInstanceOf(MockForbiddenError);
    expect(getInvoicePreviewDataMock).toHaveBeenCalledWith("biz-1", "inv-final-1");
    expect(entitlementHasFeatureMock).toHaveBeenCalledWith({}, "PDF_EXPORT");
  });

  it("returns bytes, filename, and content type when entitled", async () => {
    getInvoicePreviewDataMock.mockResolvedValue(finalizedModel());
    resolveEntitlementsMock.mockResolvedValue({});
    entitlementHasFeatureMock.mockReturnValue(true);
    const result = await exportInvoicePdf("biz-1", "inv-final-1");
    expect(result.filename).toBe("invoice-INV-101.pdf");
    expect(result.contentType).toBe("application/pdf");
    expect(Buffer.from(result.bytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
