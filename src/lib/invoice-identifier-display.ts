import { toPersianDigits } from "@/lib/formatters";

/**
 * Presentation-only invoice identifier for the Dashboard UI.
 *
 * Real data flow (traced): `prisma.invoice` rows carry:
 *   - `status`  — the lifecycle field the UI status pill uses
 *                 (`formatInvoiceStatus(inv.status)` → «پیش‌نویس» for DRAFT)
 *   - `invoiceNumber` — the internal `DRAFT-<uuid>` placeholder while DRAFT,
 *                 replaced with the official number at finalization.
 *
 * The DTOs map both fields 1:1 (`dashboardService.toRecentInvoiceDTO`,
 * `server/actions/dto.ts`); there is no per-row `lifecycle` field.
 *
 * A DRAFT row never has an official number, so the UI must render the clean
 * Persian label «پیش‌نویس» instead of the internal placeholder. Finalized
 * (and cancelled) rows keep their official `invoiceNumber` — only Persian
 * digits are applied for display.
 *
 * This is pure presentation: the underlying `invoiceNumber` value is never
 * mutated, and no fake number is ever invented.
 */
export const DRAFT_INVOICE_DISPLAY_LABEL = "پیش‌نویس";

export function formatInvoiceIdentifierDisplay(
  status: string | null | undefined,
  invoiceNumber: string | null | undefined,
): string {
  // `status === "DRAFT"` is the authoritative check (the same field the
  // status pill renders). The prefix guard is defense-in-depth for rows that
  // are no longer DRAFT but still carry a draft placeholder (e.g. a draft
  // cancelled before finalization).
  if (
    status === "DRAFT" ||
    (typeof invoiceNumber === "string" && /^DRAFT[:-]/i.test(invoiceNumber))
  ) {
    return DRAFT_INVOICE_DISPLAY_LABEL;
  }
  return invoiceNumber ? toPersianDigits(invoiceNumber) : "—";
}
