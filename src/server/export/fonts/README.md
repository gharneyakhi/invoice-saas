# Bundled Persian fonts (PDF export)

The invoice PDF renderer embeds these two static weights so Persian text
renders identically everywhere, without depending on server-installed fonts:

- `Vazirmatn-Regular.ttf` — body text
- `Vazirmatn-Bold.ttf` — headings, totals, emphasized labels

Source: the `vazirmatn@33.0.3` npm package (the font author's own release),
`fonts/ttf/`. Only these two files (plus `OFL.txt`) are vendored; nothing else
from that package is used.

License: SIL Open Font License 1.1 — see `OFL.txt`. The OFL permits embedding
(including subset embedding, which is what the PDF service does) and
redistribution with this notice.

Why Vazirmatn, and why these exact files:

- Full Persian coverage (پ چ ژ گ ک ی، digits ۰-۹, ٪، ؛ ؟) plus Latin/digits and
  the punctuation invoices need.
- A real GSUB table (`isol`/`init`/`medi`/`fina`, lam-alef `rlig`, `liga`) so
  the shaper joins Persian letters correctly. The pipeline never uses
  Arabic Presentation Forms code points; shaping is done by the font's GSUB
  through fontkit.
- No `rtlm` feature, which the pipeline relies on: bracket mirroring is applied
  explicitly per UBA rule L4 before shaping. If these files are ever replaced,
  `pdfRtl.test.ts` (paren-group expectations) and the Vazirmatn feature probe
  in `persianText.test.ts` will fail loudly when that assumption breaks.
- Static (non-variable) TTFs: pdf-lib/fontkit subset-embedding is only
  exercised against static fonts in this repo.

## Raster (PNG/JPG) pipeline font files (recovered)

The SVG→PNG/JPG renderer (`../imageService.ts`) embeds its own copy via
`@font-face`, loaded through `../fontLoader.ts` (recovered from the Export V1
branch `dd2d54c`, kept verbatim so image output stays byte-identical):

- `Vazirmatn.ttf` — single Regular weight (source: `google/fonts`,
  `ofl/vazirmatn`, `Vazirmatn[wght].ttf` default instance); the input for the
  generated embed below.
- `vazirmatnFont.ts` — GENERATED base64 module of that TTF (see
  `scripts/regen-font-embed.mjs`); embedded as a module rather than read from
  disk so generation behaves identically on serverless. Excluded from ESLint
  via `.eslintignore` (generated).

`OFL.txt` (identical in both sources) covers all files in this directory.
