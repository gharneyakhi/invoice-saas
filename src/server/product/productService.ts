import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { requireBusinessOwnership } from "@/server/auth/requireBusinessOwnership";
import { ForbiddenError, NotFoundError } from "@/server/auth/requireSession";
import { ValidationError } from "@/server/errors";
import {
  parseCreateProductInput,
  parseUpdateProductInput,
  type CreateProductInput,
  type UpdateProductInput,
} from "@/server/product/schema";

/**
 * Product CRUD domain layer (server-side only) — the minimum surface the
 * invoice editor needs to pick, create and correct a catalogue item.
 *
 * Authorization rules applied by *every* function in this module:
 *
 *   1. `requireBusinessOwnership(businessId)` runs first. It calls
 *      `requireSession()` internally (the only source of truth for "who is
 *      calling") and re-reads the Business row to compare its `accountId`
 *      against the session account — 404 when the Business is missing, 403
 *      when it belongs to another Account.
 *   2. No function accepts an `accountId`, and `businessId` is treated as an
 *      untrusted *identifier*, never as proof of ownership. The value written
 *      to `Product.businessId` and used in every `where` clause is the
 *      verified row's `id`, not the raw client string.
 *   3. A Product is only ever reachable through its own Business: a row whose
 *      `businessId` differs from the verified Business is refused with
 *      `ForbiddenError`, exactly as `invoiceService` refuses a cross-business
 *      product reference.
 *
 * INVOICE HISTORICAL INTEGRITY
 * ----------------------------
 * `model InvoiceItem` already stores its own `title`, `description`,
 * `unitPrice`, `quantity` and `unit` columns and keeps `productId` only as a
 * nullable back-reference. A finalized invoice therefore reads its money and
 * wording from the InvoiceItem row, never by joining back to `products`.
 *
 * This module relies on that existing design and does not extend it: no
 * function here reads or writes `InvoiceItem` (nor `Invoice`), so repricing or
 * renaming a Product changes the catalogue only. Finalized invoices keep the
 * values captured when they were finalized.
 *
 * Nothing is hard-deleted here either. `Product.archivedAt` exists in the
 * schema, so "delete" is an archive stamp; `InvoiceItem.productId` keeps
 * pointing at a row that still exists.
 */

/**
 * Row shape of the `products` table (mirrors `model Product` in
 * `prisma/schema.prisma`). Declared locally rather than importing the
 * `Product` model type from `@prisma/client`, which only exists after
 * `prisma generate` has run — the same convention as `BusinessRecord` in
 * `src/server/business/businessService.ts`.
 */
export interface ProductRecord {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  price: Decimal;
  unit: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/**
 * Stable order for product pickers: by name, with `id` as a final tie-breaker
 * so two products sharing a name never swap places between requests.
 */
export const PRODUCT_LIST_ORDER_BY = [{ name: "asc" }, { id: "asc" }];

function assertProductId(productId: unknown): string {
  if (typeof productId !== "string" || productId.trim() === "") {
    throw new ValidationError("Product ID is required");
  }
  return productId;
}

/**
 * An archived Business is retired: its historical data stays readable, but it
 * accepts no new writes. Mirrors the guard `invoiceService` applies before
 * creating or finalizing an invoice.
 */
function assertBusinessIsMutable(business: { archivedAt: Date | null }, action: string): void {
  if (business.archivedAt !== null) {
    throw new ValidationError(`Cannot ${action} for an archived business`);
  }
}

/**
 * Loads a Product strictly inside the already-verified Business.
 *
 * Missing row → `NotFoundError`. Row that exists but lives in another Business
 * (including another account's business) → `ForbiddenError`. The two are kept
 * distinct on purpose, matching `requireBusinessOwnership()`.
 */
async function loadProductInBusiness(
  businessId: string,
  productId: string,
): Promise<ProductRecord> {
  // Cast rather than annotate: `Product.price` is a Prisma `Decimal`, which is
  // a distinct nominal class from the `decimal.js` `Decimal` used across the
  // server layer. `invoiceService` resolves the same mismatch the same way.
  const product = (await prisma.product.findUnique({
    where: { id: productId },
  })) as unknown as ProductRecord | null;

  if (!product) {
    throw new NotFoundError("Product not found");
  }

  if (product.businessId !== businessId) {
    throw new ForbiddenError("Product does not belong to this business");
  }

  return product;
}

/**
 * Lists the products of a business the caller owns.
 *
 * Archived products are excluded — archiving is the soft delete, so they must
 * not show up in the invoice editor's picker.
 */
export async function listProducts(businessId: string): Promise<ProductRecord[]> {
  const owned = await requireBusinessOwnership(businessId);

  return (await prisma.product.findMany({
    where: { businessId: owned.id, archivedAt: null },
    orderBy: PRODUCT_LIST_ORDER_BY,
  })) as unknown as ProductRecord[];
}

/**
 * Returns a single product of a business the caller owns, including an
 * archived one — an invoice item that already references a product must still
 * be able to resolve it after archiving (list views filter instead).
 */
export async function getProduct(businessId: string, productId: string): Promise<ProductRecord> {
  const owned = await requireBusinessOwnership(businessId);
  const id = assertProductId(productId);

  return loadProductInBusiness(owned.id, id);
}

/**
 * Creates a product under a business the caller owns.
 *
 * `businessId` on the created row comes from the verified Business, and the
 * payload schema is strict, so a client cannot re-parent the product or set
 * any server-owned column. `price` is normalized to a `Decimal` — never a
 * JavaScript float — before it reaches the `Decimal(14,2)` column.
 */
export async function createProduct(businessId: string, input: unknown): Promise<ProductRecord> {
  const owned = await requireBusinessOwnership(businessId);
  assertBusinessIsMutable(owned, "create a product");
  const data: CreateProductInput = parseCreateProductInput(input);

  const created = (await prisma.product.create({
    data: {
      businessId: owned.id,
      name: data.name,
      description: data.description ?? null,
      price: new Decimal(data.price),
      unit: data.unit ?? null,
      ...(data.active !== undefined ? { active: data.active } : {}),
    },
  })) as unknown as ProductRecord;

  return created;
}

/**
 * Updates a product of a business the caller owns.
 *
 * Only fields actually present in the payload are written, so a partial update
 * cannot blank out columns it never mentioned. An explicit `null` clears a
 * nullable column.
 *
 * This touches the `products` row and nothing else. Existing `InvoiceItem`
 * rows already carry their own historical `title`/`unitPrice`/`unit`, so a
 * repriced or renamed product never rewrites an invoice that has been
 * finalized.
 */
export async function updateProduct(
  businessId: string,
  productId: string,
  input: unknown,
): Promise<ProductRecord> {
  const owned = await requireBusinessOwnership(businessId);
  assertBusinessIsMutable(owned, "update a product");
  const id = assertProductId(productId);
  const existing = await loadProductInBusiness(owned.id, id);

  if (existing.archivedAt !== null) {
    throw new ValidationError("Cannot update an archived product");
  }

  const data: UpdateProductInput = parseUpdateProductInput(input);

  const updated = (await prisma.product.update({
    where: { id: existing.id }, // the verified row's id, not the raw client value
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.price !== undefined ? { price: new Decimal(data.price) } : {}),
      ...(data.unit !== undefined ? { unit: data.unit } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
    },
  })) as unknown as ProductRecord;

  return updated;
}

/**
 * Archives (soft-deletes) a product of a business the caller owns.
 *
 * `Product.archivedAt` exists in the schema, so this is the delete path and
 * there is deliberately no hard-delete function in this module: a product may
 * be referenced by `InvoiceItem.productId`, and removing the row would break
 * that reference on finalized invoices.
 *
 * Idempotent — archiving an already archived product returns the current row
 * rather than moving the archive timestamp.
 */
export async function archiveProduct(
  businessId: string,
  productId: string,
): Promise<ProductRecord> {
  const owned = await requireBusinessOwnership(businessId);
  assertBusinessIsMutable(owned, "archive a product");
  const id = assertProductId(productId);
  const existing = await loadProductInBusiness(owned.id, id);

  if (existing.archivedAt !== null) {
    return existing;
  }

  const archived = (await prisma.product.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  })) as unknown as ProductRecord;

  return archived;
}
