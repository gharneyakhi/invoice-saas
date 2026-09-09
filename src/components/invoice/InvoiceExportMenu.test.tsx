// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  getExportMetadata,
  sendInvoiceGmail,
} from "@/server/actions/exportActions";
import { printInvoiceDocument } from "@/lib/invoice-print";
import {
  ExportMenuPanel,
  InvoiceExportMenu,
} from "@/components/invoice/InvoiceExportMenu";
import type { ExportMetadataDTO } from "@/server/actions/exportActions";

/**
 * Interaction tests for the Export & Sharing V1 menu (happy-dom).
 *
 * The static render suite (`invoiceExportRender.test.tsx`) pins labels,
 * links and dialog copy; THESE tests pin behavior: open/close (toggle,
 * Escape, outside click, selection), the metadata-driven dialogs, the
 * honest Gmail send flow (success only after API confirmation, Persian
 * errors otherwise) and the not-connected connect flow. Server Actions
 * and navigation are mocked at the module boundary.
 */

vi.mock("@/server/actions/exportActions", () => ({
  getExportMetadata: vi.fn(),
  getGmailConnectionStatus: vi.fn(),
  sendInvoiceGmail: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/invoices/inv-1",
}));

vi.mock("@/lib/invoice-print", () => ({
  printInvoiceDocument: vi.fn(),
}));

const mockedMetadata = vi.mocked(getExportMetadata);
const mockedSend = vi.mocked(sendInvoiceGmail);
const mockedPrint = vi.mocked(printInvoiceDocument);

function metadataFixture(overrides: Partial<ExportMetadataDTO> = {}): ExportMetadataDTO {
  return {
    businessId: "biz-1",
    invoiceId: "inv-1",
    isDraft: false,
    displayNumber: "۱۰۲۴",
    downloads: [
      { format: "pdf", url: "/api/businesses/biz-1/invoices/inv-1/export?format=pdf", filename: "فاکتور-۱۰۲۴.pdf" },
      { format: "png", url: "/api/businesses/biz-1/invoices/inv-1/export?format=png", filename: "فاکتور-۱۰۲۴.png" },
      { format: "jpg", url: "/api/businesses/biz-1/invoices/inv-1/export?format=jpg", filename: "فاکتور-۱۰۲۴.jpg" },
      { format: "xlsx", url: "/api/businesses/biz-1/invoices/inv-1/export?format=xlsx", filename: "فاکتور-۱۰۲۴.xlsx" },
    ],
    telegram: {
      text: "فاکتور شماره ۱۰۲۴\nمبلغ نهایی: ۱۸۶,۳۹۰ تومان",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderMenu(mode: "detail" | "preview" = "preview") {
  return render(
    <InvoiceExportMenu businessId="biz-1" invoiceId="inv-1" isDraft={false} mode={mode} />,
  );
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: /خروجی و اشتراک‌گذاری/ });
}

/**
 * happy-dom navigates on real anchor clicks; capture-phase preventDefault
 * keeps the document mounted while the component's own onClick still runs.
 */
function neutralizeLinkNavigation(container: HTMLElement) {
  container.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as HTMLElement).closest?.("a[href]");
      if (anchor) event.preventDefault();
    },
    true,
  );
}

// No `globals: true` in vitest config, so RTL auto-cleanup never
// registers — unmount explicitly to keep queries single-match.
afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedMetadata.mockResolvedValue({ success: true, data: metadataFixture() });
});

describe("menu open/close + accessibility", () => {
  it("is closed by default with correct trigger semantics", () => {
    renderMenu();
    const button = trigger();
    expect((button as HTMLElement).getAttribute("aria-haspopup")).toBe("menu");
    expect((button as HTMLElement).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on trigger click with seven menu items and loads metadata once", async () => {
    renderMenu();
    fireEvent.click(trigger());

    const menu = await screen.findByRole("menu", { name: "خروجی و اشتراک‌گذاری فاکتور" });
    expect((trigger() as HTMLElement).getAttribute("aria-expanded")).toBe("true");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(7);
    expect(mockedMetadata).toHaveBeenCalledWith("biz-1", "inv-1");
  });

  it("toggles closed on a second trigger click", async () => {
    renderMenu();
    fireEvent.click(trigger());
    await screen.findByRole("menu");
    fireEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    expect((trigger() as HTMLElement).getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape", async () => {
    renderMenu();
    fireEvent.click(trigger());
    await screen.findByRole("menu");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on outside click (overlay)", async () => {
    const { container } = renderMenu();
    fireEvent.click(trigger());
    await screen.findByRole("menu");
    const overlay = container.querySelector("button.fixed.inset-0") as HTMLElement;
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when a download link is selected", async () => {
    const { container } = renderMenu();
    neutralizeLinkNavigation(container);
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    const pdfLink = menu.querySelector(
      'a[href="/api/businesses/biz-1/invoices/inv-1/export?format=pdf"]',
    ) as HTMLElement;
    expect(pdfLink.getAttribute("role")).toBe("menuitem");
    fireEvent.click(pdfLink);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("notifies onNavigate for panel link selections", () => {
    const onNavigate = vi.fn();
    const noop = () => {};
    render(
      <ExportMenuPanel
        businessId="biz-1"
        invoiceId="inv-1"
        isDraft={false}
        previewHref="/dashboard/invoices/inv-1/preview"
        mode="preview"
        onPrint={noop}
        onTelegram={noop}
        onGmail={noop}
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /دانلود Excel/ }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("prints in place on preview mode and closes the menu", async () => {
    renderMenu("preview");
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^چاپ/ }));
    expect(mockedPrint).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("links print to the preview page on detail mode", async () => {
    const { container } = renderMenu("detail");
    neutralizeLinkNavigation(container);
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    const printLink = within(menu).getByRole("menuitem", { name: /^چاپ/ });
    expect(printLink.tagName).toBe("A");
    expect(printLink.getAttribute("href")).toBe("/dashboard/invoices/inv-1/preview");
  });
});

describe("Telegram dialog flow", () => {
  it("opens the honest share dialog from the menu", async () => {
    renderMenu();
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /اشتراک‌گذاری در تلگرام/ }));

    expect(screen.queryByRole("menu")).toBeNull();
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "اشتراک‌گذاری در تلگرام" }),
    ).not.toBeNull();
    expect(within(dialog).getByText(/فاکتور شماره ۱۰۲۴/)).not.toBeNull();
    expect(within(dialog).getByText(/به‌صورت خودکار پیامی ارسال نمی‌کند/)).not.toBeNull();
    const openLink = within(dialog).getByRole("link", { name: /باز کردن تلگرام/ });
    expect(openLink.getAttribute("href")).toContain("https://t.me/share/url");
    // No success/send claims anywhere in the dialog.
    expect(within(dialog).queryByText(/ارسال شد/)).toBeNull();
  });

  it("shows loading then the payload when metadata arrives late", async () => {
    const gate = deferred<{ success: true; data: ExportMetadataDTO }>();
    mockedMetadata.mockReturnValue(gate.promise);
    renderMenu();
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /اشتراک‌گذاری در تلگرام/ }));

    expect(await screen.findByText(/در حال آماده‌سازی/)).not.toBeNull();
    gate.resolve({ success: true, data: metadataFixture() });
    expect(await screen.findByText(/فاکتور شماره ۱۰۲۴/)).not.toBeNull();
  });

  it("shows the error state with a working retry", async () => {
    const failure = {
      success: false as const,
      error: { code: "INTERNAL_ERROR" as const, message: "boom" },
    };
    mockedMetadata.mockResolvedValueOnce(failure).mockResolvedValueOnce(failure);
    renderMenu();
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /اشتراک‌گذاری در تلگرام/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).not.toBeNull();
    expect(within(dialog).queryByText("boom")).toBeNull();
    const calls = mockedMetadata.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "تلاش مجدد" }));
    expect(mockedMetadata.mock.calls.length).toBe(calls + 1);
    // The retry hits the default success mock and the payload appears.
    expect(await within(dialog).findByText(/فاکتور شماره ۱۰۲۴/)).not.toBeNull();
  });

  it("closes the dialog on Escape", async () => {
    renderMenu();
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /اشتراک‌گذاری در تلگرام/ }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Gmail dialog flow", () => {
  it("sends only after the API confirms and then reports success", async () => {
    const gate = deferred<{ success: true; data: { messageId: string } }>();
    mockedSend.mockReturnValue(gate.promise);
    renderMenu();
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /ارسال PDF با Gmail/ }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "ارسال PDF با Gmail" }),
    ).not.toBeNull();
    // Prefilled from the server draft.
    expect((within(dialog).getByLabelText(/گیرنده/) as HTMLInputElement).value).toBe(
      "customer@example.ir",
    );

    const submit = within(dialog).getByRole("button", { name: "ارسال فاکتور" });
    fireEvent.click(submit);
    expect(mockedSend).toHaveBeenCalledWith("biz-1", "inv-1", {
      to: "customer@example.ir",
      subject: "فاکتور ۱۰۲۴",
      body: "سلام",
    });
    // Sending state, and crucially NO success claim before confirmation.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByText(/با موفقیت/)).toBeNull();

    gate.resolve({ success: true, data: { messageId: "gmail-msg-1" } });
    expect(await within(dialog).findByText(/با موفقیت/)).not.toBeNull();
  });

  it("shows a Persian error and no success claim when the send fails", async () => {
    mockedSend.mockResolvedValue({
      success: false,
      error: { code: "GMAIL_SEND_FAILED", message: "Sending through Gmail failed." },
    });
    renderMenu();
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /ارسال PDF با Gmail/ }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ارسال فاکتور" }));
    expect(await within(dialog).findByText(/ناموفق بود/)).not.toBeNull();
    expect(within(dialog).queryByText(/با موفقیت/)).toBeNull();
  });

  it("offers the connect flow when Gmail is not connected", async () => {
    mockedMetadata.mockResolvedValue({
      success: true,
      data: metadataFixture({ gmail: { connected: false, to: "", subject: "", body: "" } }),
    });
    renderMenu();
    fireEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /ارسال PDF با Gmail/ }));

    const dialog = await screen.findByRole("dialog");
    const connectLink = within(dialog).getByRole("link", { name: /اتصال جیمیل/ });
    expect(connectLink.getAttribute("href")).toBe(
      "/api/gmail/connect?returnTo=%2Fdashboard%2Finvoices%2Finv-1",
    );
    expect(within(dialog).queryByRole("button", { name: "ارسال فاکتور" })).toBeNull();
  });
});
