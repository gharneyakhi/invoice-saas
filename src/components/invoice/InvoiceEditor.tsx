"use client";

import * as React from "react";
import { FormProvider, useForm } from "react-hook-form";
import type { ActionErrorCode } from "@/server/actions/actionResult";
import type { CustomerDTO, InvoiceDetailDTO, ProductDTO } from "@/server/actions/dto";
import {
  createDraftInvoice,
  updateDraftInvoice,
} from "@/server/actions/invoiceActions";
import { InvoiceInfoForm } from "@/components/invoice/InvoiceInfoForm";
import { InvoiceItemsEditor, createEmptyItem } from "@/components/invoice/InvoiceItemsEditor";
import { InvoiceTotals } from "@/components/invoice/InvoiceTotals";
import { DraftSaveBar, type SaveFeedback } from "@/components/invoice/DraftSaveBar";
import {
  invoiceEditorResolver,
  type InvoiceEditorFields,
} from "@/components/invoice/invoiceEditorSchema";
import { toNumericInputString } from "@/lib/formatters";

export interface InvoiceEditorProps {
  /** Id of the business being invoiced — verified again server-side on save. */
  businessId: string;
  /** Real customers of this business (live rows, loaded server-side). */
  customers: CustomerDTO[];
  /** Real catalogue of this business; used to seed rows, never mutated. */
  products: ProductDTO[];
  /** Business `InvoiceSettings.defaultVatPercent` (Decimal string). */
  defaultVatPercent: string;
  /** Business `InvoiceSettings.currency` (e.g. "IRR"). */
  currency: string;
  /** "Today" as YYYY-MM-DD (server-computed for the business timezone). */
  defaultIssueDate: string;
  /** An existing draft to continue editing (e.g. after a page refresh). */
  initialDraft?: InvoiceDetailDTO | null;
}

/** Friendly Persian copy per stable action error code — internal/Prisma errors never surface. */
const SAVE_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.",
  FORBIDDEN: "شما مجاز به انجام این عملیات نیستید.",
  NOT_FOUND: "فاکتور یا مورد مرتبط با آن یافت نشد. ممکن است حذف شده باشد.",
  VALIDATION_ERROR: "اطلاعات وارد شده معتبر نیست. لطفاً فرم را دوباره بررسی کنید.",
  BUSINESS_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  INVOICE_LIMIT_REACHED: "سقف صدور فاکتور پلن فعلی شما تکمیل شده است.",
  ENTITLEMENT_DATA_ERROR: "اطلاعات اشتراک در دسترس نیست. لطفاً با پشتیبانی تماس بگیرید.",
  FILE_STORAGE_NOT_CONFIGURED: "سرویس ذخیره‌سازی فایل در دسترس نیست.",
  FILE_STORAGE_UPLOAD_FAILED: "بارگذاری فایل ناموفق بود؛ دوباره تلاش کنید.",
  INTERNAL_ERROR: "خطای غیرمنتظره‌ای رخ داد. لطفاً چند لحظه بعد دوباره تلاش کنید.",
};

function emptyFormValues(props: InvoiceEditorProps): InvoiceEditorFields {
  return {
    invoiceType: "FINAL",
    issueDate: props.defaultIssueDate,
    dueDate: "",
    customerId: "",
    notes: "",
    globalDiscountPercent: "0",
    taxPercent: toNumericInputString(props.defaultVatPercent) || "0",
    items: [createEmptyItem()],
  };
}

function draftToFormValues(draft: InvoiceDetailDTO, fallbackIssueDate: string): InvoiceEditorFields {
  return {
    invoiceType: draft.invoiceType,
    issueDate: draft.issueDate ? draft.issueDate.slice(0, 10) : fallbackIssueDate,
    dueDate: draft.dueDate ? draft.dueDate.slice(0, 10) : "",
    customerId: draft.customerId ?? "",
    notes: draft.notes ?? "",
    globalDiscountPercent: toNumericInputString(draft.globalDiscountPercent) || "0",
    taxPercent: toNumericInputString(draft.taxPercent) || "0",
    items:
      draft.items.length > 0
        ? draft.items.map((item) => ({
            productId: item.productId ?? "",
            title: item.title,
            description: item.description ?? "",
            unit: item.unit ?? "",
            quantity: toNumericInputString(item.quantity) || "1",
            unitPrice: toNumericInputString(item.unitPrice),
            discountPercent: toNumericInputString(item.discountPercent) || "0",
          }))
        : [createEmptyItem()],
  };
}

/**
 * Builds the exact payload accepted by `createDraftInvoiceSchema` /
 * `updateDraftInvoiceSchema`: only line-item inputs, dates and percent fields.
 * Money travels as canonical decimal strings (never JS floats), and no
 * totals, statuses, invoice numbers or business ids are ever included.
 */
function buildDraftPayload(values: InvoiceEditorFields) {
  return {
    invoiceType: values.invoiceType,
    issueDate: values.issueDate,
    dueDate: values.dueDate || null,
    customerId: values.customerId || null,
    notes: values.notes.trim() || null,
    globalDiscountPercent: values.globalDiscountPercent,
    taxPercent: values.taxPercent,
    items: values.items.map((item, index) => ({
      productId: item.productId || null,
      title: item.title.trim(),
      description: item.description.trim() || null,
      unit: item.unit.trim() || null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      sortOrder: index,
    })),
  };
}

/**
 * Invoice Editor V1 (Persian RTL).
 *
 * Flow: UI → `createDraftInvoice` / `updateDraftInvoice` Server Action →
 * `invoiceService` → Prisma. The browser only ever sends editable inputs;
 * authoritative validation, ownership checks and money calculation all
 * happen server-side.
 *
 * The first save creates a DRAFT. Once an invoice id exists, subsequent
 * saves update that same draft (this is why the draft-update service/action
 * exists — re-saving must never spawn duplicate drafts).
 */
export function InvoiceEditor(props: InvoiceEditorProps) {
  const [savedInvoiceId, setSavedInvoiceId] = React.useState<string | null>(
    props.initialDraft?.id ?? null,
  );
  const [feedback, setFeedback] = React.useState<SaveFeedback | null>(null);

  const form = useForm<InvoiceEditorFields, undefined, InvoiceEditorFields>({
    resolver: invoiceEditorResolver,
    reValidateMode: "onChange",
    shouldFocusError: true,
    defaultValues: props.initialDraft
      ? draftToFormValues(props.initialDraft, props.defaultIssueDate)
      : emptyFormValues(props),
  });

  const onSubmit = async (values: InvoiceEditorFields) => {
    setFeedback(null);
    const payload = buildDraftPayload(values);

    const result = savedInvoiceId
      ? await updateDraftInvoice(props.businessId, savedInvoiceId, payload)
      : await createDraftInvoice(props.businessId, payload);

    if (result.success) {
      if (savedInvoiceId) {
        setFeedback({ type: "success", message: "تغییرات پیش‌نویس با موفقیت ذخیره شد." });
      } else {
        setSavedInvoiceId(result.data.id);
        setFeedback({
          type: "success",
          message: "پیش‌نویس فاکتور با موفقیت ایجاد شد.",
          detail: "می‌توانید ویرایش را ادامه دهید؛ ذخیره مجدد همین فاکتور را به‌روز می‌کند.",
        });
        // Keep a refresh-safe URL without triggering an RSC re-render — a
        // reload now re-opens this draft instead of risking a duplicate.
        if (typeof window !== "undefined") {
          window.history.replaceState(
            null,
            "",
            `/dashboard/invoices/new?invoiceId=${encodeURIComponent(result.data.id)}`,
          );
        }
      }
      // Adopt the saved state as the clean baseline so the form is no longer
      // "dirty" and browsers don't warn about unsaved changes.
      form.reset(values);
    } else {
      setFeedback({
        type: "error",
        message: SAVE_ERROR_MESSAGES[result.error.code] ?? SAVE_ERROR_MESSAGES.INTERNAL_ERROR,
        // Domain validation details are safe (already sanitized at the action
        // boundary); anything else gets only the friendly summary.
        detail: result.error.code === "VALIDATION_ERROR" ? result.error.message : undefined,
      });
    }
  };

  const onInvalid = () => {
    setFeedback({
      type: "error",
      message: "فرم فاکتور کامل نیست. لطفاً خطاهای مشخص‌شده را برطرف کنید.",
    });
  };

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} noValidate className="min-w-0">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Main editor column */}
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <InvoiceInfoForm customers={props.customers} />
            <InvoiceItemsEditor products={props.products} currency={props.currency} />
          </div>

          {/* Totals / save sidebar — pinned on desktop, natural bottom flow on mobile */}
          <div className="min-w-0 space-y-6 lg:sticky lg:top-6 lg:self-start">
            <InvoiceTotals currency={props.currency} />
            <DraftSaveBar
              savedInvoiceId={savedInvoiceId}
              isSubmitting={form.formState.isSubmitting}
              feedback={feedback}
            />
          </div>
        </div>
      </form>
    </FormProvider>
  );
}
