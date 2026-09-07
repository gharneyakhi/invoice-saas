"use server";

import { requireSession } from "@/server/auth/requireSession";
import { getDashboardData } from "@/server/dashboard/dashboardService";
import { runAction, type ActionResult } from "@/server/actions/actionResult";
import type { DashboardData } from "@/server/dashboard/dashboardService";

/**
 * Dashboard Server Action.
 *
 * Authenticates, then returns the single assembled `DashboardData` payload (the
 * account/user display info, current + live businesses, effective plan and
 * quota, money totals and recent invoices for the current business). All
 * computation happens in `dashboardService`, which reuses the existing
 * entitlement resolver / quota helpers — no second entitlement system.
 */

export interface GetDashboardActionArgs {
  /** Cap on recent invoices (optional; service default 5, hard max 20). */
  recentInvoicesLimit?: number;
}

export async function getDashboardDataAction(
  args: GetDashboardActionArgs = {},
): Promise<ActionResult<DashboardData>> {
  return runAction(async () => {
    await requireSession();
    const data = await getDashboardData({
      ...(args.recentInvoicesLimit !== undefined
        ? { recentInvoicesLimit: args.recentInvoicesLimit }
        : {}),
    });
    return data;
  });
}
