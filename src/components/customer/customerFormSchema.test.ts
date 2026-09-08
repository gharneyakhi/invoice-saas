import { describe, it, expect } from "vitest";
import {
  customerFormSchema,
  customerToFormValues,
  emptyCustomerFormValues,
  toCreateCustomerPayload,
  toUpdateCustomerPayload,
} from "./customerFormSchema";

/**
 * Client form validation for customer create/edit.
 *
 * These tests pin the browser-side contract to the authoritative server
 * rules in `src/server/customer/schema.ts`: the same required name, the
 * same max lengths (200 / 50 / 320 / 500 / 2000) and the same email rule.
 * The browser must neither accept what the server rejects nor reject what
 * the server accepts (in particular: no stricter phone/mobile format).
 */
describe("customerFormSchema", () => {
  it("accepts a name-only payload, defaulting every optional field to an empty string", () => {
    const result = customerFormSchema.safeParse({ name: "مشتری تازه" });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      name: "مشتری تازه",
      mobile: "",
      phone: "",
      email: "",
      address: "",
      nationalId: "",
      economicCode: "",
      notes: "",
    });
  });

  it("accepts a fully populated, valid payload", () => {
    const result = customerFormSchema.safeParse({
      name: "شرکت نمونه",
      mobile: "09121234567",
      phone: "02112345678",
      email: "buyer@example.com",
      address: "تهران، خیابان نمونه",
      nationalId: "0012345678",
      economicCode: "123456789012",
      notes: "مشتری خوش‌حساب",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a missing, empty or whitespace-only name with a Persian message", () => {
    for (const name of [undefined, "", "   "]) {
      const result = customerFormSchema.safeParse({ name });
      expect(result.success).toBe(false);
      if (result.success) continue;
      const message = result.error.issues.find((issue) => issue.path[0] === "name")?.message;
      expect(message).toBe("نام مشتری الزامی است");
    }
  });

  it.each([
    ["name", "نام مشتری", 200],
    ["mobile", "موبایل", 50],
    ["phone", "تلفن ثابت", 50],
    ["address", "آدرس", 500],
    ["nationalId", "کد ملی", 50],
    ["economicCode", "کد اقتصادی", 50],
    ["notes", "یادداشت", 2000],
  ] as const)(
    "enforces the server max length on %s (%s characters)",
    (field, _label, max) => {
      const atLimit = customerFormSchema.safeParse({ name: "x", [field]: "ا".repeat(max) });
      expect(atLimit.success).toBe(true);

      const overLimit = customerFormSchema.safeParse({ name: "x", [field]: "ا".repeat(max + 1) });
      expect(overLimit.success).toBe(false);
    },
  );

  it("accepts an empty email but rejects a malformed one", () => {
    expect(customerFormSchema.safeParse({ name: "x", email: "" }).success).toBe(true);
    expect(customerFormSchema.safeParse({ name: "x", email: "buyer@example.com" }).success).toBe(
      true,
    );

    const bad = customerFormSchema.safeParse({ name: "x", email: "not-an-email" });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.message).toBe("ایمیل وارد شده معتبر نیست");
    }
  });

  it("rejects an overlong email (server caps at 320 characters)", () => {
    const longLocal = "a".repeat(310);
    const result = customerFormSchema.safeParse({ name: "x", email: `${longLocal}@example.com` });
    expect(result.success).toBe(false);
  });

  it("stays lenient where the server is lenient: no stricter mobile/phone format", () => {
    // `customerService` only length-caps these columns; the browser must not
    // block values the server accepts (foreign numbers, extensions, ...).
    const result = customerFormSchema.safeParse({
      name: "x",
      mobile: "+49 170 123456",
      phone: "021-12345678 ext 12",
      nationalId: "ABC-123",
    });
    expect(result.success).toBe(true);
  });

  it("trims values so padded input validates and submits cleanly", () => {
    const result = customerFormSchema.safeParse({
      name: "  مشتری  ",
      email: "  buyer@example.com  ",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("مشتری");
    expect(result.data.email).toBe("buyer@example.com");
  });
});

describe("customer form value helpers", () => {
  it("maps a DTO onto form values, converting nulls to empty strings", () => {
    expect(
      customerToFormValues({
        id: "cus-1",
        businessId: "biz-1",
        name: "مشتری",
        mobile: "09120000000",
        phone: null,
        email: null,
        address: "تهران",
        nationalId: null,
        economicCode: null,
        notes: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        archivedAt: null,
      }),
    ).toEqual({
      name: "مشتری",
      mobile: "09120000000",
      phone: "",
      email: "",
      address: "تهران",
      nationalId: "",
      economicCode: "",
      notes: "",
    });
  });

  it("builds create/update payloads from the writable columns only", () => {
    const values = {
      ...emptyCustomerFormValues(),
      name: "مشتری",
      mobile: "09120000000",
    };

    const createPayload = toCreateCustomerPayload(values);
    expect(createPayload).toEqual({
      name: "مشتری",
      mobile: "09120000000",
      phone: "",
      email: "",
      address: "",
      nationalId: "",
      economicCode: "",
      notes: "",
    });
    // No server-owned column may ever leak into a payload.
    for (const forbidden of ["id", "businessId", "accountId", "createdAt", "updatedAt", "archivedAt"]) {
      expect(createPayload).not.toHaveProperty(forbidden);
    }

    // Update sends the same full column set so clearing a field in the form
    // clears it in the database ("" → null server-side).
    expect(toUpdateCustomerPayload(values)).toEqual(createPayload);
  });
});
