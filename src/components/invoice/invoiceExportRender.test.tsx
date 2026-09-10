import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExportMetadataDTO } from "@/server/actions/exportActions";
import { ExportMenuPanel } from "@/components/invoice/InvoiceExportMenu";
import { TelegramShareDialog } from "@/components/invoice/TelegramShareDialog";
import { GmailSendDialog } from "@/components/invoice/GmailSendDialog";
import { GmailOutcomeMessage } from "@/components/invoice/GmailOutcomeBanner";

/**
 * Render-level tests for the Export & Sharing V1 UI.
 *
 * These prove what the service suites cannot: that the menu exposes all
 * seven actions with correct download URLs, that the share dialogs render
 * the server payload honestly (no "sent" claims for Telegram, draft
 * notices where due), and that the Gmail connect outcome has dedicated
 * copy. `renderToStaticMarkup` covers the initial (presentational) state;
 * the interactive send/copy flows delegate to the covered Server Actions.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/invoices/inv-1",
  useSearchParams: () => new URLSearchParams(),
}));

// Cuts the server chain (actions → services → prisma), mirroring the
// payment-panel render tests; the actions are covered by their own suite.
vi.mock("@/server/actions/exportActions", () => ({
  getExportMetadata: vi.fn(),
  getGmailConnectionStatus: vi.fn(),
  sendInvoiceGmail: vi.fn(),
}));

function metadataFixture(overrides: Partial<ExportMetadataDTO> = {}): ExportMetadataDTO {
  return {
    businessId: "biz-1",
    invoiceId: "inv-1",
    isDraft: false,
    displayNumber: "1024",
    downloads: [
      { format: "pdf", url: "/api/export?format=pdf", filename: "فاکتور-1024.pdf" },
      { format: "png", url: "/api/export?format=png", filename: "فاکتور-1024.png" },
      { format: "jpg", url: "/api/export?format=jpg", filename: "فاکتور-1024.jpg" },
      { format: "xlsx", url: "/api/export?format=xlsx", filename: "فاکتور-1024.xlsx" },
    ],
    telegram: {
      text: "فاکتور شماره ۱۰۲۴",
      shareUrl: "https://t.me/share/url?url=x&text=y",
      hasFileAttachment: false,
      isDraft: false,
    },
    gmail: {
      connected: true,
      to: "customer@example.ir",
      subject: "فاکتور ۱۰۲۴",
      body: "سلام",
    },
    ...overrides,
  };
}

const NOOP = () => {};

describe("ExportMenuPanel", () => {
  function renderPanel(isDraft: boolean, mode: "detail" | "preview" = "detail"): string {
    return renderToStaticMarkup(
      <ExportMenuPanel
        businessId="biz-1"
        invoiceId="inv-1"
        isDraft={isDraft}
        previewHref="/dashboard/invoices/inv-1/preview"
        mode={mode}
        onPrint={NOOP}
        onTelegram={NOOP}
        onGmail={NOOP}
      />,
    );
  }

  it("exposes all seven actions with honest labels", () => {
    const html = renderPanel(false);
    for (const label of [
      "چاپ",
      "دانلود PDF",
      "دانلود PNG",
      "دانلود JPG",
      "دانلود Excel",
      "اشتراک‌گذاری در تلگرام",
      "ارسال PDF با Gmail",
    ]) {
      expect(html).toContain(label);
    }
    // Exactly seven menu items — one compact menu, not seven buttons.
    expect(html.match(/role="menuitem"/g)).toHaveLength(7);
  });

  it("links downloads to the export route and print to the preview page", () => {
    const html = renderPanel(false);
    expect(html).toContain("/api/businesses/biz-1/invoices/inv-1/export?format=pdf");
    expect(html).toContain("/api/businesses/biz-1/invoices/inv-1/export?format=png");
    expect(html).toContain("/api/businesses/biz-1/invoices/inv-1/export?format=jpg");
    expect(html).toContain("/api/businesses/biz-1/invoices/inv-1/export?format=xlsx");
    expect(html).toContain("/dashboard/invoices/inv-1/preview");
  });

  it("prints in place on the preview page instead of linking", () => {
    const html = renderPanel(false, "preview");
    expect(html).toContain("چاپ A4 همین صفحه");
    expect(html).not.toContain("/dashboard/invoices/inv-1/preview");
  });

  it("marks draft exports as unofficial, and only drafts", () => {
    expect(renderPanel(true)).toContain("جنبه رسمی ندارد");
    expect(renderPanel(false)).not.toContain("جنبه رسمی ندارد");
  });
});

describe("TelegramShareDialog", () => {
  it("renders the share text with the honest no-auto-send disclaimer", () => {
    const html = renderToStaticMarkup(
      <TelegramShareDialog
        onClose={NOOP}
        metadata={metadataFixture()}
        loadError={null}
        onRetry={NOOP}
        pdfUrl="/api/export?format=pdf"
      />,
    );
    expect(html).toContain("فاکتور شماره ۱۰۲۴");
    expect(html).toContain("به‌صورت خودکار پیامی ارسال نمی‌کند");
    expect(html).toContain("https://t.me/share/url");
    expect(html).toContain("دانلود PDF");
    // Never claims a message was sent.
    expect(html).not.toContain("ارسال شد");
  });

  it("warns on drafts and degrades without a share URL", () => {
    const html = renderToStaticMarkup(
      <TelegramShareDialog
        onClose={NOOP}
        metadata={metadataFixture({
          isDraft: true,
          telegram: { text: "پیش‌نویس", shareUrl: null, hasFileAttachment: false, isDraft: true },
        })}
        loadError={null}
        onRetry={NOOP}
        pdfUrl="/api/export?format=pdf"
      />,
    );
    expect(html).toContain("پیش‌نویس است");
    expect(html).toContain("به‌صورت دستی ارسال کنید");
    expect(html).not.toContain("t.me/share");
  });

  it("renders loading and error states without the share content", () => {
    const loading = renderToStaticMarkup(
      <TelegramShareDialog onClose={NOOP} metadata={null} loadError={null} onRetry={NOOP} pdfUrl="/x" />,
    );
    expect(loading).toContain("در حال آماده‌سازی");

    const failed = renderToStaticMarkup(
      <TelegramShareDialog
        onClose={NOOP}
        metadata={null}
        loadError={{ code: "INTERNAL_ERROR", message: "boom" }}
        onRetry={NOOP}
        pdfUrl="/x"
      />,
    );
    expect(failed).toContain("تلاش مجدد");
    expect(failed).not.toContain("boom");
  });
});

describe("GmailSendDialog", () => {
  it("prefills the editable draft when connected", () => {
    const html = renderToStaticMarkup(
      <GmailSendDialog
        onClose={NOOP}
        businessId="biz-1"
        invoiceId="inv-1"
        metadata={metadataFixture()}
        loadError={null}
        onRetry={NOOP}
      />,
    );
    expect(html).toContain("customer@example.ir");
    expect(html).toContain("فاکتور ۱۰۲۴");
    // The attachment note is honest: the PDF is built at send time.
    expect(html).toContain("هنگام ارسال ساخته");
  });

  it("offers the connect flow when Gmail is not connected", () => {
    const html = renderToStaticMarkup(
      <GmailSendDialog
        onClose={NOOP}
        businessId="biz-1"
        invoiceId="inv-1"
        metadata={metadataFixture({ gmail: { connected: false, to: "", subject: "", body: "" } })}
        loadError={null}
        onRetry={NOOP}
      />,
    );
    expect(html).toContain("اتصال جیمیل");
    expect(html).toContain("/api/gmail/connect");
    // The send form (with its submit button) is absent until connected.
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain("gmail-send-to");
  });

  it("warns on drafts and renders loading/error states safely", () => {
    const draft = renderToStaticMarkup(
      <GmailSendDialog
        onClose={NOOP}
        businessId="biz-1"
        invoiceId="inv-1"
        metadata={metadataFixture({ isDraft: true })}
        loadError={null}
        onRetry={NOOP}
      />,
    );
    expect(draft).toContain("پیش‌نویس است");

    const loading = renderToStaticMarkup(
      <GmailSendDialog
        onClose={NOOP}
        businessId="biz-1"
        invoiceId="inv-1"
        metadata={null}
        loadError={null}
        onRetry={NOOP}
      />,
    );
    expect(loading).toContain("در حال آماده‌سازی");

    const failed = renderToStaticMarkup(
      <GmailSendDialog
        onClose={NOOP}
        businessId="biz-1"
        invoiceId="inv-1"
        metadata={null}
        loadError={{ code: "FORBIDDEN", message: "internal detail" }}
        onRetry={NOOP}
      />,
    );
    expect(failed).toContain("تلاش مجدد");
    expect(failed).not.toContain("internal detail");
  });
});

describe("GmailOutcomeMessage", () => {
  it("has distinct honest copy per outcome", () => {
    expect(renderToStaticMarkup(<GmailOutcomeMessage outcome="connected" />)).toContain(
      "جیمیل متصل شد",
    );
    expect(renderToStaticMarkup(<GmailOutcomeMessage outcome="error" />)).toContain("ناموفق بود");
    expect(renderToStaticMarkup(<GmailOutcomeMessage outcome="unavailable" />)).toContain(
      "پیکربندی نشده",
    );
  });
});
