import * as React from "react";
import clsx from "clsx";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { CreditCardIcon } from "@/components/icons";
import {
  formatPersianNumber,
  formatPersianDateShort,
  formatCurrency,
  formatSubscriptionPaymentStatus,
} from "@/lib/formatters";
import type { SubscriptionPaymentHistoryDTO } from "@/server/subscription/subscriptionDisplayService";

/**
 * Presentational payment-history table — renders the capped, newest-first
 * list assembled by `subscriptionDisplayService`. Money is already a fixed
 * string; dates are already ISO; only formatting happens here.
 */

/**
 * The gateway adapter identifier is internal vocabulary; present a neutral
 * gateway label instead of leaking adapter names (the sandbox adapter in
 * particular must never look like a real charge to the user).
 */
function formatProvider(provider: string): string {
  switch (provider) {
    case "zarinpal":
      return "درگاه زارین‌پال";
    case "sandbox":
      return "درگاه آزمایشی";
    default:
      return "درگاه پرداخت";
  }
}

export interface PaymentHistoryTableProps {
  payments: SubscriptionPaymentHistoryDTO[];
  className?: string;
}

export function PaymentHistoryTable({ payments, className }: PaymentHistoryTableProps) {
  return (
    <Card className={className}>
      <CardHeader className="p-5 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
            <CreditCardIcon size={18} />
          </div>
          <CardTitle className="text-sm font-bold text-gray-900">سوابق پرداخت اشتراک</CardTitle>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {payments.length === 0 ? (
          <EmptyState
            icon={<CreditCardIcon size={24} />}
            title="هنوز تراکنشی ثبت نشده است"
            description="پس از پرداخت، تراکنش‌های شما در این بخش نمایش داده می‌شود."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500">تاریخ</th>
                  <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500">پلن</th>
                  <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500">مبلغ</th>
                  <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500">درگاه</th>
                  <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500">وضعیت</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {payments.map((payment) => {
                  const status = formatSubscriptionPaymentStatus(payment.status);
                  return (
                    <tr key={payment.id} className="hover:bg-gray-50/40 transition-colors">
                      <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">
                        {formatPersianDateShort(payment.createdAt)}
                      </td>
                      <td className="px-5 py-3 text-xs text-gray-700 whitespace-nowrap">
                        {payment.planName ?? "—"}
                      </td>
                      <td className="px-5 py-3 text-xs font-semibold text-gray-900 whitespace-nowrap">
                        {formatCurrency(payment.amount, payment.currency)}
                      </td>
                      <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {formatProvider(payment.provider)}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <Badge variant={status.variant} showDot>
                          {status.label}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className={clsx("px-5 py-2.5 border-t border-gray-50 text-[10px] text-gray-400")}>
              {formatPersianNumber(payments.length)} تراکنش اخیر نمایش داده شده است.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
