"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { FormProvider, useForm } from "react-hook-form";
import type { InvoiceDetailDTO } from "@/server/actions/dto";
import type { CustomerDTO, ProductDTO } from "@/server/actions/dto";
import {
  createDraftInvoice,
  finalizeInvoice,
  updateDraftInvoice,
} from "@/server/actions/invoiceActions";
import { InvoiceInfoForm } from "@/components/invoice/InvoiceInfoForm";
import { InvoiceItemsEditor, createEmptyItem } from "@/components/invoice/InvoiceItemsEditor";
import { InvoiceTotals } from "@/components/invoice/InvoiceTotals";
import {
  InvoiceEditorActionsBar,
  type SaveFeedback,
} from "@/components/invoice/InvoiceEditorActionsBar";
import { InvoiceLivePreview } from "@/components/invoice/InvoiceLivePreview";
import { FinalizeInvoiceDialog } from "@/components/invoice/FinalizeInvoiceDialog";
import {
  buildDraftPayload,
  createEditorSubmitGuard,
  describeFlowOutcome,
  runEditorSubmitFlow,
  type EditorSubmitMode,
} from "@/components/invoice/invoiceEditorFlow";
import {
  EDITOR_DESKTOP_GRID_CLASS,
  EDITOR_PANES,
  resolveEditorCapabilities,
  resolvePaneClassName,
  type EditorPane,
  type EditorSaveState,
} from "@/lib/invoice-editor-state";
import {
  calculateLivePreviewTotals,
  type LivePreviewBrandingContext,
  type LivePreviewSavedDraft,
} from "@/lib/invoice-live-preview";
import {
  invoiceEditorResolver,
  type InvoiceEditorFields,
} from "@/components/invoice/invoiceEditorSchema";
import { toNumericInputString } from "@/lib/formatters";

export interface InvoiceEditorProps {
  /** Id of the business being invoiced — verified again server-side on save. */
  businessId: string;
  /** Real customers of this business (live rows, loaded server-side). */
  customers: CustomerDTO[];
  /** Real catalogue of this business; used to seed rows, never mutated. */
  products: ProductDTO[];
  /** Business `InvoiceSettings.defaultVatPercent` (Decimal string). */
  defaultVatPercent: string;
  /** Business `InvoiceSettings.currency` (e.g. "IRR"). */
  currency: string;
  /** "Today" as YYYY-MM-DD (server-computed for the business timezone). */
  defaultIssueDate: string;
  /** An existing draft to continue editing (e.g. after a page refresh). */
  initialDraft?: InvoiceDetailDTO | null;
  /**
   * Current business branding for the live preview: the `BusinessProfile` row
   * plus already-resolved logo/stamp/signature urls. Read-only payload — the
   * preview applies it to the document, and the server re-reads the same row
   * when it takes the finalization snapshot.
   */
  previewContext: LivePreviewBrandingContext;
}

function emptyFormValues(props: InvoiceEditorProps): InvoiceEditorFields {
  return {
    invoiceType: "FINAL",
    issueDate: props.defaultIssueDate,
    dueDate: "",
    customerId: "",
    notes: "",
    globalDiscountPercent: "0",
    taxPercent: toNumericInputString(props.defaultVatPercent) || "0",
    items: [createEmptyItem()],
  };
}

function draftToFormValues(draft: InvoiceDetailDTO, fallbackIssueDate: string): InvoiceEditorFields {
  return {
    invoiceType: draft.invoiceType,
    issueDate: draft.issueDate ? draft.issueDate.slice(0, 10) : fallbackIssueDate,
    dueDate: draft.dueDate ? draft.dueDate.slice(0, 10) : "",
    customerId: draft.customerId ?? "",
    notes: draft.notes ?? "",
    globalDiscountPercent: toNumericInputString(draft.globalDiscountPercent) || "0",
    taxPercent: toNumericInputString(draft.taxPercent) || "0",
    items:
      draft.items.length > 0
        ? draft.items.map((item) => ({
            productId: item.productId ?? "",
            title: item.title,
            description: item.description ?? "",
            unit: item.unit ?? "",
            quantity: toNumericInputString(item.quantity) || "1",
            unitPrice: toNumericInputString(item.unitPrice),
            discountPercent: toNumericInputString(item.discountPercent) || "0",
          }))
        : [createEmptyItem()],
  };
}

function toSavedDraftInfo(draft: InvoiceDetailDTO): LivePreviewSavedDraft {
  return {
    id: draft.id,
    invoiceNumber: draft.invoiceNumber,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

/**
 * Invoice Editor V2 (Persian RTL) — editor + live preview + two exit actions.
 *
 * Layout law: on wide screens the form and a scaled A4 document sit side by
 * side; on small screens the user switches between «ویرایش» and «پیش‌نمایش»
 * with a tab bar, and because only the panes' *visibility* changes, no input
 * is ever unmounted — switching tabs cannot lose unsaved state.
 *
 * Data law:
 *   - The live preview is a pure function of the current form state
 *     (`@/lib/invoice-live-preview`) and the current `BusinessProfile`. It
 *     never reloads the saved draft per keystroke, never depends on a
 *     successful save and never writes.
 *   - Money in the preview runs through the shared `calculateInvoice` engine,
 *     so the editor totals, the live preview and the saved/finalized invoice
 *     agree by construction. The server remains authoritative: it
 *     re-validates and recalculates on every save and at finalization.
 *   - The two CTAs are independent paths through `runEditorSubmitFlow`:
 *     «ذخیره پیش‌نویس` → create/update draft, and «صدور نهایی» → persist +
 *     the existing `finalizeInvoice` Server Action. Finalization logic (quota,
 *     entitlements, numbering, snapshots, the transaction, payment/status
 *     derivation) is not re-implemented here; only the call is wired.
 */
export function InvoiceEditor(props: InvoiceEditorProps) {
  const router = useRouter();

  // The invoice the editor is currently bound to. It starts as the opened
  // draft (or nothing, for a new invoice) and is REPLACED by the server's row
  // once finalization succeeds — which is what makes the editor read-only
  // immediately, even before the finalized detail view takes over.
  const [currentInvoice, setCurrentInvoice] = React.useState<InvoiceDetailDTO | null>(
    props.initialDraft ?? null,
  );

  const capabilities = React.useMemo(
    () =>
      resolveEditorCapabilities(
        currentInvoice
          ? { status: currentInvoice.status, finalizedAt: currentInvoice.finalizedAt }
          : null,
      ),
    [currentInvoice],
  );
  const readOnly = !capabilities.editable;

  const [savedInvoiceId, setSavedInvoiceId] = React.useState<string | null>(
    props.initialDraft?.id ?? null,
  );
  const [savedDraftInfo, setSavedDraftInfo] = React.useState<LivePreviewSavedDraft | null>(
    props.initialDraft ? toSavedDraftInfo(props.initialDraft) : null,
  );
  const [saveState, setSaveState] = React.useState<EditorSaveState>("clean");
  const [feedback, setFeedback] = React.useState<SaveFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState<EditorSubmitMode | null>(null);
  const [pane, setPane] = React.useState<EditorPane>("edit");
  const [confirmDialog, setConfirmDialog] = React.useState<{
    open: boolean;
    summary: React.ComponentProps<typeof FinalizeInvoiceDialog>["summary"];
  }>({ open: false, summary: { currency: props.currency, customerName: null, itemCount: 0, total: "0" } });

  const form = useForm<InvoiceEditorFields, undefined, InvoiceEditorFields>({
    resolver: invoiceEditorResolver,
    reValidateMode: "onChange",
    shouldFocusError: true,
    defaultValues: props.initialDraft
      ? draftToFormValues(props.initialDraft, props.defaultIssueDate)
      : emptyFormValues(props),
  });

  // The single in-flight lock for both CTAs (double click / double Enter).
  const guardRef = React.useRef(createEditorSubmitGuard());

  const previewContext = React.useMemo(
    () => ({
      ...props.previewContext,
      businessId: props.businessId,
      customers: props.customers,
    }),
    [props.previewContext, props.businessId, props.customers],
  );

  /**
   * `values` is React Hook Form's *resolver output* (the schema's
   * transformed values): localized digits are already canonical decimal
   * strings, text is trimmed and optional fields are non-null. That is what
   * makes the client payload match the server's strict draft schema — and the
   * server re-validates and recalculates every bit of it anyway.
   */
  const submit = async (mode: EditorSubmitMode, values: InvoiceEditorFields) => {
    // Defence in depth for the read-only (finalized) state: the actions bar
    // offers no CTA, and even a synthetic submit cannot reach the server.
    if (readOnly) return;

    // Double-submission protection: a second request while one is in flight is
    // dropped outright, not queued — issuing an invoice twice is not a thing.
    if (!guardRef.current.begin(mode)) return;
    setIsSubmitting(mode);
    setSaveState("saving");
    setFeedback(null);

    try {
      const outcome = await runEditorSubmitFlow({
        mode,
        businessId: props.businessId,
        savedInvoiceId,
        payload: buildDraftPayload(values),
        // The existing Server Actions are the only path to the database.
        actions: {
          createDraft: (businessId, payload) => createDraftInvoice(businessId, payload),
          updateDraft: (businessId, invoiceId, payload) =>
            updateDraftInvoice(businessId, invoiceId, payload),
          finalize: (invoiceId) => finalizeInvoice(invoiceId),
        },
      });

      const presentation = describeFlowOutcome(outcome);

      switch (outcome.kind) {
        case "draft-saved": {
          setSavedInvoiceId(outcome.invoice.id);
          setSavedDraftInfo(toSavedDraftInfo(outcome.invoice));
          setCurrentInvoice(outcome.invoice);
          // Adopt the saved state as the clean baseline so the form stops being
          // "dirty" (and browsers stop warning about unsaved changes).
          form.reset(values);
          setSaveState("saved");
          // Keep a refresh-safe URL without triggering an RSC re-render — a
          // reload now re-opens this draft instead of risking a duplicate.
          if (outcome.created && typeof window !== "undefined") {
            window.history.replaceState(
              null,
              "",
              `/dashboard/invoices/new?invoiceId=${encodeURIComponent(outcome.invoice.id)}`,
            );
          }
          break;
        }
        case "finalized": {
          // The official number, status and totals come from the server
          // result — the client never composes an invoice number. The editor
          // stops being usable for this row either way: it hands over to the
          // (read-only) finalized invoice view.
          setSavedInvoiceId(outcome.invoice.id);
          setSavedDraftInfo(toSavedDraftInfo(outcome.invoice));
          // The finalized row (official number, finalized status) is the
          // server's — the editor becomes read-only from it, not from a
          // locally guessed invoice number or status.
          setCurrentInvoice(outcome.invoice);
          form.reset(values);
          setSaveState("saved");
          setConfirmDialog((current) => ({ ...current, open: false }));
          router.push(`/dashboard/invoices/${encodeURIComponent(outcome.invoice.id)}`);
          break;
        }
        case "finalize-failed": {
          // The save inside this flow DID persist, so keep its id (the next save
          // must update this same draft rather than create a duplicate).
          setSavedInvoiceId(outcome.invoice.id);
          setSavedDraftInfo(toSavedDraftInfo(outcome.invoice));
          setCurrentInvoice(outcome.invoice);
          form.reset(values);
          setSaveState("saved");
          if (typeof window !== "undefined") {
            window.history.replaceState(
              null,
              "",
              `/dashboard/invoices/new?invoiceId=${encodeURIComponent(outcome.invoice.id)}`,
            );
          }
          break;
        }
        case "save-failed": {
          setSaveState("dirty");
          break;
        }
      }

      setFeedback({
        type: presentation.tone,
        message: presentation.message,
        detail: presentation.detail,
      });
    } catch {
      // A rejected Server Action promise (network/serialization) never carries
      // an inspectable payload — report it safely and keep the editor intact.
      setSaveState("dirty");
      setFeedback({
        type: "error",
        message: "ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.",
      });
    } finally {
      guardRef.current.end();
      setIsSubmitting(null);
    }
  };

  const onInvalid = () => {
    setFeedback({
      type: "error",
      message: "فرم فاکتور کامل نیست. لطفاً خطاهای مشخص‌شده را برطرف کنید.",
    });
    // Whatever the user was looking at, make sure the reason is visible.
    setPane("edit");
  };

  const handleSaveDraft = () => {
    void form.handleSubmit((values) => submit("save-draft", values), onInvalid)();
  };

  const openFinalizeDialog = () => {
    if (guardRef.current.isBusy() || readOnly) return;

    const values = form.getValues();
    const totals = calculateLivePreviewTotals(values);
    const customer = props.customers.find((entry) => entry.id === values.customerId);

    setConfirmDialog({
      open: true,
      summary: {
        currency: props.currency,
        customerName: customer?.name ?? null,
        itemCount: values.items.length,
        // Formatted by the shared engine + formatter, never by a client guess.
        total: totals.total.toFixed(2),
      },
    });
  };

  const confirmFinalize = () => {
    if (isSubmitting !== null) return;
    // Validation runs again at confirmation time, so an edit made between the
    // click and the dialog can never be issued unvalidated.
    void form.handleSubmit((values) => submit("issue-final", values), onInvalid)();
  };

  /** Preview/print of the persisted row — drafts and finalized alike. */
  const previewHref = savedInvoiceId
    ? `/dashboard/invoices/${encodeURIComponent(savedInvoiceId)}/preview`
    : null;

  const actionsBar = (
    <InvoiceEditorActionsBar
      capabilities={capabilities}
      hasSavedDraft={savedInvoiceId !== null}
      saveState={saveState}
      isDirty={form.formState.isDirty}
      isSubmitting={isSubmitting !== null}
      feedback={feedback}
      onSaveDraft={handleSaveDraft}
      onRequestFinalize={openFinalizeDialog}
      previewHref={previewHref}
    />
  );

  return (
    <FormProvider {...form}>
      {/* Mobile tab bar — the desktop two-column layout has no tabs. */}
      <div className="mb-4 lg:hidden" role="tablist" aria-label="نمایش ویرایشگر فاکتور">
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {EDITOR_PANES.map((entry) => {
            const active = pane === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`invoice-editor-pane-${entry.id}`}
                onClick={() => setPane(entry.id)}
                className={clsx(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "border border-gray-200 bg-white text-blue-700 shadow-sm"
                    : "text-gray-500 hover:text-gray-800",
                )}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>

      <form
        onSubmit={form.handleSubmit((values) => submit("save-draft", values), onInvalid)}
        noValidate
        className="min-w-0"
      >
        <div className={EDITOR_DESKTOP_GRID_CLASS}>
          {/* Editor column — always mounted, only hidden on small screens. */}
          <div
            id="invoice-editor-pane-edit"
            role="tabpanel"
            aria-label="ویرایش فاکتور"
            className={resolvePaneClassName("edit", pane)}
          >
            {/* A finalized row must not be editable: the CTAs disappear (see
                the actions bar) and the fields stop taking input. The
                authoritative guard stays server-side — `updateDraftInvoice` and
                `finalizeInvoice` reject any non-draft row. */}
            <div
              className={clsx(
                "min-w-0 space-y-6",
                readOnly && "pointer-events-none select-none opacity-90",
              )}
              aria-disabled={readOnly || undefined}
            >
              <InvoiceInfoForm customers={props.customers} />
              <InvoiceItemsEditor products={props.products} currency={props.currency} />
              <InvoiceTotals currency={props.currency} />
              <div className="hidden lg:block">{actionsBar}</div>
            </div>
          </div>

          {/* Live preview column — same mounted state on mobile, sticky on desktop. */}
          <div
            id="invoice-editor-pane-preview"
            role="tabpanel"
            aria-label="پیش‌نمایش فاکتور"
            className={resolvePaneClassName("preview", pane)}
          >
            <div className="min-w-0 lg:sticky lg:top-6 lg:self-start">
              <InvoiceLivePreview
                context={previewContext}
                savedDraft={savedDraftInfo}
                isDirty={form.formState.isDirty}
                readOnly={readOnly}
              />
            </div>
          </div>
        </div>

        {/* On mobile the actions belong to neither tab, so they sit under the
            active pane and stay reachable in both. */}
        <div className="mt-6 lg:hidden">{actionsBar}</div>
      </form>

      <FinalizeInvoiceDialog
        open={confirmDialog.open}
        isPending={isSubmitting === "issue-final"}
        summary={confirmDialog.summary}
        onCancel={() => setConfirmDialog((current) => ({ ...current, open: false }))}
        onConfirm={confirmFinalize}
      />
    </FormProvider>
  );
}
