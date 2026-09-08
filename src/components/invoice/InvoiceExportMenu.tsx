"use client";

import * as React from "react";
import clsx from "clsx";
import { Button } from "@/components/ui/button";
import {
  ChevronDownIcon,
  FileTextIcon,
  ImageIcon,
  MailIcon,
  PrinterIcon,
  SendIcon,
  ShareIcon,
  TableIcon,
} from "@/components/icons";
import { printInvoiceDocument } from "@/lib/invoice-print";
import { exportDownloadUrl } from "@/lib/invoice-export";
import {
  getExportMetadata,
  type ExportMetadataDTO,
} from "@/server/actions/exportActions";
import type { ActionError } from "@/server/actions/actionResult";
import { TelegramShareDialog } from "./TelegramShareDialog";
import { GmailSendDialog } from "./GmailSendDialog";

/**
 * «خروجی و اشتراک‌گذاری» — the single export & sharing menu (V1).
 *
 * One compact dropdown instead of seven large buttons: چاپ، PDF، PNG،
 * JPG، Excel، اشتراک در تلگرام، ارسال با جیمیل. File downloads are plain
 * same-origin links to the authenticated export route (the server sets
 * the Persian filename + `no-store`); the share dialogs lazy-load one
 * `getExportMetadata` payload on first open. Nothing here carries
 * secrets — ids are untrusted and re-authorized server-side on every
 * request, and Gmail tokens never leave the server.
 */

export interface InvoiceExportMenuProps {
  businessId: string;
  invoiceId: string;
  isDraft: boolean;
  /** `detail`: print links to the preview page; `preview`: prints in place. */
  mode: "detail" | "preview";
}

type MetadataState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: ExportMetadataDTO }
  | { status: "error"; error: ActionError };

export interface ExportMenuPanelProps {
  businessId: string;
  invoiceId: string;
  isDraft: boolean;
  previewHref: string;
  mode: "detail" | "preview";
  onPrint: () => void;
  onTelegram: () => void;
  onGmail: () => void;
}

function MenuRow({
  icon,
  title,
  hint,
  ...props
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
} & (
  | ({ as: "link"; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>)
  | ({ as: "button" } & React.ButtonHTMLAttributes<HTMLButtonElement>)
)) {
  const className =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-right text-sm text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";
  const content = (
    <>
      <span className="shrink-0 text-gray-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        {hint && <span className="block truncate text-[11px] text-gray-400">{hint}</span>}
      </span>
    </>
  );
  if (props.as === "link") {
    const { as: _as, ...rest } = props;
    return (
      <a role="menuitem" className={className} {...rest}>
        {content}
      </a>
    );
  }
  const { as: _as, ...rest } = props;
  return (
    <button role="menuitem" type="button" className={className} {...rest}>
      {content}
    </button>
  );
}

/**
 * Presentational menu panel (statically renderable for tests) — the
 * container below owns open state, metadata loading and the dialogs.
 */
export function ExportMenuPanel({
  businessId,
  invoiceId,
  isDraft,
  previewHref,
  mode,
  onPrint,
  onTelegram,
  onGmail,
}: ExportMenuPanelProps) {
  return (
    <div className="space-y-0.5 p-1.5">
      {mode === "detail" ? (
        <MenuRow
          as="link"
          href={previewHref}
          icon={<PrinterIcon size={17} />}
          title="چاپ"
          hint="پیش‌نمایش و چاپ A4"
        />
      ) : (
        <MenuRow
          as="button"
          onClick={onPrint}
          icon={<PrinterIcon size={17} />}
          title="چاپ"
          hint="چاپ A4 همین صفحه"
        />
      )}
      <MenuRow
        as="link"
        href={exportDownloadUrl(businessId, invoiceId, "pdf")}
        icon={<FileTextIcon size={17} />}
        title="دانلود PDF"
        hint="سند A4، مناسب چاپ و بایگانی"
      />
      <MenuRow
        as="link"
        href={exportDownloadUrl(businessId, invoiceId, "png")}
        icon={<ImageIcon size={17} />}
        title="دانلود PNG"
        hint="تصویر باکیفیت"
      />
      <MenuRow
        as="link"
        href={exportDownloadUrl(businessId, invoiceId, "jpg")}
        icon={<ImageIcon size={17} />}
        title="دانلود JPG"
        hint="تصویر کم‌حجم"
      />
      <MenuRow
        as="link"
        href={exportDownloadUrl(businessId, invoiceId, "xlsx")}
        icon={<TableIcon size={17} />}
        title="دانلود Excel"
        hint="فایل محاسباتی ‎.xlsx"
      />
      <div className="mx-2 my-1.5 border-t border-gray-100" role="separator" />
      <MenuRow
        as="button"
        onClick={onTelegram}
        icon={<SendIcon size={17} />}
        title="اشتراک در تلگرام"
        hint="متن آماده + لینک دانلود PDF"
      />
      <MenuRow
        as="button"
        onClick={onGmail}
        icon={<MailIcon size={17} />}
        title="ارسال با جیمیل"
        hint="ارسال PDF به ایمیل مشتری"
      />
      {isDraft && (
        <p className="px-3 pb-1.5 pt-2 text-[11px] leading-relaxed text-amber-700">
          خروجی پیش‌نویس جنبه رسمی ندارد و شماره رسمی روی آن درج نمی‌شود.
        </p>
      )}
    </div>
  );
}

export function InvoiceExportMenu({ businessId, invoiceId, isDraft, mode }: InvoiceExportMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [metadata, setMetadata] = React.useState<MetadataState>({ status: "idle" });
  const [dialog, setDialog] = React.useState<"telegram" | "gmail" | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const previewHref = `/dashboard/invoices/${encodeURIComponent(invoiceId)}/preview`;

  const loadMetadata = React.useCallback(async () => {
    setMetadata((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      const result = await getExportMetadata(businessId, invoiceId);
      if (result.success) {
        setMetadata({ status: "ready", data: result.data });
      } else {
        setMetadata({ status: "error", error: result.error });
      }
    } catch {
      setMetadata({
        status: "error",
        error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
      });
    }
  }, [businessId, invoiceId]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void loadMetadata();
  }

  function openDialog(which: "telegram" | "gmail") {
    setOpen(false);
    setDialog(which);
    void loadMetadata();
  }

  React.useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open ]);

  const pdfUrl = exportDownloadUrl(businessId, invoiceId, "pdf");

  return (
    <div ref={containerRef} className="relative print:hidden">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <ShareIcon size={15} />
        <span>خروجی و اشتراک‌گذاری</span>
        <ChevronDownIcon size={14} className={clsx("transition-transform", open && "rotate-180")} />
      </Button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label="خروجی و اشتراک‌گذاری فاکتور"
            className="absolute left-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white shadow-lg"
          >
            <ExportMenuPanel
              businessId={businessId}
              invoiceId={invoiceId}
              isDraft={isDraft}
              previewHref={previewHref}
              mode={mode}
              onPrint={() => {
                setOpen(false);
                printInvoiceDocument();
              }}
              onTelegram={() => openDialog("telegram")}
              onGmail={() => openDialog("gmail")}
            />
          </div>
        </>
      )}

      {dialog === "telegram" && (
        <TelegramShareDialog
          onClose={() => setDialog(null)}
          metadata={metadata.status === "ready" ? metadata.data : null}
          loadError={metadata.status === "error" ? metadata.error : null}
          onRetry={() => void loadMetadata()}
          pdfUrl={pdfUrl}
        />
      )}
      {dialog === "gmail" && (
        <GmailSendDialog
          onClose={() => setDialog(null)}
          businessId={businessId}
          invoiceId={invoiceId}
          metadata={metadata.status === "ready" ? metadata.data : null}
          loadError={metadata.status === "error" ? metadata.error : null}
          onRetry={() => void loadMetadata()}
        />
      )}
    </div>
  );
}
