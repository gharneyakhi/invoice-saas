/**
 * The invoice editor's state machine, kept outside React.
 *
 * Two independent user actions, one flow each:
 *
 *   "ذخیره پیش‌نویس" → create/update the draft            → stays DRAFT
 *   "صدور نهایی"      → persist current state (silently) → finalize
 *
 * The second action is the important one: the user is NEVER asked to save a
 * draft first. When the invoice does not exist yet, the persist step is an
 * internal implementation detail of the issue flow — the editor calls the
 * existing `createDraftInvoice` / `updateDraftInvoice` actions to obtain an
 * `invoiceId`, then immediately calls the existing `finalizeInvoice` action.
 *
 * No domain logic lives here, deliberately: quota checks, entitlement checks,
 * official numbering, snapshot creation, the finalization transaction and
 * payment/status derivation all stay inside `invoiceService.finalizeInvoice`.
 * This module only sequences the calls, keeps the returned server DTO, and
 * maps the actions' safe error payloads onto Persian copy. That is also why it
 * is a plain function with injected actions instead of a hook: the sequencing
 * contract is testable without a DOM or a database.
 */

import type { ActionError, ActionResult } from "@/server/actions/actionResult";
import type { InvoiceDetailDTO } from "@/server/actions/dto";
import { finalizationErrorMessage } from "@/lib/finalization";
import { editorActionErrorDetail, editorActionErrorMessage } from "@/lib/invoice-editor-messages";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";

/** Which CTA the user pressed. */
export type EditorSubmitMode = "save-draft" | "issue-final";

/**
 * The exact payload the draft actions accept (`createDraftInvoiceSchema` /
 * `updateDraftInvoiceSchema`): only line-item inputs, dates and percent
 * fields. Money, totals, status, invoice numbers, paid/remaining amounts,
 * quota and business ids are NEVER sent — the server recomputes or derives
 * every one of them.
 */
export interface EditorDraftPayload {
  invoiceType: InvoiceEditorFields["invoiceType"];
  issueDate: string;
  dueDate: string | null;
  customerId: string | null;
  notes: string | null;
  globalDiscountPercent: string;
  taxPercent: string;
  items: Array<{
    productId: string | null;
    title: string;
    description: string | null;
    unit: string | null;
    quantity: string;
    unitPrice: string;
    discountPercent: string;
    sortOrder: number;
  }>;
}

/** Server-owned fields that must never appear in a client payload. */
export const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = [
  "businessId",
  "accountId",
  "status",
  "invoiceNumber",
  "subtotal",
  "itemDiscountAmount",
  "globalDiscountAmount",
  "taxAmount",
  "taxableAmount",
  "total",
  "paidAmount",
  "remainingAmount",
  "finalizedAt",
  "cancelledAt",
  "invoiceCount",
  "invoiceLimit",
  "nextInvoiceNumber",
];

/** Trim a possibly-absent text input (form values are strings; nullish is "" ). */
function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** Trim and collapse empty to `null`, the representation the schemas expect. */
function trimmedOrNull(value: string | null | undefined): string | null {
  const text = trimmed(value);
  return text === "" ? null : text;
}

/**
 * Maps raw form values onto the draft payload (trim / empty → null, ordered
 * rows). Null-tolerant on purpose: the same function also normalizes the
 * editor's live-preview state, where fields may still be undefined mid-edit.
 */
export function buildDraftPayload(values: InvoiceEditorFields): EditorDraftPayload {
  return {
    invoiceType: values.invoiceType,
    issueDate: trimmed(values.issueDate),
    dueDate: trimmedOrNull(values.dueDate),
    customerId: trimmedOrNull(values.customerId),
    notes: trimmedOrNull(values.notes),
    globalDiscountPercent: trimmed(values.globalDiscountPercent),
    taxPercent: trimmed(values.taxPercent),
    items: (values.items ?? []).map((item, index) => ({
      productId: trimmedOrNull(item?.productId),
      title: trimmed(item?.title),
      description: trimmedOrNull(item?.description),
      unit: trimmedOrNull(item?.unit),
      quantity: trimmed(item?.quantity),
      unitPrice: trimmed(item?.unitPrice),
      discountPercent: trimmed(item?.discountPercent),
      sortOrder: index,
    })),
  };
}

/** The three persisted-effect entry points, injected so the flow stays pure. */
export interface EditorFlowActions {
  createDraft: (businessId: string, payload: EditorDraftPayload) => Promise<ActionResult<InvoiceDetailDTO>>;
  updateDraft: (
    businessId: string,
    invoiceId: string,
    payload: EditorDraftPayload,
  ) => Promise<ActionResult<InvoiceDetailDTO>>;
  finalize: (invoiceId: string) => Promise<ActionResult<InvoiceDetailDTO>>;
}

export interface EditorFlowInput {
  mode: EditorSubmitMode;
  businessId: string;
  /** The draft already persisted for this editor, if any. */
  savedInvoiceId: string | null;
  payload: EditorDraftPayload;
  actions: EditorFlowActions;
}

export type EditorFlowOutcome =
  | {
      kind: "draft-saved";
      /** true when this editor created the draft, false when it updated one. */
      created: boolean;
      invoice: InvoiceDetailDTO;
    }
  | {
      kind: "finalized";
      /** true when the invoice had to be created inside this very flow. */
      draftCreated: boolean;
      invoice: InvoiceDetailDTO;
    }
  | {
      kind: "save-failed";
      stage: "save";
      mode: EditorSubmitMode;
      error: ActionError;
      /** Draft persisted by an earlier save, when there is one. */
      savedInvoiceId: string | null;
    }
  | {
      kind: "finalize-failed";
      stage: "finalize";
      error: ActionError;
      /** The draft that IS saved — the editor must keep its id and stay editable. */
      invoice: InvoiceDetailDTO;
    };

/**
 * Runs one editor action end to end.
 *
 * Ordering rules that carry user-visible meaning:
 *   - a new invoice in `issue-final` mode is persisted and finalized in the
 *     SAME interaction — no manual draft-save step exists;
 *   - finalization is never attempted on stale content: the current form state
 *     is persisted first (create for a new invoice, update for an existing
 *     draft), and any save failure short-circuits before `finalize` runs;
 *   - the returned `invoice` is always the server's DTO, so the official
 *     invoice number, status and totals shown afterwards come from the server.
 */
export async function runEditorSubmitFlow(input: EditorFlowInput): Promise<EditorFlowOutcome> {
  const { mode, businessId, savedInvoiceId, payload, actions } = input;

  const persistResult = savedInvoiceId
    ? await actions.updateDraft(businessId, savedInvoiceId, payload)
    : await actions.createDraft(businessId, payload);

  if (!persistResult.success) {
    return {
      kind: "save-failed",
      stage: "save",
      mode,
      error: persistResult.error,
      savedInvoiceId,
    };
  }

  const persisted = persistResult.data;

  if (mode === "save-draft") {
    return { kind: "draft-saved", created: savedInvoiceId === null, invoice: persisted };
  }

  const finalizeResult = await actions.finalize(persisted.id);

  if (!finalizeResult.success) {
    return {
      kind: "finalize-failed",
      stage: "finalize",
      error: finalizeResult.error,
      invoice: persisted,
    };
  }

  return { kind: "finalized", draftCreated: savedInvoiceId === null, invoice: finalizeResult.data };
}

/**
 * Persian, user-facing result copy for a completed/failed flow. Friendly
 * messages only: the action boundary has already removed Prisma/SQL/AWS/stack
 * details, and validation *field* messages are surfaced as an optional detail.
 */
export function describeFlowOutcome(outcome: EditorFlowOutcome): {
  tone: "success" | "error";
  message: string;
  detail?: string;
} {
  switch (outcome.kind) {
    case "draft-saved":
      return {
        tone: "success",
        message: outcome.created
          ? "پیش‌نویس فاکتور با موفقیت ایجاد شد."
          : "تغییرات پیش‌نویس با موفقیت ذخیره شد.",
        detail: outcome.created
          ? "می‌توانید ویرایش را ادامه دهید؛ ذخیره مجدد همین فاکتور را به‌روز می‌کند."
          : undefined,
      };
    case "finalized":
      // The number is the server's, verbatim from the finalize result.
      return {
        tone: "success",
        message: `فاکتور با شماره رسمی ${outcome.invoice.invoiceNumber} صادر شد؛ اکنون فقط‌خواندنی است.`,
      };
    case "save-failed": {
      const message = editorActionErrorMessage(outcome.error);
      return {
        tone: "error",
        // Issuing implies a save; say plainly that nothing was issued.
        message:
          outcome.mode === "issue-final"
            ? `فاکتور صادر نشد — ${message}`
            : message,
        detail: editorActionErrorDetail(outcome.error),
      };
    }
    case "finalize-failed":
      return {
        tone: "error",
        // Finalization-specific mapping (quota / lifecycle / archive / …),
        // owned by `@/lib/finalization` since Invoice Finalization V1.
        message: finalizationErrorMessage(outcome.error),
      };
  }
}

// ---------------------------------------------------------------------------
// Double-submit protection
// ---------------------------------------------------------------------------

/**
 * A one-at-a-time lock for editor submissions.
 *
 * `begin` returns false when a submission is already in flight, which is what
 * keeps a second click on «صدور نهایی» (or a double Enter keypress) from
 * issuing the same invoice twice. The lock is deliberately separate from React
 * state so the rule itself is testable; the components use it *and* disable
 * their buttons while `isBusy()`.
 */
export interface EditorSubmitGuard {
  begin(mode: EditorSubmitMode): boolean;
  end(): void;
  isBusy(): boolean;
  current(): EditorSubmitMode | null;
}

export function createEditorSubmitGuard(): EditorSubmitGuard {
  let busy: EditorSubmitMode | null = null;

  return {
    begin(mode) {
      if (busy !== null) return false;
      busy = mode;
      return true;
    },
    end() {
      busy = null;
    },
    isBusy() {
      return busy !== null;
    },
    current() {
      return busy;
    },
  };
}
