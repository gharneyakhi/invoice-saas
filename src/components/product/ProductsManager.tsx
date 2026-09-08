"use client";

import * as React from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  PlusIcon,
  ProductsIcon,
  SearchIcon,
  XIcon,
} from "@/components/icons";
import type { ProductDTO } from "@/server/actions/dto";
import { formatPersianNumber } from "@/lib/formatters";
import { ProductListTable } from "@/components/product/ProductListTable";
import { ProductFormDialog } from "@/components/product/ProductFormDialog";
import { ArchiveProductDialog } from "@/components/product/ArchiveProductDialog";
import {
  filterProducts,
  sortProducts,
} from "@/components/product/productListUtils";

/**
 * Product/Service Management UI — client container for `/dashboard/products`.
 *
 * The server component loads the current business's live products through
 * the ownership-checked `productService.listProducts` and hands them over as
 * DTOs; this component owns the interactive layer on top of that authorized
 * set (same architecture as `CustomersManager`):
 *
 *   - instant search across every visible column (client-side filtering of
 *     the authorized rows — the server already decided *which* rows are
 *     visible, archived rows never reach the browser);
 *   - create / edit / archive through the existing Server Actions, with the
 *     list updated in place from the returned DTO — no full page reload;
 *   - empty (no products / no search matches), count and feedback states.
 *
 * `businessId` is passed to the Server Actions as an untrusted identifier
 * only; ownership is re-proven server-side on every mutation.
 */
export interface ProductsManagerProps {
  businessId: string;
  businessName: string;
  initialProducts: ProductDTO[];
}

type FormDialogState = { mode: "create" } | { mode: "edit"; product: ProductDTO } | null;

interface Notice {
  type: "success" | "error";
  message: string;
  detail?: string;
}

export function ProductsManager({
  businessId,
  businessName,
  initialProducts,
}: ProductsManagerProps) {
  const [products, setProducts] = React.useState<ProductDTO[]>(() =>
    sortProducts(initialProducts),
  );
  const [query, setQuery] = React.useState("");
  const [formDialog, setFormDialog] = React.useState<FormDialogState>(null);
  const [archiveTarget, setArchiveTarget] = React.useState<ProductDTO | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  // The dashboard shell can switch the current business (BusinessSwitcher +
  // router.refresh) while this component stays mounted: the server then
  // passes a new businessId with a new row set, and every piece of
  // business-scoped state must reset with it.
  const [activeBusinessId, setActiveBusinessId] = React.useState(businessId);
  if (businessId !== activeBusinessId) {
    setActiveBusinessId(businessId);
    setProducts(sortProducts(initialProducts));
    setQuery("");
    setFormDialog(null);
    setArchiveTarget(null);
    setNotice(null);
  }

  const filtered = React.useMemo(
    () => filterProducts(products, query),
    [products, query],
  );
  const isFiltering = query.trim() !== "";

  function handleCreated(product: ProductDTO) {
    setProducts((prev) => sortProducts([...prev, product]));
    setFormDialog(null);
    setNotice({ type: "success", message: `«${product.name}» با موفقیت اضافه شد.` });
  }

  function handleUpdated(product: ProductDTO) {
    setProducts((prev) =>
      sortProducts(prev.map((row) => (row.id === product.id ? product : row))),
    );
    setFormDialog(null);
    setNotice({ type: "success", message: `تغییرات «${product.name}» با موفقیت ذخیره شد.` });
  }

  function handleArchived(product: ProductDTO) {
    setProducts((prev) => prev.filter((row) => row.id !== product.id));
    setArchiveTarget(null);
    setNotice({
      type: "success",
      message: `«${product.name}» بایگانی شد.`,
      detail: "فاکتورهای قبلی شامل این قلم بدون تغییر باقی می‌مانند.",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="محصولات و خدمات"
        description={`کاتالوگ کالاها و خدمات «${businessName}» — قیمت پایه، واحد و وضعیت هر قلم`}
        badge={
          <Badge variant="secondary" showDot>
            {formatPersianNumber(products.length)} قلم ثبت‌شده
          </Badge>
        }
        actions={
          <Button
            size="md"
            className="gap-2 font-bold shadow-sm"
            onClick={() => {
              setNotice(null);
              setFormDialog({ mode: "create" });
            }}
          >
            <PlusIcon size={18} />
            <span>افزودن کالا / خدمت</span>
          </Button>
        }
      />

      {notice && (
        <div
          role={notice.type === "success" ? "status" : "alert"}
          className={
            notice.type === "success"
              ? "flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-800"
              : "flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs leading-relaxed text-rose-800"
          }
        >
          {notice.type === "success" ? (
            <CheckCircleIcon size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{notice.message}</p>
            {notice.detail && <p className="mt-0.5 opacity-80">{notice.detail}</p>}
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="بستن پیام"
            className="shrink-0 rounded-md p-1 opacity-60 transition hover:opacity-100"
          >
            <XIcon size={14} />
          </button>
        </div>
      )}

      <Card>
        <CardContent className="p-5">
          <div className="relative">
            <label htmlFor="product-search" className="sr-only">
              جستجوی کالا / خدمت
            </label>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
              <SearchIcon size={18} />
            </span>
            <input
              id="product-search"
              type="search"
              inputMode="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="جستجو با نام، توضیحات، واحد یا قیمت…"
              autoComplete="off"
              className="h-10 w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-10 text-sm text-gray-800 shadow-sm outline-none transition-colors placeholder:text-gray-400 hover:border-gray-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-600"
            />
            {query !== "" && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="پاک کردن جستجو"
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
              >
                <XIcon size={16} />
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-gray-400" aria-live="polite">
            {isFiltering
              ? `${formatPersianNumber(filtered.length)} نتیجه برای «${query.trim()}»`
              : products.length > 0
                ? `نمایش ${formatPersianNumber(products.length)} قلم`
                : "هنوز محصول یا خدمتی ثبت نشده است"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="p-6">
              {isFiltering ? (
                <EmptyState
                  icon={<SearchIcon size={24} />}
                  title="قلمی با این جستجو یافت نشد"
                  description={`هیچ کالا یا خدمتی با عبارت «${query.trim()}» مطابقت ندارد. عبارت دیگری را امتحان کنید یا جستجو را پاک کنید.`}
                  action={
                    <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                      پاک کردن جستجو
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<ProductsIcon size={28} />}
                  title="هنوز کالا یا خدمتی ثبت نکرده‌اید"
                  description="اولین قلم کاتالوگ این کسب‌وکار را با قیمت و واحد پایه اضافه کنید تا هنگام صدور فاکتور، انتخاب و درج اقلام تنها با یک کلیک انجام شود."
                  action={
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        setNotice(null);
                        setFormDialog({ mode: "create" });
                      }}
                    >
                      <PlusIcon size={16} />
                      <span>افزودن اولین قلم</span>
                    </Button>
                  }
                />
              )}
            </div>
          ) : (
            <ProductListTable
              products={filtered}
              onEdit={(product) => {
                setNotice(null);
                setFormDialog({ mode: "edit", product });
              }}
              onArchive={(product) => {
                setNotice(null);
                setArchiveTarget(product);
              }}
            />
          )}
        </CardContent>
      </Card>

      {formDialog?.mode === "create" && (
        <ProductFormDialog
          mode="create"
          businessId={businessId}
          onClose={() => setFormDialog(null)}
          onSaved={handleCreated}
        />
      )}
      {formDialog?.mode === "edit" && (
        <ProductFormDialog
          key={formDialog.product.id}
          mode="edit"
          businessId={businessId}
          product={formDialog.product}
          onClose={() => setFormDialog(null)}
          onSaved={handleUpdated}
        />
      )}
      {archiveTarget && (
        <ArchiveProductDialog
          businessId={businessId}
          product={archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onArchived={handleArchived}
        />
      )}
    </div>
  );
}
