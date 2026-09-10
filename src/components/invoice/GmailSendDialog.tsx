"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  MailIcon,
} from "@/components/icons";
import { gmailConnectUrl } from "@/lib/invoice-export";
import {
  sendInvoiceGmail,
  type ExportMetadataDTO,
} from "@/server/actions/exportActions";
import type { ActionError, ActionErrorCode } from "@/server/actions/actionResult";

/**
 * «ارسال PDF با Gmail» — server-side Gmail send of the invoice PDF (V1).
 *
 * States: loading → (not-connected → connect link) | (form → sending →
 * sent | error). The recipient/subject/body arrive prefilled from the
 * server draft and stay editable; the PDF is generated server-side at
 * send time and attached there. Success renders only after the Gmail API
 * confirms. Tokens never touch this component — the connect flow hands
 * off to `/api/gmail/connect` and returns to the current page.
 */

export interface GmailSendDialogProps {
  onClose: () => void;
  businessId: string;
  invoiceId: string;
  metadata: ExportMetadataDTO | null;
  loadError: ActionError | null;
  onRetry: () => void;
}

const DIALOG_TITLE_ID = "gmail-send-dialog-title";

/** Friendly Persian copy per stable action error code for this dialog. */
const SEND_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  UNAUTHORIZED: "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.",
  FORBIDDEN: "شما به این فاکتور دسترسی ندارید.",
  NOT_FOUND: "فاکتور مورد نظر یافت نشد.",
  VALIDATION_ERROR: "گیرنده، موضوع یا متن پیام معتبر نیست. لطفاً بررسی کنید.",
  BUSINESS_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  INVOICE_LIMIT_REACHED: "پلن فعلی شما اجازه این عملیات را نمی‌دهد.",
  ENTITLEMENT_DATA_ERROR: "اطلاعات اشتراک در دسترس نیست. لطفاً با پشتیبانی تماس بگیرید.",
  FILE_STORAGE_NOT_CONFIGURED: "سرویس ذخیره‌سازی فایل در دسترس نیست.",
  FILE_STORAGE_UPLOAD_FAILED: "سرویس ذخیره‌سازی فایل در دسترس نیست.",
  GMAIL_NOT_CONNECTED: "اتصال جیمیل قطع شده است؛ لطفاً دوباره متصل شوید.",
  GMAIL_SEND_FAILED: "ارسال از طریق جیمیل ناموفق بود. لطفاً دوباره تلاش کنید.",
  GMAIL_NOT_CONFIGURED: "سرویس ارسال جیمیل در دسترس نیست.",
  INTERNAL_ERROR: "خطای غیرمنتظره‌ای رخ داد. لطفاً چند لحظه بعد دوباره تلاش کنید.",
};

export function GmailSendDialog({
  onClose,
  businessId,
  invoiceId,
  metadata,
  loadError,
  onRetry,
}: GmailSendDialogProps) {
  const pathname = usePathname();
  // Prefilled from the server draft when it is already loaded; the effect
  // below covers the late-arrival case without clobbering user edits.
  const [to, setTo] = React.useState(metadata?.gmail.to ?? "");
  const [subject, setSubject] = React.useState(metadata?.gmail.subject ?? "");
  const [body, setBody] = React.useState(metadata?.gmail.body ?? "");
  const [draftSynced, setDraftSynced] = React.useState(metadata !== null);
  const [isSending, setIsSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<ActionError | null>(null);
  const [sent, setSent] = React.useState(false);
  const [disconnected, setDisconnected] = React.useState(false);

  // Prefill the editable draft once the server payload arrives; never
  // overwrite the user's own edits afterwards.
  React.useEffect(() => {
    if (metadata && !draftSynced) {
      setTo(metadata.gmail.to);
      setSubject(metadata.gmail.subject);
      setBody(metadata.gmail.body);
      setDraftSynced(true);
    }
  }, [metadata, draftSynced]);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    setIsSending(true);
    setSendError(null);
    try {
      const result = await sendInvoiceGmail(businessId, invoiceId, { to, subject, body });
      if (result.success) {
        setSent(true);
      } else if (result.error.code === "GMAIL_NOT_CONNECTED") {
        // The connection was revoked between load and send — offer the
        // connect flow instead of a dead-end error.
        setDisconnected(true);
      } else {
        setSendError(result.error);
      }
    } catch {
      setSendError({ code: "INTERNAL_ERROR", message: "An unexpected error occurred" });
    } finally {
      setIsSending(false);
    }
  }

  const connected = (metadata?.gmail.connected ?? false) && !disconnected;

  return (
    <Dialog labelledBy={DIALOG_TITLE_ID} onClose={onClose} className="max-w-lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <MailIcon size={18} className="text-gray-500" />
            <h2 id={DIALOG_TITLE_ID} className="text-sm font-semibold text-gray-900">
              ارسال PDF با Gmail
            </h2>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            بستن
          </Button>
        </div>

        {!metadata && !loadError && (
          <p className="rounded-lg bg-gray-50 px-3 py-6 text-center text-xs text-gray-500">
            در حال آماده‌سازی پیش‌نویس ایمیل…
          </p>
        )}

        {loadError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-relaxed text-rose-700"
          >
            <AlertTriangleIcon size={15} className="mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p>آماده‌سازی پیش‌نویس ایمیل ناموفق بود. لطفاً دوباره تلاش کنید.</p>
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                تلاش مجدد
              </Button>
            </div>
          </div>
        )}

        {metadata && sent && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-relaxed text-emerald-800">
              <CheckCircleIcon size={16} className="mt-0.5 shrink-0" />
              <p>فاکتور با موفقیت از طریق جیمیل ارسال شد.</p>
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="primary" size="sm" onClick={onClose}>
                بستن
              </Button>
            </div>
          </div>
        )}

        {metadata && !sent && !connected && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-gray-600">
              برای ارسال فاکتور با جیمیل، ابتدا حساب گوگل خود را متصل کنید. پس از اتصال،
              به همین صفحه برمی‌گردید.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <a href={gmailConnectUrl(pathname ?? "/dashboard")}>
                <Button type="button" variant="primary" size="sm" className="gap-1.5">
                  <MailIcon size={14} />
                  <span>اتصال جیمیل</span>
                </Button>
              </a>
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                انصراف
              </Button>
            </div>
          </div>
        )}

        {metadata && !sent && connected && (
          <form onSubmit={handleSend} className="space-y-3">
            {metadata.isDraft && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                این فاکتور پیش‌نویس است؛ فایل ارسالی جنبه رسمی ندارد و شماره رسمی روی آن
                درج نمی‌شود.
              </p>
            )}
            <Field label="گیرنده" htmlFor="gmail-send-to" required>
              <Input
                id="gmail-send-to"
                type="email"
                dir="ltr"
                required
                maxLength={254}
                value={to}
                onChange={(event) => setTo(event.target.value)}
                placeholder="customer@example.com"
                className="text-left"
              />
            </Field>
            <Field label="موضوع" htmlFor="gmail-send-subject" required>
              <Input
                id="gmail-send-subject"
                type="text"
                required
                maxLength={200}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </Field>
            <Field label="متن پیام" htmlFor="gmail-send-body" required>
              <Textarea
                id="gmail-send-body"
                required
                maxLength={10000}
                rows={6}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </Field>
            <p className="text-[11px] leading-relaxed text-gray-400">
              فایل PDF فاکتور هنگام ارسال ساخته و به همین ایمیل پیوست می‌شود.
            </p>
            {sendError && (
              <p
                role="alert"
                className="flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-[11px] leading-relaxed text-rose-700"
              >
                <AlertTriangleIcon size={13} className="mt-0.5 shrink-0" />
                <span>{SEND_ERROR_MESSAGES[sendError.code]}</span>
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                انصراف
              </Button>
              <Button type="submit" variant="primary" size="sm" isLoading={isSending}>
                ارسال فاکتور
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
