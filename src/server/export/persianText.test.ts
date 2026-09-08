import { describe, expect, it } from "vitest";
import { containsRtl, toVisualPersianText } from "./persianText";

/**
 * Persian shaping + bidi reordering for server-side PDF text.
 *
 * These tests pin exact presentation-form code points (not just "looks
 * right"), because `pdf-lib` draws whatever code points it receives with no
 * further shaping — a wrong form here is a visibly broken glyph in the PDF.
 */

function codePoints(text: string): string[] {
  const out: string[] = [];
  for (const char of text) {
    out.push((char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0"));
  }
  return out;
}

describe("containsRtl", () => {
  it("detects Persian/Arabic letters", () => {
    expect(containsRtl("سلام")).toBe(true);
    expect(containsRtl("فاکتور ۱۲۳")).toBe(true);
    expect(containsRtl("پ چ ژ ک گ")).toBe(true);
  });

  it("returns false for Latin/numbers/punctuation", () => {
    expect(containsRtl("INV-101")).toBe(false);
    expect(containsRtl("12345")).toBe(false);
    expect(containsRtl("۱۲۳")).toBe(false);
    expect(containsRtl("")).toBe(false);
  });
});

describe("toVisualPersianText", () => {
  it("returns pure LTR input unchanged", () => {
    expect(toVisualPersianText("INV-101")).toBe("INV-101");
    expect(toVisualPersianText("12345")).toBe("12345");
    expect(toVisualPersianText("۱۲۳")).toBe("۱۲۳");
    expect(toVisualPersianText("IR1234567890")).toBe("IR1234567890");
    expect(toVisualPersianText("")).toBe("");
  });

  it("shapes سلام with a final lam-alef ligature", () => {
    // Logical: س ل ا م → س-initial, لا-final-ligature, م-isolated, reversed.
    expect(codePoints(toVisualPersianText("سلام"))).toEqual([
      "FEE1", // م isolated
      "FEFC", // لا final ligature
      "FEB3", // س initial
    ]);
  });

  it("shapes فاکتور with correct contextual forms", () => {
    // ف-initial ا-final ک-initial ت-medial و-final ر-isolated, reversed.
    expect(codePoints(toVisualPersianText("فاکتور"))).toEqual([
      "FEAD", // ر isolated
      "FEEE", // و final
      "FE98", // ت medial
      "FB90", // ک initial
      "FE8E", // ا final
      "FED3", // ف initial
    ]);
  });

  it("shapes Persian-specific letters (پ چ ژ ک گ ی)", () => {
    expect(codePoints(toVisualPersianText("پ"))).toEqual(["FB56"]);
    expect(codePoints(toVisualPersianText("چ"))).toEqual(["FB7A"]);
    expect(codePoints(toVisualPersianText("ژ"))).toEqual(["FB8A"]);
    expect(codePoints(toVisualPersianText("ک"))).toEqual(["FB8E"]);
    expect(codePoints(toVisualPersianText("گ"))).toEqual(["FB92"]);
    expect(codePoints(toVisualPersianText("ی"))).toEqual(["FBFC"]);
  });

  it("keeps Persian digit runs in reading order inside RTL text", () => {
    // "فاکتور ۱۲۳" → digits first (left), then reversed shaped word.
    const visual = toVisualPersianText("فاکتور ۱۲۳");
    expect(visual.startsWith("۱۲۳ ")).toBe(true);
    expect(codePoints(visual.slice("۱۲۳ ".length))).toEqual([
      "FEAD",
      "FEEE",
      "FE98",
      "FB90",
      "FE8E",
      "FED3",
    ]);
  });

  it("keeps Latin tokens intact inside RTL text", () => {
    // "شماره INV-101" → token left, word right; token never split.
    const visual = toVisualPersianText("شماره INV-101");
    expect(visual.startsWith("INV-101 ")).toBe(true);
    expect(visual).toContain("INV-101");
  });

  it("keeps email addresses intact inside RTL text", () => {
    const visual = toVisualPersianText("ایمیل test@mail.com");
    expect(visual.startsWith("test@mail.com ")).toBe(true);
  });

  it("breaks joining at ZWNJ (می‌شود)", () => {
    // م-initial ی-final | ش-initial و-final د-isolated, reversed.
    expect(codePoints(toVisualPersianText("می‌شود"))).toEqual([
      "FEA9", // د isolated
      "FEEE", // و final
      "FEB7", // ش initial
      "FBFD", // ی final (FARSI YEH)
      "FEE3", // م initial
    ]);
  });

  it("mirrors brackets around RTL text", () => {
    // Logical "(تومان)" displays as "(ناموت)" left-to-right.
    const visual = toVisualPersianText("(تومان)");
    expect(visual.startsWith("(")).toBe(true);
    expect(visual.endsWith(")")).toBe(true);
  });

  it("places the percent sign on the left of Persian percent values", () => {
    // Logical "۹٪" → visual "٪۹".
    expect(toVisualPersianText("۹٪")).toBe("٪۹");
  });

  it("handles a realistic mixed label", () => {
    // "تخفیف (۹٪)" → "(٪۹ )" + shaped "تخفیف".
    const visual = toVisualPersianText("تخفیف (۹٪)");
    expect(visual.startsWith("(٪۹ )")).toBe(true);
  });

  it("does not join across spaces", () => {
    // "با ما": ب-initial ا-final | م-initial ا-final, words reversed.
    expect(codePoints(toVisualPersianText("با ما"))).toEqual([
      "FE8E", // ا final
      "FEE3", // م initial
      "0020", // space
      "FE8E", // ا final
      "FE91", // ب initial
    ]);
  });
});
