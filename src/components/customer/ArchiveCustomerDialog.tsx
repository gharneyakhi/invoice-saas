"use client";

import * as React from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { archiveCustomer } from "@/server/actions/customerActions";
import type { ActionErrorCode } from "@/server/actions/actionResult";
import type { CustomerDTO } from "@/server/actions/dto";
import { AlertTriangleIcon } from "@/components/icons";

/**
 * Archives (soft-deletes) a customer, with an explicit confirmation step.
 *
 * The rules — soft delete only (an `archivedAt` stamp, never a hard delete),
 * existing invoices and their immutable customer snapshots preserved — all
 * live in `customerService.archiveCustomer`; this dialog only explains them
 * and asks for confirmation. Ownership is re-verified server-side on every
 * attempt. On success the archived DTO is handed to `onArchived` so the
 * list can drop the row in place without a page reload.
 */

/** Friendly Persian copy per stable action error code — internal errors never surface. */
const ARCHIVE_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.",
  FORBIDDEN: "شما به این کسب‌وکار دسترسی ندارید.",
  NOT_FOUND: "مشتری مورد نظر یافت نشد. ممکن است قبلاً حذف شده باشد.",
  VALIDATION_ERROR: "این مشتری در وضعیت فعلی قابل بایگانی نیست.",
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

export interface ArchiveCustomerDialogProps {
  /** Id of the business owning the customer — re-verified server-side. */
  businessId: string;
  customer: CustomerDTO;
  onClose: () => void;
  /** Called with the archived DTO so the caller can drop it in place. */
  onArchived: (customer: CustomerDTO) => void;
}

export function ArchiveCustomerDialog({
  businessId,
  customer,
  onClose,
  onArchived,
}: ArchiveCustomerDialogProps) {
  const [isPending, setIsPending] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const titleId = React.useId();
  const descriptionId = React.useId();

  async function handleConfirm() {
    if (isPending) return;
    setIsPending(true);
    setErrorMsg(null);
    try {
      const result = await archiveCustomer(businessId, customer.id);
      if (result.success) {
        onArchived(result.data);
      } else {
        setErrorMsg(
          ARCHIVE_ERROR_MESSAGES[result.error.code] ?? ARCHIVE_ERROR_MESSAGES.INTERNAL_ERROR,
        );
      }
    } catch {
      setErrorMsg("خطای غیرمنتظره رخ داد. دوباره تلاش کنید.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Dialog
      labelledBy={titleId}
      describedBy={descriptionId}
      onClose={isPending ? () => undefined : onClose}
      closeOnBackdrop={!isPending}
      className="max-w-md"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <AlertTriangleIcon size={20} />
        </div>
        <div className="min-w-0 space-y-2">
          <h2 id={titleId} className="text-sm font-bold text-gray-900">
            بایگانی «{customer.name}»
          </h2>
          <p id={descriptionId} className="text-xs leading-relaxed text-gray-600">
            این مشتری از فهرست فعال حذف می‌شود و دیگر در انتخاب‌گر مشتری فاکتورهای جدید نمایش
            داده نمی‌شود؛ اما{" "}
            <strong className="font-semibold text-gray-800">
              تمام فاکتورهای قبلی و سوابق مالی او بدون تغییر باقی می‌مانند
            </strong>{" "}
            و هیچ داده‌ای به‌طور کامل حذف نمی‌شود.
          </p>
          {errorMsg && (
            <p className="text-[11px] leading-relaxed text-rose-600" role="alert">
              {errorMsg}
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" size="sm" onClick={onClose} disabled={isPending}>
          انصراف
        </Button>
        <Button variant="danger" size="sm" onClick={handleConfirm} isLoading={isPending}>
          {isPending ? "در حال بایگانی…" : "بله، بایگانی کن"}
        </Button>
      </div>
    </Dialog>
  );
}
