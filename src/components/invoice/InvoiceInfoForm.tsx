"use client";

import clsx from "clsx";
import { useFormContext, useWatch } from "react-hook-form";
import type { CustomerDTO } from "@/server/actions/dto";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoiceField, invoiceInputClassName } from "@/components/invoice/InvoiceField";
import { CustomerSelector } from "@/components/invoice/CustomerSelector";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";
import { formatPersianDate } from "@/lib/formatters";

const INVOICE_TYPE_OPTIONS: { value: InvoiceEditorFields["invoiceType"]; label: string }[] = [
  { value: "FINAL", label: "فاکتور رسمی" },
  { value: "PROFORMA", label: "پیش‌فاکتور" },
];

/** Jalali hint shown next to a Gregorian date input (empty while invalid). */
function jalaliHint(dateInput: string | undefined): string | undefined {
  if (!dateInput || isNaN(Date.parse(dateInput))) return undefined;
  return `معادل شمسی: ${formatPersianDate(dateInput)}`;
}

/**
 * Invoice header fields: type (segmented control over the domain
 * `InvoiceType` enum), customer, issue/due dates and notes. Dates are native
 * Gregorian date inputs (DB stores Date); a live Jalali equivalent is shown
 * as a hint via the shared `formatPersianDate` formatter.
 */
export function InvoiceInfoForm({ customers }: { customers: CustomerDTO[] }) {
  const {
    register,
    setValue,
    control,
    formState: { errors },
  } = useFormContext<InvoiceEditorFields>();

  const invoiceType = useWatch({ control, name: "invoiceType" });
  const issueDate = useWatch({ control, name: "issueDate" });
  const dueDate = useWatch({ control, name: "dueDate" });

  return (
    <Card>
      <CardHeader>
        <CardTitle>اطلاعات فاکتور</CardTitle>
        <CardDescription>نوع فاکتور، مشتری، تاریخ‌ها و یادداشت</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input type="hidden" {...register("invoiceType")} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InvoiceField label="نوع فاکتور" required>
            <div
              className="flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1"
              role="radiogroup"
              aria-label="نوع فاکتور"
            >
              {INVOICE_TYPE_OPTIONS.map((option) => {
                const active = invoiceType === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      setValue("invoiceType", option.value, { shouldDirty: true, shouldValidate: true })
                    }
                    className={clsx(
                      "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      active
                        ? "border border-gray-200 bg-white text-blue-700 shadow-sm"
                        : "text-gray-500 hover:text-gray-800",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {errors.invoiceType?.message && (
              <p className="text-[11px] leading-relaxed text-rose-600" role="alert">
                {errors.invoiceType.message}
              </p>
            )}
          </InvoiceField>

          <CustomerSelector customers={customers} />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InvoiceField
            label="تاریخ صدور"
            htmlFor="invoice-issue-date"
            required
            error={errors.issueDate?.message}
            hint={jalaliHint(issueDate)}
          >
            <input
              id="invoice-issue-date"
              type="date"
              dir="ltr"
              className={invoiceInputClassName(Boolean(errors.issueDate))}
              aria-invalid={Boolean(errors.issueDate)}
              {...register("issueDate")}
            />
          </InvoiceField>

          <InvoiceField
            label="تاریخ سررسید (اختیاری)"
            htmlFor="invoice-due-date"
            error={errors.dueDate?.message}
            hint={jalaliHint(dueDate)}
          >
            <input
              id="invoice-due-date"
              type="date"
              dir="ltr"
              className={invoiceInputClassName(Boolean(errors.dueDate))}
              aria-invalid={Boolean(errors.dueDate)}
              {...register("dueDate")}
            />
          </InvoiceField>
        </div>

        <InvoiceField
          label="یادداشت فاکتور (اختیاری)"
          htmlFor="invoice-notes"
          error={errors.notes?.message}
        >
          <textarea
            id="invoice-notes"
            rows={3}
            placeholder="توضیحات تکمیلی برای نمایش روی فاکتور…"
            className={clsx(invoiceInputClassName(Boolean(errors.notes)), "resize-y leading-relaxed")}
            aria-invalid={Boolean(errors.notes)}
            {...register("notes")}
          />
        </InvoiceField>
      </CardContent>
    </Card>
  );
}
