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
 * Line-item editor layout (UI only).
 *
 * The invoice form sits in the ~42% desktop column beside the live A4 preview,
 * so a single 12-column row cannot give numeric fields a usable width. Identity
 * fields (product / title) take the flexible first band; quantity, unit, price,
 * discount % and the two money readouts reflow on a second band. Container
 * queries follow the card width, not the viewport, so the editor never relies
 * on page-level horizontal overflow.
 */
export const ITEM_ROW_CLASS = "space-y-3 border-b border-gray-100 py-4 last:border-b-0";
export const ITEM_IDENTITY_ROW_CLASS = "flex flex-col gap-3 @[36rem]:flex-row @[36rem]:items-start";
export const ITEM_PRODUCT_FIELD_CLASS = "w-full min-w-0 @[36rem]:w-56 @[36rem]:shrink-0";
export const ITEM_TITLE_FIELD_CLASS = "min-w-0 flex-1 space-y-2";
export const ITEM_NUMBERS_ROW_CLASS = "grid grid-cols-2 gap-3 @[28rem]:grid-cols-3";
/** Floor for compact numeric cells (qty, unit, discount %). */
export const ITEM_COMPACT_FIELD_CLASS = "min-w-[5.5rem]";
/** Practical floor so «تخفیف (٪)» never collapses into a sliver. */
export const ITEM_DISCOUNT_FIELD_CLASS = ITEM_COMPACT_FIELD_CLASS;
export const ITEM_MONEY_FIELD_CLASS = "min-w-[7rem]";
export const ITEM_NUMERIC_INPUT_CLASS = "min-w-[5.5rem]";

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

  const line = React.useMemo(() => {
    try {
      const unitPrice = normalizeLocalizedNumber(item?.unitPrice);
      const quantity = normalizeLocalizedNumber(item?.quantity);
      const discountPercent = normalizeLocalizedNumber(item?.discountPercent) || "0";
      if (unitPrice === "" || quantity === "" || Number(quantity) <= 0) return null;
      return calculateLineItem({ unitPrice, quantity, discountPercent });
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

  const numericInputClass = (hasError?: boolean) =>
    clsx(invoiceInputClassName(hasError), ITEM_NUMERIC_INPUT_CLASS, "tabular-nums");

  return (
    <div className={ITEM_ROW_CLASS}>
      <div className={ITEM_IDENTITY_ROW_CLASS}>
        {products.length > 0 && (
          <InvoiceField
            label="کالا / خدمت"
            className={ITEM_PRODUCT_FIELD_CLASS}
            htmlFor={`${fieldId}-product`}
          >
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

        <div className={ITEM_TITLE_FIELD_CLASS}>
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

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="حذف ردیف"
          className="h-9 w-9 shrink-0 self-start text-gray-400 hover:bg-rose-50 hover:text-rose-600 @[36rem]:mt-[1.625rem]"
        >
          <XIcon size={16} />
        </Button>
      </div>

      <div className={ITEM_NUMBERS_ROW_CLASS}>
        <InvoiceField
          label="تعداد"
          error={rowErrors?.quantity?.message}
          className={ITEM_COMPACT_FIELD_CLASS}
          htmlFor={`${fieldId}-quantity`}
        >
          <input
            id={`${fieldId}-quantity`}
            type="text"
            inputMode="decimal"
            dir="ltr"
            className={numericInputClass(Boolean(rowErrors?.quantity))}
            aria-invalid={Boolean(rowErrors?.quantity)}
            {...register(`items.${index}.quantity`)}
          />
        </InvoiceField>

        <InvoiceField label="واحد" className={ITEM_DISCOUNT_FIELD_CLASS} htmlFor={`${fieldId}-unit`}>
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
          className={ITEM_MONEY_FIELD_CLASS}
          htmlFor={`${fieldId}-unit-price`}
        >
          <input
            id={`${fieldId}-unit-price`}
            type="text"
            inputMode="decimal"
            dir="ltr"
            placeholder="0"
            className={numericInputClass(Boolean(rowErrors?.unitPrice))}
            aria-invalid={Boolean(rowErrors?.unitPrice)}
            {...register(`items.${index}.unitPrice`)}
          />
        </InvoiceField>

        <InvoiceField
          label="تخفیف (٪)"
          error={rowErrors?.discountPercent?.message}
          className={ITEM_DISCOUNT_FIELD_CLASS}
          htmlFor={`${fieldId}-discount`}
        >
          <input
            id={`${fieldId}-discount`}
            type="text"
            inputMode="decimal"
            dir="ltr"
            className={numericInputClass(Boolean(rowErrors?.discountPercent))}
            aria-invalid={Boolean(rowErrors?.discountPercent)}
            {...register(`items.${index}.discountPercent`)}
          />
        </InvoiceField>

        <MoneyReadout
          label="مبلغ تخفیف"
          value={line ? formatCurrency(line.discountAmount.toString(), currency) : null}
        />

        <MoneyReadout
          label="مبلغ نهایی"
          value={line ? formatCurrency(line.total.toString(), currency) : null}
        />
      </div>
    </div>
  );
}

function MoneyReadout({ label, value }: { label: string; value: string | null }) {
  return (
    <div className={clsx(ITEM_MONEY_FIELD_CLASS, "space-y-1.5")}>
      <p className="block text-xs font-medium text-gray-700">{label}</p>
      <p
        className={clsx(
          "flex h-[38px] items-center text-sm font-semibold tabular-nums whitespace-nowrap",
          value ? "text-gray-900" : "text-gray-400",
        )}
        title={value ?? undefined}
      >
        {value ?? "—"}
      </p>
    </div>
  );
}
