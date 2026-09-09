"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { AlertCircleIcon } from "@/components/icons";
import { createCustomer, updateCustomer } from "@/server/actions/customerActions";
import type { ActionErrorCode } from "@/server/actions/actionResult";
import type { CustomerDTO } from "@/server/actions/dto";
import {
  customerFormResolver,
  customerToFormValues,
  emptyCustomerFormValues,
  toCreateCustomerPayload,
  toUpdateCustomerPayload,
  type CustomerFormFields,
} from "@/components/customer/customerFormSchema";

/**
 * Create/edit dialog for one customer of the current business.
 *
 * Flow: UI → `createCustomer` / `updateCustomer` Server Action →
 * `customerService` → Prisma. The browser only ever sends the editable
 * columns; `businessId` travels as an untrusted *identifier* and ownership,
 * the archived-business rule and every format check are re-verified
 * server-side on each save. On success the returned DTO is handed to
 * `onSaved` so the list can update in place without a page reload.
 */

/** Friendly Persian copy per stable action error code — internal errors never surface. */
const SAVE_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.",
  FORBIDDEN: "شما به این کسب‌وکار دسترسی ندارید.",
  NOT_FOUND: "مشتری مورد نظر یافت نشد. ممکن است حذف شده باشد.",
  VALIDATION_ERROR: "اطلاعات وارد شده معتبر نیست. لطفاً فرم را دوباره بررسی کنید.",
  BUSINESS_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  INVOICE_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  ENTITLEMENT_DATA_ERROR: "اطلاعات اشتراک در دسترس نیست. لطفاً با پشتیبانی تماس بگیرید.",
  FILE_STORAGE_NOT_CONFIGURED: "سرویس ذخیره‌سازی فایل در دسترس نیست.",
  FILE_STORAGE_UPLOAD_FAILED: "بارگذاری فایل ناموفق بود؛ دوباره تلاش کنید.",
  GMAIL_NOT_CONNECTED: "حساب جیمیل متصل نیست. ابتدا جیمیل را متصل کنید.",
  GMAIL_SEND_FAILED: "ارسال از طریق جیمیل ناموفق بود. لطفاً دوباره تلاش کنید.",
  GMAIL_NOT_CONFIGURED: "سرویس ارسال جیمیل در دسترس نیست.",
  INTERNAL_ERROR: "خطای غیرمنتظره‌ای رخ داد. لطفاً چند لحظه بعد دوباره تلاش کنید.",
};

export interface CustomerFormDialogProps {
  /** `create` for a new customer, `edit` for an existing (live) one. */
  mode: "create" | "edit";
  /** Id of the business being edited — re-verified server-side on save. */
  businessId: string;
  /** Edit mode only: the customer being edited. */
  customer?: CustomerDTO;
  onClose: () => void;
  /** Called with the saved DTO so the caller can update its list in place. */
  onSaved: (customer: CustomerDTO) => void;
}

export function CustomerFormDialog({
  mode,
  businessId,
  customer,
  onClose,
  onSaved,
}: CustomerFormDialogProps) {
  const isCreate = mode === "create";
  const [serverError, setServerError] = React.useState<{
    message: string;
    detail?: string;
  } | null>(null);

  const form = useForm<CustomerFormFields, undefined, CustomerFormFields>({
    resolver: customerFormResolver,
    reValidateMode: "onChange",
    shouldFocusError: true,
    defaultValues: customer ? customerToFormValues(customer) : emptyCustomerFormValues(),
  });

  const { register, handleSubmit, formState } = form;
  const errors = formState.errors;
  const isSubmitting = formState.isSubmitting;

  const titleId = React.useId();
  const descriptionId = React.useId();

  const onSubmit = async (values: CustomerFormFields) => {
    setServerError(null);

    const result = isCreate
      ? await createCustomer(businessId, toCreateCustomerPayload(values))
      : await updateCustomer(businessId, customer?.id ?? "", toUpdateCustomerPayload(values));

    if (result.success) {
      onSaved(result.data);
      return;
    }

    setServerError({
      message: SAVE_ERROR_MESSAGES[result.error.code] ?? SAVE_ERROR_MESSAGES.INTERNAL_ERROR,
      // Domain validation details are safe (already sanitized at the action
      // boundary); anything else gets only the friendly summary.
      detail: result.error.code === "VALIDATION_ERROR" ? result.error.message : undefined,
    });
  };

  const inputDisabled = isSubmitting;

  return (
    <Dialog
      labelledBy={titleId}
      describedBy={descriptionId}
      onClose={isSubmitting ? () => undefined : onClose}
      closeOnBackdrop={!isSubmitting}
      className="max-w-2xl"
    >
      <div className="space-y-1">
        <h2 id={titleId} className="text-base font-bold text-gray-900">
          {isCreate ? "افزودن مشتری جدید" : `ویرایش «${customer?.name ?? ""}»`}
        </h2>
        <p id={descriptionId} className="text-xs leading-relaxed text-gray-500">
          {isCreate
            ? "مشخصات مشتری را وارد کنید؛ پس از ذخیره، در فهرست مشتریان و انتخاب‌گر مشتری فاکتور در دسترس خواهد بود."
            : "تغییرات فقط روی مشخصات جاری مشتری اعمال می‌شود؛ فاکتورهای نهایی‌شده قبلی بدون تغییر باقی می‌مانند."}
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-5 space-y-4">
        <Field
          label="نام مشتری"
          htmlFor="customer-name"
          required
          error={errors.name?.message}
          hint="نام شخص حقیقی یا حقوقی طرف حساب"
        >
          <Input
            id="customer-name"
            hasError={Boolean(errors.name)}
            disabled={inputDisabled}
            placeholder="مثال: شرکت نمونه / علی رضایی"
            autoComplete="off"
            aria-invalid={Boolean(errors.name)}
            {...register("name")}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="موبایل" htmlFor="customer-mobile" error={errors.mobile?.message}>
            <Input
              id="customer-mobile"
              dir="ltr"
              className="text-left"
              hasError={Boolean(errors.mobile)}
              disabled={inputDisabled}
              placeholder="09121234567"
              autoComplete="off"
              inputMode="tel"
              aria-invalid={Boolean(errors.mobile)}
              {...register("mobile")}
            />
          </Field>
          <Field label="تلفن ثابت" htmlFor="customer-phone" error={errors.phone?.message}>
            <Input
              id="customer-phone"
              dir="ltr"
              className="text-left"
              hasError={Boolean(errors.phone)}
              disabled={inputDisabled}
              placeholder="02112345678"
              autoComplete="off"
              inputMode="tel"
              aria-invalid={Boolean(errors.phone)}
              {...register("phone")}
            />
          </Field>
          <Field label="ایمیل" htmlFor="customer-email" error={errors.email?.message}>
            <Input
              id="customer-email"
              type="email"
              dir="ltr"
              className="text-left"
              hasError={Boolean(errors.email)}
              disabled={inputDisabled}
              placeholder="customer@example.com"
              autoComplete="off"
              aria-invalid={Boolean(errors.email)}
              {...register("email")}
            />
          </Field>
          <Field label="کد ملی" htmlFor="customer-national-id" error={errors.nationalId?.message}>
            <Input
              id="customer-national-id"
              dir="ltr"
              className="text-left"
              hasError={Boolean(errors.nationalId)}
              disabled={inputDisabled}
              autoComplete="off"
              inputMode="numeric"
              aria-invalid={Boolean(errors.nationalId)}
              {...register("nationalId")}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="کد اقتصادی"
              htmlFor="customer-economic-code"
              error={errors.economicCode?.message}
              hint="برای اشخاص حقوقی"
            >
              <Input
                id="customer-economic-code"
                dir="ltr"
                className="text-left"
                hasError={Boolean(errors.economicCode)}
                disabled={inputDisabled}
                autoComplete="off"
                inputMode="numeric"
                aria-invalid={Boolean(errors.economicCode)}
                {...register("economicCode")}
              />
            </Field>
          </div>
        </div>

        <Field label="آدرس" htmlFor="customer-address" error={errors.address?.message}>
          <Textarea
            id="customer-address"
            rows={2}
            hasError={Boolean(errors.address)}
            disabled={inputDisabled}
            placeholder="آدرس کامل مشتری"
            aria-invalid={Boolean(errors.address)}
            {...register("address")}
          />
        </Field>

        <Field label="یادداشت" htmlFor="customer-notes" error={errors.notes?.message}>
          <Textarea
            id="customer-notes"
            rows={3}
            hasError={Boolean(errors.notes)}
            disabled={inputDisabled}
            placeholder="توضیحات داخلی درباره این مشتری (در فاکتور چاپ نمی‌شود)"
            aria-invalid={Boolean(errors.notes)}
            {...register("notes")}
          />
        </Field>

        {serverError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-relaxed text-rose-800"
          >
            <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">{serverError.message}</p>
              {serverError.detail && (
                <p className="mt-0.5 text-[11px] opacity-80" dir="ltr">
                  {serverError.detail}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 border-t border-gray-100 pt-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={onClose}
            disabled={inputDisabled}
            className="w-full sm:w-auto"
          >
            انصراف
          </Button>
          <Button
            type="submit"
            size="md"
            isLoading={isSubmitting}
            className="w-full gap-2 font-bold sm:w-auto"
          >
            {isSubmitting ? "در حال ذخیره…" : isCreate ? "افزودن مشتری" : "ذخیره تغییرات"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
