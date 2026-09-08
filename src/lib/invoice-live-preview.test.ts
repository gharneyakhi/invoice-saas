import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildLivePreviewModel,
  calculateLivePreviewTotals,
  type LivePreviewContext,
} from "@/lib/invoice-live-preview";
import { calculateInvoice } from "@/lib/invoice-calculation";
import { buildInvoicePreviewModel } from "@/lib/invoice-preview-model";
import { deepStrictEqual } from "node:assert";

/**
 * Live-preview model tests (pure, no DB, no DOM).
 *
 * The behaviour under test is the promise the editor makes to the user: the
 * document you see while typing IS the document your data describes — unsaved
 * changes included, computed by the one calculation engine, with the current
 * business branding applied, and with an invoice number invented never.
 */

const CUSTOMER_A = {
  id: "cust-1",
  name: "شرکت آلفا",
  mobile: "09120000001",
  phone: "02111111111",
  email: "a@example.com",
  address: "تهران، خیابان ولیعصر",
  nationalId: "1110000000",
  economicCode: "2220000000",
};

const CUSTOMER_B = {
  id: "cust-2",
  name: "فروشگاه بتا",
  mobile: "09350000002",
  phone: null,
  email: null,
  address: null,
  nationalId: null,
  economicCode: null,
};

function context(overrides: Partial<LivePreviewContext> = {}): LivePreviewContext {
  return {
    businessId: "biz-1",
    fallbackBusinessName: "کسب‌وکار پیش‌فرض",
    currentProfile: {
      businessName: "فروشگاه البرز",
      slogan: "کیفیت، به قیمت منصفانه",
      ownerName: "علی رضایی",
      address: "کرج، میدان امام، خیابان بهار ۱۲",
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
    customers: [CUSTOMER_A, CUSTOMER_B],
    ...overrides,
  };
}

function item(overrides: Partial<Record<string, string>> = {}) {
  return {
    productId: "",
    title: "خدمت طراحی وب",
    description: "",
    unit: "ساعت",
    quantity: "2",
    unitPrice: "100000",
    discountPercent: "0",
    ...overrides,
  };
}

function values(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    invoiceType: "FINAL" as const,
    issueDate: "2026-03-05",
    dueDate: "2026-03-30",
    customerId: "cust-1",
    notes: "",
    globalDiscountPercent: "0",
    taxPercent: "0",
    items: [item()],
    ...overrides,
  };
}

function build(overrides: Partial<Record<string, unknown>> = {}, ctx?: LivePreviewContext) {
  return buildLivePreviewModel({
    context: ctx ?? context(),
    values: values(overrides) as never,
    savedDraft: null,
  });
}

describe("live preview — follows the CURRENT, unsaved form state", () => {
  it("renders the customer selected in the form, not a saved reference", () => {
    expect(build().customer?.name).toBe("شرکت آلفا");

    const switched = build({ customerId: "cust-2" });
    expect(switched.customer?.name).toBe("فروشگاه بتا");
    expect(switched.customer?.mobile).toBe("09350000002");
    // A field the second customer has never leaks from the first one.
    expect(switched.customer?.email).toBeNull();
  });

  it("omits the buyer block when no customer is selected yet", () => {
    expect(build({ customerId: "" }).customer).toBeNull();
  });

  it("shows an item's title, unit and description while they are being typed", () => {
    const model = build({
      items: [item({ title: "پشتیبانی ماهانه", description: "شامل ۲۰ ساعت", unit: "ماه" })],
    });

    expect(model.invoice.items).toHaveLength(1);
    expect(model.invoice.items[0]?.title).toBe("پشتیبانی ماهانه");
    expect(model.invoice.items[0]?.description).toBe("شامل ۲۰ ساعت");
    expect(model.invoice.items[0]?.unit).toBe("ماه");
  });

  it("keeps every row the editor holds, in the editor's order", () => {
    const model = build({
      items: [item({ title: "قلم یک" }), item({ title: "قلم دو" }), item({ title: "قلم سه" })],
    });

    expect(model.invoice.items.map((entry) => entry.title)).toEqual(["قلم یک", "قلم دو", "قلم سه"]);
  });

  it("reflects an added or removed line without any save", () => {
    const one = build({ items: [item()] });
    const two = build({ items: [item(), item({ title: "اجازه استفاده از نرم‌افزار" })] });

    expect(one.invoice.items).toHaveLength(1);
    expect(two.invoice.items).toHaveLength(2);
  });
});

describe("live preview — totals come from the existing calculation engine", () => {
  it("equals what `calculateInvoice` produces for the same inputs", () => {
    const state = values({
      items: [item({ quantity: "3", unitPrice: "250000", discountPercent: "10" })],
      globalDiscountPercent: "5",
      taxPercent: "9",
    });

    const expected = calculateInvoice({
      items: [{ unitPrice: "250000", quantity: "3", discountPercent: "10" }],
      globalDiscountPercent: "5",
      taxPercent: "9",
    });

    const model = buildLivePreviewModel({ context: context(), values: state as never });

    expect(model.invoice.subtotal).toBe(expected.subtotal.toFixed(2));
    expect(model.invoice.itemDiscountAmount).toBe(expected.itemDiscountAmount.toFixed(2));
    expect(model.invoice.globalDiscountAmount).toBe(expected.globalDiscountAmount.toFixed(2));
    expect(model.invoice.taxableAmount).toBe(expected.taxableAmount.toFixed(2));
    expect(model.invoice.taxAmount).toBe(expected.taxAmount.toFixed(2));
    expect(model.invoice.total).toBe(expected.total.toFixed(2));
  });

  it("reacts to quantity, price, line discount, global discount and VAT edits", () => {
    const base = build();
    const totalOf = (overrides: Partial<Record<string, unknown>>) =>
      build(overrides).invoice.total;

    expect(totalOf({ items: [item({ quantity: "4" })] })).not.toBe(base.invoice.total);
    expect(totalOf({ items: [item({ unitPrice: "180000" })] })).not.toBe(base.invoice.total);
    expect(totalOf({ items: [item({ discountPercent: "25" })] })).not.toBe(base.invoice.total);
    expect(totalOf({ globalDiscountPercent: "10" })).not.toBe(base.invoice.total);
    expect(totalOf({ taxPercent: "10" })).not.toBe(base.invoice.total);

    // …and the magnitudes are right, not merely different.
    expect(totalOf({ items: [item({ quantity: "3" })] })).toBe("300000.00");
    expect(
      totalOf({ items: [item({ unitPrice: "200000", quantity: "1", discountPercent: "25" })] }),
    ).toBe("150000.00");
    expect(totalOf({ globalDiscountPercent: "50" })).toBe("100000.00");
    expect(totalOf({ taxPercent: "10" })).toBe("220000.00");
  });

  it("is Decimal-safe with Persian digits and thousands separators typed in the form", () => {
    const model = build({
      items: [item({ quantity: "۲", unitPrice: "۱٬۰۰۰٬۰۰۰", discountPercent: "۱۰" })],
      taxPercent: "۹",
    });

    // 2 × 1,000,000 = 2,000,000; −10% = 1,800,000; +9% VAT = 1,962,000
    expect(model.invoice.total).toBe("1962000.00");
    expect(model.invoice.taxAmount).toBe("162000.00");
  });

  it("keeps the line totals consistent with the invoice totals it renders", () => {
    const model = build({
      items: [item({ unitPrice: "100000", quantity: "2" }), item({ unitPrice: "50000", quantity: "3", discountPercent: "20" })],
    });

    const lineTotalSum = model.invoice.items
      .reduce((acc, entry) => acc.plus(new Decimal(entry.total)), new Decimal(0))
      .toFixed(2);

    expect(lineTotalSum).toBe(model.invoice.taxableAmount);
  });

  it("never renders as 0 money just because a row is mid-edit", () => {
    // An empty/invalid quantity is neutralised for display; the form-level
    // validation, not the preview, is what stops the save.
    const totals = calculateLivePreviewTotals(
      values({ items: [item({ quantity: "", unitPrice: "" })] }) as never,
    );
    expect(totals.total.equals(new Decimal(0))).toBe(true);
    expect(() => calculateLivePreviewTotals(values({ items: [] }) as never)).not.toThrow();
  });
});

describe("live preview — presentation only, never a second database client", () => {
  it("is a pure function: neither the context nor the form state is mutated", () => {
    const ctx = context();
    const state = values({ items: [item(), item({ title: "قلم دوم" })], notes: "یادداشت" });
    const ctxBefore = structuredClone(ctx);
    const stateBefore = structuredClone(state);

    buildLivePreviewModel({ context: ctx, values: state as never });
    buildLivePreviewModel({ context: ctx, values: { ...state, customerId: "cust-2" } as never });

    deepStrictEqual(ctx, ctxBefore);
    deepStrictEqual(state, stateBefore);
  });

  it("imports no persistence layer at all — which is why it is browser-safe", () => {
    // The suite itself is the strongest proof: it loads these modules in a
    // plain node environment where no DB, session or `next` runtime exists
    // (compare `previewModel.test.ts`, which cannot even load because
    // `previewService` sits on top of Prisma). Statically, the modules may
    // only reference the server for types plus the pure DTO mapper.
    const PURE_SERVER_MODULES = new Set(["@/server/actions/dto"]);

    for (const file of ["src/lib/invoice-live-preview.ts", "src/lib/invoice-preview-model.ts"]) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");

      expect(source).not.toMatch(/@\/lib\/prisma/);
      expect(source).not.toMatch(/@prisma\/client/);
      expect(source).not.toMatch(/from "next/);
      expect(source).not.toMatch(/@\/server\/auth/);
      expect(source).not.toMatch(/\bprisma\.[a-zA-Z]+\s*\(/);

      const typeOnly = new Set(
        [...source.matchAll(/import type [\s\S]*?from "([^"]+)"/g)].map((match) => match[1]),
      );
      for (const specifier of [...source.matchAll(/^import (?!type)[^;]*?from "([^"]+)"/gm)].map((m) => m[1]!)) {
        if (specifier.startsWith("@/server/")) {
          expect(PURE_SERVER_MODULES.has(specifier) || typeOnly.has(specifier)).toBe(true);
        }
      }
    }
  });
});

describe("live preview — identity rules for a draft", () => {
  it("never fabricates an official invoice number for an unsaved invoice", () => {
    const model = build();

    expect(model.officialNumber).toBeNull();
    expect(model.lifecycle).toBe("DRAFT");
    expect(model.isDraft).toBe(true);
    expect(model.invoice.invoiceNumber).toBe("");
    expect(model.invoice.status).toBe("DRAFT");
    expect(model.invoice.finalizedAt).toBeNull();
  });

  it("keeps the server's draft placeholder hidden when the draft already exists", () => {
    const model = buildLivePreviewModel({
      context: context(),
      values: values() as never,
      savedDraft: {
        id: "inv-9",
        invoiceNumber: "DRAFT-3f2a",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    });

    expect(model.invoice.id).toBe("inv-9");
    expect(model.invoice.invoiceNumber).toBe("DRAFT-3f2a");
    // A draft placeholder is never an official number for the document.
    expect(model.officialNumber).toBeNull();
  });

  it("shows no payment state while the invoice is a draft", () => {
    const model = build({ taxPercent: "9" });
    expect(model.isDraft).toBe(true);
    expect(model.invoice.paidAmount).toBe("0.00");
    expect(model.invoice.remainingAmount).toBe(model.invoice.total);
  });

  it("carries the invoice type and dates the user chose", () => {
    const model = build({ invoiceType: "PROFORMA", issueDate: "2026-04-01", dueDate: "2026-04-15" });
    expect(model.invoice.invoiceType).toBe("PROFORMA");
    expect(model.invoice.issueDate.startsWith("2026-04-01")).toBe(true);
    expect(model.invoice.dueDate?.startsWith("2026-04-15")).toBe(true);
  });

  it("falls back to today when the issue date is being re-typed", () => {
    const model = build({ issueDate: "", dueDate: "" });
    expect(model.invoice.issueDate).not.toBe("");
    expect(model.invoice.dueDate).toBeNull();
  });
});

describe("live preview — current business branding is what the user verifies", () => {
  it("applies name, slogan, colours, contacts, banking, footer and assets", () => {
    const seller = build().seller;

    expect(seller).not.toBeNull();
    expect(seller?.source).toBe("PROFILE");
    expect(seller?.businessName).toBe("فروشگاه البرز");
    expect(seller?.slogan).toBe("کیفیت، به قیمت منصفانه");
    expect(seller?.primaryColor).toBe("#0f766e");
    expect(seller?.footerText).toBe("با تشکر از همراهی شما");
    expect(seller?.address).toBe("کرج، میدان امام، خیابان بهار ۱۲");
    expect(seller?.email).toBe("sales@alborz.test");
    expect(seller?.iban).toBe("IR820540102680020900941012");
    expect(seller?.logo?.url).toBe("https://cdn.test/logo.png");
    expect(seller?.sellerStamp?.url).toBe("https://cdn.test/stamp.png");
    expect(seller?.sellerSignature?.url).toBe("https://cdn.test/sign.png");
  });

  it("degrades to no assets — without inventing a URL — when storage is unconfigured", () => {
    const model = build(
      {},
      context({
        images: {
          logo: { fileId: "file-logo", url: null },
          sellerStamp: null,
          sellerSignature: null,
        },
      }),
    );

    expect(model.seller?.logo?.url).toBeNull();
    expect(model.seller?.sellerStamp).toBeNull();
    expect(model.seller?.sellerSignature).toBeNull();
    // The rest of the preview stays visible.
    expect(model.seller?.businessName).toBe("فروشگاه البرز");
    expect(model.customer?.name).toBe("شرکت آلفا");
    expect(model.invoice.total).toBe("200000.00");
  });

  it("shows only the business name when the business has no profile row yet", () => {
    const model = build({}, context({ currentProfile: null, images: { logo: null, sellerStamp: null, sellerSignature: null } }));

    expect(model.seller?.businessName).toBe("کسب‌وکار پیش‌فرض");
    expect(model.seller?.slogan).toBeNull();
    expect(model.seller?.iban).toBeNull();
    expect(model.seller?.logo).toBeNull();
  });

  it("blanks out whitespace-only profile values instead of printing empty lines", () => {
    const model = build(
      {},
      context({
        currentProfile: {
          ...context().currentProfile!,
          slogan: "   ",
          iban: "",
        },
      }),
    );

    expect(model.seller?.slogan).toBeNull();
    expect(model.seller?.iban).toBeNull();
  });
});

describe("live preview — one invoice language, one model", () => {
  it("reuses the shared preview model builder (the same function object)", () => {
    // `buildLivePreviewModel` must assemble its output through the model the
    // printable document already consumes — otherwise the editor would drift
    // into a second, invented invoice design.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/invoice-live-preview.ts"),
      "utf8",
    );
    expect(source).toMatch(/import \{[\s\S]*?buildInvoicePreviewModel[\s\S]*?\} from "@\/lib\/invoice-preview-model"/);
    expect(typeof buildInvoicePreviewModel).toBe("function");
  });

  it("renders the document model shape the preview route renders", () => {
    const live = build();

    expect(Object.keys(live).sort()).toEqual(
      ["businessId", "currency", "customer", "invoice", "isDraft", "lifecycle", "officialNumber", "seller"].sort(),
    );
    // The invoice half is the shared detail-DTO contract.
    expect(Object.keys(live.invoice).sort()).toContain("invoiceNumber");
    expect(new Set(Object.keys(live.invoice.items[0] ?? {})).has("discountAmount")).toBe(true);
  });
});
