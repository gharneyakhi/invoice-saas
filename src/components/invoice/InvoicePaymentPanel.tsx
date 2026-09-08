"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  createInvoicePayment,
  deleteInvoicePayment,
} from "@/server/actions/paymentActions";
import type { InvoicePaymentDTO } from "@/server/actions/dto";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  formatCurrency,
  formatGregorianDateInput,
  formatPaymentMethod,
  formatPersianDate,
  normalizeLocalizedNumber,
} from "@/lib/formatters";
import { formatInvoiceStatus } from "@/lib/formatters";

/**
 * Payment management UI for a finalized invoice.
 *
 * Status is NEVER edited here. The only write path is the existing
 * `InvoicePayment` Server Actions; `paidAmount` / `remainingAmount` / `status`
 * are recalculated server-side from the payment rows.
 */

const METHOD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CASH", label: "نقد" },
  { value: "CARD", label: "کارت" },
  { value: "BANK_TRANSFER", label: "انتقال بانکی" },
  { value: "ONLINE", label: "آنلاین" },
  { value: "OTHER", label: "سایر" },
];

export interface InvoicePaymentPanelProps {
  invoiceId: string;
  currency: string;
  total: string;
  paidAmount: string;
  remainingAmount: string;
  status: string;
  payments: InvoicePaymentDTO[];
  /** Cancelled invoices keep history visible but refuse new writes. */
  readOnly?: boolean;
}

export function InvoicePaymentPanel({
  invoiceId,
  currency,
  total,
  paidAmount,
  remainingAmount,
  status,
  payments,
  readOnly = false,
}: InvoicePaymentPanelProps) {
  const router = useRouter();
  const remaining = Number(remainingAmount);
  const canRegister = !readOnly && Number.isFinite(remaining) && remaining > 0;

  const [amount, setAmount] = React.useState("");
  const [paymentDate, setPaymentDate] = React.useState(() => formatGregorianDateInput(new Date()));
  const [method, setMethod] = React.useState("CASH");
  const [referenceNumber, setReferenceNumber] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);

  const statusMeta = formatInvoiceStatus(status);

  const resetForm = () => {
    setAmount("");
    setPaymentDate(formatGregorianDateInput(new Date()));
    setMethod("CASH");
    setReferenceNumber("");
    setNotes("");
  };

  const submit = async (overrideAmount?: string) => {
    if (!canRegister || pending) return;
    setError(null);

    const raw = overrideAmount ?? amount;
    const canonical = normalizeLocalizedNumber(raw);
    if (canonical === "" || Number(canonical) <= 0) {
      setError("مبلغ پرداخت باید بزرگ‌تر از صفر باشد.");
      return;
    }

    setPending(true);
    try {
      const result = await createInvoicePayment(invoiceId, {
        amount: canonical,
        paymentDate: paymentDate ? new Date(`${paymentDate}T12:00:00.000Z`) : undefined,
        method,
        referenceNumber: referenceNumber.trim() === "" ? null : referenceNumber,
        notes: notes.trim() === "" ? null : notes,
      });
      if (!result.success) {
        setError(
          result.error.code === "VALIDATION_ERROR"
            ? result.error.message
            : "ثبت پرداخت ناموفق بود. لطفاً دوباره تلاش کنید.",
        );
        return;
      }
      resetForm();
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  const prefillRemaining = () => {
    const whole = remainingAmount.replace(/\.00$/, "");
    setAmount(whole);
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId || readOnly) return;
    setDeletingId(confirmDeleteId);
    setError(null);
    try {
      const result = await deleteInvoicePayment(confirmDeleteId);
      if (!result.success) {
        setError(
          result.error.code === "VALIDATION_ERROR"
            ? result.error.message
            : "حذف پرداخت ناموفق بود. لطفاً دوباره تلاش کنید.",
        );
        return;
      }
      setConfirmDeleteId(null);
      router.refresh();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">مدیریت پرداخت</CardTitle>
        <CardDescription>
          وضعیت پرداخت از مجموع پرداخت‌های ثبت‌شده محاسبه می‌شود و به‌صورت دستی قابل تغییر نیست.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid grid-cols-2 gap-3 rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-[11px] text-gray-400">مبلغ کل</dt>
            <dd className="mt-0.5 font-sans font-semibold text-gray-900">{formatCurrency(total, currency)}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-gray-400">پرداخت‌شده</dt>
            <dd className="mt-0.5 font-sans font-semibold text-emerald-700">
              {formatCurrency(paidAmount, currency)}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-gray-400">مانده</dt>
            <dd className="mt-0.5 font-sans font-semibold text-gray-900">
              {formatCurrency(remainingAmount, currency)}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-gray-400">وضعیت پرداخت</dt>
            <dd className="mt-1">
              <Badge variant={statusMeta.variant} showDot>
                {statusMeta.label}
              </Badge>
            </dd>
          </div>
        </dl>

        {error && (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {error}
          </p>
        )}

        {canRegister && (
          <form
            className="space-y-3 rounded-xl border border-gray-200 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p className="text-xs font-semibold text-gray-800">ثبت پرداخت</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="مبلغ" htmlFor="payment-amount" required hint={`مانده: ${formatCurrency(remainingAmount, currency)}`}>
                <Input
                  id="payment-amount"
                  dir="ltr"
                  className="text-left"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder={remainingAmount.replace(/\.00$/, "")}
                  disabled={pending}
                />
              </Field>
              <Field label="تاریخ پرداخت" htmlFor="payment-date">
                <Input
                  id="payment-date"
                  type="date"
                  dir="ltr"
                  className="text-left"
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                  disabled={pending}
                />
              </Field>
              <Field label="روش پرداخت" htmlFor="payment-method" required>
                <Select
                  id="payment-method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                  disabled={pending}
                >
                  {METHOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="شماره پیگیری" htmlFor="payment-ref">
                <Input
                  id="payment-ref"
                  value={referenceNumber}
                  onChange={(event) => setReferenceNumber(event.target.value)}
                  disabled={pending}
                />
              </Field>
            </div>
            <Field label="یادداشت" htmlFor="payment-notes">
              <Textarea
                id="payment-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={pending}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" isLoading={pending} className="font-bold">
                ثبت پرداخت
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={prefillRemaining}
              >
                ثبت پرداخت کامل
              </Button>
            </div>
          </form>
        )}

        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-800">تاریخچه پرداخت‌ها</p>
          {payments.length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-[11px] text-gray-400">
              هنوز پرداختی برای این فاکتور ثبت نشده است.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
              {payments.map((payment) => (
                <li key={payment.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-xs">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-sans font-semibold text-gray-900">
                      {formatCurrency(payment.amount, currency)}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      {formatPaymentMethod(payment.method)} · {formatPersianDate(payment.paymentDate)}
                      {payment.referenceNumber ? ` · پیگیری ${payment.referenceNumber}` : ""}
                    </p>
                    {payment.notes && (
                      <p className="text-[11px] leading-relaxed text-gray-500">{payment.notes}</p>
                    )}
                  </div>
                  {!readOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-rose-600 hover:text-rose-700"
                      disabled={deletingId === payment.id}
                      onClick={() => setConfirmDeleteId(payment.id)}
                    >
                      حذف
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      {confirmDeleteId && (
        <Dialog
          labelledBy="delete-payment-title"
          describedBy="delete-payment-desc"
          onClose={() => setConfirmDeleteId(null)}
          className="max-w-sm"
        >
          <h2 id="delete-payment-title" className="text-sm font-bold text-gray-900">
            حذف پرداخت
          </h2>
          <p id="delete-payment-desc" className="mt-2 text-xs leading-relaxed text-gray-600">
            با حذف این پرداخت، مانده و وضعیت فاکتور دوباره از مجموع پرداخت‌های باقی‌مانده محاسبه می‌شود.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>
              انصراف
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              isLoading={deletingId === confirmDeleteId}
              onClick={() => void confirmDelete()}
            >
              حذف پرداخت
            </Button>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
