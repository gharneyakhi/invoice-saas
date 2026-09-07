"use client";

import * as React from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { calculateInvoice, type InvoiceCalculationResult } from "@/lib/invoice-calculation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoiceField, invoiceInputClassName } from "@/components/invoice/InvoiceField";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";
import { formatCurrency, normalizeLocalizedNumber, toPersianDigits } from "@/lib/formatters";

export interface InvoiceTotalsProps {
  currency: string;
}

/**
 * Money sidebar of the editor: global discount %, VAT % (pre-filled from the
 * business' InvoiceSettings) and the live summary.
 *
 * The summary runs the *same* pure `calculateInvoice` engine the server uses,
 * purely for on-screen feedback — "browser calculations are only for UX".
 * The Server Action re-validates inputs and recalculates authoritatively
 * before persisting, so nothing displayed or computed here is ever trusted.
 */
export function InvoiceTotals({ currency }: InvoiceTotalsProps) {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<InvoiceEditorFields>();

  const values = useWatch({ control });

  const preview = React.useMemo<InvoiceCalculationResult | null>(() => {
    try {
      const items = (values.items ?? []).map((item) => ({
        unitPrice: normalizeLocalizedNumber(item?.unitPrice) || "0",
        quantity: normalizeLocalizedNumber(item?.quantity),
        discountPercent: normalizeLocalizedNumber(item?.discountPercent) || "0",
      }));

      if (items.length === 0 || items.some((item) => item.quantity === "" || Number(item.quantity) <= 0)) {
        return null;
      }

      return calculateInvoice({
        items,
        globalDiscountPercent: normalizeLocalizedNumber(values.globalDiscountPercent) || "0",
        taxPercent: normalizeLocalizedNumber(values.taxPercent) || "0",
      });
    } catch {
      // Incomplete / invalid rows simply pause the preview; the form-level
      // validation messages guide the user instead.
      return null;
    }
  }, [values]);

  const money = (value: { toString(): string } | null | undefined) =>
    value ? formatCurrency(value.toString(), currency) : "—";

  const taxPercentLabel = toPersianDigits(normalizeLocalizedNumber(values.taxPercent) || "0");
  const globalDiscountLabel = toPersianDigits(
    normalizeLocalizedNumber(values.globalDiscountPercent) || "0",
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>خلاصه و تنظیمات مالی</CardTitle>
        <CardDescription>تخفیف کلی، مالیات بر ارزش افزوده و جمع فاکتور</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <InvoiceField
            label="تخفیف کلی (٪)"
            htmlFor="invoice-global-discount"
            error={errors.globalDiscountPercent?.message}
          >
            <input
              id="invoice-global-discount"
              type="text"
              inputMode="decimal"
              dir="ltr"
              className={invoiceInputClassName(Boolean(errors.globalDiscountPercent))}
              aria-invalid={Boolean(errors.globalDiscountPercent)}
              {...register("globalDiscountPercent")}
            />
          </InvoiceField>

          <InvoiceField
            label="ارزش افزوده (٪)"
            htmlFor="invoice-tax-percent"
            error={errors.taxPercent?.message}
            hint="پیش‌فرض تنظیمات کسب‌وکار"
          >
            <input
              id="invoice-tax-percent"
              type="text"
              inputMode="decimal"
              dir="ltr"
              className={invoiceInputClassName(Boolean(errors.taxPercent))}
              aria-invalid={Boolean(errors.taxPercent)}
              {...register("taxPercent")}
            />
          </InvoiceField>
        </div>

        <div className="space-y-2.5 border-t border-gray-100 pt-4 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-gray-500">جمع اقلام</span>
            <span className="font-medium tabular-nums text-gray-900">{money(preview?.subtotal)}</span>
          </div>

          {preview && preview.itemDiscountAmount.greaterThan(0) && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500">تخفیف اقلام</span>
              <span className="font-medium tabular-nums text-amber-700">
                {money(preview.itemDiscountAmount)}−
              </span>
            </div>
          )}

          {preview && preview.globalDiscountAmount.greaterThan(0) && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500">تخفیف کلی (٪{globalDiscountLabel})</span>
              <span className="font-medium tabular-nums text-amber-700">
                {money(preview.globalDiscountAmount)}−
              </span>
            </div>
          )}

          {preview && preview.taxAmount.greaterThan(0) && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500">مالیات بر ارزش افزوده (٪{taxPercentLabel})</span>
              <span className="font-medium tabular-nums text-gray-900">+{money(preview.taxAmount)}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-gray-100 pt-3">
            <span className="font-bold text-gray-900">مبلغ قابل پرداخت</span>
            <span className="text-base font-bold tabular-nums text-blue-700">{money(preview?.total)}</span>
          </div>

          {!preview && (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-400">
              جمع فاکتور پس از تکمیل عنوان، تعداد و قیمت اقلام به‌صورت زنده نمایش داده می‌شود.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
