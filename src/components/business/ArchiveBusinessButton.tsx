"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { archiveBusiness } from "@/server/actions/businessActions";
import { AlertTriangleIcon } from "@/components/icons";

export interface ArchiveBusinessButtonProps {
  businessId: string;
  businessName: string;
  isPrimary: boolean;
}

/**
 * Archives (soft-deletes) a business, with an explicit confirmation dialog.
 *
 * The rules — soft delete only, historical invoices/payments/files preserved,
 * primary promotion of the remaining businesses — all live in
 * `businessService.archiveBusiness`; this component does not duplicate them,
 * it just explains them and asks for confirmation.
 */
export function ArchiveBusinessButton({
  businessId,
  businessName,
  isPrimary,
}: ArchiveBusinessButtonProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = React.useState(false);
  const [isPending, setIsPending] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);

  // Close on Escape; keep focus inside the dialog while it is open.
  React.useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  async function handleConfirm() {
    if (isPending) return;
    setIsPending(true);
    setErrorMsg(null);
    try {
      const result = await archiveBusiness(businessId);
      if (result.success) {
        setIsOpen(false);
        router.refresh();
      } else {
        setErrorMsg(result.error.message || "بایگانی کسب‌وکار ناموفق بود.");
      }
    } catch {
      setErrorMsg("خطای غیرمنتظره رخ داد. دوباره تلاش کنید.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
        onClick={() => setIsOpen(true)}
      >
        بایگانی
      </Button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 p-4"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setIsOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-business-dialog-title"
            tabIndex={-1}
            className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl focus:outline-none"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <AlertTriangleIcon size={20} />
              </div>
              <div className="min-w-0 space-y-2">
                <h2
                  id="archive-business-dialog-title"
                  className="text-sm font-bold text-gray-900"
                >
                  بایگانی «{businessName}»
                </h2>
                <p className="text-xs leading-relaxed text-gray-600">
                  کسب‌وکار از فهرست فعال حذف می‌شود و دیگر قابل ویرایش نخواهد بود؛ اما
                  <strong className="font-semibold text-gray-800">
                    {" "}
                    تمام فاکتورها، پرداخت‌ها و داده‌های تاریخی آن حفظ می‌شوند
                  </strong>{" "}
                  و هیچ چیزی به‌طور کامل حذف نمی‌شود.
                </p>
                {isPrimary && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                    این کسب‌وکار پیش‌فرض شماست؛ پس از بایگانی، قدیمی‌ترین کسب‌وکار فعال
                    دیگر به‌صورت خودکار پیش‌فرض می‌شود.
                  </p>
                )}
                {errorMsg && (
                  <p className="text-[11px] text-rose-600" role="alert">
                    {errorMsg}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsOpen(false)}
                disabled={isPending}
              >
                انصراف
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleConfirm}
                isLoading={isPending}
              >
                {isPending ? "در حال بایگانی…" : "بله، بایگانی کن"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
