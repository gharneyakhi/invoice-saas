import { z } from "zod";
import type { Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { normalizeLocalizedNumber } from "@/lib/formatters";

/**
 * Client-side validation for the business settings form (UX feedback only).
 *
 * Mirrors the *rules* of the authoritative server schemas in
 * `src/server/business/schema.ts` so obvious mistakes are caught in the
 * browser with Persian, field-level messages — but it is NOT a second source
 * of truth: every value is re-validated server-side by
 * `businessService.updateBusinessSettings` / `createBusiness` before anything
 * is persisted.
 *
 * Numeric/identifier fields stay stringly-typed inside the form (users may
 * type Persian digits); the preprocessors normalize them via
 * `normalizeLocalizedNumber` exactly like the server does.
 */

export interface BusinessSettingsFormFields {
  name: string;
  slogan: string;
  ownerName: string;
  address: string;
  email: string;
  mobile: string;
  landline: string;
  cardNumber: string;
  accountNumber: string;
  iban: string;
  primaryColor: string;
  footerBackgroundColor: string;
  footerText: string;
  defaultVatPercent: string;
  currency: string;
  calendar: "JALALI" | "GREGORIAN";
  invoicePrefix: string;
}

const required = (label: string) => `${label} الزامی است`;
const invalid = (label: string) => `${label} نامعتبر است`;

/** Required business/display name. */
const nameField = z
  .string({ required_error: required("نام کسب‌وکار"), invalid_type_error: invalid("نام کسب‌وکار") })
  .trim()
  .min(1, required("نام کسب‌وکار"))
  .max(120, "نام کسب‌وکار حداکثر ۱۲۰ کاراکتر است");

/** Optional trimmed text; empty becomes null-equivalent ("" in the form). */
const optionalText = (label: string, max: number) =>
  z
    .string({ invalid_type_error: invalid(label) })
    .trim()
    .max(max, `${label} حداکثر ${max} کاراکتر است`)
    .optional()
    .default("");

const emailField = z
  .string()
  .trim()
  .max(320, "ایمیل حداکثر ۳۲۰ کاراکتر است")
  .refine((value) => value === "" || z.string().email().safeParse(value).success, {
    message: "ایمیل وارد شده معتبر نیست",
  })
  .optional()
  .default("");

/** Optional digits-only field with Persian-digit normalization. */
const digitsField = (label: string, pattern: RegExp, message: string) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      if (trimmed === "") return "";
      const normalized = normalizeLocalizedNumber(trimmed);
      return normalized === "" ? trimmed : normalized;
    },
    z
      .string({ invalid_type_error: invalid(label) })
      .refine((value) => value === "" || pattern.test(value), { message })
      .optional()
      .default(""),
  );

const mobileField = digitsField(
  "موبایل",
  /^09\d{9}$/,
  "موبایل باید با ۰۹ شروع شده و ۱۱ رقم باشد",
);

const landlineField = digitsField(
  "تلفن ثابت",
  /^0\d{9,10}$/,
  "تلفن ثابت باید با کد شهر شروع شود (مثال: ۰۲۱۱۲۳۴۵۶۷۸)",
);

const cardNumberField = digitsField(
  "شماره کارت",
  /^\d{16}$/,
  "شماره کارت باید دقیقاً ۱۶ رقم باشد",
);

const accountNumberField = digitsField(
  "شماره حساب",
  /^\d{4,24}$/,
  "شماره حساب باید بین ۴ تا ۲۴ رقم باشد",
);

const ibanField = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed === "") return "";
    const upper = trimmed.toUpperCase();
    const body = upper.startsWith("IR") ? upper.slice(2) : upper;
    const digits = normalizeLocalizedNumber(body);
    return digits === "" ? upper : `IR${digits}`;
  },
  z
    .string({ invalid_type_error: invalid("شماره شبا") })
    .refine((value) => value === "" || /^IR\d{24}$/.test(value), {
      message: "شماره شبا باید «IR» به‌همراه ۲۴ رقم باشد",
    })
    .optional()
    .default(""),
);

const hexColorField = (label: string) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z
      .string({ invalid_type_error: invalid(label) })
      .refine((value) => value === "" || /^#[0-9a-f]{6}$/.test(value), {
        message: `${label} باید کد هگز معتبر باشد (مثال: #2563eb)`,
      })
      .optional()
      .default(""),
  );

const primaryColorField = hexColorField("رنگ سازمانی");
const footerBackgroundColorField = hexColorField("رنگ پس‌زمینه پاورقی");

const vatPercentField = z.preprocess(
  (value) => {
    if (typeof value !== "string" && typeof value !== "number") return value;
    const normalized = normalizeLocalizedNumber(value);
    return normalized === "" ? String(value) : normalized;
  },
  z
    .string({ required_error: required("درصد مالیات"), invalid_type_error: invalid("درصد مالیات") })
    .refine((value) => /^\d+(\.\d{1,2})?$/.test(value) && Number(value) >= 0 && Number(value) <= 100, {
      message: "درصد مالیات باید عددی بین ۰ تا ۱۰۰ باشد",
    })
    .optional()
    .default("0"),
);

const currencyField = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z
    .string({ required_error: required("واحد پول"), invalid_type_error: invalid("واحد پول") })
    .refine((value) => value === "IRR" || value === "IRT", {
      message: "واحد پول باید ریال یا تومان باشد",
    })
    .optional()
    .default("IRR"),
);

const invoicePrefixField = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z
    .string()
    .refine((value) => value === "" || /^[\w-]{1,20}$/.test(value), {
      message: "پیشوند شماره فقط می‌تواند حرف، رقم، خط تیره یا آندرلاین باشد (حداکثر ۲۰ کاراکتر)",
    })
    .optional()
    .default(""),
);

export const businessSettingsFormSchema = z.object({
  name: nameField,
  slogan: optionalText("شعار", 200),
  ownerName: optionalText("نام مالک", 120),
  address: optionalText("آدرس", 500),
  email: emailField,
  mobile: mobileField,
  landline: landlineField,
  cardNumber: cardNumberField,
  accountNumber: accountNumberField,
  iban: ibanField,
  primaryColor: primaryColorField,
  footerBackgroundColor: footerBackgroundColorField,
  footerText: optionalText("متن پاورقی فاکتور", 500),
  defaultVatPercent: vatPercentField,
  currency: currencyField,
  calendar: z.enum(["JALALI", "GREGORIAN"], {
    errorMap: () => ({ message: "تقویم انتخاب‌شده نامعتبر است" }),
  }),
  invoicePrefix: invoicePrefixField,
});

/**
 * Ready-to-use React Hook Form resolver. `z.preprocess` makes Zod infer the
 * normalized fields' input as `unknown`; the single cast bridges that phantom
 * typing gap — no runtime effect (same pattern as `invoiceEditorResolver`).
 */
export const businessSettingsFormResolver = zodResolver(
  businessSettingsFormSchema,
) as unknown as Resolver<BusinessSettingsFormFields, undefined, BusinessSettingsFormFields>;
