/**
 * The ten exact acceptance strings for Export V1 PDF RTL hardening, with
 * hand-derived UBA expectations.
 *
 * `visual` is the UBA-correct visual (left-to-right) string: levels resolved
 * under base direction RTL, runs reordered per L1/L2, odd-level mirrored
 * characters substituted per L4. `levels` is one digit per UTF-16 unit (all
 * ten strings are BMP-only, so one digit per character).
 *
 * These literals were derived against the `bidi-js` oracle (UBA 13.0,
 * conformance-tested) and cross-checked with python-bidi; the `bidi.test.ts`
 * suite asserts them mechanically, so any transcription slip fails loudly
 * instead of silently weakening the PDF assertions built on top.
 */
export interface RtlCase {
  id: string;
  logical: string;
  visual: string;
  levels: string;
  /**
   * Glyph-joined text override for real-PDF assertions. The UBA `visual`
   * string is character-level; when an RTL run contains a ligature (lam-alef
   * in `کالا`), the fused glyph's `/ToUnicode` entry stays in LOGICAL order
   * ("لا") while occupying the first two visual slots, so the joined glyph
   * text differs from `visual` as a string while rendering identically.
   */
  pdfJoinedText?: string;
}

export const RTL_CASES: RtlCase[] = [
  { id: "studio", logical: "استودیو نمارو", visual: "ورامن ویدوتسا", levels: "1111111111111" },
  { id: "doctype", logical: "فاکتور رسمی", visual: "یمسر روتکاف", levels: "11111111111" },
  { id: "credit", logical: "امتیاز: علیرضا قوایی", visual: "ییاوق اضریلع :زایتما", levels: "11111111111111111111" },
  {
    id: "subtitle",
    logical: "فروش کالا و خدمات",
    visual: "تامدخ و الاک شورف",
    levels: "11111111111111111",
    pdfJoinedText: "تامدخ و لااک شورف",
  },
  {
    id: "grand",
    logical: "مبلغ کل: ۱۷۱,۰۰۰ تومان",
    visual: "ناموت ۱۷۱,۰۰۰ :لک غلبم",
    levels: "1111111112222222111111",
  },
  {
    id: "discount",
    logical: "تخفیف کل (۱۰٪): ۱۷,۱۰۰ تومان",
    visual: "ناموت ۱۷,۱۰۰ :(٪۱۰) لک فیفخت",
    levels: "1111111111221111222222111111",
  },
  {
    id: "amount",
    logical: "۲۰,۰۰۰ تومان (۱۰٪)",
    visual: "(٪۱۰) ناموت ۲۰,۰۰۰",
    levels: "222222111111112211",
  },
  { id: "mixed-ltr-lead", logical: "ABC ۱۲۳ تست", visual: "تست ABC ۱۲۳", levels: "22222221111" },
  { id: "mixed-rtl-lead", logical: "تست ABC 123", visual: "ABC 123 تست", levels: "11112222222" },
  {
    id: "paren-lead",
    logical: "(۱۰٪) ۲۰,۰۰۰ تومان",
    visual: "ناموت ۲۰,۰۰۰ (۱۰٪)",
    levels: "122211222222111111",
  },
];
