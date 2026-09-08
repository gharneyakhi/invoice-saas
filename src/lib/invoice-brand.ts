/**
 * Controlled brand-color helpers for the invoice print/preview document.
 *
 * `BusinessProfile.primaryColor` (and the finalized
 * `InvoiceSellerSnapshot.primaryColor`) is validated at write time by the
 * business schema as a lowercase `#rrggbb` hex string — the exact same rule
 * as `PRIMARY_COLOR_PATTERN` in `src/server/business/schema.ts`. These helpers
 * re-apply that rule defensively at render time so a color value is NEVER
 * injected into CSS unless it is a plain hex literal:
 *
 *   - `normalizeBrandColor` returns the value only when it matches the
 *     pattern, otherwise `null`;
 *   - `brandCssVars` maps the safe value onto two CSS custom properties
 *     (`--pv-brand` and a translucent soft variant) with a hard-coded
 *     fallback, so the document always has a deterministic accent color.
 *
 * The output is a fixed set of CSS variables with values from a validated
 * allow-list pattern — never raw user text concatenated into a stylesheet.
 */

export const BRAND_COLOR_FALLBACK = "#2563eb";

/** Mirrors the server-side `PRIMARY_COLOR_PATTERN` (business schema). */
export const BRAND_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Returns the color only when it is a safe lowercase `#rrggbb` hex; else null. */
export function normalizeBrandColor(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return BRAND_COLOR_PATTERN.test(candidate) ? candidate : null;
}

export interface BrandCssVars {
  "--pv-brand": string;
  "--pv-brand-soft": string;
}

/**
 * Builds the CSS custom properties the invoice document consumes.
 *
 * `--pv-brand` is the exact brand hex (fallback applied when the stored value
 * is missing or not a valid hex). `--pv-brand-soft` is an 8-digit hex (the
 * brand color at ~8% opacity) used for tinted surfaces (table header, badges);
 * it is derived only from an already-validated hex string, so it is safe to
 * inject.
 */
export function brandCssVars(value: string | null | undefined): BrandCssVars {
  const brand = normalizeBrandColor(value) ?? BRAND_COLOR_FALLBACK;
  return {
    "--pv-brand": brand,
    "--pv-brand-soft": `${brand}14`,
  };
}
