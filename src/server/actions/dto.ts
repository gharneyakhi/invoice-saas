import Decimal from "decimal.js";
import type { BusinessRecord } from "@/server/business/businessService";
import type { CustomerRecord } from "@/server/customer/customerService";
import type { ProductRecord } from "@/server/product/productService";
import type {
  InvoiceListResult,
  InvoiceListRow,
  InvoiceRecord,
} from "@/server/invoice/invoiceService";
import type { InvoicePaymentRecord } from "@/server/payment/paymentService";

/**
 * DTO mapping for the Server Action boundary.
 *
 * React/Next can only serialise a limited set of values across the server
 * boundary; Prisma objects with Decimal/Date and unexpected relations, and JS
 * `Error` instances, must not leak out of a Server Action. Every mapper here
 * returns an explicit, flat, UI-safe object:
 *
 *   - Decimal (money)  -> string (never a JS float)
 *   - Date             -> ISO string
 *   - unknown relations-> dropped (only listed fields are returned)
 *
 * These functions are pure and DB-free, so they are trivially unit-testable
 * and safe to import from anywhere (they only touch *types* from the services).
 */

/** A value that can be turned into a fixed-precision money string. */
type MoneyLike = string | number | { toString(): string } | null | undefined;

/** Prisma Decimal(14,2) / decimal.js values are converted losslessly. */
export function moneyToString(value: MoneyLike): string {
  if (value === null || value === undefined) return "0";
  const text = typeof value === "string" || typeof value === "number" ? String(value) : value.toString();
  // decimal.js / Prisma toString already yields a plain decimal; re-parse and
  // normalise to 2dp so the UI always sees a predictable, serializable string.
  return new Decimal(text).toFixed(2);
}

/** Exact string form for a non-money decimal column (e.g. quantity Decimal(12,3)). */
function decimalExactString(value: { toString(): string } | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : value.toString();
}

export function dateToIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value as unknown as number).toISOString();
}

// ---------------------------------------------------------------------------
// Business
// ---------------------------------------------------------------------------

export interface BusinessDTO {
  id: string;
  name: string;
  isActive: boolean;
  isLocked: boolean;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function toBusinessDTO(row: BusinessRecord): BusinessDTO {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    isLocked: row.isLocked,
    isPrimary: row.isPrimary,
    createdAt: dateToIso(row.createdAt) ?? "",
    updatedAt: dateToIso(row.updatedAt) ?? "",
    archivedAt: dateToIso(row.archivedAt),
  };
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export interface CustomerDTO {
  id: string;
  businessId: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nationalId: string | null;
  economicCode: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function toCustomerDTO(row: CustomerRecord): CustomerDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    mobile: row.mobile,
    phone: row.phone,
    email: row.email,
    address: row.address,
    nationalId: row.nationalId,
    economicCode: row.economicCode,
    notes: row.notes,
    createdAt: dateToIso(row.createdAt) ?? "",
    updatedAt: dateToIso(row.updatedAt) ?? "",
    archivedAt: dateToIso(row.archivedAt),
  };
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export interface ProductDTO {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  price: string;
  unit: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function toProductDTO(row: ProductRecord): ProductDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    description: row.description,
    price: moneyToString(row.price),
    unit: row.unit,
    active: row.active,
    createdAt: dateToIso(row.createdAt) ?? "",
    updatedAt: dateToIso(row.updatedAt) ?? "",
    archivedAt: dateToIso(row.archivedAt),
  };
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

export interface InvoiceLineItemDTO {
  id: string;
  productId: string | null;
  title: string;
  description: string | null;
  itemDate: string | null;
  unitPrice: string;
  quantity: string;
  unit: string | null;
  discountPercent: string;
  discountAmount: string;
  subtotal: string;
  total: string;
  sortOrder: number;
}

export interface InvoiceDTO {
  id: string;
  businessId: string;
  customerId: string | null;
  invoiceNumber: string;
  invoiceType: "PROFORMA" | "FINAL";
  issueDate: string;
  dueDate: string | null;
  status: string;
  subtotal: string;
  itemDiscountAmount: string;
  globalDiscountPercent: string;
  globalDiscountAmount: string;
  taxPercent: string;
  taxAmount: string;
  taxableAmount: string;
  total: string;
  paidAmount: string;
  remainingAmount: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  cancelledAt: string | null;
}

export interface InvoiceDetailDTO extends InvoiceDTO {
  items: InvoiceLineItemDTO[];
}

/** List row — summary columns plus the customer's current display name. */
export interface InvoiceListRowDTO extends InvoiceDTO {
  customerName: string | null;
}

export interface InvoiceListDTO {
  rows: InvoiceListRowDTO[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  lifecycleCounts: { all: number; draft: number; finalized: number; cancelled: number };
}

function toLineItemDTO(item: NonNullable<InvoiceRecord["items"]>[number]): InvoiceLineItemDTO {
  return {
    id: item.id,
    productId: item.productId,
    title: item.title,
    description: item.description,
    itemDate: dateToIso(item.itemDate),
    unitPrice: moneyToString(item.unitPrice),
    quantity: decimalExactString(item.quantity),
    unit: item.unit,
    discountPercent: moneyToString(item.discountPercent),
    discountAmount: moneyToString(item.discountAmount),
    subtotal: moneyToString(item.subtotal),
    total: moneyToString(item.total),
    sortOrder: item.sortOrder,
  };
}

function toInvoiceBaseDTO(row: InvoiceRecord): InvoiceDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    customerId: row.customerId,
    invoiceNumber: row.invoiceNumber,
    invoiceType: row.invoiceType,
    issueDate: dateToIso(row.issueDate) ?? "",
    dueDate: dateToIso(row.dueDate),
    status: row.status,
    subtotal: moneyToString(row.subtotal),
    itemDiscountAmount: moneyToString(row.itemDiscountAmount),
    globalDiscountPercent: moneyToString(row.globalDiscountPercent),
    globalDiscountAmount: moneyToString(row.globalDiscountAmount),
    taxPercent: moneyToString(row.taxPercent),
    taxAmount: moneyToString(row.taxAmount),
    taxableAmount: moneyToString(row.taxableAmount),
    total: moneyToString(row.total),
    paidAmount: moneyToString(row.paidAmount),
    remainingAmount: moneyToString(row.remainingAmount),
    notes: row.notes,
    createdAt: dateToIso(row.createdAt) ?? "",
    updatedAt: dateToIso(row.updatedAt) ?? "",
    finalizedAt: dateToIso(row.finalizedAt),
    cancelledAt: dateToIso(row.cancelledAt),
  };
}

/** List / summary view — no line items or snapshots. */
export function toInvoiceDTO(row: InvoiceRecord): InvoiceDTO {
  return toInvoiceBaseDTO(row);
}

/** List view — summary row plus the joined customer name. */
export function toInvoiceListRowDTO(row: InvoiceListRow): InvoiceListRowDTO {
  return { ...toInvoiceBaseDTO(row), customerName: row.customerName ?? null };
}

/** Paginated list payload for the invoice list screen. */
export function toInvoiceListDTO(result: InvoiceListResult): InvoiceListDTO {
  return {
    rows: result.rows.map(toInvoiceListRowDTO),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    pageCount: result.pageCount,
    lifecycleCounts: result.lifecycleCounts,
  };
}

/** Detail view — includes ordered line items. */
export function toInvoiceDetailDTO(row: InvoiceRecord): InvoiceDetailDTO {
  return {
    ...toInvoiceBaseDTO(row),
    items: (row.items ?? []).map(toLineItemDTO),
  };
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export interface InvoicePaymentDTO {
  id: string;
  invoiceId: string;
  amount: string;
  paymentDate: string;
  method: string;
  referenceNumber: string | null;
  notes: string | null;
  createdAt: string;
}

export function toInvoicePaymentDTO(row: InvoicePaymentRecord): InvoicePaymentDTO {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    amount: moneyToString(row.amount),
    paymentDate: dateToIso(row.paymentDate) ?? "",
    method: row.method,
    referenceNumber: row.referenceNumber,
    notes: row.notes,
    createdAt: dateToIso(row.createdAt) ?? "",
  };
}
