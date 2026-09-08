import { Button } from "@/components/ui/button";
import type { CustomerDTO } from "@/server/actions/dto";
import { formatPersianDateShort, toPersianDigits } from "@/lib/formatters";
import { ArchiveIcon, PencilIcon } from "@/components/icons";
import { customerInitial } from "@/components/customer/customerListUtils";

/**
 * Customer list — responsive RTL.
 *
 * Desktop renders a real table; below `md` the same rows become stacked
 * cards so nothing is horizontally clipped on a phone. Pure presentation:
 * it renders exactly the (already ownership-checked) rows it receives, and
 * reports edit/archive intent back to the caller — all mutations run through
 * the existing Server Actions in the dialogs.
 */
export interface CustomerListTableProps {
  customers: CustomerDTO[];
  onEdit: (customer: CustomerDTO) => void;
  onArchive: (customer: CustomerDTO) => void;
}

function RowActions({
  customer,
  onEdit,
  onArchive,
}: {
  customer: CustomerDTO;
  onEdit: (customer: CustomerDTO) => void;
  onArchive: (customer: CustomerDTO) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => onEdit(customer)}
        aria-label={`ویرایش ${customer.name}`}
      >
        <PencilIcon size={14} />
        <span>ویرایش</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-rose-600 hover:bg-rose-50 hover:text-rose-700"
        onClick={() => onArchive(customer)}
        aria-label={`بایگانی ${customer.name}`}
      >
        <ArchiveIcon size={14} />
        <span>بایگانی</span>
      </Button>
    </div>
  );
}

export function CustomerListTable({ customers, onEdit, onArchive }: CustomerListTableProps) {
  return (
    <>
      {/* Desktop */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-right text-xs">
          <caption className="sr-only">فهرست مشتریان کسب‌وکار جاری</caption>
          <thead className="border-y border-gray-100 bg-gray-50/75 text-gray-500">
            <tr>
              <th scope="col" className="px-5 py-3 font-semibold">
                مشتری
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                تماس
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                ایمیل
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                شناسه‌ها
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
            {customers.map((customer) => (
              <tr key={customer.id} className="transition-colors hover:bg-gray-50/80">
                <td className="max-w-[240px] px-5 py-3.5">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-bold text-blue-700"
                      aria-hidden="true"
                    >
                      {customerInitial(customer.name)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-gray-900" title={customer.name}>
                        {customer.name}
                      </p>
                      {customer.address ? (
                        <p className="mt-0.5 truncate text-[11px] text-gray-400" title={customer.address}>
                          {customer.address}
                        </p>
                      ) : (
                        <p className="mt-0.5 text-[11px] text-gray-300">بدون آدرس</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-gray-700">
                  {customer.mobile || customer.phone ? (
                    <div className="space-y-0.5" dir="ltr">
                      {customer.mobile && <p>{customer.mobile}</p>}
                      {customer.phone && <p className="text-gray-500">{customer.phone}</p>}
                    </div>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="max-w-[200px] px-4 py-3.5">
                  {customer.email ? (
                    <p className="truncate font-sans text-gray-600" dir="ltr" title={customer.email}>
                      {customer.email}
                    </p>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-gray-600">
                  {customer.nationalId || customer.economicCode ? (
                    <div className="space-y-0.5">
                      {customer.nationalId && (
                        <p title="کد ملی">
                          <span className="text-gray-400">ملی: </span>
                          {toPersianDigits(customer.nationalId)}
                        </p>
                      )}
                      {customer.economicCode && (
                        <p title="کد اقتصادی">
                          <span className="text-gray-400">اقتصادی: </span>
                          {toPersianDigits(customer.economicCode)}
                        </p>
                      )}
                    </div>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-gray-500">
                  {formatPersianDateShort(customer.createdAt)}
                </td>
                <td className="px-5 py-3.5">
                  <div className="flex justify-end">
                    <RowActions customer={customer} onEdit={onEdit} onArchive={onArchive} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <ul className="divide-y divide-gray-100 md:hidden">
        {customers.map((customer) => (
          <li key={customer.id} className="space-y-3 bg-white p-4">
            <div className="flex items-start gap-2.5">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-base font-bold text-blue-700"
                aria-hidden="true"
              >
                {customerInitial(customer.name)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-gray-900">{customer.name}</p>
                <p className="mt-0.5 font-sans text-[11px] text-gray-400">
                  ثبت: {formatPersianDateShort(customer.createdAt)}
                </p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-[11px] text-gray-400">موبایل</dt>
                <dd className="mt-0.5 font-sans text-gray-700" dir="ltr">
                  {customer.mobile ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-gray-400">تلفن ثابت</dt>
                <dd className="mt-0.5 font-sans text-gray-700" dir="ltr">
                  {customer.phone ?? "—"}
                </dd>
              </div>
              {(customer.email || customer.nationalId || customer.economicCode) && (
                <>
                  {customer.email && (
                    <div className="col-span-2">
                      <dt className="text-[11px] text-gray-400">ایمیل</dt>
                      <dd className="mt-0.5 truncate font-sans text-gray-700" dir="ltr">
                        {customer.email}
                      </dd>
                    </div>
                  )}
                  {customer.nationalId && (
                    <div>
                      <dt className="text-[11px] text-gray-400">کد ملی</dt>
                      <dd className="mt-0.5 font-sans text-gray-700">
                        {toPersianDigits(customer.nationalId)}
                      </dd>
                    </div>
                  )}
                  {customer.economicCode && (
                    <div>
                      <dt className="text-[11px] text-gray-400">کد اقتصادی</dt>
                      <dd className="mt-0.5 font-sans text-gray-700">
                        {toPersianDigits(customer.economicCode)}
                      </dd>
                    </div>
                  )}
                </>
              )}
              {customer.address && (
                <div className="col-span-2">
                  <dt className="text-[11px] text-gray-400">آدرس</dt>
                  <dd className="mt-0.5 line-clamp-2 leading-relaxed text-gray-700">
                    {customer.address}
                  </dd>
                </div>
              )}
            </dl>

            <div className="flex justify-end border-t border-gray-100 pt-3">
              <RowActions customer={customer} onEdit={onEdit} onArchive={onArchive} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
