import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EDITOR_PANES,
  isEditorReadOnly,
  resolveEditorCapabilities,
  resolvePaneClassName,
  resolveSaveStateLabel,
} from "@/lib/invoice-editor-state";

/**
 * Editor state rules: what the user may do depends on the invoice lifecycle,
 * and switching panes on mobile must never be a reason to lose work.
 */

describe("draft / finalized capabilities", () => {
  it("treats a brand-new, unsaved invoice as an editable draft with BOTH actions", () => {
    const capabilities = resolveEditorCapabilities(null);

    expect(capabilities).toEqual({
      isDraft: true,
      editable: true,
      canSaveDraft: true,
      canFinalize: true,
      canPreview: true,
    });
    expect(isEditorReadOnly(capabilities)).toBe(false);
  });

  it("keeps a persisted draft editable, saveable and issuable", () => {
    const capabilities = resolveEditorCapabilities({ status: "DRAFT", finalizedAt: null });

    expect(capabilities.editable).toBe(true);
    expect(capabilities.canSaveDraft).toBe(true);
    expect(capabilities.canFinalize).toBe(true);
    expect(capabilities.canPreview).toBe(true);
  });

  it("locks every finalized status down to read-only + preview", () => {
    for (const status of ["ISSUED", "SENT", "PENDING_PAYMENT", "PARTIALLY_PAID", "PAID", "OVERDUE"]) {
      const capabilities = resolveEditorCapabilities({ status, finalizedAt: "2026-03-06T00:00:00.000Z" });

      expect(capabilities, status).toEqual({
        isDraft: false,
        editable: false,
        canSaveDraft: false,
        canFinalize: false,
        canPreview: true,
      });
      expect(isEditorReadOnly(capabilities)).toBe(true);
    }
  });

  it("treats closed history (cancelled) and inconsistent rows as non-editable", () => {
    expect(resolveEditorCapabilities({ status: "CANCELLED", finalizedAt: null }).editable).toBe(false);
    // Defensive: a DRAFT stamp with a finalizedAt is not an editable row.
    expect(resolveEditorCapabilities({ status: "DRAFT", finalizedAt: "2026-03-06" }).editable).toBe(false);
  });
});

describe("unsaved-changes indicator", () => {
  it("warns while the form differs from the last saved state", () => {
    expect(
      resolveSaveStateLabel({ saveState: "dirty", isDirty: true, hasSavedDraft: true })?.text,
    ).toBe("تغییرات ذخیره نشده");
    // Editing again right after a save flips the label back.
    expect(
      resolveSaveStateLabel({ saveState: "saved", isDirty: true, hasSavedDraft: true })?.text,
    ).toBe("تغییرات ذخیره نشده");
  });

  it("reports success once the draft matches the server", () => {
    expect(resolveSaveStateLabel({ saveState: "saved", isDirty: false, hasSavedDraft: true })).toEqual({
      text: "ذخیره شد",
      tone: "success",
    });
  });

  it("says nothing is saved yet for a fresh invoice — and never blocks it", () => {
    const label = resolveSaveStateLabel({ saveState: "clean", isDirty: false, hasSavedDraft: false });

    expect(label?.text).toBe("هنوز ذخیره نشده");
    // The dirty state is informational only: the API offers no "blocked" flag,
    // so the preview stays available while the user is mid-edit.
    expect(label).not.toHaveProperty("blocked");
    expect(label).not.toHaveProperty("disabled");
  });

  it("shows progress while a request is running", () => {
    expect(
      resolveSaveStateLabel({ saveState: "saving", isDirty: true, hasSavedDraft: true })?.text,
    ).toBe("در حال ذخیره…");
  });
});

describe("mobile edit / preview toggle", () => {
  it("offers exactly the two Persian tabs", () => {
    expect(EDITOR_PANES.map((pane) => pane.label)).toEqual(["ویرایش", "پیش‌نمایش"]);
  });

  it("hides the inactive pane and shows the active one — both stay mounted", () => {
    for (const active of ["edit", "preview"] as const) {
      const shown = resolvePaneClassName(active, active);
      const hidden = resolvePaneClassName(active === "edit" ? "preview" : "edit", active);

      // `hidden` + `lg:block` is a VISIBILITY rule: no conditional rendering,
      // so React never unmounts an input and unsaved state cannot be lost when
      // the user switches tabs. The breakpoint matches the two-column layout,
      // so the tabs disappear exactly when both panes fit.
      expect(hidden.split(" ")).toContain("hidden");
      expect(hidden.split(" ")).toContain("lg:block");
      expect(shown.split(" ")).not.toContain("hidden");
      expect(shown).toContain("lg:block");
    }
  });

  it("the editor really renders both panes (nothing is conditionally unmounted)", () => {
    // The visibility-only rule is worthless if the component drops the inactive
    // pane from the tree, so the wiring itself is pinned here.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/invoice/InvoiceEditor.tsx"),
      "utf8",
    );

    expect(source).toMatch(/resolvePaneClassName\("edit", pane\)/);
    expect(source).toMatch(/resolvePaneClassName\("preview", pane\)/);
    expect(source).not.toMatch(/pane === "edit" &&|pane === "preview" &&|\{pane === "[a-z]+" \?/);
  });
});
