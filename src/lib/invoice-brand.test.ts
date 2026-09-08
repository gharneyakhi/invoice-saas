import { describe, expect, it } from "vitest";
import {
  BRAND_COLOR_FALLBACK,
  FG_ON_DARK,
  FG_ON_LIGHT,
  FOOTER_COLOR_FALLBACK,
  brandCssVars,
  contrastForeground,
  normalizeBrandColor,
} from "./invoice-brand";

describe("normalizeBrandColor", () => {
  it("accepts a lowercase hex and rejects everything else", () => {
    expect(normalizeBrandColor("#0f766e")).toBe("#0f766e");
    expect(normalizeBrandColor("  #0F766E  ")).toBe("#0f766e");
    expect(normalizeBrandColor("blue")).toBeNull();
    expect(normalizeBrandColor("#12345")).toBeNull();
    expect(normalizeBrandColor("url(javascript:alert(1))")).toBeNull();
  });
});

describe("contrastForeground", () => {
  it("picks white on a dark header and near-black on a light one", () => {
    expect(contrastForeground("#0f766e")).toBe(FG_ON_DARK);
    expect(contrastForeground("#111827")).toBe(FG_ON_DARK);
    expect(contrastForeground("#fde68a")).toBe(FG_ON_LIGHT);
    expect(contrastForeground("#ffffff")).toBe(FG_ON_LIGHT);
  });
});

describe("brandCssVars", () => {
  it("maps primaryColor to the HEADER background, not body text", () => {
    const vars = brandCssVars("#0f766e", "#111827");
    expect(vars["--pv-header-bg"]).toBe("#0f766e");
    expect(vars["--pv-header-fg"]).toBe(FG_ON_DARK);
    expect(vars["--pv-brand"]).toBe("#0f766e");
    expect(vars["--pv-footer-bg"]).toBe("#111827");
    expect(vars["--pv-footer-fg"]).toBe(FG_ON_DARK);
  });

  it("falls back to the default header / footer colours when unset", () => {
    const vars = brandCssVars(null, null);
    expect(vars["--pv-header-bg"]).toBe(BRAND_COLOR_FALLBACK);
    expect(vars["--pv-footer-bg"]).toBe(FOOTER_COLOR_FALLBACK);
  });
});
