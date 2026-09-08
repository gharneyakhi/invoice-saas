"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { uploadBusinessImage } from "@/server/actions/businessActions";
import type { BusinessImageRefDTO } from "@/server/actions/dto";
import { AlertCircleIcon, CheckCircleIcon } from "@/components/icons";

/**
 * Image upload field for the business profile (logo / stamp / signature).
 *
 * Driven by the server-passed `enabled` flag (see
 * `storageService.isFileUploadsEnabled` — true only when the S3-compatible
 * STORAGE_* env contract is complete):
 *   - enabled  → real flow: pick a file, client-side pre-check (type/size),
 *                local preview, immediate upload through the
 *                `uploadBusinessImage` Server Action (which re-validates
 *                server-side, sniffs the actual bytes and writes to S3),
 *                then display of the server-confirmed image reference plus a
 *                `router.refresh()` so server-rendered state catches up.
 *   - disabled → storage is not configured; the field shows the explicit
 *                notice instead of pretending.
 *
 * An existing image (already persisted as a `File` reference) renders from its
 * public URL when one is configured; a missing image is handled gracefully
 * with a neutral placeholder. Credentials never reach this component — only
 * the boolean flag and resolved public URLs do.
 */

// Client-side mirrors of the server rules (UX only — the Server Action
// re-validates type, size and content authoritatively).
const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const MAX_BYTES = 5 * 1024 * 1024;

const CATEGORY_DTO_IMAGE_FIELD: Record<
  "BUSINESS_LOGO" | "SELLER_STAMP" | "SELLER_SIGNATURE",
  "logo" | "sellerStamp" | "sellerSignature"
> = {
  BUSINESS_LOGO: "logo",
  SELLER_STAMP: "sellerStamp",
  SELLER_SIGNATURE: "sellerSignature",
};

export interface ImageUploadFieldProps {
  id: string;
  label: string;
  hint?: string;
  category: "BUSINESS_LOGO" | "SELLER_STAMP" | "SELLER_SIGNATURE";
  /** Whether the storage adapter is configured (server-derived, never env-read here). */
  enabled: boolean;
  /** Required when `enabled` — the action re-proves ownership server-side. */
  businessId?: string;
  currentImage: { fileId: string; url: string | null; originalName: string | null } | null;
  /** Whole-form read-only mode (e.g. archived business). */
  disabled?: boolean;
  className?: string;
}

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "error"; message: string };

export function ImageUploadField({
  id,
  label,
  hint,
  category,
  enabled,
  businessId,
  currentImage,
  disabled = false,
  className,
}: ImageUploadFieldProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [state, setState] = React.useState<UploadState>({ kind: "idle" });
  const [pendingPreview, setPendingPreview] = React.useState<{ url: string; name: string } | null>(
    null,
  );
  // The image reference returned by the LAST server-confirmed upload (shown
  // until the router.refresh() below feeds the new `currentImage` back).
  const [savedImage, setSavedImage] = React.useState<BusinessImageRefDTO | null>(null);

  // Revoke object URLs so previews never leak memory across replacements.
  React.useEffect(() => {
    return () => {
      if (pendingPreview) URL.revokeObjectURL(pendingPreview.url);
    };
  }, [pendingPreview]);

  // Uploading is only meaningful once a real (existing) business id exists;
  // create mode keeps the field informative but inert.
  const actionable = enabled && Boolean(businessId) && !disabled;

  const shownImage = pendingPreview?.url ?? savedImage?.url ?? currentImage?.url ?? null;
  const shownName =
    pendingPreview?.name ?? savedImage?.originalName ?? currentImage?.originalName ?? null;

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after an error.
    event.target.value = "";
    if (!file || !actionable || !businessId) return;

    if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
      setState({ kind: "error", message: "فقط تصاویر PNG، JPG یا WebP پذیرفته می‌شوند." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setState({ kind: "error", message: "حجم تصویر باید حداکثر ۵ مگابایت باشد." });
      return;
    }

    if (pendingPreview) URL.revokeObjectURL(pendingPreview.url);
    setPendingPreview({ url: URL.createObjectURL(file), name: file.name });
    setState({ kind: "uploading" });

    const formData = new FormData();
    formData.append("file", file);

    try {
      const result = await uploadBusinessImage(businessId, category, formData);
      if (result.success) {
        // Server-confirmed: the object is stored and the profile reference is
        // persisted. Show the returned image reference and refresh the server
        // components so the whole page reflects the saved image.
        const dtoImage = result.data.profile
          ? result.data.profile[CATEGORY_DTO_IMAGE_FIELD[category]]
          : null;
        setSavedImage(dtoImage);
        if (pendingPreview) URL.revokeObjectURL(pendingPreview.url);
        setPendingPreview(null);
        setState({ kind: "idle" });
        router.refresh();
      } else {
        setState({
          kind: "error",
          message:
            result.error.code === "FILE_STORAGE_NOT_CONFIGURED"
              ? "بارگذاری تصویر فعلاً فعال نیست؛ سرویس ذخیره‌سازی فایل متصل نشده است."
              : result.error.code === "FILE_STORAGE_UPLOAD_FAILED"
                ? "بارگذاری تصویر ناموفق بود؛ فایل روی سرور ذخیره نشد. کمی بعد دوباره تلاش کنید."
                : result.error.code === "VALIDATION_ERROR"
                  ? result.error.message
                  : "بارگذاری تصویر ناموفق بود. دوباره تلاش کنید.",
        });
      }
    } catch {
      setState({ kind: "error", message: "خطای غیرمنتظره هنگام بارگذاری تصویر." });
    }
  }

  return (
    <div className={clsx("space-y-2 min-w-0", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-700">{label}</span>
        {enabled ? null : (
          <Badge variant="secondary">نیازمند اتصال ذخیره‌ساز</Badge>
        )}
      </div>

      <div
        className={clsx(
          "rounded-xl border border-dashed p-3 transition-colors",
          state.kind === "error"
            ? "border-rose-300 bg-rose-50/50"
            : "border-gray-200 bg-gray-50/60",
        )}
      >
        {shownImage ? (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={shownImage}
              alt={label}
              className="h-16 w-16 shrink-0 rounded-lg border border-gray-200 bg-white object-contain p-1"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-gray-700" title={shownName ?? undefined}>
                {shownName ?? "تصویر ذخیره‌شده"}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-400">
                {pendingPreview ? "پیش‌نمایش — در حال بارگذاری…" : "تصویر فعلی"}
              </p>
            </div>
            {actionable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.kind === "uploading"}
                onClick={() => inputRef.current?.click()}
              >
                {currentImage || pendingPreview || savedImage ? "جایگزینی" : "انتخاب"}
              </Button>
            )}
          </div>
        ) : actionable ? (
          <button
            type="button"
            disabled={state.kind === "uploading"}
            onClick={() => inputRef.current?.click()}
            className="flex h-20 w-full flex-col items-center justify-center gap-1 rounded-lg text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-xs font-medium">انتخاب تصویر</span>
            <span className="text-[11px] text-gray-400">PNG، JPG یا WebP — حداکثر ۵ مگابایت</span>
          </button>
        ) : enabled ? (
          // Storage is configured but no business exists yet (create mode).
          <div className="flex h-20 flex-col items-center justify-center gap-1 text-center">
            <span className="text-[11px] leading-relaxed text-gray-400">
              پس از ایجاد کسب‌وکار می‌توانید {label} را از صفحه تنظیمات بارگذاری کنید.
            </span>
          </div>
        ) : currentImage ? (
          <div className="flex h-20 flex-col items-center justify-center gap-1 text-center">
            <span className="text-[11px] font-medium text-gray-600">
              تصویر فعلی: {currentImage.originalName ?? "—"}
            </span>
            <span className="text-[11px] text-gray-400">
              نمایش و جایگزینی تصویر پس از اتصال ذخیره‌ساز فایل فعال می‌شود.
            </span>
          </div>
        ) : (
          <div className="flex h-20 flex-col items-center justify-center gap-1 text-center">
            <span className="text-[11px] leading-relaxed text-gray-400">
              بارگذاری {label} به‌محض اتصال ذخیره‌ساز فایل (S3) فعال می‌شود.
            </span>
          </div>
        )}

        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={ACCEPTED_MIME_TYPES.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={handleFileSelected}
          disabled={disabled || !enabled || !businessId || state.kind === "uploading"}
        />
      </div>

      {state.kind === "error" && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-600" role="alert">
          <AlertCircleIcon size={14} className="mt-0.5 shrink-0" />
          {state.message}
        </p>
      )}
      {state.kind === "uploading" && (
        <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
          در حال بارگذاری تصویر…
        </p>
      )}
      {state.kind === "idle" && savedImage && !pendingPreview && (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-600">
          <CheckCircleIcon size={14} className="shrink-0" />
          تصویر با موفقیت ذخیره شد.
        </p>
      )}
      {hint && state.kind !== "error" && (
        <p className="text-[11px] leading-relaxed text-gray-400">{hint}</p>
      )}
    </div>
  );
}
