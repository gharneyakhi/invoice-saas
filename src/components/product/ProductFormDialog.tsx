"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { AlertCircleIcon } from "@/components/icons";
import { createProduct, updateProduct } from "@/server/actions/productActions";
import type { ActionErrorCode } from "@/server/actions/actionResult";
import type { ProductDTO } from "@/server/actions/dto";
import { formatCurrency, normalizeLocalizedNumber } from "@/lib/formatters";
import {
  productFormResolver,
  productToFormValues,
  emptyProductFormValues,
  toCreateProductPayload,
  toUpdateProductPayload,
  type ProductFormFields,
} from "@/components/product/productFormSchema";

/**
 * Create/edit dialog for one product/service of the current business.
 *
 * Flow: UI → `createProduct` / `updateProduct` Server Action →
 * `productService` → Prisma. The browser only ever sends the editable
 * columns of `model Product` (name, description, price, unit, active);
 * `businessId` travels as an untrusted *identifier* and ownership, the
 * archived-business/archived-product rules and every format check are
 * re-verified server-side on each save. On success the returned DTO is
 * handed to `onSaved` so the list can update in place without a page reload.
 *
 * Editing here never touches invoicing history: `InvoiceItem` rows keep
 * their own title/unitPrice/unit/description snapshot, so a repriced or
 * renamed product leaves finalized invoices exactly as they were.
 */

/** Friendly Persian copy per stable action error code — internal errors never surface. */
const SAVE_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.",
  FORBIDDEN: "شما به این کسب‌وکار دسترسی ندارید.",
  NOT_FOUND: "محصول مورد نظر یافت نشد. ممکن است حذف شده باشد.",
  VALIDATION_ERROR: "اطلاعات وارد شده معتبر نیست. لطفاً فرم را دوباره بررسی کنید.",
  BUSINESS_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  INVOICE_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  ENTITLEMENT_DATA_ERROR: "اطلاعات اشتراک در دسترس نیست. لطفاً با پشتیبانی تماس بگیرید.",
  FILE_STORAGE_NOT_CONFIGURED: "سرویس ذخیره‌سازی فایل در دسترس نیست.",
  FILE_STORAGE_UPLOAD_FAILED: "بارگذاری فایل ناموفق بود؛ دوباره تلاش کنید.",
  INTERNAL_ERROR: "خطای غیرمنتظره‌ای رخ داد. لطفاً چند لحظه بعد دوباره تلاش کنید.",
};

export interface ProductFormDialogProps {
  /** `create` for a new product/service, `edit` for an existing (live) one. */
  mode: "create" | "edit";
  /** Id of the business being edited — re-verified server-side on save. */
  businessId: string;
  /** Edit mode only: the product being edited. */
  product?: ProductDTO;
  onClose: () => void;
  /** Called with the saved DTO so the caller can update its list in place. */
  onSaved: (product: ProductDTO) => void;
}

export function ProductFormDialog({
  mode,
  businessId,
  product,
  onClose,
  onSaved,
}: ProductFormDialogProps) {
  const isCreate = mode === "create";
  const [serverError, setServerError] = React.useState<{
    message: string;
    detail?: string;
  } | null>(null);

  const form = useForm<ProductFormFields, undefined, ProductFormFields>({
    resolver: productFormResolver,
    reValidateMode: "onChange",
    shouldFocusError: true,
    defaultValues: product ? productToFormValues(product) : emptyProductFormValues(),
  });

  const { register, handleSubmit, watch, formState } = form;
  const errors = formState.errors;
  const isSubmitting = formState.isSubmitting;

  // Live Persian preview of the localized price input (digits/separators are
  // folded by the same utility the invoice editor uses).
  const priceValue = watch("price");
  const pricePreview = React.useMemo(() => {
    const normalized = normalizeLocalizedNumber(priceValue);
    return normalized === "" ? null : formatCurrency(normalized);
  }, [priceValue]);

  const titleId = React.useId();
  const descriptionId = React.useId();

  const onSubmit = async (values: ProductFormFields) => {
    setServerError(null);

    const result = isCreate
      ? await createProduct(businessId, toCreateProductPayload(values))
      : await updateProduct(businessId, product?.id ?? "", toUpdateProductPayload(values));

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
          {isCreate ? "افزودن کالا / خدمت جدید" : `ویرایش «${product?.name ?? ""}»`}
        </h2>
        <p id={descriptionId} className="text-xs leading-relaxed text-gray-500">
          {isCreate
            ? "مشخصات قلم را وارد کنید؛ پس از ذخیره، در فهرست محصولات و انتخاب‌گر کالای فاکتور در دسترس خواهد بود."
            : "تغییرات فقط روی همین قلم اعمال می‌شود؛ فاکتورهای صادرشده قبلی، مقادیر ثبت‌شده خود را حفظ می‌کنند و بدون تغییر باقی می‌مانند."}
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-5 space-y-4">
        <Field
          label="نام کالا / خدمت"
          htmlFor="product-name"
          required
          error={errors.name?.message}
          hint="عنوانی که هنگام انتخاب این قلم در فاکتور درج می‌شود"
        >
          <Input
            id="product-name"
            hasError={Boolean(errors.name)}
            disabled={inputDisabled}
            placeholder="مثال: خدمات طراحی وب‌سایت / لپ‌تاپ ایسوس"
            autoComplete="off"
            aria-invalid={Boolean(errors.name)}
            {...register("name")}
          />
        </Field>

        <Field label="توضیحات" htmlFor="product-description" error={errors.description?.message}>
          <Textarea
            id="product-description"
            rows={2}
            hasError={Boolean(errors.description)}
            disabled={inputDisabled}
            placeholder="توضیح کوتاه درباره این قلم (هنگام انتخاب در فاکتور به‌صورت پیش‌فرض درج می‌شود)"
            aria-invalid={Boolean(errors.description)}
            {...register("description")}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="قیمت واحد (ریال)"
            htmlFor="product-price"
            required
            error={errors.price?.message}
            hint={pricePreview ? `معادل: ${pricePreview}` : "قیمت پیش‌فرض این قلم در فاکتور"}
          >
            <Input
              id="product-price"
              dir="ltr"
              className="text-left font-sans"
              hasError={Boolean(errors.price)}
              disabled={inputDisabled}
              placeholder="1500000"
              autoComplete="off"
              inputMode="decimal"
              aria-invalid={Boolean(errors.price)}
              {...register("price")}
            />
          </Field>
          <Field
            label="واحد"
            htmlFor="product-unit"
            error={errors.unit?.message}
            hint="مثال: عدد، ساعت، کیلوگرم"
          >
            <Input
              id="product-unit"
              hasError={Boolean(errors.unit)}
              disabled={inputDisabled}
              placeholder="عدد"
              autoComplete="off"
              aria-invalid={Boolean(errors.unit)}
              {...register("unit")}
            />
          </Field>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-gray-200 bg-gray-50/60 px-3.5 py-3">
          <input
            id="product-active"
            type="checkbox"
            disabled={inputDisabled}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300 text-blue-600 accent-blue-600 focus:ring-2 focus:ring-blue-600"
            aria-describedby="product-active-hint"
            {...register("active")}
          />
          <div className="min-w-0 space-y-0.5">
            <label
              htmlFor="product-active"
              className="block cursor-pointer text-xs font-semibold text-gray-800"
            >
              این قلم فعال است
            </label>
            <p id="product-active-hint" className="text-[11px] leading-relaxed text-gray-500">
              اقلام غیرفعال با نشان «غیرفعال» در فهرست مشخص می‌شوند. برای خارج کردن دائمی یک قلم
              از دسترس، آن را بایگانی کنید؛ بایگانی، قلم را از انتخاب‌گر کالای فاکتورهای جدید
              نیز حذف می‌کند.
            </p>
          </div>
        </div>

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
            {isSubmitting ? "در حال ذخیره…" : isCreate ? "افزودن قلم" : "ذخیره تغییرات"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
