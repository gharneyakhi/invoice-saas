import Decimal from "decimal.js";
import { z } from "zod";
import type { Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ProductDTO } from "@/server/actions/dto";
import { normalizeLocalizedNumber, toNumericInputString } from "@/lib/formatters";

/**
 * Client-side validation for the product/service create/edit form (UX
 * feedback only).
 *
 * Mirrors the *rules* of the authoritative server schemas in
 * `src/server/product/schema.ts` — required name with the same max lengths
 * (200 / 1000 / 50), a non-negative Decimal-safe price and a boolean `active`
 * flag — so obvious mistakes are caught in the browser with Persian,
 * field-level messages. It is NOT a second source of truth: every value is
 * re-validated server-side by `productService` before anything is persisted,
 * and the server is deliberately the only place that normalizes (`""` →
 * `null`) and rejects unknown keys (`.strict()`).
 *
 * Price input is a *localized string*: Persian/Arabic digits, thousands
 * separators and the Persian decimal separator are all accepted and folded
 * to a canonical ASCII decimal by `normalizeLocalizedNumber` (the same input
 * utility the invoice editor trusts) before the value travels to the action.
 * The only client-side bound beyond the server's rules is the storage
 * capacity of the `Decimal(14,2)` column — a larger value would be rejected
 * by the database itself, so catching it here is strictly friendlier, never
 * stricter than what the server ultimately accepts.
 */

export interface ProductFormFields {
  name: string;
  description: string;
  price: string;
  unit: string;
  active: boolean;
}

const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 1000;
const UNIT_MAX_LENGTH = 50;

/** Capacity of `Product.price Decimal(14,2)` — 12 integer digits, 2 decimals. */
const PRICE_MAX = new Decimal("999999999999.99");

const PRICE_INVALID_MESSAGE = "قیمت را به عدد معتبر و غیرمنفی وارد کنید (مثال: ۱۵۰۰۰۰۰)";
const PRICE_TOO_LARGE_MESSAGE = "قیمت از حداکثر مقدار مجاز بیشتر است";

const nameField = z
  .string({
    required_error: "نام کالا / خدمت الزامی است",
    invalid_type_error: "نام کالا / خدمت نامعتبر است",
  })
  .trim()
  .min(1, "نام کالا / خدمت الزامی است")
  .max(NAME_MAX_LENGTH, `نام کالا / خدمت حداکثر ${NAME_MAX_LENGTH} کاراکتر است`);

/** Optional trimmed text; empty stays `""` in the form (server maps it to null). */
const optionalText = (label: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${label} نامعتبر است` })
    .trim()
    .max(maxLength, `${label} حداکثر ${maxLength} کاراکتر است`)
    .optional()
    .default("");

/**
 * Localized-number price: required, non-negative, and within the Decimal
 * column's capacity. `normalizeLocalizedNumber` returns `""` for anything
 * that is not a plain non-negative decimal (including negatives and free
 * text), so a single check covers both "missing" and "malformed".
 */
const priceField = z
  .string({
    required_error: PRICE_INVALID_MESSAGE,
    invalid_type_error: PRICE_INVALID_MESSAGE,
  })
  .trim()
  .refine((value) => normalizeLocalizedNumber(value) !== "", PRICE_INVALID_MESSAGE)
  .refine((value) => {
    const normalized = normalizeLocalizedNumber(value);
    if (normalized === "") return false;
    try {
      return new Decimal(normalized).lessThanOrEqualTo(PRICE_MAX);
    } catch {
      return false;
    }
  }, PRICE_TOO_LARGE_MESSAGE);

export const productFormSchema = z.object({
  name: nameField,
  description: optionalText("توضیحات", DESCRIPTION_MAX_LENGTH),
  price: priceField,
  unit: optionalText("واحد", UNIT_MAX_LENGTH),
  active: z.boolean({ invalid_type_error: "وضعیت نامعتبر است" }).default(true),
});

/**
 * Ready-to-use React Hook Form resolver. The `.default(...)` fields make Zod
 * infer the input as optional while the form always carries concrete values;
 * the single cast bridges that phantom typing gap — no runtime effect (same
 * pattern as `customerFormResolver`).
 */
export const productFormResolver = zodResolver(
  productFormSchema,
) as unknown as Resolver<ProductFormFields, undefined, ProductFormFields>;

export function emptyProductFormValues(): ProductFormFields {
  return {
    name: "",
    description: "",
    price: "",
    unit: "",
    active: true,
  };
}

/**
 * Maps a server DTO onto form values (`null` → `""` for controlled inputs;
 * the stored `"5000000.00"` price string → the shortest editable form
 * `"5000000"`, exactly like the invoice editor seeds its unit-price input).
 */
export function productToFormValues(product: ProductDTO): ProductFormFields {
  return {
    name: product.name,
    description: product.description ?? "",
    price: toNumericInputString(product.price),
    unit: product.unit ?? "",
    active: product.active,
  };
}

/**
 * Payload for `createProduct`. Only the client-writable columns of
 * `model Product` — values are already trimmed by the schema, the price is
 * folded to a canonical ASCII decimal string, and the server normalizes
 * `""` to `null` and rejects anything else (`.strict()`).
 */
export function toCreateProductPayload(
  values: ProductFormFields,
): Record<string, string | boolean> {
  return {
    name: values.name,
    description: values.description,
    price: normalizeLocalizedNumber(values.price),
    unit: values.unit,
    active: values.active,
  };
}

/**
 * Payload for `updateProduct`. All writable columns are sent so clearing a
 * field in the form clears it in the database (`""` → `null` server-side);
 * unchanged fields are simply rewritten with the same value.
 */
export function toUpdateProductPayload(
  values: ProductFormFields,
): Record<string, string | boolean> {
  return toCreateProductPayload(values);
}
