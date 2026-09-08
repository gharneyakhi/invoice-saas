import { describe, expect, it } from "vitest";
import {
  TELEGRAM_COPY,
  TELEGRAM_SHARE_BASE_URL,
  buildTelegramShareText,
  buildTelegramShareUrl,
  getTelegramShare,
} from "./telegram";
import { draftPreviewModel, finalizedPreviewModel } from "./testFixtures";

/**
 * Telegram share tests: the summary content for finalized/draft invoices,
 * deep-link encoding, and — most importantly — the honesty contract: no
 * `sent` status, no attachment claims, explicit no-auto-send copy.
 */

describe("buildTelegramShareText", () => {
  it("summarizes finalized invoices with snapshot data", () => {
    const text = buildTelegramShareText(finalizedPreviewModel());
    expect(text).toContain("۱۰۲۴");
    expect(text).toContain("فروشگاه البرز (snapshot)");
    expect(text).toContain("۱۸۶,۳۹۰ تومان");
    expect(text).toContain("۵۰,۰۰۰ تومان");
    expect(text).toContain("در انتظار پرداخت");
    expect(text).not.toContain("DRAFT");
    expect(text).not.toContain("پیش‌نویس");
  });

  it("clearly marks drafts without leaking the placeholder number", () => {
    const text = buildTelegramShareText(draftPreviewModel());
    expect(text).toContain("پیش‌نویس");
    expect(text).toContain("جنبه رسمی ندارد");
    expect(text).not.toContain("DRAFT-xyz");
    expect(text).not.toContain("پرداخت شده");
  });
});

describe("buildTelegramShareUrl", () => {
  it("encodes the page url and Persian text", () => {
    const url = buildTelegramShareUrl({ text: "فاکتور ۱۰۲۴", pageUrl: "https://app.example.ir" });
    expect(url).toContain(TELEGRAM_SHARE_BASE_URL);
    expect(url).toContain(`url=${encodeURIComponent("https://app.example.ir")}`);
    const textParam = (url as string).split("text=")[1] as string;
    expect(decodeURIComponent(textParam)).toBe("فاکتور ۱۰۲۴");
  });

  it("returns null without a public url (copy-text fallback)", () => {
    expect(buildTelegramShareUrl({ text: "x", pageUrl: null })).toBeNull();
    expect(buildTelegramShareUrl({ text: "x", pageUrl: "  " })).toBeNull();
  });
});

describe("getTelegramShare honesty contract", () => {
  it("never reports a file attachment or a sent status", () => {
    const payload = getTelegramShare(finalizedPreviewModel(), "https://app.example.ir");
    expect(payload.hasFileAttachment).toBe(false);
    expect(payload).not.toHaveProperty("sent");
    expect(payload).not.toHaveProperty("messageId");
    expect(JSON.stringify(payload)).not.toContain("ارسال شد");
  });

  it("states explicitly that no automatic send happens", () => {
    expect(TELEGRAM_COPY.explainer).toContain("خودکار");
    expect(TELEGRAM_COPY.explainer).toContain("ارسال نمی‌کند");
    expect(TELEGRAM_COPY.attachmentNote).toContain("دستی");
    expect(JSON.stringify(TELEGRAM_COPY)).not.toContain("ارسال شد");
    expect(JSON.stringify(TELEGRAM_COPY)).not.toContain("ارسال خودکار");
  });
});
