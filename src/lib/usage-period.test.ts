import { describe, it, expect } from "vitest";
import { getUsagePeriodBounds } from "./usage-period";

describe("getUsagePeriodBounds", () => {
  it("returns the first and last instant of the reference month", () => {
    // date-fns operates in local time, so we build the reference date from
    // local components to keep this test timezone-independent.
    const reference = new Date(2026, 1, 15, 10, 30); // Feb 15, 2026, local time
    const { periodStart, periodEnd } = getUsagePeriodBounds(reference);
    expect(periodStart.getMonth()).toBe(1); // February
    expect(periodStart.getDate()).toBe(1);
    expect(periodEnd.getMonth()).toBe(1);
    expect(periodEnd.getDate()).toBe(28); // 2026 is not a leap year
  });

  it("handles a leap-year February correctly", () => {
    const reference = new Date(2028, 1, 10); // Feb 10, 2028, local time
    const { periodEnd } = getUsagePeriodBounds(reference);
    expect(periodEnd.getDate()).toBe(29);
  });

  it("defaults to the current date when no reference is given", () => {
    const { periodStart, periodEnd } = getUsagePeriodBounds();
    expect(periodStart.getTime()).toBeLessThanOrEqual(Date.now());
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(Date.now());
  });
});
