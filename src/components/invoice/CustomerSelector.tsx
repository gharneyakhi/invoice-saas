"use client";

import Link from "next/link";
import { useFormContext, useWatch } from "react-hook-form";
import type { CustomerDTO } from "@/server/actions/dto";
import { InvoiceField, invoiceInputClassName } from "@/components/invoice/InvoiceField";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";

/**
 * Customer picker bound to the `customerId` form field. Lists only the real
 * customers of the current business (loaded server-side with ownership
 * checks); selecting one never sends any customer data to the invoice beyond
 * its id — the server re-verifies ownership on save.
 */
export function CustomerSelector({ customers }: { customers: CustomerDTO[] }) {
  const { register, control } = useFormContext<InvoiceEditorFields>();
  const customerId = useWatch({ control, name: "customerId" });
  const selected = customers.find((customer) => customer.id === customerId);

  return (
    <InvoiceField label="مشتری (اختیاری)" htmlFor="invoice-customer">
      {customers.length > 0 ? (
        <>
          <select id="invoice-customer" className={invoiceInputClassName(false)} {...register("customerId")}>
            <option value="">بدون مشتری (فاکتور نقدی)</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
                {customer.mobile ? ` — ${customer.mobile}` : ""}
              </option>
            ))}
          </select>
          {selected && (selected.mobile || selected.phone || selected.email) && (
            <p className="text-[11px] text-gray-400 leading-relaxed" dir="ltr">
              {[selected.mobile, selected.phone, selected.email].filter(Boolean).join(" · ")}
            </p>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/50 px-3 py-2.5 text-xs text-gray-500 leading-relaxed">
          هنوز مشتری برای این کسب‌وکار ثبت نشده است. می‌توانید بدون مشتری ادامه دهید یا بعداً از بخش{" "}
          <Link href="/dashboard/customers" className="text-blue-600 hover:underline">
            مشتریان
          </Link>{" "}
          یک مشتری اضافه کنید.
        </div>
      )}
    </InvoiceField>
  );
}
