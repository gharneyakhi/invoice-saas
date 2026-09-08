"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useForm } from "react-hook-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import {
  createBusiness,
  updateBusinessSettings,
} from "@/server/actions/businessActions";
import type { ActionErrorCode } from "@/server/actions/actionResult";
import type {
  BusinessInvoiceSettingsDTO,
  BusinessProfileDTO,
} from "@/server/actions/dto";
import { ImageUploadField } from "@/components/business/ImageUploadField";
import {
  businessSettingsFormResolver,
  type BusinessSettingsFormFields,
} from "@/components/business/businessSettingsFormSchema";
import { toNumericInputString } from "@/lib/formatters";
import {
  AlertCircleIcon,
  BusinessIcon,
  CheckCircleIcon,
  CreditCardIcon,
  InvoicesIcon,
  SparklesIcon,
  StampIcon,
} from "@/components/icons";

/**
 * Business settings form — the single form behind both
 * `/dashboard/businesses/new` (creation) and
 * `/dashboard/businesses/[businessId]` (profile & invoice settings).
 *
 * Flow: UI → `createBusiness` / `updateBusinessSettings` Server Action →
 * `businessService` → Prisma. The browser only ever sends editable inputs;
 * ownership, entitlement limits (creation), the archive rule and every format
 * check are re-validated server-side. Finalized-invoice snapshots are never
 * touched by this form — profile edits only affect the *current* profile.
 */

/** Friendly Persian copy per stable action error code — internal errors never surface. */
const SAVE_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.",
  FORBIDDEN: "شما به این کسب‌وکار دسترسی ندارید.",
  NOT_FOUND: "کسب‌وکار مورد نظر یافت نشد. ممکن است حذف شده باشد.",
  VALIDATION_ERROR: "اطلاعات وارد شده معتبر نیست. لطفاً فرم را دوباره بررسی کنید.",
  BUSINESS_LIMIT_REACHED:
    "سقف کسب‌وکارهای پلن فعلی شما تکمیل شده است؛ امکان افزودن کسب‌وکار جدید وجود ندارد.",
  INVOICE_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  ENTITLEMENT_DATA_ERROR: "اطلاعات اشتراک در دسترس نیست. لطفاً با پشتیبانی تماس بگیرید.",
  FILE_STORAGE_NOT_CONFIGURED: "سرویس ذخیره‌سازی فایل در دسترس نیست.",
  FILE_STORAGE_UPLOAD_FAILED: "بارگذاری تصویر ناموفق بود؛ فایل روی سرور ذخیره نشد. کمی بعد دوباره تلاش کنید.",
  INTERNAL_ERROR: "خطای غیرمنتظره‌ای رخ داد. لطفاً چند لحظه بعد دوباره تلاش کنید.",
};

/** Maps an action error onto the form's feedback banner (safe messages only). */
function toErrorFeedback(code: ActionErrorCode, message: string) {
  return {
    type: "error" as const,
    message: SAVE_ERROR_MESSAGES[code] ?? SAVE_ERROR_MESSAGES.INTERNAL_ERROR,
    detail: code === "VALIDATION_ERROR" ? message : undefined,
  };
}

export interface BusinessSettingsFormProps {
  mode: "create" | "edit";
  /** Edit mode only — re-verified server-side on every save. */
  businessId?: string;
  /** Current `Business.name` (edit) — kept mirrored with the profile server-side. */
  initialName?: string;
  initialProfile?: BusinessProfileDTO | null;
  initialInvoiceSettings?: BusinessInvoiceSettingsDTO | null;
  /** Server-derived flag: whether the storage adapter is active. */
  imageUploadsEnabled: boolean;
  /** Read-only rendering (e.g. archived business). */
  readOnly?: boolean;
}

function toFormValues(props: BusinessSettingsFormProps): BusinessSettingsFormFields {
  const profile = props.initialProfile ?? null;
  const settings = props.initialInvoiceSettings ?? null;
  return {
    name: props.initialName ?? profile?.businessName ?? "",
    slogan: profile?.slogan ?? "",
    ownerName: profile?.ownerName ?? "",
    address: profile?.address ?? "",
    email: profile?.email ?? "",
    mobile: profile?.mobile ?? "",
    landline: profile?.landline ?? "",
    cardNumber: profile?.cardNumber ?? "",
    accountNumber: profile?.accountNumber ?? "",
    iban: profile?.iban ?? "",
    primaryColor: profile?.primaryColor ?? "",
    footerBackgroundColor: profile?.footerBackgroundColor ?? "",
    footerText: profile?.footerText ?? "",
    defaultVatPercent: toNumericInputString(settings?.defaultVatPercent) || "0",
    currency: settings?.currency ?? "IRR",
    calendar: settings?.calendar ?? "JALALI",
    invoicePrefix: settings?.invoicePrefix ?? "",
  };
}

/** Builds the exact payload accepted by the server schemas (raw strings; the server normalizes). */
function buildPayload(values: BusinessSettingsFormFields, mode: "create" | "edit") {
  const base = {
    name: values.name.trim(),
    slogan: values.slogan,
    ownerName: values.ownerName,
    address: values.address,
    email: values.email,
    mobile: values.mobile,
    landline: values.landline,
    cardNumber: values.cardNumber,
    accountNumber: values.accountNumber,
    iban: values.iban,
    primaryColor: values.primaryColor,
    footerBackgroundColor: values.footerBackgroundColor,
    footerText: values.footerText,
  };
  if (mode === "create") {
    // InvoiceSettings are created with defaults by the service.
    return base;
  }
  return {
    ...base,
    invoiceSettings: {
      defaultVatPercent: values.defaultVatPercent,
      currency: values.currency,
      calendar: values.calendar,
      invoicePrefix: values.invoicePrefix === "" ? null : values.invoicePrefix,
    },
  };
}

export function BusinessSettingsForm(props: BusinessSettingsFormProps) {
  const router = useRouter();
  const isCreate = props.mode === "create";
  const readOnly = props.readOnly === true;

  const [feedback, setFeedback] = React.useState<
    { type: "success" | "error"; message: string; detail?: string } | null
  >(null);

  const form = useForm<BusinessSettingsFormFields, undefined, BusinessSettingsFormFields>({
    resolver: businessSettingsFormResolver,
    reValidateMode: "onChange",
    shouldFocusError: true,
    defaultValues: toFormValues(props),
  });

  const { register, handleSubmit, watch, setValue, formState } = form;
  const errors = formState.errors;
  const isSubmitting = formState.isSubmitting;
  const isDirty = formState.isDirty;

  const nameValue = watch("name");
  const sloganValue = watch("slogan");
  const colorValue = watch("primaryColor");
  const footerColorValue = watch("footerBackgroundColor");
  const validColor = /^#[0-9a-f]{6}$/i.test(colorValue) ? colorValue : "";
  const validFooterColor = /^#[0-9a-f]{6}$/i.test(footerColorValue) ? footerColorValue : "";

  // Unsaved-changes guard: warn before the tab is closed/reloaded while dirty.
  React.useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const onSubmit = async (values: BusinessSettingsFormFields) => {
    setFeedback(null);
    const payload = buildPayload(values, props.mode);

    if (isCreate) {
      const result = await createBusiness(payload);
      if (result.success) {
        router.push(`/dashboard/businesses/${result.data.id}?created=1`);
        return;
      }
      setFeedback(toErrorFeedback(result.error.code, result.error.message));
      return;
    }

    const result = await updateBusinessSettings(props.businessId ?? "", payload);
    if (result.success) {
      // Adopt the saved state as the clean baseline (no unsaved-changes warning)
      // and refresh the RSC tree so the shell/switcher shows the new name.
      form.reset(values);
      setFeedback({ type: "success", message: "تغییرات با موفقیت ذخیره شد." });
      router.refresh();
    } else {
      setFeedback(toErrorFeedback(result.error.code, result.error.message));
    }
  };

  const onInvalid = () => {
    setFeedback({
      type: "error",
      message: "فرم کامل نیست. لطفاً خطاهای مشخص‌شده را برطرف کنید.",
    });
  };

  const inputDisabled = readOnly || isSubmitting;
  const profile = props.initialProfile ?? null;
  const settings = props.initialInvoiceSettings ?? null;

  return (
    <form onSubmit={handleSubmit(onSubmit, onInvalid)} noValidate className="space-y-6">
      {/* ----------------------------------------------------------------- 1 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <BusinessIcon size={18} />
            </div>
            <CardTitle className="text-sm font-bold">اطلاعات کسب‌وکار</CardTitle>
          </div>
          <CardDescription>
            این اطلاعات در سربرگ فاکتورهای این کسب‌وکار نمایش داده می‌شود.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="نام کسب‌وکار"
              htmlFor="business-name"
              required
              error={errors.name?.message}
              hint="نام رسمی یا تجاری کسب‌وکار"
            >
              <Input
                id="business-name"
                hasError={Boolean(errors.name)}
                disabled={inputDisabled}
                placeholder="مثال: فروشگاه نمونه"
                {...register("name")}
              />
            </Field>
            <Field
              label="شعار"
              htmlFor="business-slogan"
              error={errors.slogan?.message}
              hint="یک جمله کوتاه زیر نام کسب‌وکار"
            >
              <Input
                id="business-slogan"
                hasError={Boolean(errors.slogan)}
                disabled={inputDisabled}
                placeholder="مثال: کیفیت، سرعت، اعتماد"
                {...register("slogan")}
              />
            </Field>
            <Field
              label="نام مالک / مدیر"
              htmlFor="business-owner"
              error={errors.ownerName?.message}
            >
              <Input
                id="business-owner"
                hasError={Boolean(errors.ownerName)}
                disabled={inputDisabled}
                {...register("ownerName")}
              />
            </Field>
            <Field label="ایمیل" htmlFor="business-email" error={errors.email?.message}>
              <Input
                id="business-email"
                type="email"
                dir="ltr"
                className="text-left"
                hasError={Boolean(errors.email)}
                disabled={inputDisabled}
                placeholder="info@example.com"
                {...register("email")}
              />
            </Field>
            <Field
              label="موبایل"
              htmlFor="business-mobile"
              error={errors.mobile?.message}
              hint="۱۱ رقم، با ۰۹ شروع می‌شود"
            >
              <Input
                id="business-mobile"
                dir="ltr"
                className="text-left"
                hasError={Boolean(errors.mobile)}
                disabled={inputDisabled}
                placeholder="09121234567"
                {...register("mobile")}
              />
            </Field>
            <Field
              label="تلفن ثابت"
              htmlFor="business-landline"
              error={errors.landline?.message}
              hint="با کد شهر، مثال 02112345678"
            >
              <Input
                id="business-landline"
                dir="ltr"
                className="text-left"
                hasError={Boolean(errors.landline)}
                disabled={inputDisabled}
                placeholder="02112345678"
                {...register("landline")}
              />
            </Field>
          </div>
          <Field label="آدرس" htmlFor="business-address" error={errors.address?.message}>
            <Textarea
              id="business-address"
              hasError={Boolean(errors.address)}
              disabled={inputDisabled}
              placeholder="آدرس کامل کسب‌وکار"
              {...register("address")}
            />
          </Field>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------------------- 2 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <SparklesIcon size={18} />
            </div>
            <CardTitle className="text-sm font-bold">هویت بصری</CardTitle>
          </div>
          <CardDescription>
            رنگ سازمانی پس‌زمینه سربرگ فاکتور است و رنگ پاورقی پس‌زمینه نوار پایین سند.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <Field
              label="رنگ سازمانی"
              htmlFor="business-color"
              error={errors.primaryColor?.message}
              hint="رنگ پس‌زمینه سربرگ فاکتور — خالی یعنی رنگ پیش‌فرض"
            >
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="انتخاب رنگ سازمانی"
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-gray-300 bg-white p-1"
                  value={validColor || "#2563eb"}
                  disabled={inputDisabled}
                  onChange={(event) => setValue("primaryColor", event.target.value, { shouldDirty: true })}
                />
                <Input
                  id="business-color"
                  dir="ltr"
                  className="text-left"
                  hasError={Boolean(errors.primaryColor)}
                  disabled={inputDisabled}
                  placeholder="#2563eb"
                  {...register("primaryColor")}
                />
              </div>
            </Field>

            <Field
              label="رنگ پاورقی"
              htmlFor="business-footer-color"
              error={errors.footerBackgroundColor?.message}
              hint="رنگ پس‌زمینه پاورقی"
            >
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="انتخاب رنگ پاورقی"
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-gray-300 bg-white p-1"
                  value={validFooterColor || "#f3f4f6"}
                  disabled={inputDisabled}
                  onChange={(event) =>
                    setValue("footerBackgroundColor", event.target.value, { shouldDirty: true })
                  }
                />
                <Input
                  id="business-footer-color"
                  dir="ltr"
                  className="text-left"
                  hasError={Boolean(errors.footerBackgroundColor)}
                  disabled={inputDisabled}
                  placeholder="#f3f4f6"
                  {...register("footerBackgroundColor")}
                />
              </div>
            </Field>

            <ImageUploadField
              id="business-logo-upload"
              label="لوگو"
              category="BUSINESS_LOGO"
              enabled={props.imageUploadsEnabled}
              businessId={isCreate ? undefined : props.businessId}
              currentImage={profile?.logo ?? null}
              disabled={readOnly}
            />
          </div>

          {/* Live letterhead preview */}
          <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
            <p className="mb-3 text-[11px] font-medium text-gray-400">پیش‌نمایش سربرگ فاکتور</p>
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
              <div
                className="flex items-center gap-3 px-4 py-3 text-white"
                style={{ backgroundColor: validColor || "#2563eb" }}
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/15 text-base font-bold">
                  {(nameValue.trim().charAt(0) || "ک")}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold">
                    {nameValue.trim() || "نام کسب‌وکار"}
                  </p>
                  <p className="truncate text-xs opacity-90">
                    {sloganValue.trim() || "شعار کسب‌وکار"}
                  </p>
                </div>
              </div>
              <div
                className="h-2"
                style={{ backgroundColor: validFooterColor || "#f3f4f6" }}
                aria-hidden="true"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------------------- 3 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <CreditCardIcon size={18} />
            </div>
            <CardTitle className="text-sm font-bold">اطلاعات بانکی</CardTitle>
          </div>
          <CardDescription>
            این اطلاعات برای درج در فاکتور و تسویه حساب استفاده می‌شود.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            label="شماره کارت"
            htmlFor="business-card"
            error={errors.cardNumber?.message}
            hint="۱۶ رقم"
          >
            <Input
              id="business-card"
              dir="ltr"
              className="text-left"
              hasError={Boolean(errors.cardNumber)}
              disabled={inputDisabled}
              placeholder="6104337812345678"
              {...register("cardNumber")}
            />
          </Field>
          <Field
            label="شماره حساب"
            htmlFor="business-account"
            error={errors.accountNumber?.message}
          >
            <Input
              id="business-account"
              dir="ltr"
              className="text-left"
              hasError={Boolean(errors.accountNumber)}
              disabled={inputDisabled}
              {...register("accountNumber")}
            />
          </Field>
          <Field
            label="شماره شبا"
            htmlFor="business-iban"
            error={errors.iban?.message}
            hint="IR به‌همراه ۲۴ رقم"
          >
            <Input
              id="business-iban"
              dir="ltr"
              className="text-left"
              hasError={Boolean(errors.iban)}
              disabled={inputDisabled}
              placeholder="IR120620000000123456789"
              {...register("iban")}
            />
          </Field>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------------------- 4 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <StampIcon size={18} />
            </div>
            <CardTitle className="text-sm font-bold">مهر و امضا</CardTitle>
          </div>
          <CardDescription>
            تصویر مهر و امضای فروشنده؛ در صورت بارگذاری، روی فاکتورهای چاپی درج می‌شود.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <ImageUploadField
            id="business-stamp-upload"
            label="مهر فروشنده"
            category="SELLER_STAMP"
            enabled={props.imageUploadsEnabled}
            businessId={isCreate ? undefined : props.businessId}
            currentImage={profile?.sellerStamp ?? null}
            disabled={readOnly}
          />
          <ImageUploadField
            id="business-signature-upload"
            label="امضای فروشنده"
            category="SELLER_SIGNATURE"
            enabled={props.imageUploadsEnabled}
            businessId={isCreate ? undefined : props.businessId}
            currentImage={profile?.sellerSignature ?? null}
            disabled={readOnly}
          />
        </CardContent>
      </Card>

      {/* ----------------------------------------------------------------- 5 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <InvoicesIcon size={18} />
            </div>
            <CardTitle className="text-sm font-bold">فاکتور</CardTitle>
          </div>
          <CardDescription>
            متن پاورقی و تنظیمات پیش‌فرض فاکتورهای این کسب‌وکار.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="متن پاورقی فاکتور"
            htmlFor="business-footer"
            error={errors.footerText?.message}
            hint="مثال: از خرید شما سپاسگزاریم — این فاکتور بدون مهر و امضا معتبر نیست."
          >
            <Textarea
              id="business-footer"
              hasError={Boolean(errors.footerText)}
              disabled={inputDisabled}
              {...register("footerText")}
            />
          </Field>

          {!isCreate && (
            <div className="grid grid-cols-1 gap-4 border-t border-gray-100 pt-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                label="درصد پیش‌فرض مالیات"
                htmlFor="business-vat"
                error={errors.defaultVatPercent?.message}
                hint="برای فاکتورهای جدید"
              >
                <Input
                  id="business-vat"
                  dir="ltr"
                  className="text-left"
                  hasError={Boolean(errors.defaultVatPercent)}
                  disabled={inputDisabled}
                  placeholder="9"
                  {...register("defaultVatPercent")}
                />
              </Field>
              <Field
                label="واحد پول"
                htmlFor="business-currency"
                error={errors.currency?.message}
                hint="ریال یا تومان — فاکتورهای نهایی‌شده واحد خود را نگه می‌دارند"
              >
                <Select
                  id="business-currency"
                  hasError={Boolean(errors.currency)}
                  disabled={inputDisabled}
                  {...register("currency")}
                >
                  <option value="IRR">ریال</option>
                  <option value="IRT">تومان</option>
                </Select>
              </Field>
              <Field label="تقویم" htmlFor="business-calendar" error={errors.calendar?.message}>
                <Select
                  id="business-calendar"
                  hasError={Boolean(errors.calendar)}
                  disabled={inputDisabled}
                  {...register("calendar")}
                >
                  <option value="JALALI">جلالی (شمسی)</option>
                  <option value="GREGORIAN">میلادی</option>
                </Select>
              </Field>
              <Field
                label="پیشوند شماره فاکتور"
                htmlFor="business-prefix"
                error={errors.invoicePrefix?.message}
                hint="فقط برای فاکتورهای بعدی؛ شماره‌گذاری خودکار است"
              >
                <Input
                  id="business-prefix"
                  dir="ltr"
                  className="text-left"
                  hasError={Boolean(errors.invoicePrefix)}
                  disabled={inputDisabled}
                  placeholder="مثال: 1405-"
                  {...register("invoicePrefix")}
                />
              </Field>
              {settings && (
                <div className="sm:col-span-2 lg:col-span-4">
                  <div className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
                    <span>شماره فاکتور بعدی این کسب‌وکار:</span>
                    <strong className="font-semibold text-gray-800" dir="ltr">
                      {`${settings.invoicePrefix ?? ""}${settings.nextInvoiceNumber}`}
                    </strong>
                    <span className="text-gray-400">
                      (به‌صورت خودکار هنگام نهایی‌سازی فاکتور اختصاص می‌یابد و از این فرم قابل تغییر نیست)
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------- save */}
      {!readOnly && (
        <div className="sticky bottom-4 z-10 rounded-xl border border-gray-200 bg-white/95 p-4 shadow-lg backdrop-blur-sm">
          {feedback && (
            <div
              role="alert"
              className={clsx(
                "mb-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed",
                feedback.type === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-rose-200 bg-rose-50 text-rose-800",
              )}
            >
              {feedback.type === "success" ? (
                <CheckCircleIcon size={16} className="mt-0.5 shrink-0" />
              ) : (
                <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="font-medium">{feedback.message}</p>
                {feedback.detail && <p className="mt-0.5 text-[11px] opacity-80">{feedback.detail}</p>}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              {isDirty ? (
                <Badge variant="warning" showDot>
                  تغییرات ذخیره‌نشده
                </Badge>
              ) : (
                <span className="text-[11px] text-gray-400">
                  {isCreate
                    ? "پس از ایجاد، می‌توانید جزئیات را کامل کنید"
                    : "همه تغییرات ذخیره شده است"}
                </span>
              )}
            </div>
            <Button
              type="submit"
              size="md"
              isLoading={isSubmitting}
              className="w-full shrink-0 gap-2 font-bold sm:w-auto"
            >
              {isSubmitting ? "در حال ذخیره…" : isCreate ? "ایجاد کسب‌وکار" : "ذخیره تغییرات"}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
