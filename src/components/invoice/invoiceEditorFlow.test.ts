import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FORBIDDEN_PAYLOAD_KEYS,
  buildDraftPayload,
  createEditorSubmitGuard,
  describeFlowOutcome,
  runEditorSubmitFlow,
  type EditorDraftPayload,
  type EditorFlowActions,
} from "@/components/invoice/invoiceEditorFlow";
import type { InvoiceDetailDTO } from "@/server/actions/dto";
import type { ActionError } from "@/server/actions/actionResult";
import type { InvoiceEditorFields } from "@/components/invoice/invoiceEditorSchema";
import { FINALIZATION_CONFIRMATION } from "@/lib/finalization";

/**
 * Contract tests for the two editor actions.
 *
 * The user-visible promise: «ذخیره پیش‌نویس» and «صدور نهایی» are two
 * independent exits, and issuing does NOT require pressing save first. What is
 * asserted here is the sequencing and the boundaries (which action runs, with
 * what, in which order, and what happens when the server says no) — never a
 * re-implementation of the rules themselves, which stay in `invoiceService`.
 */

function invoiceDto(overrides: Partial<InvoiceDetailDTO> = {}): InvoiceDetailDTO {
  return {
    id: "inv-1",
    businessId: "biz-1",
    customerId: "cust-1",
    invoiceNumber: "DRAFT-7c1d",
    invoiceType: "FINAL",
    issueDate: "2026-03-05T00:00:00.000Z",
    dueDate: null,
    status: "DRAFT",
    subtotal: "200000.00",
    itemDiscountAmount: "0.00",
    globalDiscountPercent: "0.00",
    globalDiscountAmount: "0.00",
    taxPercent: "0.00",
    taxAmount: "0.00",
    taxableAmount: "200000.00",
    total: "200000.00",
    paidAmount: "0.00",
    remainingAmount: "200000.00",
    currency: null,
    notes: null,
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt: "2026-03-05T00:00:00.000Z",
    finalizedAt: null,
    cancelledAt: null,
    items: [],
    ...overrides,
  };
}

const ok = <T,>(data: T) => ({ success: true as const, data });
const fail = (error: ActionError) => ({ success: false as const, error });

function actions(overrides: Partial<Record<keyof EditorFlowActions, unknown>> = {}): EditorFlowActions {
  return {
    createDraft: vi.fn(async () => ok(invoiceDto())),
    updateDraft: vi.fn(async () => ok(invoiceDto())),
    finalize: vi.fn(async () =>
      ok(invoiceDto({ invoiceNumber: "INV-102", status: "PENDING_PAYMENT", finalizedAt: "2026-03-06T00:00:00.000Z" })),
    ),
    ...overrides,
  } as EditorFlowActions;
}

const payload: EditorDraftPayload = buildDraftPayload({
  invoiceType: "FINAL",
  issueDate: "2026-03-05",
  dueDate: "",
  customerId: "",
  notes: "  ",
  globalDiscountPercent: "0",
  taxPercent: "9",
  items: [
    {
      productId: "",
      title: "  خدمت طراحی  ",
      description: "  ",
      unit: "",
      quantity: "2",
      unitPrice: "100000",
      discountPercent: "0",
    },
  ],
} satisfies InvoiceEditorFields);

describe("«ذخیره پیش‌نویس» — the draft path", () => {
  it("creates a draft for a new invoice and never touches finalization", async () => {
    const deps = actions();

    const outcome = await runEditorSubmitFlow({
      mode: "save-draft",
      businessId: "biz-1",
      savedInvoiceId: null,
      payload,
      actions: deps,
    });

    expect(outcome.kind).toBe("draft-saved");
    expect(outcome).toMatchObject({ created: true });
    expect(deps.createDraft).toHaveBeenCalledWith("biz-1", payload);
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("updates the same draft once it exists, instead of spawning duplicates", async () => {
    const deps = actions();

    const outcome = await runEditorSubmitFlow({
      mode: "save-draft",
      businessId: "biz-1",
      savedInvoiceId: "inv-9",
      payload,
      actions: deps,
    });

    expect(outcome.kind).toBe("draft-saved");
    expect(outcome).toMatchObject({ created: false });
    expect(deps.updateDraft).toHaveBeenCalledWith("biz-1", "inv-9", payload);
    expect(deps.createDraft).not.toHaveBeenCalled();
  });

  it("keeps the invoice id the server returned so the editor can go on editing", async () => {
    const outcome = await runEditorSubmitFlow({
      mode: "save-draft",
      businessId: "biz-1",
      savedInvoiceId: null,
      payload,
      actions: actions({ createDraft: vi.fn(async () => ok(invoiceDto({ id: "inv-42" }))) }),
    });

    expect(outcome.kind === "draft-saved" && outcome.invoice.id).toBe("inv-42");
  });
});

describe("«صدور نهایی» — the direct issue path", () => {
  it("issues a brand-new invoice in ONE user action: persist, then finalize", async () => {
    const order: string[] = [];
    const deps: EditorFlowActions = {
      createDraft: vi.fn(async () => {
        order.push("create");
        return ok(invoiceDto({ id: "inv-new" }));
      }),
      updateDraft: vi.fn(async () => {
        order.push("update");
        return ok(invoiceDto());
      }),
      finalize: vi.fn(async () => {
        order.push("finalize");
        return ok(invoiceDto({ id: "inv-new", invoiceNumber: "INV-102", status: "PENDING_PAYMENT" }));
      }),
    };

    const outcome = await runEditorSubmitFlow({
      mode: "issue-final",
      businessId: "biz-1",
      savedInvoiceId: null, // nothing was ever saved by the user
      payload,
      actions: deps,
    });

    expect(outcome.kind).toBe("finalized");
    expect(outcome).toMatchObject({ draftCreated: true });
    // The internal draft step is an implementation detail of the issue flow:
    // exactly one persist call, followed by the existing finalization action.
    expect(order).toEqual(["create", "finalize"]);
    expect(deps.finalize).toHaveBeenCalledWith("inv-new");
    expect(deps.finalize).toHaveBeenCalledTimes(1);
  });

  it("finalizes an existing draft after saving the current changes", async () => {
    const deps = actions({ updateDraft: vi.fn(async () => ok(invoiceDto({ id: "inv-9" }))) });

    const outcome = await runEditorSubmitFlow({
      mode: "issue-final",
      businessId: "biz-1",
      savedInvoiceId: "inv-9",
      payload,
      actions: deps,
    });

    expect(outcome.kind).toBe("finalized");
    expect(outcome).toMatchObject({ draftCreated: false });
    expect(deps.updateDraft).toHaveBeenCalledWith("biz-1", "inv-9", payload);
    expect(deps.createDraft).not.toHaveBeenCalled();
    // Finalization targets the id the server confirmed, never a client guess.
    expect(deps.finalize).toHaveBeenCalledWith("inv-9");
  });

  it("never finalizes content the server has not accepted (save failure short-circuits)", async () => {
    const deps = actions({
      createDraft: vi.fn(async () => fail({ code: "VALIDATION_ERROR", message: "items.0.title: required" })),
    });

    const outcome = await runEditorSubmitFlow({
      mode: "issue-final",
      businessId: "biz-1",
      savedInvoiceId: null,
      payload,
      actions: deps,
    });

    expect(outcome.kind).toBe("save-failed");
    expect(outcome).toMatchObject({ mode: "issue-final", savedInvoiceId: null });
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("keeps the draft alive when finalization is refused, so nothing is lost", async () => {
    const deps = actions({
      finalize: vi.fn(async () =>
        fail({ code: "INVOICE_LIMIT_REACHED", message: "Invoice limit reached: the free plan allows 5" }),
      ),
    });

    const outcome = await runEditorSubmitFlow({
      mode: "issue-final",
      businessId: "biz-1",
      savedInvoiceId: null,
      payload,
      actions: deps,
    });

    expect(outcome.kind).toBe("finalize-failed");
    if (outcome.kind !== "finalize-failed") throw new Error("unreachable");
    // The content persisted inside the flow: the editor adopts this id and the
    // user can fix the plan issue and press «صدور نهایی» again — on the SAME
    // invoice, not on a duplicated draft.
    expect(outcome.invoice.id).toBe("inv-1");
  });
});

describe("the payload the editor is allowed to send", () => {
  it("carries only editable inputs, trimmed, with empty strings as null", () => {
    expect(payload).toEqual({
      invoiceType: "FINAL",
      issueDate: "2026-03-05",
      dueDate: null,
      customerId: null,
      notes: null,
      globalDiscountPercent: "0",
      taxPercent: "9",
      items: [
        {
          productId: null,
          title: "خدمت طراحی",
          description: null,
          unit: null,
          quantity: "2",
          unitPrice: "100000",
          discountPercent: "0",
          sortOrder: 0,
        },
      ],
    });
  });

  it("numbers rows in editor order (line order is presentation, not identity)", () => {
    const twoRows = buildDraftPayload({
      ...payload,
      items: [
        { productId: "", title: "یک", description: "", unit: "", quantity: "1", unitPrice: "1", discountPercent: "0" },
        { productId: "", title: "دو", description: "", unit: "", quantity: "1", unitPrice: "2", discountPercent: "0" },
      ],
    } as InvoiceEditorFields);

    expect(twoRows.items.map((item) => [item.sortOrder, item.title])).toEqual([
      [0, "یک"],
      [1, "دو"],
    ]);
  });

  it("sends no server-owned field — no totals, no number, no status, no quota", () => {
    const serialized = JSON.stringify(payload);

    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    // Money never travels either: only the raw per-line inputs do.
    expect(payload.items[0]).not.toHaveProperty("total");
    expect(payload.items[0]).not.toHaveProperty("subtotal");
  });
});

describe("error reporting stays friendly and Persian", () => {
  it("maps a draft-save failure through the shared action error copy", () => {
    const outcome = describeFlowOutcome({
      kind: "save-failed",
      stage: "save",
      mode: "save-draft",
      savedInvoiceId: null,
      error: { code: "FORBIDDEN", message: "Business does not belong to this account" },
    });

    expect(outcome.tone).toBe("error");
    expect(outcome.message).toBe("شما مجاز به انجام این عملیات نیستید.");
    // A foreign-resource message is never repeated back to the user.
    expect(outcome.detail).toBeUndefined();
  });

  it("says plainly that nothing was issued when the internal save failed", () => {
    const outcome = describeFlowOutcome({
      kind: "save-failed",
      stage: "save",
      mode: "issue-final",
      savedInvoiceId: null,
      error: { code: "VALIDATION_ERROR", message: "items.0.title: Item title is required" },
    });

    expect(outcome.message).toContain("فاکتور صادر نشد");
    // Field-level validation messages are the user's own text: shown as detail.
    expect(outcome.detail).toContain("items.0.title");
  });

  it("maps the finalization rejections with the existing finalization copy", () => {
    const cases: Array<[ActionError, string]> = [
      [{ code: "INVOICE_LIMIT_REACHED", message: "Invoice limit reached" }, "سقف"],
      [{ code: "VALIDATION_ERROR", message: "Only draft invoices can be finalized; this invoice is already finalized" }, "نهایی شده"],
      [{ code: "VALIDATION_ERROR", message: "Cannot finalize invoice referencing an archived customer" }, "بایگانی"],
      [{ code: "NOT_FOUND", message: "Invoice not found" }, "یافت نشد"],
    ];

    for (const [error, needle] of cases) {
      const outcome = describeFlowOutcome({
        kind: "finalize-failed",
        stage: "finalize",
        error,
        invoice: invoiceDto(),
      });
      expect(outcome.tone).toBe("error");
      expect(outcome.message).toContain(needle);
    }
  });

  it("never echoes infrastructure detail back to the screen", () => {
    const outcome = describeFlowOutcome({
      kind: "finalize-failed",
      stage: "finalize",
      error: {
        code: "INTERNAL_ERROR",
        message:
          "PrismaClientKnownRequestError: SELECT * FROM invoices WHERE token=aws://secret — at Object.<anonymous> (/app/dist/server/invoice/invoiceService.js:12:3)",
      },
      invoice: invoiceDto(),
    });

    for (const needle of ["Prisma", "SELECT", "aws", "/app/", "token"]) {
      expect(outcome.message).not.toContain(needle);
      expect(outcome.detail ?? "").not.toContain(needle);
    }
    expect(outcome.message).toContain("خطای غیرمنتظره");
  });

  it("reports the successful issue with the SERVER's official number", () => {
    const outcome = describeFlowOutcome({
      kind: "finalized",
      draftCreated: true,
      invoice: invoiceDto({ invoiceNumber: "INV-000102", status: "PENDING_PAYMENT", finalizedAt: "2026-03-06T00:00:00.000Z" }),
    });

    expect(outcome.tone).toBe("success");
    expect(outcome.message).toContain("INV-000102");
  });
});

describe("double-submission protection", () => {
  it("accepts one submission at a time and releases afterwards", () => {
    const guard = createEditorSubmitGuard();

    expect(guard.isBusy()).toBe(false);
    expect(guard.begin("issue-final")).toBe(true);
    expect(guard.current()).toBe("issue-final");
    // A second click on «صدور نهایی» (or a double Enter) while the first is in
    // flight must be dropped, not queued.
    expect(guard.begin("issue-final")).toBe(false);
    expect(guard.begin("save-draft")).toBe(false);
    expect(guard.isBusy()).toBe(true);

    guard.end();
    expect(guard.isBusy()).toBe(false);
    expect(guard.begin("save-draft")).toBe(true);
  });

  it("runs the whole flow while the guard is held and releases it on failure too", async () => {
    const guard = createEditorSubmitGuard();
    const deps = actions({
      createDraft: vi.fn(async () => {
        expect(guard.isBusy()).toBe(true);
        throw new Error("network exploded");
      }),
    });

    guard.begin("issue-final");
    await expect(
      runEditorSubmitFlow({
        mode: "issue-final",
        businessId: "biz-1",
        savedInvoiceId: null,
        payload,
        actions: deps,
      }),
    ).rejects.toThrow();
    guard.end();

    expect(guard.isBusy()).toBe(false);
    expect(deps.finalize).not.toHaveBeenCalled();
  });
});

describe("the confirmation the user must pass before issuing", () => {
  it("states the irreversibility in Persian with explicit action labels", () => {
    expect(FINALIZATION_CONFIRMATION.message).toBe(
      "پس از صدور نهایی، فاکتور قابل ویرایش نخواهد بود. آیا از صدور فاکتور مطمئن هستید؟",
    );
    expect(FINALIZATION_CONFIRMATION.confirmLabel).toBe("صدور نهایی");
    expect(FINALIZATION_CONFIRMATION.cancelLabel).toBe("انصراف");
    // The warning names what actually happens server-side (number + quota),
    // without the client ever computing either.
    expect(FINALIZATION_CONFIRMATION.warning).toContain("سهمیه");
    expect(FINALIZATION_CONFIRMATION.warning).toContain("شماره رسمی");
  });
});

describe("wiring: the editor goes through the existing actions only", () => {
  const editorSource = readFileSync(
    path.resolve(process.cwd(), "src/components/invoice/InvoiceEditor.tsx"),
    "utf8",
  );

  it("uses the createDraft/updateDraft/finalize Server Actions of invoiceActions", () => {
    const imported = /import \{([^}]*)\} from "@\/server\/actions\/invoiceActions"/.exec(editorSource);
    const names = (imported?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    expect(new Set(names)).toEqual(new Set(["createDraftInvoice", "finalizeInvoice", "updateDraftInvoice"]));
  });

  it("has no other route to the database (no prisma, no direct service import, no fetch)", () => {
    expect(editorSource).not.toMatch(/@\/lib\/prisma/);
    expect(editorSource).not.toMatch(/@\/server\/invoice\/invoiceService/);
    expect(editorSource).not.toMatch(/fetch\(/);
    // The live preview component is presentation-only, likewise.
    const previewSource = readFileSync(
      path.resolve(process.cwd(), "src/components/invoice/InvoiceLivePreview.tsx"),
      "utf8",
    );
    expect(previewSource).not.toMatch(/@\/lib\/prisma|fetch\(|@\/server\/actions\/(create|update|finalize)/);
  });

  it("exposes both CTAs and never chains them through a required draft save", () => {
    const barSource = readFileSync(
      path.resolve(process.cwd(), "src/components/invoice/InvoiceEditorActionsBar.tsx"),
      "utf8",
    );
    expect(barSource).toContain("ذخیره پیش‌نویس");
    expect(barSource).toContain("صدور نهایی");
    expect(barSource).toContain("onSaveDraft");
    expect(barSource).toContain("onRequestFinalize");
    // No "save first, then finalize" step exists in the flow module either.
    const flowSource = readFileSync(
      path.resolve(process.cwd(), "src/components/invoice/invoiceEditorFlow.ts"),
      "utf8",
    );
    expect(flowSource).toMatch(/mode === "save-draft"/);
    expect(flowSource).toMatch(/actions\.finalize\(persisted\.id\)/);
  });
});
