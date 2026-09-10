"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AlertTriangleIcon, CheckIcon, CopyIcon, DownloadIcon, SendIcon } from "@/components/icons";
import type { ExportMetadataDTO } from "@/server/actions/exportActions";
import type { ActionErrorCode } from "@/server/actions/actionResult";

/**
 * «اشتراک‌گذاری در تلگرام» — an HONEST share dialog (V1).
 *
 * Telegram has no server-side send here: the dialog shows the exact share
 * text, copies it to the clipboard on request, links the generated PDF
 * download, and opens `t.me/share/url` so the user posts MANUALLY. The
 * copy states this explicitly — the UI never claims a message was sent,
 * and `hasFileAttachment` is always false (the PDF travels separately).
 */

export interface TelegramShareDialogProps {
  onClose: () => void;
  metadata: ExportMetadataDTO | null;
  loadError: { code: ActionErrorCode; message: string } | null;
  onRetry: () => void;
  /** Same-origin PDF download URL (server sets the Persian filename). */
  pdfUrl: string;
}

const DIALOG_TITLE_ID = "telegram-share-dialog-title";

export function TelegramShareDialog({
  onClose,
  metadata,
  loadError,
  onRetry,
  pdfUrl,
}: TelegramShareDialogProps) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    const text = metadata?.telegram.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard unavailable (permissions / non-secure context): leave the
      // text selectable so the user can copy it manually.
      setCopied(false);
    }
  }

  return (
    <Dialog labelledBy={DIALOG_TITLE_ID} onClose={onClose} className="max-w-lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <SendIcon size={18} className="text-gray-500" />
            <h2 id={DIALOG_TITLE_ID} className="text-sm font-semibold text-gray-900">
              اشتراک‌گذاری در تلگرام
            </h2>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            بستن
          </Button>
        </div>

        {!metadata && !loadError && (
          <p className="rounded-lg bg-gray-50 px-3 py-6 text-center text-xs text-gray-500">
            در حال آماده‌سازی متن اشتراک‌گذاری…
          </p>
        )}

        {loadError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-relaxed text-rose-700"
          >
            <AlertTriangleIcon size={15} className="mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p>آماده‌سازی متن اشتراک‌گذاری ناموفق بود. لطفاً دوباره تلاش کنید.</p>
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                تلاش مجدد
              </Button>
            </div>
          </div>
        )}

        {metadata && (
          <>
            {metadata.isDraft && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                این فاکتور پیش‌نویس است؛ خروجی آن جنبه رسمی ندارد و شماره رسمی روی آن درج
                نمی‌شود.
              </p>
            )}
            <p className="text-xs leading-relaxed text-gray-600">
              متن زیر را کپی کنید و در گفت‌وگوی تلگرام الصاق کنید؛ فایل PDF را هم جداگانه
              دانلود و ارسال کنید. تلگرام به‌صورت خودکار پیامی ارسال نمی‌کند.
            </p>
            <div
              dir="rtl"
              className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs leading-loose text-gray-800"
            >
              {metadata.telegram.text}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={handleCopy}>
                {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                <span>{copied ? "کپی شد" : "کپی متن"}</span>
              </Button>
              <a href={pdfUrl}>
                <Button type="button" variant="outline" size="sm" className="gap-1.5">
                  <DownloadIcon size={14} />
                  <span>دانلود PDF</span>
                </Button>
              </a>
              {metadata.telegram.shareUrl ? (
                <a href={metadata.telegram.shareUrl} target="_blank" rel="noreferrer">
                  <Button type="button" variant="primary" size="sm" className="gap-1.5">
                    <SendIcon size={14} />
                    <span>باز کردن تلگرام</span>
                  </Button>
                </a>
              ) : (
                <span className="text-[11px] text-gray-400">
                  لینک مستقیم تلگرام در دسترس نیست؛ متن را به‌صورت دستی ارسال کنید.
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
