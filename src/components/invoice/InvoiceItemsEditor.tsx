"use client";

import { useFieldArray, useFormContext } from "react-hook-form";
import type { ProductDTO } from "@/server/actions/dto";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/icons";
import { InvoiceItemRow } from "@/components/invoice/InvoiceItemRow";
import type { InvoiceEditorFields, InvoiceEditorItemFields } from "@/components/invoice/invoiceEditorSchema";

export interface InvoiceItemsEditorProps {
  products: ProductDTO[];
  currency: string;
}

/** Defaults for a fresh invoice line. */
export function createEmptyItem(): InvoiceEditorItemFields {
  return {
    productId: "",
    title: "",
    description: "",
    unit: "",
    quantity: "1",
    unitPrice: "",
    discountPercent: "0",
  };
}

/**
 * The line-item list of the invoice editor: add/remove rows, each bound to a
 * `items.<index>` field-array entry. At least one row always exists (the
 * domain requires a non-empty items array).
 */
export function InvoiceItemsEditor({ products, currency }: InvoiceItemsEditorProps) {
  const {
    control,
    formState: { errors },
  } = useFormContext<InvoiceEditorFields>();

  const { fields, append, remove } = useFieldArray({ control, name: "items" });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle>اقلام فاکتور</CardTitle>
            <CardDescription>
              {products.length > 0
                ? "کالا یا خدمت را انتخاب کنید یا قلم دستی ثبت کنید"
                : "اقلام فاکتور را به‌صورت دستی وارد کنید"}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 self-start sm:self-center"
            onClick={() => append(createEmptyItem())}
          >
            <PlusIcon size={16} />
            <span>افزودن قلم</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {products.length === 0 && (
          <p className="mb-4 rounded-lg border border-dashed border-gray-200 bg-gray-50/50 px-3 py-2.5 text-xs leading-relaxed text-gray-500">
            برای این کسب‌وکار هنوز کالا یا خدمتی ثبت نشده است. قلم‌ها را دستی وارد کنید؛ یا بعداً در بخش
            «محصولات و خدمات» کاتالوگ بسازید تا با یک کلیک قیمت‌ها پر شوند.
          </p>
        )}

        <div className="min-w-0">
          {fields.map((field, index) => (
            <InvoiceItemRow
              key={field.id}
              index={index}
              products={products}
              currency={currency}
              canRemove={fields.length > 1}
              onRemove={() => remove(index)}
            />
          ))}
        </div>

        {errors.items?.message && (
          <p className="mt-2 text-[11px] leading-relaxed text-rose-600" role="alert">
            {errors.items.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
