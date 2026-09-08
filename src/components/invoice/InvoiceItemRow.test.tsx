import { describe, expect, it } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { FormProvider, useForm } from "react-hook-form";
import {
  InvoiceItemRow,
  ITEM_DISCOUNT_FIELD_CLASS,
  ITEM_IDENTITY_ROW_CLASS,
  ITEM_MONEY_FIELD_CLASS,
  ITEM_NUMERIC_INPUT_CLASS,
  ITEM_NUMBERS_ROW_CLASS,
  ITEM_ROW_CLASS,
} from "./InvoiceItemRow";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";
import type { ProductDTO } from "@/server/actions/dto";

/**
 * Layout contract for a single invoice line in the editor.
 *
 * Calculation, persistence and discount *meaning* stay in
 * `calculateLineItem` / the draft actions — this suite only pins that the
 * discount % input and money columns remain labelled, readable and unable
 * to collapse into a 12-column sliver.
 */

const PRODUCT: ProductDTO = {
  id: "prod-1",
  businessId: "biz-1",
  name: "خدمات طراحی",
  description: null,
  price: "200000.00",
  unit: "ساعت",
  active: true,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  archivedAt: null,
};

function Harness({
  products = [PRODUCT],
  canRemove = true,
}: {
  products?: ProductDTO[];
  canRemove?: boolean;
}) {
  const methods = useForm<InvoiceEditorFields>({
    defaultValues: {
      invoiceType: "FINAL",
      issueDate: "2026-03-05",
      dueDate: "",
      customerId: "",
      notes: "",
      globalDiscountPercent: "0",
      taxPercent: "9",
      items: [
        {
          productId: "",
          title: "خدمات طراحی وب",
          description: "",
          unit: "ساعت",
          quantity: "2",
          unitPrice: "100000",
          discountPercent: "10",
        },
      ],
    },
  });

  return (
    <FormProvider {...methods}>
      <InvoiceItemRow
        index={0}
        products={products}
        currency="IRT"
        canRemove={canRemove}
        onRemove={() => {}}
      />
    </FormProvider>
  );
}

function render(props?: React.ComponentProps<typeof Harness>) {
  return renderToStaticMarkup(<Harness {...props} />);
}

describe("InvoiceItemRow — field labels stay distinct", () => {
  it("renders کالا / خدمت, عنوان, تعداد, واحد, قیمت واحد, تخفیف, مبلغ تخفیف, مبلغ نهایی and حذف", () => {
    const html = render();

    expect(html).toContain("کالا / خدمت");
    expect(html).toContain("عنوان قلم");
    expect(html).toContain("تعداد");
    expect(html).toContain("واحد");
    expect(html).toContain("قیمت واحد");
    expect(html).toContain("تخفیف (٪)");
    expect(html).toContain("مبلغ تخفیف");
    expect(html).toContain("مبلغ نهایی");
    expect(html).toContain("حذف ردیف");
  });

  it("shows the line discount amount and payable total from the existing engine (تومان)", () => {
    const html = render();
    // 2 × 100,000 = 200,000 ; −10% = 20,000 discount, 180,000 payable
    expect(html).toContain("۲۰,۰۰۰ تومان");
    expect(html).toContain("۱۸۰,۰۰۰ تومان");
  });
});

describe("InvoiceItemRow — discount and money columns never collapse", () => {
  it("gives the discount percent input a practical minimum width", () => {
    const html = render();
    expect(html).toContain(ITEM_NUMERIC_INPUT_CLASS);
    expect(html).toContain(ITEM_DISCOUNT_FIELD_CLASS);
    // The percent field is an actual text input, not a squeezed icon button.
    expect(html).toMatch(/id="[^"]*-discount"/);
    expect(html).toMatch(/<input[^>]*id="[^"]*-discount"[^>]*class="[^"]*min-w-\[5\.5rem\]/);
  });

  it("keeps monetary readouts on their own labelled cells with a money min-width", () => {
    const html = render();
    expect(html).toContain(ITEM_MONEY_FIELD_CLASS);
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("tabular-nums");
  });

  it("reflows numeric fields on a 2-then-3 column grid instead of a 12-column squeeze", () => {
    expect(ITEM_NUMBERS_ROW_CLASS).toContain("grid-cols-2");
    expect(ITEM_NUMBERS_ROW_CLASS).toContain("@[28rem]:grid-cols-3");
    expect(ITEM_NUMBERS_ROW_CLASS).not.toContain("md:grid-cols-12");
    expect(ITEM_ROW_CLASS).not.toContain("overflow-x-auto");
    expect(ITEM_IDENTITY_ROW_CLASS).toContain("@[36rem]:flex-row");

    const html = render();
    expect(html).toContain(ITEM_NUMBERS_ROW_CLASS);
    expect(html).not.toContain("md:grid-cols-12");
    expect(html).not.toContain("md:col-span-1");
  });
});

describe("InvoiceItemRow — source stays a layout fix", () => {
  const source = readFileSync(path.resolve(process.cwd(), "src/components/invoice/InvoiceItemRow.tsx"), "utf8");

  it("does not reimplement invoice math or talk to the server", () => {
    expect(source).toMatch(/calculateLineItem/);
    expect(source).not.toMatch(/calculateInvoice\b/);
    expect(source).not.toMatch(/@\/lib\/prisma/);
    expect(source).not.toMatch(/@\/server\/invoice\/invoiceService/);
    expect(source).not.toMatch(/fetch\(/);
  });

  it("does not introduce page-level horizontal overflow as the desktop fix", () => {
    expect(source).not.toMatch(/overflow-x-auto/);
    expect(source).not.toMatch(/md:grid-cols-12/);
  });
});
