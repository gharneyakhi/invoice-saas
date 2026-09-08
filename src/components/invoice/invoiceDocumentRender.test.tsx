import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoicePreviewDocument } from "@/components/invoice/InvoicePreviewDocument";
import { InvoiceEditorActionsBar } from "@/components/invoice/InvoiceEditorActionsBar";
import { buildLivePreviewModel, type LivePreviewContext } from "@/lib/invoice-live-preview";
import { resolveEditorCapabilities } from "@/lib/invoice-editor-state";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";

/**
 * Render-level smoke tests for the editor's live preview.
 *
 * These prove what the model tests cannot: that the document the editor draws
 * really contains the user's data (and the business's branding), in the same
 * markup the print route uses. Rendering is done with `renderToStaticMarkup`
 * because the invoice document is pure markup — no hooks, no context — which
 * is also what guarantees the editor's preview and the server's preview are the
 * same component, not two implementations of an invoice.
 */

const CONTEXT: LivePreviewContext = {
  businessId: "biz-1",
  fallbackBusinessName: "البرز",
  currentProfile: {
    businessName: "فروشگاه البرز",
    slogan: "کیفیت، به قیمت منصفانه",
    ownerName: "علی رضایی",
    address: "کرج، خیابان بهار ۱۲",
    email: "sales@alborz.test",
    mobile: "09126667777",
    landline: "02632223333",
    cardNumber: "6104337800000000",
    accountNumber: "1234567890",
    iban: "IR820540102680020900941012",
    primaryColor: "#0f766e",
    footerText: "با تشکر از همراهی شما",
    logoFileId: "file-logo",
    sellerStampFileId: "file-stamp",
    sellerSignatureFileId: "file-sign",
  },
  images: {
    logo: { fileId: "file-logo", url: "https://cdn.test/logo.png" },
    sellerStamp: { fileId: "file-stamp", url: "https://cdn.test/stamp.png" },
    sellerSignature: { fileId: "file-sign", url: "https://cdn.test/sign.png" },
  },
  currency: "IRR",
  customers: [
    {
      id: "cust-1",
      name: "شرکت آلفا",
      mobile: "09120000001",
      phone: "02111111111",
      email: "buyer@example.com",
      address: "تهران، خیابان ولیعصر ۵",
      nationalId: "1110000000",
      economicCode: "2220000000",
    },
  ],
};

function formState(overrides: Partial<InvoiceEditorFields> = {}): InvoiceEditorFields {
  return {
    invoiceType: "FINAL",
    issueDate: "2026-03-05",
    dueDate: "2026-03-30",
    customerId: "cust-1",
    notes: "تحویل در اسرع وقت",
    globalDiscountPercent: "10",
    taxPercent: "9",
    items: [
      {
        productId: "",
        title: "خدمات طراحی سایت",
        description: "طراحی رابط کاربری",
        unit: "ساعت",
        quantity: "3",
        unitPrice: "200000",
        discountPercent: "25",
      },
    ],
    ...overrides,
  };
}

function renderForm(overrides: Partial<InvoiceEditorFields> = {}, context = CONTEXT) {
  const model = buildLivePreviewModel({ context, values: formState(overrides) });
  return { html: renderToStaticMarkup(<InvoicePreviewDocument model={model} />), model };
}

describe("live preview document — the real invoice, not a placeholder", () => {
  it("renders the A4 sheet with the business letterhead and brand color", () => {
    const { html } = renderForm();

    expect(html).toContain("invoice-print-sheet");
    expect(html).toContain("فروشگاه البرز");
    expect(html).toContain("کیفیت، به قیمت منصفانه");
    expect(html).toContain("کرج، خیابان بهار ۱۲");
    expect(html).toContain("6104337800000000");
    expect(html).toContain("IR820540102680020900941012");
    expect(html).toContain("--pv-brand:#0f766e");
    // the printable document, not an editor card
    expect(html).toContain("با تشکر از همراهی شما");
  });

  it("shows logo, seller stamp and signature images from the resolved urls", () => {
    const { html } = renderForm();

    expect(html).toContain('src="https://cdn.test/logo.png"');
    expect(html).toContain('alt="لوگوی کسب‌وکار"');
    expect(html).toContain('src="https://cdn.test/stamp.png"');
    expect(html).toContain('alt="مهر فروشنده"');
    expect(html).toContain('src="https://cdn.test/sign.png"');
    expect(html).toContain('alt="امضای فروشنده"');
  });

  it("renders the invoice type, draft status and no invoice number", () => {
    const { html, model } = renderForm();

    expect(html).toContain("فاکتور رسمی");
    expect(html).toContain("پیش‌نویس");
    expect(html).toContain("تاریخ صدور");
    // An unsaved invoice has nothing to print in the number slot.
    expect(model.officialNumber).toBeNull();
    expect(html).not.toContain("DRAFT-");
    expect(html).not.toMatch(/شماره فاکتور<\/span><span[^>]*>۱/);
  });

  it("renders the selected customer block", () => {
    const { html } = renderForm();

    expect(html).toContain("مشتری / گیرنده");
    expect(html).toContain("شرکت آلفا");
    expect(html).toContain("تهران، خیابان ولیعصر ۵");
  });

  it("renders the line items with quantity, unit, price and discount", () => {
    const { html } = renderForm();

    expect(html).toContain("خدمات طراحی سایت");
    expect(html).toContain("طراحی رابط کاربری");
    expect(html).toContain("ساعت");
    // 3 × 200,000 = 600,000 ; −25% = 450,000 ; −10% global = 405,000 ; +9% VAT = 441,450
    expect(html).toContain("۶۰۰,۰۰۰");
    expect(html).toContain("۱۵۰,۰۰۰");
    expect(html).toContain("۴۵,۰۰۰");
    expect(html).toContain("۳۶,۴۵۰");
    expect(html).toContain("۴۴۱,۴۵۰ ریال");
  });

  it("shows a newly typed item title immediately, without any save", () => {
    const edited = renderForm({
      items: [
        {
          productId: "",
          title: "پشتیبانی سالانه",
          description: "",
          unit: "ماه",
          quantity: "12",
          unitPrice: "500000",
          discountPercent: "0",
        },
      ],
    });

    expect(edited.html).toContain("پشتیبانی سالانه");
    expect(edited.html).not.toContain("خدمات طراحی سایت");
    // 12 × 500,000 = 6,000,000 ; −10% = 5,400,000 ; +9% = 5,886,000
    expect(edited.html).toContain("۵,۸۸۶,۰۰۰ ریال");
  });

  it("renders the notes and the VAT line the user just changed", () => {
    const { html } = renderForm({ notes: "پرداخت در دو قسط", taxPercent: "12" });

    expect(html).toContain("پرداخت در دو قسط");
    expect(html).toContain("مالیات بر ارزش افزوده");
    expect(html).toContain("۱۲٪");
  });

  it("keeps rendering when branding assets are unavailable — and invents no image", () => {
    const { html } = renderForm(
      {},
      {
        ...CONTEXT,
        images: { logo: { fileId: "file-logo", url: null }, sellerStamp: null, sellerSignature: null },
      },
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("cdn.test");
    // Everything else of the invoice is still there.
    expect(html).toContain("فروشگاه البرز");
    expect(html).toContain("شرکت آلفا");
    expect(html).toContain("خدمات طراحی سایت");
  });

  it("omits the buyer block while no customer has been picked yet", () => {
    const { html } = renderForm({ customerId: "" });

    expect(html).not.toContain("مشتری / گیرنده");
    expect(html).toContain("فاکتور رسمی");
  });
});

describe("editor action bar — two independent exits", () => {
  const draft = resolveEditorCapabilities({ status: "DRAFT", finalizedAt: null });
  const finalized = resolveEditorCapabilities({ status: "PAID", finalizedAt: "2026-03-06T00:00:00.000Z" });

  function renderBar(capabilities: typeof draft, isDirty = false) {
    return renderToStaticMarkup(
      <InvoiceEditorActionsBar
        capabilities={capabilities}
        hasSavedDraft={capabilities.isDraft}
        saveState={isDirty ? "dirty" : "saved"}
        isDirty={isDirty}
        isSubmitting={false}
        feedback={null}
        onSaveDraft={() => {}}
        onRequestFinalize={() => {}}
        previewHref="/dashboard/invoices/inv-1/preview"
      />,
    );
  }

  it("offers «ذخیره پیش‌نویس» and «صدور نهایی» side by side for a draft", () => {
    const html = renderBar(draft);

    expect(html).toContain("ذخیره پیش‌نویس");
    expect(html).toContain("صدور نهایی");
    expect(html).toContain("پیش‌نویس");
    // They are siblings, not a sequence: no "save first" instruction anywhere.
    expect(html).not.toContain("ابتدا ذخیره");
  });

  it("marks unsaved changes, and clears them after a save", () => {
    expect(renderBar(draft, true)).toContain("تغییرات ذخیره نشده");
    expect(renderBar(draft, false)).toContain("ذخیره شد");
  });

  it("for a finalized invoice shows no save/issue controls, only preview", () => {
    const html = renderBar(finalized);

    expect(html).not.toContain("صدور نهایی");
    expect(html).not.toContain("ذخیره پیش‌نویس");
    expect(html).toContain("پیش‌نمایش / چاپ");
    expect(html).toContain("قابل ویرایش نیست");
  });
});
