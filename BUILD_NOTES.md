# BUILD_NOTES — BG Laufzettel Generator PWA

## Implementation

- **Parser:** `js/parse.js` — 1:1 JS port of `bg-laufzettel-app/app/parse_input.py`.
- **PDF:** Approach A — `js/pdf.js` draws the form with **pdf-lib** using coordinates measured from the Windows reference PDF (`BG Endstufe V2.pdf` via pymupdf).
- **Fonts:** Subset Calibri / Calibri-Bold / Aeonis embedded via `@pdf-lib/fontkit` (vendored).
- **UI:** German; pill input; example click-fill; collapsible Aufträge; status line; settings (auto-share + Version/© only).
- **PWA packaging:** Pattern copied from `BG-Laufzettel-Web` (manifest, sw.js, netlify.toml, `_headers`, DEPLOY.txt).

## Verified (2026-09-11)

| Test | Result |
|------|--------|
| Parse `10x 100.123 BG Endstufe V2 A12345 Daniel` | OK → qty 10, A/12345, stem `BG Endstufe V2` |
| Parse `12x …` / example `15x … B12345 Daniel` | OK |
| PDF 10× | 1 page, SNs **A12345–A12354** |
| PDF 12× | 2 pages, SNs **A12345–A12354** + **A12355–A12356** |
| Filename | `BG Endstufe V2.pdf` (article number stripped) |
| `python3 -m http.server` + headless Chrome on `index.html` | **no console errors** |
| Service-worker asset list | all files present |

Local server used for checks: `http://127.0.0.1:8791/`

## Visual compromises vs Windows LibreOffice PDFs

- Drawn with pdf-lib (not LO/XLSM), so micro-kerning / exact LO line joins may differ slightly.
- BEAK mark: Aeonis letters + drawn pink circle (not the exact LO text bullet glyph alone).
- SN vertical position ~3–4 pt vs reference (still centered in row).
- Fonts are **subset** TTFs (Latin + German); exotic glyphs outside the subset may missing-glyph.
- Thin grid uses filled 0.14 pt rectangles (same approach as Windows postprocess), not stroked paths.

## Not included in settings (by design)

No LibreOffice / template / output-folder paths (browser PWA).

## 2026-09-11 visual + UI merge

### PDF layout (vs Windows SOLL)
- Baugruppe value left-aligned (pad ≈ 8.59 pt)
- BEAK logo gray `#727272` with wider letter spacing (spaces @23pt) + pink bullet circle
- Table header two-line block vertically centered (Windows `WIN_ASCENT=0.92`, `NUDGE_Y=-1.35`)
- SN / value cells use fontkit ascent/descent for vertical centering

### UI merge (Generator + Fill)
- Home: Generator top → Beispiel linebreak → Trennlinie → Fill empty-state + **PDF öffnen**
- Fill mode: toolbar with Einstellungen (left), Speichern / Stift rückgängig / Schließen (right); no top-right PDF öffnen
- Fill features from latest fill-bot (v11): stamps, header column stamp, erase mode, colors, Speichern/share, Apple Pencil ink + undo
- Cache: `bg-laufzettel-generator-v3`

## 2026-09-16 — v1.4 Scan → Katalog → Öffnen

- Ported DataMatrix/Barcode camera scanning from Geräte Laufzettel (`scan.js`, ZXing UMD).
- `sn.js`: BG etikett (`B00001` / letter+digits) + last-segment-after-hyphen + bare alphanumeric.
- `catalog.js`: IndexedDB `bg-laufzettel-catalog-v1` (not Geräte). On import, stores blob + filename and indexes serial-like tokens from **filename and PDF text** via pdf.js `getTextContent`.
- `findPdfBySerial`: prefer exact `serialKeys` hit, else filename/haystack substring/token.
- Home **Scannen** UI + settings catalog (folder picker when available, file multi-pick, clear).
- Cache `bg-laufzettel-generator-v58`; footer Version **1.4**.
- Camera needs secure context (HTTPS/localhost) + permission; catalog must be filled before auto-open.
