# Image Text Selector (v2.0)

A **Manifest V3** browser extension for **Google Chrome** and **Microsoft Edge** that turns text inside web images, videos, canvases, and screen regions into selectable, copyable, translatable, and structured text (`Ctrl+C` / `Ctrl+V`) powered by an offline Tesseract.js v7 WASM engine with optional Cloud AI Vision fallback.

---

## Key Features (v2.0)

- **Direct On-Image Text Layer:** Overlays transparent, responsive `<span>` text aligned word-by-word on images for natural highlighting and `Ctrl+C` copying.
- **Smart Preprocessing & Noise Filter:** Contrast normalization, automatic dark-background inversion, integral-image adaptive binarization (to capture white text on colored/dark buttons), and icon/artifact filtering.
- **Auto Language & Quick Toolbar Switcher:** Auto-detects page language (`Auto`), supports 2-worker LRU pooling, and lets you switch language (`ENG`, `VIE+ENG`, `CHI`, `JPN`, `KOR`) or preprocessing (`Auto`, `Contrast`, `Invert`, `Raw`) directly from the image toolbar.
- **Region & Media Capture (`Alt+Shift+O`):** Captures native `<canvas>` / `<video>` frames directly when possible, or falls back to DPR-safe tab capture.
- **Table Recognition & Structured Entities:** Reconstructs rows/columns into **Markdown** or **TSV** tables, and surfaces 1-click copy chips for detected prices, emails, URLs, and phone numbers.
- **Instant Translate & Batch Page Scan:** Translate extracted text inline, scan all qualifying images on a page at once, and export to **Markdown (`.md`)** or **CSV (`.csv`)**.
- **Local Scan History & Optional AI Vision:** Searchable local history (last 50 scans) plus opt-in **Google Gemini** or **OpenAI-compatible** Vision fallback for handwriting, math, or stylized graphics.
- **99% Crimson & Obsidian UI:** High-contrast dark interface with deep crimson accents.

---

## Installation (Chrome / Edge)

1. Open `chrome://extensions/` (or `edge://extensions/`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the extension root folder (`Copy-pastes-texts-from-pictures-extension-main`).

---

## Usage

- **Hover:** Move over any image (`>= 120x60px`) and click **Select Text**.
- **Right-Click:** Choose **Select text on this image (OCR)** or **Scan text from selected region**.
- **Shortcut:** Press `Alt+Shift+O` and drag across any region (including videos, canvases, or UI cards).
- **Popup Tabs:** Use **Scan** (settings, region & batch scan), **History** (search & re-copy), and **AI & Tools** (translate target & optional Cloud Vision API key).
- **Playground:** Open `test.html` in your browser to test with `sample-quote.png`.

---

## Project Structure

```text
├── manifest.json          # Manifest V3 configuration (v2.0.0)
├── background.js          # Service worker: menus, CORS fetch, translate, AI Vision, history
├── content.js             # Overlay, region/canvas/video capture, toolbar, batch scan
├── styles.css             # 99% Crimson & Obsidian injected UI styles
├── utils/ocr-utils.js     # Text cleanup, entity extraction, table structure recognition
├── offscreen/             # Offscreen document hosting the 2-worker Tesseract pool & PGM pipeline
├── libs/                  # Tesseract.js v7, WASM core, and bundled eng/vie traineddata
├── popup/                 # 3-tab extension popup (Scan, History, AI & Tools)
├── docs/                  # Product documentation and real-world test results
└── test.html              # Local test playground
```

---

## Documentation

See [docs/PRODUCT_DOCS.md](docs/PRODUCT_DOCS.md) for architecture details, v1.2.0 → v2.0.0 benchmark & weakness resolutions, real-world test screenshots, and technical notes.
