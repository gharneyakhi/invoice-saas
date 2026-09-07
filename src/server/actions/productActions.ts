"use server";

import { requireSession } from "@/server/auth/requireSession";
import {
  archiveProduct as archiveProductService,
  createProduct as createProductService,
  getProduct as getProductService,
  listProducts as listProductsService,
  updateProduct as updateProductService,
} from "@/server/product/productService";
import { runAction, type ActionResult } from "@/server/actions/actionResult";
import { toProductDTO, type ProductDTO } from "@/server/actions/dto";

/**
 * Product Server Actions — thin application boundary over `productService`.
 *
 * `businessId` is an untrusted identifier; ownership is proven server-side so
 * a client can never touch another account's catalogue. Input validation,
 * Decimal handling and archive semantics all stay in `productService` (the
 * source of truth) — nothing here re-implements them.
 */

/** Lists the live products of a business the caller owns. */
export async function listProducts(businessId: string): Promise<ActionResult<ProductDTO[]>> {
  return runAction(async () => {
    await requireSession();
    const records = await listProductsService(businessId);
    return records.map(toProductDTO);
  });
}

/** Returns one product (including archived) of a business the caller owns. */
export async function getProduct(
  businessId: string,
  productId: string,
): Promise<ActionResult<ProductDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await getProductService(businessId, productId);
    return toProductDTO(record);
  });
}

export async function createProduct(
  businessId: string,
  input: unknown,
): Promise<ActionResult<ProductDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await createProductService(businessId, input);
    return toProductDTO(record);
  });
}

export async function updateProduct(
  businessId: string,
  productId: string,
  input: unknown,
): Promise<ActionResult<ProductDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await updateProductService(businessId, productId, input);
    return toProductDTO(record);
  });
}

export async function archiveProduct(
  businessId: string,
  productId: string,
): Promise<ActionResult<ProductDTO>> {
  return runAction(async () => {
    await requireSession();
    const record = await archiveProductService(businessId, productId);
    return toProductDTO(record);
  });
}
