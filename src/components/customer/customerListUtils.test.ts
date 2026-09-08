import { describe, it, expect } from "vitest";
import type { CustomerDTO } from "@/server/actions/dto";
import {
  customerInitial,
  filterCustomers,
  normalizeSearchText,
  sortCustomers,
} from "./customerListUtils";

/**
 * Pure list helpers behind the customer management UI (ordering + instant
 * search). These never decide *which* rows are visible — that stays with
 * the ownership-checked service — they only order/filter the authorized
 * set, so they are covered here as fast unit tests.
 */
function customer(overrides: Partial<CustomerDTO> = {}): CustomerDTO {
  return {
    id: "cus-1",
    businessId: "biz-1",
    name: "مشتری یک",
    mobile: null,
    phone: null,
    email: null,
    address: null,
    nationalId: null,
    economicCode: null,
    notes: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("normalizeSearchText", () => {
  it("trims, lowercases and folds Persian/Arabic digits to Latin", () => {
    expect(normalizeSearchText("  TeHRaN ")).toBe("tehran");
    expect(normalizeSearchText("۰۹۱۲۳۴۵۶۷۸۹")).toBe("09123456789");
    expect(normalizeSearchText("٠٩١٢")).toBe("0912");
    expect(normalizeSearchText(null)).toBe("");
    expect(normalizeSearchText(undefined)).toBe("");
    expect(normalizeSearchText("   ")).toBe("");
  });
});

describe("sortCustomers", () => {
  it("orders by name with id as a stable tie-breaker and never mutates the input", () => {
    const input = [
      customer({ id: "cus-b", name: "ب" }),
      customer({ id: "cus-2", name: "الف" }),
      customer({ id: "cus-1", name: "الف" }),
    ];
    const snapshot = [...input];

    const sorted = sortCustomers(input);

    expect(sorted.map((row) => row.id)).toEqual(["cus-1", "cus-2", "cus-b"]);
    expect(input).toEqual(snapshot);
  });
});

describe("filterCustomers", () => {
  const rows = [
    customer({
      id: "cus-1",
      name: "علی رضایی",
      mobile: "09121234567",
      email: "ali@example.com",
    }),
    customer({
      id: "cus-2",
      name: "شرکت نمونه",
      phone: "02112345678",
      address: "تهران، خیابان ولیعصر",
      nationalId: "0012345678",
      economicCode: "411123456789",
      notes: "قرارداد سالانه",
    }),
  ];

  it("returns the whole list (copied) for an empty or whitespace query", () => {
    for (const query of ["", "   "]) {
      const result = filterCustomers(rows, query);
      expect(result).toEqual(rows);
      expect(result).not.toBe(rows);
    }
  });

  it("matches a substring of the name", () => {
    expect(filterCustomers(rows, "رضایی").map((row) => row.id)).toEqual(["cus-1"]);
    expect(filterCustomers(rows, "شرکت").map((row) => row.id)).toEqual(["cus-2"]);
  });

  it("matches contact columns: mobile, phone and email", () => {
    expect(filterCustomers(rows, "0912123").map((row) => row.id)).toEqual(["cus-1"]);
    expect(filterCustomers(rows, "0211234").map((row) => row.id)).toEqual(["cus-2"]);
    expect(filterCustomers(rows, "ALI@EXAMPLE.COM").map((row) => row.id)).toEqual(["cus-1"]);
  });

  it("matches identity, address and notes columns", () => {
    expect(filterCustomers(rows, "0012345678").map((row) => row.id)).toEqual(["cus-2"]);
    expect(filterCustomers(rows, "4111234").map((row) => row.id)).toEqual(["cus-2"]);
    expect(filterCustomers(rows, "ولیعصر").map((row) => row.id)).toEqual(["cus-2"]);
    expect(filterCustomers(rows, "سالانه").map((row) => row.id)).toEqual(["cus-2"]);
  });

  it("matches across digit scripts (query and stored value may differ)", () => {
    // Stored Latin, queried Persian.
    expect(filterCustomers(rows, "۰۹۱۲۱۲۳").map((row) => row.id)).toEqual(["cus-1"]);
    // Stored Persian, queried Latin.
    const persianStored = [customer({ id: "cus-3", name: "تست", mobile: "۰۹۱۹۰۰۰۰۰۰۰" })];
    expect(filterCustomers(persianStored, "0919").map((row) => row.id)).toEqual(["cus-3"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterCustomers(rows, "ناموجود-xyz")).toEqual([]);
  });
});

describe("customerInitial", () => {
  it("returns the first letter of the trimmed name, or a fallback", () => {
    expect(customerInitial("علی")).toBe("ع");
    expect(customerInitial("  شرکت نمونه ")).toBe("ش");
    expect(customerInitial("")).toBe("م");
    expect(customerInitial("   ")).toBe("م");
  });
});
