import type { CustomerDTO } from "@/server/actions/dto";

/**
 * Pure list helpers for the customer management UI.
 *
 * The server (`customerService.listCustomers`) is the only thing that decides
 * *which* customers the caller may see — already ownership-checked and with
 * archived rows excluded. These helpers only order and filter that
 * authorized set in the browser so search stays instant and create/update/
 * archive can update the list without a full page reload. They are pure and
 * UI-free on purpose, so they are unit-testable in the Node test
 * environment (see `customerListUtils.test.ts`).
 */

/**
 * Normalizes text for search comparison: trims, lowercases, and folds
 * Persian (۰-۹) and Arabic-Indic (٠-٩) digits to Latin digits so a phone
 * number typed on any keyboard matches regardless of how it was stored.
 */
export function normalizeSearchText(value: string | null | undefined): string {
  if (!value) return "";
  let text = value.trim().toLowerCase();
  if (text === "") return "";
  text = text.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
  text = text.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  return text;
}

/**
 * Stable display order: Persian alphabetical by name, with `id` as the final
 * tie-breaker so two customers sharing a name never swap places between
 * renders (mirrors `CUSTOMER_LIST_ORDER_BY` in `customerService`).
 * Never mutates the input.
 */
export function sortCustomers<T extends Pick<CustomerDTO, "id" | "name">>(
  customers: readonly T[],
): T[] {
  return [...customers].sort(
    (a, b) => a.name.localeCompare(b.name, "fa") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Substring search across every user-visible customer column. An empty query
 * returns the whole (copied) list. Matching is case-insensitive and
 * digit-normalized on both sides.
 */
export function filterCustomers<T extends CustomerDTO>(
  customers: readonly T[],
  query: string,
): T[] {
  const needle = normalizeSearchText(query);
  if (needle === "") return [...customers];
  return customers.filter((customer) =>
    [
      customer.name,
      customer.mobile,
      customer.phone,
      customer.email,
      customer.address,
      customer.nationalId,
      customer.economicCode,
      customer.notes,
    ].some((field) => normalizeSearchText(field).includes(needle)),
  );
}

/** Avatar fallback: first letter of the trimmed name, or «م» when blank. */
export function customerInitial(name: string): string {
  return name.trim().charAt(0) || "م";
}
