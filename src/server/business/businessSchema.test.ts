import { describe, it, expect } from "vitest";
import { ValidationError } from "@/server/errors";
import {
  businessInvoiceSettingsSchema,
  createBusinessSchema,
  parseCreateBusinessInput,
  parseUpdateBusinessSettingsInput,
  updateBusinessSettingsSchema,
} from "./schema";

/**
 * Validation tests for the Business profile / settings Zod contracts.
 *
 * These prove the *server-side* rules the settings form relies on: strict
 * payloads (server-owned and storage-owned fields rejected), Iranian-specific
 * formats (mobile / landline / card / IBAN) with Persian-digit
 * normalization, hex colors, email, decimal-string VAT and the invoice
 * settings subset that must never include `nextInvoiceNumber`.
 */

describe("createBusinessSchema", () => {
  it("accepts a bare name-only payload (backwards compatible)", () => {
    const parsed = createBusinessSchema.parse({ name: "  کسب‌وکار من  " });
    expect(parsed.name).toBe("کسب‌وکار من");
  });

  it("accepts every BusinessProfile column with normalization", () => {
    const parsed = createBusinessSchema.parse({
      name: "فروشگاه نمونه",
      slogan: "کیفیت و اعتماد",
      ownerName: "علی رضایی",
      address: "تهران، خیابان ولیعصر",
      email: " INFO@Example.COM ",
      mobile: "۰۹۱۲۳۴۵۶۷۸۹", // Persian digits
      landline: "02188667799",
      cardNumber: "۶۱۰۴۳۳۷۸۱۲۳۴۵۶۷۸", // Persian digits, 16
      accountNumber: "0123456789",
      iban: "ir017000000001234567890123", // lowercase prefix, 24-digit body
      primaryColor: "  #1E64FF  ",
      footerText: "با تشکر از خرید شما",
    });
    expect(parsed.email).toBe("INFO@Example.COM");
    expect(parsed.mobile).toBe("09123456789");
    expect(parsed.cardNumber).toBe("6104337812345678");
    expect(parsed.primaryColor).toBe("#1e64ff");
  });

  it("normalizes empty strings to null (not set)", () => {
    const parsed = createBusinessSchema.parse({
      name: "کسب‌وکار",
      slogan: "   ",
      email: "",
      mobile: "",
      iban: "",
      primaryColor: "",
    });
    expect(parsed.slogan).toBeNull();
    expect(parsed.email).toBeNull();
    expect(parsed.mobile).toBeNull();
    expect(parsed.iban).toBeNull();
    expect(parsed.primaryColor).toBeNull();
  });

  it.each([
    ["accountId", { name: "x", accountId: "acc-other" }],
    ["id", { name: "x", id: "biz-other" }],
    ["isPrimary", { name: "x", isPrimary: true }],
    ["isLocked", { name: "x", isLocked: false }],
    ["archivedAt", { name: "x", archivedAt: null }],
    ["logoFileId (storage-owned)", { name: "x", logoFileId: "file-1" }],
    ["sellerStampFileId (storage-owned)", { name: "x", sellerStampFileId: "file-1" }],
    ["sellerSignatureFileId (storage-owned)", { name: "x", sellerSignatureFileId: "file-1" }],
    ["unknown key", { name: "x", nope: 1 }],
  ])("rejects a create payload containing %s", (_label, payload) => {
    expect(() => parseCreateBusinessInput(payload)).toThrow(ValidationError);
  });

  it("rejects invalid profile values with field-scoped messages", () => {
    expect(() => parseCreateBusinessInput({ name: "x", email: "not-an-email" })).toThrow(
      /email/,
    );
    expect(() => parseCreateBusinessInput({ name: "x", mobile: "12345" })).toThrow(/mobile/);
    expect(() => parseCreateBusinessInput({ name: "x", mobile: "0912345678" })).toThrow(
      /mobile/,
    );
    expect(() => parseCreateBusinessInput({ name: "x", landline: "911" })).toThrow(/landline/);
    expect(() => parseCreateBusinessInput({ name: "x", cardNumber: "6104" })).toThrow(
      /cardNumber/,
    );
    expect(() => parseCreateBusinessInput({ name: "x", accountNumber: "12" })).toThrow(
      /accountNumber/,
    );
    expect(() => parseCreateBusinessInput({ name: "x", iban: "IR123" })).toThrow(/iban/);
    expect(() => parseCreateBusinessInput({ name: "x", primaryColor: "blue" })).toThrow(
      /primaryColor/,
    );
    expect(() => parseCreateBusinessInput({ name: "x", primaryColor: "#12345" })).toThrow(
      /primaryColor/,
    );
    expect(() => parseCreateBusinessInput({ name: "x", slogan: "x".repeat(201) })).toThrow(
      /slogan/,
    );
  });

  it("accepts a 24-digit IBAN body without the IR prefix and normalizes it", () => {
    const parsed = createBusinessSchema.parse({
      name: "x",
      iban: "017000000001234567890123",
    });
    expect(parsed.iban).toBe("IR017000000001234567890123");
  });
});

describe("updateBusinessSettingsSchema", () => {
  it("requires the business name and accepts the full profile + invoice settings", () => {
    const parsed = updateBusinessSettingsSchema.parse({
      name: "نام جدید",
      slogan: null,
      invoiceSettings: {
        defaultVatPercent: "۹", // Persian digits
        currency: "irr",
        calendar: "GREGORIAN",
        invoicePrefix: "1405-",
      },
    });
    expect(parsed.name).toBe("نام جدید");
    expect(parsed.slogan).toBeNull();
    expect(parsed.invoiceSettings?.defaultVatPercent).toBe("9");
    expect(parsed.invoiceSettings?.currency).toBe("IRR");
    expect(parsed.invoiceSettings?.calendar).toBe("GREGORIAN");
    expect(parsed.invoiceSettings?.invoicePrefix).toBe("1405-");
  });

  it("rejects a missing name", () => {
    expect(() =>
      parseUpdateBusinessSettingsInput({ slogan: "بدون نام" } as unknown as Record<string, unknown>),
    ).toThrow(ValidationError);
  });

  it("rejects nextInvoiceNumber and defaultTemplate (numbering is server-owned)", () => {
    expect(() =>
      parseUpdateBusinessSettingsInput({
        name: "x",
        invoiceSettings: { nextInvoiceNumber: 99 },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseUpdateBusinessSettingsInput({
        name: "x",
        invoiceSettings: { defaultTemplate: "fancy" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an out-of-range or malformed VAT percent", () => {
    expect(() =>
      parseUpdateBusinessSettingsInput({
        name: "x",
        invoiceSettings: { defaultVatPercent: "101" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseUpdateBusinessSettingsInput({
        name: "x",
        invoiceSettings: { defaultVatPercent: "-5" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseUpdateBusinessSettingsInput({
        name: "x",
        invoiceSettings: { defaultVatPercent: "abc" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a bad currency code and invoice prefix", () => {
    expect(() =>
      parseUpdateBusinessSettingsInput({ name: "x", invoiceSettings: { currency: "RIAL" } }),
    ).toThrow(ValidationError);
    expect(() =>
      parseUpdateBusinessSettingsInput({ name: "x", invoiceSettings: { invoicePrefix: "a b" } }),
    ).toThrow(ValidationError);
  });

  it("normalizes an empty invoice prefix to null (clears the prefix)", () => {
    const parsed = updateBusinessSettingsSchema.parse({
      name: "x",
      invoiceSettings: { invoicePrefix: "  " },
    });
    expect(parsed.invoiceSettings?.invoicePrefix).toBeNull();
  });
});

describe("businessInvoiceSettingsSchema", () => {
  it("accepts the empty object (settings untouched)", () => {
    expect(businessInvoiceSettingsSchema.parse({})).toEqual({});
  });
});
