import type { ProductDTO } from "@/server/actions/dto";
import { formatPersianNumber } from "@/lib/formatters";
// Reuse of the customer module's pure search normalizer (trim, lowercase,
// Persian/Arabic digit folding) rather than a duplicate copy; the customer
// module itself stays untouched.
import { normalizeSearchText } from "@/components/customer/customerListUtils";

/**
 * Pure list helpers for the product/service management UI.
 *
 * The server (`productService.listProducts`) is the only thing that decides
 * *which* products the caller may see — already ownership-checked and with
 * archived rows excluded. These helpers only order and filter that
 * authorized set in the browser so search stays instant and create/update/
 * archive can update the list without a full page reload. They are pure and
 * UI-free on purpose, so they are unit-testable in the Node test
 * environment (see `productListUtils.test.ts`).
 */

/** Persian labels of the `active` flag, also used as searchable status text. */
export const PRODUCT_STATUS_LABELS = { active: "فعال", inactive: "غیرفعال" } as const;

export function productStatusLabel(active: boolean): string {
  return active ? PRODUCT_STATUS_LABELS.active : PRODUCT_STATUS_LABELS.inactive;
}

/**
 * Stable display order: Persian alphabetical by name, with `id` as the final
 * tie-breaker so two products sharing a name never swap places between
 * renders (mirrors `PRODUCT_LIST_ORDER_BY` in `productService`).
 * Never mutates the input.
 */
export function sortProducts<T extends Pick<ProductDTO, "id" | "name">>(products: readonly T[]): T[] {
  return [...products].sort(
    (a, b) => a.name.localeCompare(b.name, "fa") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Substring search across every user-visible product column: name,
 * description, unit, the status label and the price. The price matches both
 * in its raw stored form ("5000000.00" ⊇ "5000000") and in its grouped
 * display form with either thousands separator (a query of "5,000,000",
 * "۵,۰۰۰,۰۰۰" or "۵٬۰۰۰٬۰۰۰" all match). An empty query returns the whole
 * (copied) list. Matching is case-insensitive and digit-normalized on both
 * sides.
 */
export function filterProducts<T extends ProductDTO>(products: readonly T[], query: string): T[] {
  const needle = normalizeSearchText(query);
  if (needle === "") return [...products];
  return products.filter((product) => {
    // Grouped display form: "5000000.00" → "۵,۰۰۰,۰۰۰" → (normalized) "5,000,000";
    // the Arabic thousands separator `٬` is what Persian keyboards commonly type.
    const groupedPrice = formatPersianNumber(product.price);
    return [
      product.name,
      product.description,
      product.unit,
      productStatusLabel(product.active),
      product.price,
      groupedPrice,
      groupedPrice.replace(/,/g, "٬"),
    ].some((field) => normalizeSearchText(field).includes(needle));
  });
}

/** Avatar fallback: first letter of the trimmed name, or «ک» (کالا) when blank. */
export function productInitial(name: string): string {
  return name.trim().charAt(0) || "ک";
}
