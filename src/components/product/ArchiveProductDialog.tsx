"use client";

import * as React from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { archiveProduct } from "@/server/actions/productActions";
import type { ActionErrorCode } from "@/server/actions/actionResult";
import type { ProductDTO } from "@/server/actions/dto";
import { formatCurrency } from "@/lib/formatters";
import { AlertTriangleIcon } from "@/components/icons";

/**
 * Archives (soft-deletes) a product/service, with an explicit confirmation
 * step.
 *
 * The rules — soft delete only (an `archivedAt` stamp, never a hard delete),
 * existing invoices and their immutable line-item snapshots preserved — all
 * live in `productService.archiveProduct`; this dialog only explains them
 * and asks for confirmation. Ownership is re-verified server-side on every
 * attempt. On success the archived DTO is handed to `onArchived` so the list
 * can drop the row in place without a page reload.
 */

/** Friendly Persian copy per stable action error code — internal errors never surface. */
const ARCHIVE_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.",
  FORBIDDEN: "شما به این کسب‌وکار دسترسی ندارید.",
  NOT_FOUND: "محصول مورد نظر یافت نشد. ممکن است قبلاً حذف شده باشد.",
  VALIDATION_ERROR: "این قلم در وضعیت فعلی قابل بایگانی نیست.",
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

export interface ArchiveProductDialogProps {
  /** Id of the business owning the product — re-verified server-side. */
  businessId: string;
  product: ProductDTO;
  onClose: () => void;
  /** Called with the archived DTO so the caller can drop it in place. */
  onArchived: (product: ProductDTO) => void;
}

export function ArchiveProductDialog({
  businessId,
  product,
  onClose,
  onArchived,
}: ArchiveProductDialogProps) {
  const [isPending, setIsPending] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const titleId = React.useId();
  const descriptionId = React.useId();

  async function handleConfirm() {
    if (isPending) return;
    setIsPending(true);
    setErrorMsg(null);
    try {
      const result = await archiveProduct(businessId, product.id);
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
            بایگانی «{product.name}»
          </h2>
          <p className="text-[11px] text-gray-400">
            قیمت فعلی: {formatCurrency(product.price)}
            {product.unit ? ` / ${product.unit}` : ""}
          </p>
          <p id={descriptionId} className="text-xs leading-relaxed text-gray-600">
            این قلم از فهرست محصولات حذف می‌شود و دیگر در انتخاب‌گر کالای فاکتورهای جدید نمایش
            داده نمی‌شود؛ اما{" "}
            <strong className="font-semibold text-gray-800">
              تمام فاکتورهای قبلی و اقلام آن‌ها بدون تغییر باقی می‌مانند
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
