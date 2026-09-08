import { describe, it, expect } from "vitest";
import type { ProductDTO } from "@/server/actions/dto";
import {
  filterProducts,
  productInitial,
  productStatusLabel,
  sortProducts,
} from "./productListUtils";

/**
 * Pure list helpers behind the product/service management UI (ordering +
 * instant search). These never decide *which* rows are visible — that stays
 * with the ownership-checked service (`listProducts` already excludes
 * archived rows) — they only order/filter the authorized set, so they are
 * covered here as fast unit tests.
 */
function product(overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: "prod-1",
    businessId: "biz-1",
    name: "محصول یک",
    description: null,
    price: "100000.00",
    unit: null,
    active: true,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("sortProducts", () => {
  it("orders by name with id as a stable tie-breaker and never mutates the input", () => {
    const input = [
      product({ id: "prod-b", name: "ب" }),
      product({ id: "prod-2", name: "الف" }),
      product({ id: "prod-1", name: "الف" }),
    ];
    const snapshot = [...input];

    const sorted = sortProducts(input);

    expect(sorted.map((row) => row.id)).toEqual(["prod-1", "prod-2", "prod-b"]);
    expect(input).toEqual(snapshot);
  });
});

describe("productStatusLabel", () => {
  it("maps the active flag to Persian labels", () => {
    expect(productStatusLabel(true)).toBe("فعال");
    expect(productStatusLabel(false)).toBe("غیرفعال");
  });
});

describe("filterProducts", () => {
  const rows = [
    product({
      id: "prod-1",
      name: "خدمات طراحی وب‌سایت",
      description: "طراحی سایت شرکتی با وردپرس",
      price: "5000000.00",
      unit: "ساعت",
      active: true,
    }),
    product({
      id: "prod-2",
      name: "لپ‌تاپ ایسوس VivoBook",
      description: null,
      price: "450000000.00",
      unit: "عدد",
      active: false,
    }),
    product({
      id: "prod-3",
      name: "پشتیبانی سالانه",
      description: "قرارداد پشتیبانی نرم‌افزار",
      price: "1500.50",
      unit: null,
      active: true,
    }),
  ];

  it("returns a copy of the whole list for an empty or whitespace query", () => {
    expect(filterProducts(rows, "")).toEqual(rows);
    expect(filterProducts(rows, "   ")).toEqual(rows);
    expect(filterProducts(rows, "")).not.toBe(rows);
  });

  it("matches the name case-insensitively as a substring", () => {
    expect(filterProducts(rows, "طراحی").map((row) => row.id)).toEqual(["prod-1"]);
    expect(filterProducts(rows, "vivobook").map((row) => row.id)).toEqual(["prod-2"]);
    expect(filterProducts(rows, "پشتیبانی").map((row) => row.id)).toEqual(["prod-3"]);
  });

  it("matches the description and unit columns", () => {
    expect(filterProducts(rows, "وردپرس").map((row) => row.id)).toEqual(["prod-1"]);
    expect(filterProducts(rows, "ساعت").map((row) => row.id)).toEqual(["prod-1"]);
    expect(filterProducts(rows, "عدد").map((row) => row.id)).toEqual(["prod-2"]);
  });

  it("matches the raw stored price string (substring semantics, like every other column)", () => {
    // "450000000.00" legitimately contains "5000000" — search is a substring
    // match, not an equality check, on every column including the price.
    expect(filterProducts(rows, "5000000").map((row) => row.id)).toEqual(["prod-1", "prod-2"]);
    expect(filterProducts(rows, "1500.50").map((row) => row.id)).toEqual(["prod-3"]);
    expect(filterProducts(rows, "450000000").map((row) => row.id)).toEqual(["prod-2"]);
  });

  it("matches the grouped display price (Latin or Persian digits, any separator)", () => {
    expect(filterProducts(rows, "5,000,000").map((row) => row.id)).toEqual(["prod-1"]);
    expect(filterProducts(rows, "۵,۰۰۰,۰۰۰").map((row) => row.id)).toEqual(["prod-1"]);
    expect(filterProducts(rows, "۴۵۰٬۰۰۰٬۰۰۰").map((row) => row.id)).toEqual(["prod-2"]);
  });

  it("folds Persian/Arabic digits in the query for name and price matches alike", () => {
    expect(filterProducts(rows, "۱۵۰۰").map((row) => row.id)).toEqual(["prod-3"]);
    expect(filterProducts(rows, "٤٥٠٠٠٠٠٠٠").map((row) => row.id)).toEqual(["prod-2"]);
  });

  it("matches the visible status label", () => {
    expect(filterProducts(rows, "غیرفعال").map((row) => row.id)).toEqual(["prod-2"]);
    // "فعال" is a substring of "غیرفعال" — both statuses legitimately match.
    expect(filterProducts(rows, "فعال").map((row) => row.id)).toEqual([
      "prod-1",
      "prod-2",
      "prod-3",
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterProducts(rows, "ناموجود")).toEqual([]);
  });
});

describe("productInitial", () => {
  it("takes the first letter of the trimmed name, falling back to «ک»", () => {
    expect(productInitial("لپ‌تاپ")).toBe("ل");
    expect(productInitial("  خدمات  ")).toBe("خ");
    expect(productInitial("")).toBe("ک");
    expect(productInitial("   ")).toBe("ک");
  });
});
