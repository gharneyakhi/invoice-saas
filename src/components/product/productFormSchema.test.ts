import { describe, it, expect } from "vitest";
import type { ProductDTO } from "@/server/actions/dto";
import {
  productFormSchema,
  productToFormValues,
  emptyProductFormValues,
  toCreateProductPayload,
  toUpdateProductPayload,
} from "./productFormSchema";

/**
 * Client form validation for product/service create/edit.
 *
 * These tests pin the browser-side contract to the authoritative server
 * rules in `src/server/product/schema.ts`: the same required name, the same
 * max lengths (200 / 1000 / 50), a Decimal-safe non-negative price and the
 * writable `active` flag — and to the `Decimal(14,2)` storage capacity of
 * `model Product.price`. The browser must neither accept what the server
 * rejects nor reject what the server accepts (in particular: localized
 * Persian digit/separator input is folded, never blocked).
 */
function dto(overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: "prod-1",
    businessId: "biz-1",
    name: "محصول",
    description: null,
    price: "5000000.00",
    unit: null,
    active: true,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("productFormSchema", () => {
  it("accepts a name+price payload, defaulting description/unit to empty strings and active to true", () => {
    const result = productFormSchema.safeParse({ name: "خدمت پشتیبانی", price: "1500000" });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      name: "خدمت پشتیبانی",
      description: "",
      price: "1500000",
      unit: "",
      active: true,
    });
  });

  it("accepts a fully populated, valid payload", () => {
    const result = productFormSchema.safeParse({
      name: "لپ‌تاپ ایسوس",
      description: "مدل VivoBook — یک سال گارانتی",
      price: "450000000",
      unit: "عدد",
      active: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.active).toBe(false);
  });

  it("rejects a missing, empty or whitespace-only name with a Persian message", () => {
    for (const name of [undefined, "", "   "]) {
      const result = productFormSchema.safeParse({ name, price: "1000" });
      expect(result.success).toBe(false);
      if (result.success) continue;
      const message = result.error.issues.find((issue) => issue.path[0] === "name")?.message;
      expect(message).toBe("نام کالا / خدمت الزامی است");
    }
  });

  it.each([
    ["name", "نام کالا / خدمت", 200],
    ["description", "توضیحات", 1000],
    ["unit", "واحد", 50],
  ] as const)("enforces the server max length on %s (%s characters)", (field, _label, max) => {
    const atLimit = productFormSchema.safeParse({
      name: "x",
      price: "1000",
      [field]: "ا".repeat(max),
    });
    expect(atLimit.success).toBe(true);

    const overLimit = productFormSchema.safeParse({
      name: "x",
      price: "1000",
      [field]: "ا".repeat(max + 1),
    });
    expect(overLimit.success).toBe(false);
  });

  it("rejects a missing or empty price with a Persian message", () => {
    for (const price of [undefined, "", "   "]) {
      const result = productFormSchema.safeParse({ name: "x", price });
      expect(result.success).toBe(false);
      if (result.success) continue;
      const message = result.error.issues.find((issue) => issue.path[0] === "price")?.message;
      expect(message).toBe("قیمت را به عدد معتبر و غیرمنفی وارد کنید (مثال: ۱۵۰۰۰۰۰)");
    }
  });

  it("rejects non-numeric and negative prices (normalizeLocalizedNumber folds both to '')", () => {
    for (const price of ["abc", "-1500", "1.2.3", "۱۲abc", "{}"]) {
      const result = productFormSchema.safeParse({ name: "x", price });
      expect(result.success).toBe(false);
    }
  });

  it("accepts localized Persian/Arabic digits, separators and the Persian decimal separator", () => {
    for (const price of ["۱۵۰۰۰۰۰", "١٥٠٠٠٠٠", "1,500,000", "۱٬۵۰۰٬۰۰۰", "1500.50", "۱۵۰۰٫۵۰", "0"]) {
      const result = productFormSchema.safeParse({ name: "x", price });
      expect(result.success).toBe(true);
    }
  });

  it("accepts decimals beyond 2 places (the server/DB rounds — the browser must not be stricter)", () => {
    const result = productFormSchema.safeParse({ name: "x", price: "1500.999" });
    expect(result.success).toBe(true);
  });

  it("enforces the Decimal(14,2) storage capacity", () => {
    const atLimit = productFormSchema.safeParse({ name: "x", price: "999999999999.99" });
    expect(atLimit.success).toBe(true);

    const overLimit = productFormSchema.safeParse({ name: "x", price: "1000000000000" });
    expect(overLimit.success).toBe(false);
    if (!overLimit.success) {
      const message = overLimit.error.issues.find((issue) => issue.path[0] === "price")?.message;
      expect(message).toBe("قیمت از حداکثر مقدار مجاز بیشتر است");
    }
  });

  it("rejects a non-boolean active flag", () => {
    const result = productFormSchema.safeParse({ name: "x", price: "1000", active: "yes" });
    expect(result.success).toBe(false);
  });

  it("trims values so padded input validates and submits cleanly", () => {
    const result = productFormSchema.safeParse({
      name: "  محصول  ",
      description: "  توضیح  ",
      unit: "  عدد  ",
      price: " 1500000 ",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("محصول");
    expect(result.data.description).toBe("توضیح");
    expect(result.data.unit).toBe("عدد");
  });
});

describe("product form value helpers", () => {
  it("maps a DTO onto form values: nulls to empty strings, stored price to its shortest input form", () => {
    expect(
      productToFormValues(
        dto({ name: "محصول", description: null, price: "5000000.00", unit: null, active: true }),
      ),
    ).toEqual({
      name: "محصول",
      description: "",
      price: "5000000",
      unit: "",
      active: true,
    });

    // Trailing zeros trimmed, real decimals preserved — same seeding the
    // invoice editor's unit-price input uses.
    expect(productToFormValues(dto({ price: "1500.50" })).price).toBe("1500.5");
    expect(productToFormValues(dto({ price: "0.00" })).price).toBe("0");
    expect(productToFormValues(dto({ active: false })).active).toBe(false);
  });

  it("empty form values carry exactly the writable columns", () => {
    expect(emptyProductFormValues()).toEqual({
      name: "",
      description: "",
      price: "",
      unit: "",
      active: true,
    });
  });

  it("builds create/update payloads from the writable columns only, with a normalized price", () => {
    const values: ReturnType<typeof emptyProductFormValues> = {
      name: "خدمات طراحی",
      description: "طراحی سایت شرکتی",
      price: "۱٬۵۰۰٬۰۰۰",
      unit: "ساعت",
      active: true,
    };

    const createPayload = toCreateProductPayload(values);
    expect(createPayload).toEqual({
      name: "خدمات طراحی",
      description: "طراحی سایت شرکتی",
      price: "1500000",
      unit: "ساعت",
      active: true,
    });
    // The server schema is `.strict()` — no server-owned column may ever
    // leak into a payload, or the action rejects it.
    for (const forbidden of [
      "id",
      "businessId",
      "accountId",
      "createdAt",
      "updatedAt",
      "archivedAt",
    ]) {
      expect(createPayload).not.toHaveProperty(forbidden);
    }

    // Update sends the same full column set so clearing a field in the form
    // clears it in the database ("" → null server-side).
    expect(toUpdateProductPayload(values)).toEqual(createPayload);
  });

  it("payload price stays a canonical ASCII decimal string for any localized input", () => {
    const base = emptyProductFormValues();
    expect(toCreateProductPayload({ ...base, name: "x", price: "۲۵۰۰۰۰" }).price).toBe("250000");
    expect(toCreateProductPayload({ ...base, name: "x", price: "2,500.75" }).price).toBe("2500.75");
    expect(toCreateProductPayload({ ...base, name: "x", price: "۲٫۵" }).price).toBe("2.5");
  });
});
