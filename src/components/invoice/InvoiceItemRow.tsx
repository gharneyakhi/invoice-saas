"use client";

import * as React from "react";
import clsx from "clsx";
import { useFormContext, useWatch } from "react-hook-form";
import type { ProductDTO } from "@/server/actions/dto";
import { calculateLineItem } from "@/lib/invoice-calculation";
import { Button } from "@/components/ui/button";
import { XIcon } from "@/components/icons";
import { InvoiceField, invoiceInputClassName } from "@/components/invoice/InvoiceField";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";
import { formatCurrency, normalizeLocalizedNumber, toNumericInputString } from "@/lib/formatters";

export interface InvoiceItemRowProps {
  index: number;
  /** Live catalogue of the current business (ownership already verified server-side). */
  products: ProductDTO[];
  currency: string;
  /** Row removal is disabled when the invoice has only one line. */
  canRemove: boolean;
  onRemove: () => void;
}

/**
 * One invoice line: optional product pick (fills the row from the catalogue),
 * title/description, quantity, unit, unit price and line discount percent.
 *
 * Selecting a product only *copies* its snapshot values into this row — the
 * product itself is never mutated, and editing the row afterwards stays
 * local. The line total shown here is a UX preview of the same pure
 * `calculateLineItem` engine the server trusts; the server recalculates
 * authoritatively on save.
 */
export function InvoiceItemRow({ index, products, currency, canRemove, onRemove }: InvoiceItemRowProps) {
  const fieldId = React.useId();
  const {
    register,
    setValue,
    control,
    formState: { errors },
  } = useFormContext<InvoiceEditorFields>();

  const item = useWatch({ control, name: `items.${index}` });
  const rowErrors = errors.items?.[index];

  const lineTotal = React.useMemo(() => {
    try {
      const unitPrice = normalizeLocalizedNumber(item?.unitPrice);
      const quantity = normalizeLocalizedNumber(item?.quantity);
      const discountPercent = normalizeLocalizedNumber(item?.discountPercent) || "0";
      if (unitPrice === "" || quantity === "" || Number(quantity) <= 0) return null;
      return calculateLineItem({ unitPrice, quantity, discountPercent }).total;
    } catch {
      return null;
    }
  }, [item?.unitPrice, item?.quantity, item?.discountPercent]);

  const handleProductChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const productId = event.target.value;
    setValue(`items.${index}.productId`, productId, { shouldDirty: true });

    const product = products.find((entry) => entry.id === productId);
    if (product) {
      // Copy catalogue defaults into the editable row (product stays untouched).
      setValue(`items.${index}.title`, product.name, { shouldDirty: true, shouldValidate: true });
      setValue(`items.${index}.unitPrice`, toNumericInputString(product.price), {
        shouldDirty: true,
        shouldValidate: true,
      });
      setValue(`items.${index}.unit`, product.unit ?? "", { shouldDirty: true });
      setValue(`items.${index}.description`, product.description ?? "", { shouldDirty: true });
    }
  };

  return (
    <div className="grid grid-cols-2 gap-3 border-b border-gray-100 py-4 last:border-b-0 md:grid-cols-12 md:items-start md:gap-x-2">
      {products.length > 0 && (
        <InvoiceField label="کالا / خدمت" className="col-span-2 md:col-span-2" htmlFor={`${fieldId}-product`}>
          {/* productId rides along as a hidden registered field; the select only seeds the row. */}
          <input type="hidden" {...register(`items.${index}.productId`)} />
          <select
            id={`${fieldId}-product`}
            value={item?.productId ?? ""}
            onChange={handleProductChange}
            className={invoiceInputClassName(false)}
          >
            <option value="">قلم دستی…</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name} — {formatCurrency(product.price, currency)}
              </option>
            ))}
          </select>
        </InvoiceField>
      )}

      <div className={clsx("col-span-2 space-y-2", products.length > 0 ? "md:col-span-3" : "md:col-span-5")}>
        <InvoiceField label="عنوان قلم" required error={rowErrors?.title?.message} htmlFor={`${fieldId}-title`}>
          <input
            id={`${fieldId}-title`}
            type="text"
            placeholder="مثلاً: خدمات طراحی وب‌سایت"
            className={invoiceInputClassName(Boolean(rowErrors?.title))}
            aria-invalid={Boolean(rowErrors?.title)}
            {...register(`items.${index}.title`)}
          />
        </InvoiceField>
        <input
          type="text"
          placeholder="توضیح کوتاه (اختیاری)"
          aria-label="توضیحات قلم"
          className={clsx(invoiceInputClassName(Boolean(rowErrors?.description)), "text-xs")}
          {...register(`items.${index}.description`)}
        />
      </div>

      <InvoiceField
        label="تعداد"
        error={rowErrors?.quantity?.message}
        className="col-span-1 md:col-span-1"
        htmlFor={`${fieldId}-quantity`}
      >
        <input
          id={`${fieldId}-quantity`}
          type="text"
          inputMode="decimal"
          dir="ltr"
          className={invoiceInputClassName(Boolean(rowErrors?.quantity))}
          aria-invalid={Boolean(rowErrors?.quantity)}
          {...register(`items.${index}.quantity`)}
        />
      </InvoiceField>

      <InvoiceField label="واحد" className="col-span-1 md:col-span-1" htmlFor={`${fieldId}-unit`}>
        <input
          id={`${fieldId}-unit`}
          type="text"
          placeholder="عدد"
          className={invoiceInputClassName(false)}
          {...register(`items.${index}.unit`)}
        />
      </InvoiceField>

      <InvoiceField
        label="قیمت واحد"
        error={rowErrors?.unitPrice?.message}
        className="col-span-1 md:col-span-2"
        htmlFor={`${fieldId}-unit-price`}
      >
        <input
          id={`${fieldId}-unit-price`}
          type="text"
          inputMode="decimal"
          dir="ltr"
          placeholder="0"
          className={invoiceInputClassName(Boolean(rowErrors?.unitPrice))}
          aria-invalid={Boolean(rowErrors?.unitPrice)}
          {...register(`items.${index}.unitPrice`)}
        />
      </InvoiceField>

      <InvoiceField
        label="تخفیف (٪)"
        error={rowErrors?.discountPercent?.message}
        className="col-span-1 md:col-span-1"
        htmlFor={`${fieldId}-discount`}
      >
        <input
          id={`${fieldId}-discount`}
          type="text"
          inputMode="decimal"
          dir="ltr"
          className={invoiceInputClassName(Boolean(rowErrors?.discountPercent))}
          aria-invalid={Boolean(rowErrors?.discountPercent)}
          {...register(`items.${index}.discountPercent`)}
        />
      </InvoiceField>

      <div className="col-span-2 md:col-span-2 flex items-end justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="block text-xs font-medium text-gray-700">جمع سطر</p>
          <p
            className={clsx(
              "flex h-[38px] items-center truncate text-sm font-semibold tabular-nums",
              lineTotal !== null ? "text-gray-900" : "text-gray-400",
            )}
            title={lineTotal !== null ? formatCurrency(lineTotal.toString(), currency) : undefined}
          >
            {lineTotal !== null ? formatCurrency(lineTotal.toString(), currency) : "—"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="حذف قلم"
          className="h-9 w-9 shrink-0 mb-px text-gray-400 hover:text-rose-600 hover:bg-rose-50"
        >
          <XIcon size={16} />
        </Button>
      </div>
    </div>
  );
}
