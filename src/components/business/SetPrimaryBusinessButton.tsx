"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setPrimaryBusiness } from "@/server/actions/businessActions";
import { CheckIcon } from "@/components/icons";

export interface SetPrimaryBusinessButtonProps {
  businessId: string;
  businessName: string;
  isPrimary: boolean;
}

/**
 * Marks a business as the account's primary business — the *same* mechanism
 * the dashboard BusinessSwitcher uses (`setPrimaryBusiness` /
 * `Business.isPrimary`). No second business-selection state is introduced;
 * after the switch the whole RSC tree refreshes so the switcher follows.
 */
export function SetPrimaryBusinessButton({
  businessId,
  businessName,
  isPrimary,
}: SetPrimaryBusinessButtonProps) {
  const router = useRouter();
  const [isPending, setIsPending] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  async function handleClick() {
    if (isPrimary || isPending) return;
    setIsPending(true);
    setErrorMsg(null);
    try {
      const result = await setPrimaryBusiness(businessId);
      if (result.success) {
        router.refresh();
      } else {
        setErrorMsg(result.error.message || "خطا در تغییر کسب‌وکار پیش‌فرض");
      }
    } catch {
      setErrorMsg("خطای غیرمنتظره رخ داد. دوباره تلاش کنید.");
    } finally {
      setIsPending(false);
    }
  }

  if (isPrimary) {
    return (
      <Button variant="secondary" size="sm" disabled className="gap-1.5">
        <CheckIcon size={14} />
        <span>کسب‌وکار پیش‌فرض</span>
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={isPending}
        title={`انتخاب «${businessName}» به‌عنوان کسب‌وکار پیش‌فرض`}
      >
        {isPending ? "در حال تغییر…" : "انتخاب به‌عنوان پیش‌فرض"}
      </Button>
      {errorMsg && (
        <p className="text-[11px] text-rose-600" role="alert">
          {errorMsg}
        </p>
      )}
    </div>
  );
}
