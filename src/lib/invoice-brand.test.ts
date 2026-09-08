import { describe, expect, it } from "vitest";
import {
  BRAND_COLOR_FALLBACK,
  brandCssVars,
  normalizeBrandColor,
} from "@/lib/invoice-brand";

/**
 * Brand-colour helpers — the invoice document's accent colour is injected
 * through CSS variables ONLY after passing the same `#rrggbb` allow-list the
 * business schema validates at write time; anything else falls back to a
 * hard-coded colour instead of reaching the stylesheet.
 */

describe("normalizeBrandColor", () => {
  it("accepts a lowercase hex colour", () => {
    expect(normalizeBrandColor("#2563eb")).toBe("#2563eb");
  });

  it("normalizes case", () => {
    expect(normalizeBrandColor("#A1B2C3")).toBe("#a1b2c3");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeBrandColor("  #123456  ")).toBe("#123456");
  });

  it("rejects anything that is not a #rrggbb hex literal", () => {
    expect(normalizeBrandColor(null)).toBeNull();
    expect(normalizeBrandColor(undefined)).toBeNull();
    expect(normalizeBrandColor("")).toBeNull();
    expect(normalizeBrandColor("blue")).toBeNull();
    expect(normalizeBrandColor("rgb(0,0,0)")).toBeNull();
    expect(normalizeBrandColor("#fff")).toBeNull();
    expect(normalizeBrandColor("#GGGGGG")).toBeNull();
    expect(normalizeBrandColor("#12345")).toBeNull();
    expect(normalizeBrandColor("url(javascript:alert(1))")).toBeNull();
  });
});

describe("brandCssVars", () => {
  it("exposes the validated colour as --pv-brand with a soft tint", () => {
    const vars = brandCssVars("#2563eb");
    expect(vars["--pv-brand"]).toBe("#2563eb");
    expect(vars["--pv-brand-soft"]).toBe("#2563eb14");
  });

  it("falls back to the default brand colour for invalid/missing values", () => {
    expect(brandCssVars(null)["--pv-brand"]).toBe(BRAND_COLOR_FALLBACK);
    expect(brandCssVars("")["--pv-brand"]).toBe(BRAND_COLOR_FALLBACK);
    expect(brandCssVars("hsl(0, 0%, 0%)")["--pv-brand"]).toBe(BRAND_COLOR_FALLBACK);
    expect(brandCssVars("injected; color: red")["--pv-brand"]).toBe(BRAND_COLOR_FALLBACK);
  });

  it("always derives the soft tint from the final (safe) brand value", () => {
    const vars = brandCssVars("invalid!");
    expect(vars["--pv-brand-soft"]).toBe(`${BRAND_COLOR_FALLBACK}14`);
  });
});
