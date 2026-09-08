/**
 * Pure state helpers for the invoice editor (no React, no next, no DB).
 *
 * The editor shows one document in two very different lifecycles — a DRAFT the
 * user is still writing and a FINALIZED invoice that is an immutable
 * accounting record — and on mobile it also has to decide which pane is on
 * screen. All three decisions are kept here as tiny pure functions so the
 * components stay wiring and the rules stay testable.
 *
 * These helpers never implement a domain rule of their own: the authoritative
 * lifecycle checks live in `invoiceService` (draft-only editing, immutable
 * finalized rows). This module only mirrors those facts for presentation.
 */

/** Anything with the two lifecycle fields the editor needs to see. */
export interface EditorInvoiceLifecycleView {
  status: string;
  finalizedAt?: string | Date | null;
}

export interface InvoiceEditorCapabilities {
  /** The row exists and is still a DRAFT — the only editable state. */
  isDraft: boolean;
  editable: boolean;
  canSaveDraft: boolean;
  canFinalize: boolean;
  /** Preview / print is available for every lifecycle (drafts and finalized alike). */
  canPreview: boolean;
}

/**
 * Which actions the editor may offer for an invoice row.
 *
 * `savedInvoiceId === null` means "nothing persisted yet" (a brand-new,
 * unsaved invoice): that state is a DRAFT in waiting, so it is editable and
 * both actions are offered — the user is never forced to save a draft before
 * choosing to issue the invoice.
 */
export function resolveEditorCapabilities(
  invoice?: EditorInvoiceLifecycleView | null,
): InvoiceEditorCapabilities {
  const row = invoice ?? null;

  // No row yet (new invoice) → editable draft with both actions.
  if (!row) {
    return {
      isDraft: true,
      editable: true,
      canSaveDraft: true,
      canFinalize: true,
      canPreview: true,
    };
  }

  const isDraft = row.status === "DRAFT" && row.finalizedAt == null;

  return {
    isDraft,
    editable: isDraft,
    canSaveDraft: isDraft,
    canFinalize: isDraft,
    // Read-only finalized/cancelled rows keep preview & print — that is the
    // whole point of the snapshot-based document.
    canPreview: true,
  };
}

/**
 * A finalized row must never be editable, whatever the UI asks for. The editor
 * enforces this on the client for immediate feedback, and the server enforces
 * it again (`updateDraftInvoice` / `finalizeInvoice` reject non-draft rows).
 */
export function isEditorReadOnly(capabilities: InvoiceEditorCapabilities): boolean {
  return !capabilities.editable;
}

// ---------------------------------------------------------------------------
// Unsaved-changes indicator
// ---------------------------------------------------------------------------

export type EditorSaveState = "clean" | "dirty" | "saving" | "saved";

export interface EditorSaveStateLabel {
  text: string;
  tone: "muted" | "warning" | "info" | "success";
}

/**
 * The save-state line of the action bar.
 *
 * `isDirty` is React Hook Form's own comparison of the current values against
 * the last saved baseline, so any edit after a save flips the label back to
 * "تغییرات ذخیره نشده" automatically. Nothing here blocks the preview: the
 * live document always renders the latest form state, saved or not.
 */
export function resolveSaveStateLabel(args: {
  saveState: EditorSaveState;
  isDirty: boolean;
  hasSavedDraft: boolean;
}): EditorSaveStateLabel | null {
  if (args.saveState === "saving") {
    return { text: "در حال ذخیره…", tone: "info" };
  }
  if (args.isDirty) {
    return { text: "تغییرات ذخیره نشده", tone: "warning" };
  }
  if (args.saveState === "saved" || args.hasSavedDraft) {
    return { text: "ذخیره شد", tone: "success" };
  }
  return { text: "هنوز ذخیره نشده", tone: "muted" };
}

// ---------------------------------------------------------------------------
// Mobile pane toggle (edit / preview)
// ---------------------------------------------------------------------------

export type EditorPane = "edit" | "preview";

export const EDITOR_PANES: ReadonlyArray<{ id: EditorPane; label: string }> = [
  { id: "edit", label: "ویرایش" },
  { id: "preview", label: "پیش‌نمایش" },
];

/**
 * Desktop editor layout: form ~42% / live A4 preview ~58%. The preview
 * column is the wider one so the sheet can fill most of the available width
 * while A4 proportions stay intact. Mobile keeps the «ویرایش / پیش‌نمایش»
 * tabs and this class is a single-column stack below `lg`.
 */
export const EDITOR_DESKTOP_GRID_CLASS =
  "grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,42%)_minmax(0,58%)]";

/**
 * Tailwind visibility classes for the two panes below the two-column breakpoint (`lg`).
 *
 * The KEY behaviour: the hidden pane is still mounted. Both the form and the
 * preview live in the same React tree and only their visibility toggles, so
 * switching tabs can never unmount an input and lose unsaved state. From the
 * `lg` breakpoint up — where the editor becomes a two-column layout — both
 * classes are inert and the panes sit side by side.
 */
export function resolvePaneClassName(pane: EditorPane, active: EditorPane): string {
  return pane === active ? "lg:block" : "hidden lg:block";
}
