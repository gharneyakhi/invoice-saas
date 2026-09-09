import Decimal from "decimal.js";
import type { BusinessRecord } from "@/server/business/businessService";
import { listBusinesses } from "@/server/business/businessService";
import { getInvoiceQuotaStatus } from "@/server/entitlements/invoiceQuota";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/server/auth/requireSession";
import { DEFAULT_INVOICE_CURRENCY, normalizeInvoiceCurrency } from "@/lib/currency";

/**
 * Dashboard data assembly (server-side, application boundary).
 *
 * One query/action that returns the *minimum* the future Dashboard needs. It is
 * deliberately the only consumer of a few overlapping server modules, and it
 * reuses the existing services rather than introducing a second entitlement or
 * quota system:
 *
 *   - account/user display info  -> prisma.account (explicit select)
 *   - live businesses + current  -> businessService.listBusinesses (existing
 *                                   primary-first ordering & archive filtering)
 *   - effective plan & quota     -> invoiceQuota.getInvoiceQuotaStatus (existing
 *                                   resolver: effective plan, used/remaining)
 *   - money totals               -> prisma.invoice.aggregate (SQL-side sums, no
 *                                   loading of invoice rows, Decimal-safe)
 *   - recent invoices            -> prisma.invoice.findMany (bounded, explicit
 *                                   select, deterministic ordering)
 *
 * Money is always returned as a string (never a JS float). The current business
 * is the account's primary live business via the existing primary convention —
 * no schema change and no ownership claims carried in the JWT.
 *
 * Everything thrown here is a domain/application error the caller's action
 * wrapper maps onto a safe `{ code, message }` payload.
 */

export type DashboardInvoiceStatus =
  | "DRAFT"
  | "ISSUED"
  | "SENT"
  | "PENDING_PAYMENT"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "CANCELLED";

export interface DashboardAccountDTO {
  accountId: string;
  accountName: string;
  userName: string;
  userEmail: string;
  userAvatarUrl: string | null;
}

export interface DashboardPlanDTO {
  /** Effective plan key (already Free when the subscription lapsed). */
  planKey: "FREE" | "BASIC" | "PRO";
  /** Human-friendly name for the current effective plan. */
  planName: string;
  /** Monthly finalized-invoice limit of the effective plan. */
  monthlyInvoiceLimit: number;
  /** Finalized invoices recorded in the current calendar-month period. */
  currentMonthlyFinalizedInvoiceCount: number;
  /** Remaining finalized invoices this month (never negative). */
  remainingInvoiceQuota: number;
  canFinalize: boolean;
  warningLevel: "OK" | "WARNING_80" | "REACHED";
  usagePeriodId: string | null;
  periodStart: string;
  periodEnd: string;
  /** Why the account is on Free (NONE when it is not). Diagnostics for UI copy. */
  fallbackReason: string;
}

export interface DashboardRecentInvoiceDTO {
  id: string;
  invoiceNumber: string;
  invoiceType: "PROFORMA" | "FINAL";
  status: DashboardInvoiceStatus;
  /** Current customer name (live relation, same source as the invoice list). */
  customerName: string | null;
  total: string;
  paidAmount: string;
  remainingAmount: string;
  /** Snapshotted currency; `null` on drafts (dashboard falls back to settings). */
  currency: string | null;
  issueDate: string;
  dueDate: string | null;
  finalizedAt: string | null;
  createdAt: string;
}

export interface DashboardData {
  account: DashboardAccountDTO;
  currentBusiness: BusinessDTO | null;
  businesses: BusinessDTO[];
  plan: DashboardPlanDTO;
  /** Money totals for the current business, as Decimal-safe strings. */
  totals: {
    pendingAmount: string;
    paidAmount: string;
    /** Current InvoiceSettings.currency of the business (ریال / تومان). */
    currency: string;
  };
  recentInvoices: DashboardRecentInvoiceDTO[];
}

// Re-declared here (not imported from the action DTO module) so the dashboard
// service has no dependency on the "use server" / action layer.
export interface BusinessDTO {
  id: string;
  name: string;
  isActive: boolean;
  isLocked: boolean;
  isPrimary: boolean;
  archivedAt: string | null;
}

export interface DashboardOptions {
  /** Server-side time reference; injected for tests / deterministic boundaries. */
  now?: Date;
  /** Cap on recent invoices (default 5, hard max 20). */
  recentInvoicesLimit?: number;
}

const PLAN_NAMES: Record<"FREE" | "BASIC" | "PRO", string> = {
  FREE: "Free",
  BASIC: "Basic",
  PRO: "Pro",
};

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function moneyToFixed(value: { toString(): string } | string | null | undefined): string {
  if (value === null || value === undefined) return "0";
  const text = typeof value === "string" ? value : value.toString();
  // Decimal-safe conversion to a fixed 2dp string. The input is already a
  // fixed-point string from a Decimal(14,2) column, so decimal.js keeps every
  // digit exact — no JavaScript float is ever used for money.
  return new Decimal(text).toFixed(2);
}

function toBusinessDTO(row: BusinessRecord): BusinessDTO {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    isLocked: row.isLocked,
    isPrimary: row.isPrimary,
    archivedAt: toIso(row.archivedAt),
  };
}

interface RecentInvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceType: "PROFORMA" | "FINAL";
  status: DashboardInvoiceStatus;
  customer: { name: string } | null;
  total: { toString(): string };
  paidAmount: { toString(): string };
  remainingAmount: { toString(): string };
  currency: string | null;
  issueDate: Date;
  dueDate: Date | null;
  finalizedAt: Date | null;
  createdAt: Date;
}

function toRecentInvoiceDTO(row: RecentInvoiceRow): DashboardRecentInvoiceDTO {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    invoiceType: row.invoiceType,
    status: row.status,
    customerName: row.customer?.name ?? null,
    total: moneyToFixed(row.total),
    paidAmount: moneyToFixed(row.paidAmount),
    remainingAmount: moneyToFixed(row.remainingAmount),
    currency: row.currency ?? null,
    issueDate: toIso(row.issueDate) ?? "",
    dueDate: toIso(row.dueDate),
    finalizedAt: toIso(row.finalizedAt),
    createdAt: toIso(row.createdAt) ?? "",
  };
}

export async function getDashboardData(options: DashboardOptions = {}): Promise<DashboardData> {
  const { accountId } = await requireSession();

  // 1. Account/user display info — explicit select only.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      name: true,
      owner: { select: { name: true, email: true, avatarUrl: true } },
    },
  });

  // 2. Live businesses (reuses the existing service: primary-first, archives
  //    excluded). The current business is the primary live business.
  const businessRecords = await listBusinesses();

  // 3. Effective plan + monthly invoice quota (reuses the existing resolver).
  const quota = await getInvoiceQuotaStatus({ now: options.now });

  const businesses = businessRecords.map(toBusinessDTO);
  const currentBusiness = businesses[0] ?? null;

  const plan: DashboardPlanDTO = {
    planKey: quota.planKey,
    planName: PLAN_NAMES[quota.planKey],
    monthlyInvoiceLimit: quota.invoiceLimit,
    currentMonthlyFinalizedInvoiceCount: quota.usedInvoices,
    remainingInvoiceQuota: quota.remainingInvoices,
    canFinalize: quota.canFinalize,
    warningLevel: quota.warningLevel,
    usagePeriodId: quota.usagePeriodId,
    periodStart: toIso(quota.periodStart) ?? "",
    periodEnd: toIso(quota.periodEnd) ?? "",
    fallbackReason: quota.fallbackReason,
  };

  // 4. Money totals for the current business — SQL-side sums (no invoice rows
  //    loaded). Scope: finalized (issued...) invoices that are not cancelled.
  let totals: DashboardData["totals"] = {
    pendingAmount: "0",
    paidAmount: "0",
    currency: DEFAULT_INVOICE_CURRENCY,
  };
  if (currentBusiness) {
    const [aggregate, settings] = await Promise.all([
      prisma.invoice.aggregate({
        where: {
          businessId: currentBusiness.id,
          finalizedAt: { not: null },
          status: { not: "CANCELLED" },
        },
        _sum: { remainingAmount: true, paidAmount: true },
      }),
      prisma.invoiceSettings.findUnique({
        where: { businessId: currentBusiness.id },
        select: { currency: true },
      }),
    ]);
    totals = {
      pendingAmount: moneyToFixed(aggregate?._sum?.remainingAmount ?? null),
      paidAmount: moneyToFixed(aggregate?._sum?.paidAmount ?? null),
      currency: normalizeInvoiceCurrency(settings?.currency),
    };
  }

  // 5. Recent invoices for the current business — bounded, explicit select,
  //    deterministic ordering (newest created first, id tie-breaker).
  const recentInvoices: DashboardRecentInvoiceDTO[] = [];
  if (currentBusiness) {
    const limit = Math.max(1, Math.min(options.recentInvoicesLimit ?? 5, 20));
    const rows = (await prisma.invoice.findMany({
      where: { businessId: currentBusiness.id },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        invoiceNumber: true,
        invoiceType: true,
        status: true,
        // Live customer name only (same narrow relation as the invoice list);
        // no customer row is loaded into the dashboard payload.
        customer: { select: { name: true } },
        total: true,
        paidAmount: true,
        remainingAmount: true,
        currency: true,
        issueDate: true,
        dueDate: true,
        finalizedAt: true,
        createdAt: true,
      },
    })) as unknown as RecentInvoiceRow[];
    for (const row of rows) {
      recentInvoices.push(toRecentInvoiceDTO(row));
    }
  }

  return {
    account: {
      accountId,
      accountName: account?.name ?? "",
      userName: account?.owner?.name ?? "",
      userEmail: account?.owner?.email ?? "",
      userAvatarUrl: account?.owner?.avatarUrl ?? null,
    },
    currentBusiness,
    businesses,
    plan,
    totals,
    recentInvoices,
  };
}
