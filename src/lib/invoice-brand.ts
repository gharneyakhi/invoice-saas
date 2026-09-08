/**
 * Controlled brand-color helpers for the invoice print/preview document.
 *
 * `BusinessProfile.primaryColor` (and the finalized
 * `InvoiceSellerSnapshot.primaryColor`) is the HEADER BACKGROUND of the
 * invoice document — never body text. `footerBackgroundColor` is the FOOTER
 * strip. Both are validated at write time by the business schema as a
 * lowercase `#rrggbb` hex string. These helpers re-apply that rule
 * defensively at render time so a color value is NEVER injected into CSS
 * unless it is a plain hex literal:
 *
 *   - `normalizeBrandColor` returns the value only when it matches the
 *     pattern, otherwise `null`;
 *   - `contrastForeground` picks white vs near-black from relative luminance
 *     so logo/name/slogan (and footer text) stay readable on the chosen
 *     background — there is no separate font-color setting;
 *   - `brandCssVars` maps the safe values onto CSS custom properties with
 *     hard-coded fallbacks, so the document always has deterministic colours.
 *
 * The output is a fixed set of CSS variables with values from a validated
 * allow-list pattern — never raw user text concatenated into a stylesheet.
 */

export const BRAND_COLOR_FALLBACK = "#2563eb";
export const FOOTER_COLOR_FALLBACK = "#f3f4f6";
export const FG_ON_DARK = "#ffffff";
export const FG_ON_LIGHT = "#111827";

/** Mirrors the server-side `PRIMARY_COLOR_PATTERN` (business schema). */
export const BRAND_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Returns the color only when it is a safe lowercase `#rrggbb` hex; else null. */
export function normalizeBrandColor(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return BRAND_COLOR_PATTERN.test(candidate) ? candidate : null;
}

function srgbChannelToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a validated `#rrggbb` hex. */
export function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

function contrastRatio(luminanceA: number, luminanceB: number): number {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Readable foreground for a background hex: white on dark surfaces, near-black
 * on light ones. Picks whichever of the two has the higher WCAG contrast.
 */
export function contrastForeground(hex: string): typeof FG_ON_DARK | typeof FG_ON_LIGHT {
  const background = relativeLuminance(hex);
  const white = contrastRatio(1, background);
  const dark = contrastRatio(relativeLuminance(FG_ON_LIGHT), background);
  return white >= dark ? FG_ON_DARK : FG_ON_LIGHT;
}

export interface BrandCssVars {
  "--pv-brand": string;
  "--pv-brand-soft": string;
  "--pv-header-bg": string;
  "--pv-header-fg": string;
  "--pv-footer-bg": string;
  "--pv-footer-fg": string;
}

/**
 * Builds the CSS custom properties the invoice document consumes.
 *
 * `--pv-header-bg` is the brand/primary colour (header BACKGROUND).
 * `--pv-header-fg` is the auto-computed readable foreground for that header.
 * `--pv-footer-bg` / `--pv-footer-fg` are the same pair for the footer strip.
 * `--pv-brand` is kept as an alias of the header background (table-header
 * tint via `--pv-brand-soft`) so existing tests and the soft tint stay valid.
 * Body text never reads these variables: headings and totals use gray.
 */
export function brandCssVars(
  primaryColor: string | null | undefined,
  footerBackgroundColor?: string | null,
): BrandCssVars {
  const brand = normalizeBrandColor(primaryColor) ?? BRAND_COLOR_FALLBACK;
  const footer = normalizeBrandColor(footerBackgroundColor) ?? FOOTER_COLOR_FALLBACK;
  return {
    "--pv-brand": brand,
    "--pv-brand-soft": `${brand}14`,
    "--pv-header-bg": brand,
    "--pv-header-fg": contrastForeground(brand),
    "--pv-footer-bg": footer,
    "--pv-footer-fg": contrastForeground(footer),
  };
}
