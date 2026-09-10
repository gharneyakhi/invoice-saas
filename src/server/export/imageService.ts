import type { InvoicePreviewModel } from "@/lib/invoice-preview-model";
import { buildPdfContent, type PdfContent } from "./exportContent";
import { DRAFT_EXPORT_NOTICE } from "./exportCopy";
import { fetchImageAsPng, logoNeedsWhiteBacking, pngToDataUri } from "./imageAssets";
import { getVazirmatnFontBase64 } from "./fontLoader";

/**
 * Server-side invoice image export (PNG / JPG) — Export & Sharing V1.
 *
 * The invoice is composed as a self-contained SVG (embedded Vazirmatn font
 * via `@font-face`, brand colours, data-URI business images) and rasterized
 * deterministically with `sharp` — no browser, no screenshot hacks. Persian
 * shaping and bidi are handled by the SVG renderer's text engine, so the
 * content strings are the SAME logical strings the PDF uses (see
 * `buildPdfContent`, shared by both generators): one export content model,
 * two renderers.
 *
 * Geometry: single-page exports are exactly A4 at 96 dpi (794×1123). Longer
 * invoices grow vertically rather than clipping or shrinking data — the
 * width (and therefore the A4 look) is always preserved.
 */

export type InvoiceImageFormat = "png" | "jpg";

export const IMAGE_SVG_WIDTH = 794;
export const IMAGE_SVG_MIN_HEIGHT = 1123;
export const IMAGE_OUTPUT_WIDTH = 1985; // ≈250 dpi — crisp for sharing/printing
export const IMAGE_JPEG_QUALITY = 90;

const MARGIN = 48;
const CONTENT_RIGHT = IMAGE_SVG_WIDTH - MARGIN;
const CONTENT_LEFT = MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Greedy word-wrap by character budget (SVG has no auto-wrap). */
function wrapBudget(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (candidate.length <= maxChars || current === "") {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}

export interface ImageAssets {
  logo: string | null;
  sellerStamp: string | null;
  sellerSignature: string | null;
  /** False when the logo is near-white and must skip the white backing rect. */
  logoNeedsBacking?: boolean;
}

async function resolveImageAssets(
  model: InvoicePreviewModel,
  fetchImage: (url: string) => Promise<Buffer | null>,
): Promise<ImageAssets> {
  const safeFetch = async (url: string | null | undefined): Promise<Buffer | null> => {
    if (!url) return null;
    try {
      return await fetchImage(url);
    } catch {
      return null;
    }
  };
  const [logo, sellerStamp, sellerSignature] = await Promise.all([
    safeFetch(model.seller?.logo?.url),
    safeFetch(model.seller?.sellerStamp?.url),
    safeFetch(model.seller?.sellerSignature?.url),
  ]);
  return {
    logo: logo ? pngToDataUri(logo) : null,
    sellerStamp: sellerStamp ? pngToDataUri(sellerStamp) : null,
    sellerSignature: sellerSignature ? pngToDataUri(sellerSignature) : null,
    logoNeedsBacking: logo ? await logoNeedsWhiteBacking(logo) : true,
  };
}

// ---------------------------------------------------------------------------
// SVG composer
// ---------------------------------------------------------------------------

interface Composer {
  parts: string[];
  y: number;
}

/**
 * The `anchor` parameter is VISUAL (where the text sits relative to `x`):
 * the whole document is `direction:rtl`, where SVG's `start` is the right
 * side and `end` is the left — so visual-right maps to `text-anchor=start`.
 */
function text(
  c: Composer,
  logical: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  anchor: "start" | "middle" | "end" = "end",
  weight: number = 400,
): void {
  const svgAnchor = anchor === "end" ? "start" : anchor === "start" ? "end" : "middle";
  c.parts.push(
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${svgAnchor}" font-weight="${weight}">${escapeXml(logical)}</text>`,
  );
}

function rect(
  c: Composer,
  x: number,
  y: number,
  width: number,
  height: number,
  attrs: string,
): void {
  c.parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" ${attrs}/>`);
}

function softBrand(hex: string): string {
  // 8% brand tint for table headers (same idea as the PDF soft header).
  const value = Number.parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(value)) return "#eef2ff";
  const mix = (channel: number): number => Math.round(255 - (255 - channel) * 0.08);
  const r = mix((value >> 16) & 0xff);
  const g = mix((value >> 8) & 0xff) ;
  const b = mix(value & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function heading(c: Composer, title: string): void {
  text(c, title, CONTENT_RIGHT, c.y, 17, "#111827", "end", 700);
  c.y += 10;
  c.parts.push(
    `<line x1="${CONTENT_LEFT}" y1="${c.y}" x2="${CONTENT_RIGHT}" y2="${c.y}" stroke="#e5e7eb" stroke-width="1"/>`,
  );
  c.y += 20;
}

function bodyLines(c: Composer, lines: string[], size = 14, fill = "#4b5563"): void {
  for (const line of lines) {
    const wrapped = wrapBudget(line, 82);
    for (const w of wrapped) {
      text(c, w, CONTENT_RIGHT, c.y, size, fill);
      c.y += size + 8;
    }
  }
  c.y += 4;
}

/**
 * Builds the standalone invoice SVG (pure — images must already be data
 * URIs). Exported for tests; production callers use `renderInvoiceImage`,
 * which resolves remote images first.
 */
export function buildInvoiceSvg(
  model: InvoicePreviewModel,
  assets: ImageAssets = { logo: null, sellerStamp: null, sellerSignature: null },
): string {
  const content: PdfContent = buildPdfContent(model);
  const c: Composer = { parts: [], y: 0 };

  // ---- Header band -------------------------------------------------------
  const headerHeight = 140;
  rect(c, 0, 0, IMAGE_SVG_WIDTH, headerHeight, `fill="${content.headerBackground}"`);
  const fg = content.headerForeground;
  const logoSize = 76;
  const textRight = assets.logo ? CONTENT_RIGHT - logoSize - 16 : CONTENT_RIGHT;
  text(c, content.businessName, textRight, 62, 30, fg, "end", 700);
  if (content.slogan) {
    // One slogan line fits the band; longer slogans are clipped by design.
    const [firstSloganLine] = wrapBudget(content.slogan, 60);
    text(c, firstSloganLine ?? "", textRight, 92, 14, fg);
  }
  if (assets.logo) {
    if (assets.logoNeedsBacking !== false) {
      c.parts.push(
        `<rect x="${CONTENT_RIGHT - logoSize}" y="${(headerHeight - logoSize) / 2}" width="${logoSize}" height="${logoSize}" rx="10" fill="#ffffff"/>`,
      );
    }
    c.parts.push(
      `<image href="${assets.logo}" x="${CONTENT_RIGHT - logoSize + 6}" y="${(headerHeight - logoSize) / 2 + 6}" width="${logoSize - 12}" height="${logoSize - 12}" preserveAspectRatio="xMidYMid meet"/>`,
    );
  }
  c.y = headerHeight + 34;

  // ---- Draft banner ------------------------------------------------------
  if (content.isDraft) {
    const lines = wrapBudget(DRAFT_EXPORT_NOTICE, 80);
    const boxHeight = lines.length * 22 + 20;
    rect(
      c, CONTENT_LEFT, c.y - 18, CONTENT_WIDTH, boxHeight,
      `fill="#fffbeb" stroke="#f59e0b" stroke-width="1.5" rx="10"`,
    );
    for (const line of lines) {
      text(c, line, IMAGE_SVG_WIDTH / 2, c.y + 4, 14, "#92400e", "middle");
      c.y += 22;
    }
    c.y += 24;
  }

  // ---- Title + meta ------------------------------------------------------
  text(c, content.documentTitle, IMAGE_SVG_WIDTH / 2, c.y, 25, "#111827", "middle", 700);
  c.y += 24;
  text(c, content.documentSubtitle, IMAGE_SVG_WIDTH / 2, c.y, 12.5, "#6b7280", "middle");
  c.y += 28;

  const numberLabel = content.isDraft ? "پیش‌نویس (بدون شماره رسمی)" : "شماره فاکتور";
  const meta: Array<[string, string]> = [
    [numberLabel, content.officialNumber ?? "—"],
    ["تاریخ صدور", content.issueDate],
    ["وضعیت", content.statusLabel],
    ["سررسید", content.dueDate],
  ];
  const metaHeight = 78;
  rect(
    c, CONTENT_LEFT, c.y - 22, CONTENT_WIDTH, metaHeight,
    `fill="#f9fafb" stroke="#e5e7eb" stroke-width="1" rx="10"`,
  );
  const midX = CONTENT_LEFT + CONTENT_WIDTH / 2;
  meta.forEach(([label, value], index) => {
    const colRight = index % 2 === 0 ? CONTENT_RIGHT - 16 : midX - 16;
    const rowY = c.y + Math.floor(index / 2) * 34;
    text(c, `${label}:`, colRight, rowY, 13, "#9ca3af");
    // Value sits left of the label; estimate label width conservatively.
    text(c, value, colRight - label.length * 8 - 14, rowY, 13.5, "#111827");
  });
  c.y += metaHeight - 8;

  // ---- Seller ------------------------------------------------------------
  heading(c, "فروشنده");
  const sellerLines: string[] = [];
  if (content.ownerName) sellerLines.push(`مدیر / صاحب امتیاز: ${content.ownerName}`);
  if (content.contacts) sellerLines.push(content.contacts);
  if (content.address) sellerLines.push(`نشانی: ${content.address}`);
  if (content.cardNumber) sellerLines.push(`شماره کارت: ${content.cardNumber}`);
  if (content.accountNumber) sellerLines.push(`شماره حساب: ${content.accountNumber}`);
  if (content.iban) sellerLines.push(`شبا: ${content.iban}`);
  bodyLines(c, sellerLines.length > 0 ? sellerLines : ["—"]);

  // ---- Customer ----------------------------------------------------------
  if (content.customerName || content.customerLines.length > 0) {
    heading(c, "مشتری / گیرنده");
    if (content.customerName) {
      text(c, content.customerName, CONTENT_RIGHT, c.y, 16, "#111827", "end", 700);
      c.y += 26;
    }
    bodyLines(c, content.customerLines);
  }

  // ---- Items table -------------------------------------------------------
  heading(c, `اقلام فاکتور (${content.currencyUnit})`);
  const colWidths = { row: 44, qty: 64, unit: 60, price: 100, discount: 100, total: 110 };
  const descWidth =
    CONTENT_WIDTH -
    (colWidths.row + colWidths.qty + colWidths.unit + colWidths.price + colWidths.discount + colWidths.total);
  interface SvgCol { title: string; right: number; width: number; anchor: "middle" | "end"; }
  let cursor = CONTENT_RIGHT;
  const col = (title: string, width: number, anchor: "middle" | "end"): SvgCol => {
    const right = cursor;
    cursor -= width;
    return { title, right, width, anchor };
  };
  const columns: SvgCol[] = [
    col("ردیف", colWidths.row, "middle"),
    col("شرح کالا / خدمت", descWidth, "end"),
    col("تعداد", colWidths.qty, "middle"),
    col("واحد", colWidths.unit, "middle"),
    col("قیمت واحد", colWidths.price, "end"),
    col("تخفیف", colWidths.discount, "end"),
    col("مبلغ ردیف", colWidths.total, "end"),
  ];

  const headerY = c.y - 16;
  rect(
    c, CONTENT_LEFT, headerY, CONTENT_WIDTH, 36,
    `fill="${softBrand(content.headerBackground)}" stroke="#e5e7eb" stroke-width="1"`,
  );
  for (const column of columns) {
    const x = column.anchor === "middle" ? column.right - column.width / 2 : column.right - 8;
    text(c, column.title, x, headerY + 23, 12.5, "#4b5563", column.anchor, 700);
  }
  c.y = headerY + 36;

  if (content.items.length === 0) {
    rect(c, CONTENT_LEFT, c.y, CONTENT_WIDTH, 44, `fill="#ffffff" stroke="#e5e7eb" stroke-width="1"`);
    text(c, "این فاکتور قلمی ندارد.", IMAGE_SVG_WIDTH / 2, c.y + 28, 13, "#9ca3af", "middle");
    c.y += 44;
  }

  content.items.forEach((item, index) => {
    const titleLines = wrapBudget(item.title, 26);
    const descLines = item.description ? wrapBudget(item.description, 30) : [];
    const rowHeight = 16 + titleLines.length * 20 + descLines.length * 17;
    const fill = index % 2 === 1 ? `fill="#f9fafb" ` : `fill="#ffffff" `;
    rect(c, CONTENT_LEFT, c.y, CONTENT_WIDTH, rowHeight, `${fill}stroke="#e5e7eb" stroke-width="1"`);
    const rowTop = c.y;
    // Vertical separators.
    let sx = CONTENT_RIGHT;
    for (const column of columns) {
      sx -= column.width;
      if (sx > CONTENT_LEFT + 1) {
        c.parts.push(
          `<line x1="${sx}" y1="${rowTop}" x2="${sx}" y2="${rowTop + rowHeight}" stroke="#f3f4f6" stroke-width="1"/>`,
        );
      }
    }
    const cell = (column: SvgCol, value: string, size: number, fillColor: string): void => {
      const x = column.anchor === "middle" ? column.right - column.width / 2 : column.right - 8;
      text(c, value, x, rowTop + 22, size, fillColor, column.anchor);
    };
    cell(columns[0] as SvgCol, item.rowNumber, 13, "#6b7280");
    let ly = rowTop + 22;
    for (const line of titleLines) {
      text(c, line, (columns[1] as SvgCol).right - 8, ly, 13.5, "#111827");
      ly += 20;
    }
    for (const line of descLines) {
      text(c, line, (columns[1] as SvgCol).right - 8, ly, 12, "#6b7280");
      ly += 17;
    }
    cell(columns[2] as SvgCol, item.quantity, 13.5, "#111827");
    cell(columns[3] as SvgCol, item.unit, 12.5, "#6b7280");
    cell(columns[4] as SvgCol, item.unitPrice, 13, "#111827");
    cell(columns[5] as SvgCol, item.discount, 12, "#6b7280");
    cell(columns[6] as SvgCol, item.total, 13.5, "#111827");
    c.y += rowHeight;
  });
  c.y += 26;

  // ---- Totals ------------------------------------------------------------
  heading(c, "خلاصه مالی");
  const totalRows: Array<{ label: string; value: string; strong: boolean; muted: boolean }> = [
    { label: "جمع اقلام (پیش از تخفیف)", value: content.subtotal, strong: false, muted: false },
    { label: "مجموع تخفیف اقلام", value: content.itemDiscount, strong: false, muted: true },
    { label: content.globalDiscountLabel, value: content.globalDiscount, strong: false, muted: true },
  ];
  if (content.taxLabel) {
    totalRows.push({ label: content.taxLabel, value: content.taxAmount, strong: false, muted: false });
  }
  totalRows.push({ label: "مبلغ نهایی فاکتور", value: content.total, strong: true, muted: false });
  if (content.paidAmount && content.remainingAmount) {
    totalRows.push({ label: "پرداخت شده", value: content.paidAmount, strong: false, muted: false });
    totalRows.push({ label: "مانده قابل پرداخت", value: content.remainingAmount, strong: true, muted: false });
  }
  const totalsHeight = totalRows.length * 32 + 4;
  rect(
    c, CONTENT_LEFT, c.y - 16, CONTENT_WIDTH, totalsHeight,
    `fill="#ffffff" stroke="#e5e7eb" stroke-width="1" rx="10"`,
  );
  const labelZone = 330;
  for (const row of totalRows) {
    const size = row.strong ? 15 : 13.5;
    const fill = row.muted ? "#9ca3af" : "#111827";
    text(c, row.label, CONTENT_RIGHT - 14, c.y, size, fill, "end", row.strong ? 700 : 400);
    text(c, row.value, CONTENT_RIGHT - labelZone, c.y, size, fill, "end", row.strong ? 700 : 400);
    c.y += 32;
  }
  c.y += 8;

  // ---- Notes -------------------------------------------------------------
  if (content.notes) {
    heading(c, "توضیحات");
    const lines = wrapBudget(content.notes, 82);
    const boxHeight = lines.length * 22 + 12;
    rect(
      c, CONTENT_LEFT, c.y - 16, CONTENT_WIDTH, boxHeight,
      `fill="#ffffff" stroke="#e5e7eb" stroke-width="1" rx="10"`,
    );
    for (const line of lines) {
      text(c, line, CONTENT_RIGHT - 14, c.y, 13.5, "#4b5563");
      c.y += 22;
    }
    c.y += 22;
  }

  // ---- Stamp / signature -------------------------------------------------
  if (assets.sellerStamp || assets.sellerSignature) {
    heading(c, "مهر و امضا");
    let xRight = CONTENT_RIGHT;
    const box = (uri: string | null, caption: string, w: number, h: number): void => {
      if (!uri) return;
      const left = xRight - w;
      rect(c, left, c.y - 14, w, h, `fill="#ffffff" stroke="#e5e7eb" stroke-width="1" rx="8"`);
      c.parts.push(
        `<image href="${uri}" x="${left + 8}" y="${c.y - 6}" width="${w - 16}" height="${h - 16}" preserveAspectRatio="xMidYMid meet"/>`,
      );
      text(c, caption, left + w / 2, c.y + h + 2, 12, "#9ca3af", "middle");
      xRight = left - 24;
    };
    box(assets.sellerSignature, "امضا", 170, 104);
    box(assets.sellerStamp, "مهر", 116, 104);
    c.y += 110;
  }

  // ---- Footer band -------------------------------------------------------
  const pageHeight = Math.max(IMAGE_SVG_MIN_HEIGHT, Math.ceil(c.y + 96));
  if (content.hasFooter) {
    const footerHeight = 56;
    const footerY = pageHeight - footerHeight;
    rect(c, 0, footerY, IMAGE_SVG_WIDTH, footerHeight, `fill="${content.footerBackground}"`);
    if (content.footerText) {
      const lines = wrapBudget(content.footerText, 90).slice(0, 2);
      lines.forEach((line, index) => {
        text(c, line, IMAGE_SVG_WIDTH / 2, footerY + 24 + index * 18, 12.5, content.footerForeground, "middle");
      });
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_SVG_WIDTH}" height="${pageHeight}" viewBox="0 0 ${IMAGE_SVG_WIDTH} ${pageHeight}" style="direction:rtl">` +
    `<style>@font-face{font-family:'Vazirmatn';src:url(data:font/ttf;base64,${getVazirmatnFontBase64()}) format('truetype');}text{font-family:'Vazirmatn';}</style>` +
    `<rect x="0" y="0" width="${IMAGE_SVG_WIDTH}" height="${pageHeight}" fill="#ffffff"/>` +
    c.parts.join("") +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// Raster renderer (sharp)
// ---------------------------------------------------------------------------

export interface RenderInvoiceImageOptions {
  /** Override for tests / offline environments (defaults to fetch + sharp). */
  fetchImage?: (url: string) => Promise<Buffer | null>;
  /** Output width in px (defaults to {@link IMAGE_OUTPUT_WIDTH}). */
  width?: number;
}

/**
 * Renders the invoice as a PNG or JPG buffer.
 *
 * High-resolution, deterministic, server-side: the SVG is composed from
 * the authorized preview model (snapshots for finalized rows) and
 * rasterized with `sharp` at ~250 dpi.
 */
export async function renderInvoiceImage(
  model: InvoicePreviewModel,
  format: InvoiceImageFormat,
  options: RenderInvoiceImageOptions = {},
): Promise<Buffer> {
  const fetchImage = options.fetchImage ?? fetchImageAsPng;
  const assets = await resolveImageAssets(model, fetchImage);
  const svg = buildInvoiceSvg(model, assets);
  const width = options.width ?? IMAGE_OUTPUT_WIDTH;

  const { default: sharp } = await import("sharp");
  const pipeline = sharp(Buffer.from(svg)).resize({ width });
  if (format === "png") {
    return pipeline.png().toBuffer();
  }
  return pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: IMAGE_JPEG_QUALITY }).toBuffer();
}
