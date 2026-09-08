"use client";

import * as React from "react";
import { useFormContext, useWatch } from "react-hook-form";
import {
  buildLivePreviewModel,
  type LivePreviewContext,
  type LivePreviewSavedDraft,
} from "@/lib/invoice-live-preview";
import { buildDraftPayload } from "@/components/invoice/invoiceEditorFlow";
import { InvoicePreviewDocument } from "@/components/invoice/InvoicePreviewDocument";
import { formatCurrency, normalizeLocalizedNumber, toPersianDigits } from "@/lib/formatters";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";
import { Badge } from "@/components/ui/badge";
import { EyeIcon } from "@/components/icons";

/** A4 portrait width at 96dpi — the natural width of the printable document. */
const A4_WIDTH_PX = 794;
const MIN_SCALE = 0.3;

export interface InvoiceLivePreviewProps {
  context: LivePreviewContext;
  /** Identity of the persisted draft, when this editor already has one. */
  savedDraft: LivePreviewSavedDraft | null;
  /** `true` while the form differs from the last saved state (label only). */
  isDirty: boolean;
  /** Read-only mode disables nothing in the document, but says so plainly. */
  readOnly?: boolean;
}

/**
 * The editor's LIVE invoice preview.
 *
 * What it renders is the real printable document (`InvoicePreviewDocument`)
 * driven by the model built from the CURRENT form state — every keystroke in
 * the customer picker, an item title, a quantity, a discount or the VAT field
 * changes it immediately. That is the point of the feature: the user can
 * verify how the invoice will actually look BEFORE deciding between saving a
 * draft and issuing it.
 *
 * How it stays honest:
 *   - The values come from `useWatch`, i.e. React Hook Form's live state. No
 *     fetch, no `router.refresh()`, no dependence on a successful save.
 *   - Totals come from the shared `calculateInvoice` engine via
 *     `buildLivePreviewModel`, so they agree with the editor's own totals and
 *     with what the server will recompute — the server stays authoritative.
 *   - This component is presentation-only: it never writes and never mutates
 *     the form (it maps the values into the draft payload shape the model
 *     builder expects, through the same `buildDraftPayload` the save uses, so
 *     "what you preview" and "what you save" cannot diverge).
 *
 * Layout: the document is measured and scaled to fit its column (A4 ratio
 * preserved), so the preview never pushes the editor off-screen.
 */
export function InvoiceLivePreview({
  context,
  savedDraft,
  isDirty,
  readOnly = false,
}: InvoiceLivePreviewProps) {
  const { control } = useFormContext<InvoiceEditorFields>();

  // `undefined` until the first render settles; falls back to the defaults.
  const values = useWatch({ control }) as InvoiceEditorFields | undefined;

  const model = React.useMemo(() => {
    if (!values || !Array.isArray(values.items)) return null;
    // Round-trip through the payload builder so the preview reads exactly the
    // values that would be persisted (trimmed, empty-as-null), then hand them
    // to the shared live-preview model builder.
    const payload = buildDraftPayload(values);
    return buildLivePreviewModel({
      context,
      savedDraft,
      values: {
        ...payload,
        dueDate: payload.dueDate ?? "",
        customerId: payload.customerId ?? "",
        notes: payload.notes ?? "",
        items: payload.items.map((item) => ({
          productId: item.productId ?? "",
          title: item.title,
          description: item.description ?? "",
          unit: item.unit ?? "",
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountPercent: item.discountPercent,
        })),
      },
    });
  }, [values, context, savedDraft]);

  // --- fit-to-width scaling (measured, so the A4 ratio is preserved) -------
  const outerRef = React.useRef<HTMLDivElement>(null);
  const innerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.5);
  const [documentHeight, setDocumentHeight] = React.useState(0);

  React.useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const available = outer.clientWidth;
      if (available > 0) {
        // Fill the preview column (may scale above 1 when the column is wider
        // than A4) so the live sheet uses ~80%+ of the available width.
        setScale(Math.max(MIN_SCALE, available / A4_WIDTH_PX));
      }
      setDocumentHeight(inner.scrollHeight);
    };

    measure();
    // Both elements are observed for the component's lifetime: the outer one
    // drives the scale (column width), the inner one the reserved height
    // (content grows as items are added). No per-keystroke re-subscription.
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const finalTotal = model
    ? formatCurrency(model.invoice.total, model.currency)
    : "—";
  const vatLabel = values
    ? `${toPercentText(values.taxPercent)}٪`
    : "—";

  return (
    // No `aria-live` here on purpose: this is a whole document that changes on
    // every keystroke, and announcing it would drown out the form. The action
    // bar's feedback line is the accessible status channel.
    <section className="space-y-3" aria-label="پیش‌نمایش زنده فاکتور">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <EyeIcon size={16} className="text-gray-400" />
          <h2 className="text-sm font-bold text-gray-900">پیش‌نمایش زنده فاکتور</h2>
          {readOnly ? (
            <Badge variant="secondary" showDot>
              فقط‌خواندنی
            </Badge>
          ) : (
            isDirty && (
              <Badge variant="warning" showDot>
                ذخیره‌نشده
              </Badge>
            )
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-gray-400">
          همین حالا با مقادیر فرم ساخته می‌شود؛ برای دیدن آن نیازی به ذخیره نیست.
        </p>
      </header>

      <div className="rounded-xl border border-gray-200 bg-gray-100/70 p-1.5 shadow-inner sm:p-2">
        {model ? (
          <div
            ref={outerRef}
            className="overflow-hidden rounded-lg"
            style={{ height: documentHeight > 0 ? Math.round(documentHeight * scale) : undefined }}
          >
            <div
              ref={innerRef}
              style={{
                width: A4_WIDTH_PX,
                transform: `scale(${scale})`,
                transformOrigin: "top right",
              }}
            >
              <InvoicePreviewDocument model={model} />
            </div>
          </div>
        ) : (
          <p className="px-3 py-10 text-center text-xs leading-relaxed text-gray-500">
            در حال آماده‌سازی پیش‌نمایش…
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-400">
        <span>
          مبلغ قابل پرداخت: <span className="font-semibold text-gray-600">{finalTotal}</span>
        </span>
        <span>
          مالیات: {vatLabel} · مقیاس نمایش: {Math.round(scale * 100)}٪
        </span>
      </footer>
    </section>
  );
}

function toPercentText(value: string | undefined): string {
  const normalized = normalizeLocalizedNumber(value);
  return normalized === "" ? "۰" : toPersianDigits(normalized);
}
