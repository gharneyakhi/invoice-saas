import { describe, expect, it } from "vitest";
import { containsRtl, shapePersianLine, type PdfTextFragment } from "./persianText";

/**
 * Fragment segmentation for server-side PDF text.
 *
 * `shapePersianLine` converts one logical line into visual-order fragments;
 * the renderer draws each fragment with its own `drawText` call. These tests
 * pin the EXACT fragments (text + direction) because each direction carries
 * a fontkit contract:
 *
 *   - `rtl`:     drawn logical; fontkit reverses + GSUB-shapes it. MUST
 *                contain an Arabic-script char (the RTL trigger) and MUST
 *                NOT contain Latin letters or digits.
 *   - `ltr`:     drawn as-is; fontkit's LTR path. MUST NOT contain any
 *                Arabic-script char.
 *   - `ltr-rev`: drawn PRE-REVERSED; fontkit's RTL path reverses it back.
 *                MUST contain an Arabic-script char and MUST NOT contain
 *                Latin letters.
 *
 * The pinned outputs below were verified against Pango-rendered ground truth
 * (see the Export & Sharing V1 hardening notes): concatenating the fragments
 * as fontkit renders them (`rtl`/`ltr-rev` reversed, `ltr` as-is) reproduces
 * the reference display for every string.
 */

function shapes(input: string): Array<[PdfTextFragment["direction"], string]> {
  return shapePersianLine(input).map((fragment) => [fragment.direction, fragment.text]);
}

function isArabicScript(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x0870 && cp <= 0x089f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

function isLatinLetter(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function isDigit(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x0660 && cp <= 0x0669) ||
    (cp >= 0x06f0 && cp <= 0x06f9)
  );
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

describe("shapePersianLine", () => {
  it("returns pure LTR input as a single as-is fragment", () => {
    expect(shapes("INV-101")).toEqual([["ltr", "INV-101"]]);
    expect(shapes("12345")).toEqual([["ltr", "12345"]]);
    expect(shapes("IR1234567890")).toEqual([["ltr", "IR1234567890"]]);
    expect(shapes("+98 912 345 6789")).toEqual([["ltr", "+98 912 345 6789"]]);
    expect(shapes("")).toEqual([]);
  });

  it("keeps RTL text logical (the font's GSUB shaper shapes it)", () => {
    // No presentation forms: lam-alef ligatures, contextual forms and mark
    // positioning are the embedded font's job once fontkit reverses the run.
    expect(shapes("سلام")).toEqual([["rtl", "سلام"]]);
    expect(shapes("فاکتور")).toEqual([["rtl", "فاکتور"]]);
    expect(shapes("پ چ ژ ک گ ی")).toEqual([
      ["rtl", "ی"],
      ["rtl", "گ "],
      ["rtl", "ک "],
      ["rtl", "ژ "],
      ["rtl", "چ "],
      ["rtl", "پ "],
    ]);
  });

  it("keeps Persian digit runs in reading order inside RTL text", () => {
    expect(shapes("فاکتور ۱۲۳")).toEqual([
      ["ltr-rev", "۳۲۱"],
      ["ltr", " "],
      ["rtl", "فاکتور"],
    ]);
  });

  it("keeps Latin tokens intact inside RTL text", () => {
    expect(shapes("شماره INV-101")).toEqual([
      ["ltr", "INV-101 "],
      ["rtl", "شماره"],
    ]);
  });

  it("keeps email addresses intact inside RTL text", () => {
    expect(shapes("ایمیل test@mail.com")).toEqual([
      ["ltr", "test@mail.com "],
      ["rtl", "ایمیل"],
    ]);
    expect(shapes("ایمیل: test@mail.com")).toEqual([
      ["ltr", "test@mail.com :"],
      ["rtl", "ایمیل"],
    ]);
  });

  it("keeps ZWNJ inside the RTL run (می‌شود) for the shaper", () => {
    expect(shapes("می‌شود")).toEqual([["rtl", "می‌شود"]]);
    expect(shapes("پیش‌نویس")).toEqual([["rtl", "پیش‌نویس"]]);
  });

  it("pre-mirrors brackets around RTL text", () => {
    // Logical `(تومان)` is drawn `)تومان(` so fontkit's reversal shows
    // `(تومان)`; fontkit reverses but never mirrors.
    expect(shapes("(تومان)")).toEqual([["rtl", ")تومان("]]);
  });

  it("keeps a Latin bracket pair an intact LTR unit", () => {
    expect(shapes("(snapshot)")).toEqual([["ltr", "(snapshot)"]]);
    expect(shapes("فروشگاه البرز (snapshot)")).toEqual([
      ["ltr", "(snapshot) "],
      ["rtl", "البرز"],
      ["rtl", "فروشگاه "],
    ]);
  });

  it("pre-reverses Persian percent values so the render restores them", () => {
    // Logical `۹٪` would trigger fontkit's RTL path and come back `٪۹`,
    // so it is drawn pre-reversed.
    expect(shapes("۹٪")).toEqual([["ltr-rev", "٪۹"]]);
    expect(shapes("(۹٪)")).toEqual([
      ["ltr", "("],
      ["ltr-rev", "٪۹"],
      ["ltr", ")"],
    ]);
  });

  it("reverses block order around number-only bracket pairs", () => {
    // UBA N0: `(۱۰٪)` sits on the RTL side, so `۲۰,۰۰۰ (۱۰٪)` displays as
    // `(۱۰٪) ۲۰,۰۰۰` (verified against Pango ground truth).
    expect(shapes("۲۰,۰۰۰ (۱۰٪)")).toEqual([
      ["ltr", "("],
      ["ltr-rev", "٪۰۱"],
      ["ltr", ") "],
      ["ltr-rev", "۰۲"],
      ["ltr", ","],
      ["ltr-rev", "۰۰۰"],
    ]);
  });

  it("handles realistic mixed labels", () => {
    expect(shapes("تخفیف (۹٪)")).toEqual([
      ["ltr", "("],
      ["ltr-rev", "٪۹"],
      ["ltr", ")"],
      ["rtl", "تخفیف "],
    ]);
    expect(shapes("تخفیف کلی (۵٪)")).toEqual([
      ["ltr", "("],
      ["ltr-rev", "٪۵"],
      ["ltr", ")"],
      ["rtl", "کلی "],
      ["rtl", "تخفیف "],
    ]);
    expect(shapes("مالیات بر ارزش افزوده (۹٪)")).toEqual([
      ["ltr", "("],
      ["ltr-rev", "٪۹"],
      ["ltr", ")"],
      ["rtl", "افزوده "],
      ["rtl", "ارزش "],
      ["rtl", "بر "],
      ["rtl", "مالیات "],
    ]);
    expect(shapes("اقلام فاکتور (تومان)")).toEqual([
      ["rtl", "تومان("],
      ["rtl", "فاکتور )"],
      ["rtl", "اقلام "],
    ]);
  });

  it("glues Arabic decimal/thousands separators to their digits", () => {
    expect(shapes("۱،۲")).toEqual([["ltr-rev", "۲،۱"]]);
    expect(shapes("۳٫۱۴")).toEqual([["ltr-rev", "۴۱٫۳"]]);
  });

  it("orders colon labels, dates and page numbers like the reference", () => {
    expect(shapes("موبایل: 09120000001")).toEqual([
      ["ltr", "09120000001 :"],
      ["rtl", "موبایل"],
    ]);
    expect(shapes("شبا: IR111111111111111111111111")).toEqual([
      ["ltr", "IR111111111111111111111111 :"],
      ["rtl", "شبا"],
    ]);
    expect(shapes("کد ملی: 1010101010")).toEqual([
      ["ltr", "1010101010 :"],
      ["rtl", "ملی"],
      ["rtl", "کد "],
    ]);
    expect(shapes("۱۴ اسفند ۱۴۰۴")).toEqual([
      ["ltr-rev", "۴۰۴۱"],
      ["ltr", " "],
      ["rtl", " اسفند"],
      ["ltr-rev", "۴۱"],
    ]);
    expect(shapes("۱۸۶,۳۹۰ تومان")).toEqual([
      ["rtl", " تومان"],
      ["ltr-rev", "۶۸۱"],
      ["ltr", ","],
      ["ltr-rev", "۰۹۳"],
    ]);
    expect(shapes("صفحه ۱ از ۲")).toEqual([
      ["ltr-rev", "۲"],
      ["ltr", " "],
      ["rtl", " از"],
      ["ltr-rev", "۱"],
      ["ltr", " "],
      ["rtl", "صفحه"],
    ]);
  });

  it("keeps percent runs intact between Persian words", () => {
    expect(shapes("تخفیف ۱۰٪ برای خرید نقدی")).toEqual([
      ["rtl", "نقدی"],
      ["rtl", "خرید "],
      ["rtl", " برای "],
      ["ltr-rev", "٪۰۱"],
      ["ltr", " "],
      ["rtl", "تخفیف"],
    ]);
  });

  it("renders pure-number lines exactly like the Pango reference", () => {
    // Simulate fontkit: `ltr-rev` fragments are reversed by the RTL path,
    // `ltr` fragments pass through. (RTL-letter lines are covered by the
    // fragment pins above; their reversal is fontkit's well-tested path.)
    const render = (input: string): string =>
      shapePersianLine(input)
        .map((fragment) =>
          fragment.direction === "ltr"
            ? fragment.text
            : [...fragment.text].reverse().join(""),
        )
        .join("");
    expect(render("۲۰,۰۰۰ (۱۰٪)")).toBe("(۱۰٪) ۲۰,۰۰۰");
    expect(render("(۹٪)")).toBe("(۹٪)");
    expect(render("۹٪")).toBe("۹٪");
    expect(render("۱،۲")).toBe("۱،۲");
    expect(render("۳٫۱۴")).toBe("۳٫۱۴");
    expect(render("INV-101")).toBe("INV-101");
  });

  it("holds the fontkit contract invariants over an invoice corpus", () => {
    const corpus = [
      "۹٪",
      "۲۰,۰۰۰ (۱۰٪)",
      "تخفیف کلی (۵٪)",
      "مالیات بر ارزش افزوده (۹٪)",
      "موبایل: 09120000001",
      "ایمیل: test@mail.com",
      "شبا: IR111111111111111111111111",
      "۱۴ اسفند ۱۴۰۴",
      "۱۸۶,۳۹۰ تومان",
      "(تومان)",
      "فروشگاه البرز (snapshot)",
      "پیش‌نویس",
      "۱،۲",
      "۳٫۱۴",
      "صفحه ۱ از ۲",
      "تخفیف ۱۰٪ برای خرید نقدی",
      "شماره INV-101",
      "ایمیل test@mail.com",
      "(۹٪)",
      "(snapshot)",
      "کد ملی: 1010101010",
      "اقلام فاکتور (تومان)",
      "پانوشت snapshot",
      "بِسْمِ اللَّهِ",
      "«سلام»",
      "می‌شود",
      "INV-101",
      "09120000002",
      "خدمات طراحی وب",
      "با ما",
    ];
    for (const input of corpus) {
      const fragments = shapePersianLine(input);
      // Never drop or invent characters.
      const produced = fragments.reduce((sum, fragment) => sum + [...fragment.text].length, 0);
      expect(produced).toBe([...input].length);
      for (const fragment of fragments) {
        expect(fragment.text).not.toBe("");
        const chars = [...fragment.text];
        if (fragment.direction === "rtl") {
          expect(chars.some(isArabicScript)).toBe(true);
          expect(chars.some(isLatinLetter)).toBe(false);
          expect(chars.some(isDigit)).toBe(false);
        } else if (fragment.direction === "ltr") {
          expect(chars.some(isArabicScript)).toBe(false);
        } else {
          expect(chars.some(isArabicScript)).toBe(true);
          expect(chars.some(isLatinLetter)).toBe(false);
        }
      }
    }
  });
});
