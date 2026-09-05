import { startOfMonth, endOfMonth } from "date-fns";

/**
 * Computes the calendar-month bounds used for a UsagePeriod. Kept as a
 * pure function (no DB access) so it's trivially unit-testable and can be
 * reused by both the bootstrap flow (Phase 2) and the finalize/quota-check
 * flow (Phase 4).
 */
export function getUsagePeriodBounds(reference: Date = new Date()): { periodStart: Date; periodEnd: Date } {
  return {
    periodStart: startOfMonth(reference),
    periodEnd: endOfMonth(reference),
  };
}
