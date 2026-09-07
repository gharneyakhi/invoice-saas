import { z } from "zod";
import type { Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { normalizeLocalizedNumber } from "@/lib/formatters";

/**
 * Client-side validation for the invoice editor (UX feedback only).
 *
 * Mirrors the *rules* of the authoritative server schemas in
 * `src/server/invoice/schema.ts` so obvious mistakes are caught in the
 * browser with Persian, field-level messages — but it is NOT a second source
 * of truth: every value is re-validated and all money is recalculated
 * server-side before anything is persisted.
 *
 * Numeric fields stay stringly-typed inside the form (so the user can type
 * Persian digits or thousands separators); the preprocessors below normalize
 * them via `normalizeLocalizedNumber` into canonical ASCII decimal strings,
 * which are posted to the Server Action as exact decimal strings (never JS
 * floats).
 */

/** Raw field values as held by the form (all user-editable inputs). */
export interface InvoiceEditorItemFields {
  productId: string;
  title: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
}

export interface InvoiceEditorFields {
  invoiceType: "PROFORMA" | "FINAL";
  issueDate: string;
  dueDate: string;
  customerId: string;
  notes: string;
  globalDiscountPercent: string;
  taxPercent: string;
  items: InvoiceEditorItemFields[];
}

const required = (label: string) => `${label} الزامی است`;
const invalid = (label: string) => `${label} نامعتبر است`;

/**
 * A required non-negative decimal input. Normalizes localized digits first;
 * rejects anything that is not a plain non-negative decimal string.
 */
const moneyField = (label: string) =>
  z.preprocess(
    (value) => (typeof value === "string" || typeof value === "number" ? normalizeLocalizedNumber(value) : value),
    z
      .string({ required_error: required(label), invalid_type_error: invalid(label) })
      .regex(/^\d+(\.\d+)?$/, `${label} باید یک عدد نامنفی باشد`),
  );

/** A required decimal input that must be strictly greater than zero. */
const positiveField = (label: string) =>
  moneyField(label).refine((value) => Number(value) > 0, `${label} باید بزرگ‌تر از صفر باشد`);

/** A required percent input in the inclusive range 0–100. */
const percentField = (label: string) =>
  moneyField(label).refine((value) => Number(value) <= 100, `${label} باید بین ۰ تا ۱۰۰ باشد`);

const editorItemSchema = z.object({
  productId: z.string().optional().default(""),
  title: z
    .string({ required_error: "عنوان قلم الزامی است", invalid_type_error: "عنوان قلم نامعتبر است" })
    .trim()
    .min(1, "عنوان قلم الزامی است")
    .max(300, "عنوان قلم حداکثر ۳۰۰ کاراکتر است"),
  description: z
    .string()
    .trim()
    .max(1000, "توضیحات قلم حداکثر ۱۰۰۰ کاراکتر است")
    .optional()
    .default(""),
  unit: z.string().trim().max(50, "واحد حداکثر ۵۰ کاراکتر است").optional().default(""),
  quantity: positiveField("تعداد"),
  unitPrice: moneyField("قیمت واحد"),
  discountPercent: percentField("تخفیف قلم"),
});

export const invoiceEditorSchema = z.object({
  invoiceType: z.enum(["PROFORMA", "FINAL"], {
    errorMap: () => ({ message: "نوع فاکتور نامعتبر است" }),
  }),
  issueDate: z
    .string({ required_error: "تاریخ صدور الزامی است" })
    .min(1, "تاریخ صدور الزامی است")
    .refine((value) => !isNaN(Date.parse(value)), "تاریخ صدور نامعتبر است"),
  dueDate: z
    .string()
    .optional()
    .default("")
    .refine((value) => value === "" || !isNaN(Date.parse(value)), "تاریخ سررسید نامعتبر است"),
  customerId: z.string().optional().default(""),
  notes: z.string().trim().max(2000, "یادداشت حداکثر ۲۰۰۰ کاراکتر است").optional().default(""),
  globalDiscountPercent: percentField("تخفیف کلی"),
  taxPercent: percentField("مالیات بر ارزش افزوده"),
  items: z.array(editorItemSchema).min(1, "حداقل یک قلم برای فاکتور لازم است"),
});

/**
 * Ready-to-use React Hook Form resolver.
 *
 * `z.preprocess` makes Zod infer the numeric fields' *input* as `unknown`
 * while the form keeps them as plain strings; the (already validated) schema
 * output equals `InvoiceEditorFields`. The single cast bridges that phantom
 * typing gap — no runtime effect.
 */
export const invoiceEditorResolver = zodResolver(
  invoiceEditorSchema,
) as unknown as Resolver<InvoiceEditorFields, undefined, InvoiceEditorFields>;
