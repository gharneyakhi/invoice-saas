import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ProductDTO } from "@/server/actions/dto";
import { formatCurrency, formatPersianDateShort } from "@/lib/formatters";
import { ArchiveIcon, PencilIcon } from "@/components/icons";
import { productInitial, productStatusLabel } from "@/components/product/productListUtils";

/**
 * Product/service list — responsive RTL.
 *
 * Desktop renders a real table; below `md` the same rows become stacked
 * cards so nothing is horizontally clipped on a phone (same contract as
 * `CustomerListTable`). Pure presentation: it renders exactly the (already
 * ownership-checked, archived-excluded) rows it receives, and reports
 * edit/archive intent back to the caller — all mutations run through the
 * existing Server Actions in the dialogs.
 */
export interface ProductListTableProps {
  products: ProductDTO[];
  onEdit: (product: ProductDTO) => void;
  onArchive: (product: ProductDTO) => void;
}

function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge variant="success" showDot>
      {productStatusLabel(true)}
    </Badge>
  ) : (
    <Badge variant="secondary" showDot>
      {productStatusLabel(false)}
    </Badge>
  );
}

function RowActions({
  product,
  onEdit,
  onArchive,
}: {
  product: ProductDTO;
  onEdit: (product: ProductDTO) => void;
  onArchive: (product: ProductDTO) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => onEdit(product)}
        aria-label={`ویرایش ${product.name}`}
      >
        <PencilIcon size={14} />
        <span>ویرایش</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-rose-600 hover:bg-rose-50 hover:text-rose-700"
        onClick={() => onArchive(product)}
        aria-label={`بایگانی ${product.name}`}
      >
        <ArchiveIcon size={14} />
        <span>بایگانی</span>
      </Button>
    </div>
  );
}

export function ProductListTable({ products, onEdit, onArchive }: ProductListTableProps) {
  return (
    <>
      {/* Desktop */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-right text-xs">
          <caption className="sr-only">فهرست محصولات و خدمات کسب‌وکار جاری</caption>
          <thead className="border-y border-gray-100 bg-gray-50/75 text-gray-500">
            <tr>
              <th scope="col" className="px-5 py-3 font-semibold">
                کالا / خدمت
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                قیمت واحد
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                واحد
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                وضعیت
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                ثبت
              </th>
              <th scope="col" className="px-5 py-3 text-left font-semibold">
                عملیات
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {products.map((product) => (
              <tr key={product.id} className="transition-colors hover:bg-gray-50/80">
                <td className="max-w-[260px] px-5 py-3.5">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-700"
                      aria-hidden="true"
                    >
                      {productInitial(product.name)}
                    </div>
                    <div className="min-w-0">
                      <p
                        className="truncate text-[13px] font-semibold text-gray-900"
                        title={product.name}
                      >
                        {product.name}
                      </p>
                      {product.description ? (
                        <p
                          className="mt-0.5 truncate text-[11px] text-gray-400"
                          title={product.description}
                        >
                          {product.description}
                        </p>
                      ) : (
                        <p className="mt-0.5 text-[11px] text-gray-300">بدون توضیحات</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans font-semibold text-gray-800">
                  {formatCurrency(product.price)}
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 text-gray-600">
                  {product.unit ?? <span className="text-gray-300">—</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3.5">
                  <StatusBadge active={product.active} />
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-gray-500">
                  {formatPersianDateShort(product.createdAt)}
                </td>
                <td className="px-5 py-3.5">
                  <div className="flex justify-end">
                    <RowActions product={product} onEdit={onEdit} onArchive={onArchive} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <ul className="divide-y divide-gray-100 md:hidden">
        {products.map((product) => (
          <li key={product.id} className="space-y-3 bg-white p-4">
            <div className="flex items-start gap-2.5">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-base font-bold text-indigo-700"
                aria-hidden="true"
              >
                {productInitial(product.name)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-gray-900">{product.name}</p>
                {product.description ? (
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-gray-400">
                    {product.description}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-gray-300">بدون توضیحات</p>
                )}
              </div>
              <StatusBadge active={product.active} />
            </div>

            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-[11px] text-gray-400">قیمت واحد</dt>
                <dd className="mt-0.5 font-sans font-semibold text-gray-800">
                  {formatCurrency(product.price)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-gray-400">واحد</dt>
                <dd className="mt-0.5 text-gray-700">{product.unit ?? "—"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[11px] text-gray-400">تاریخ ثبت</dt>
                <dd className="mt-0.5 font-sans text-gray-700">
                  {formatPersianDateShort(product.createdAt)}
                </dd>
              </div>
            </dl>

            <div className="flex justify-end border-t border-gray-100 pt-3">
              <RowActions product={product} onEdit={onEdit} onArchive={onArchive} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
