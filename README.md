# Image Text Selector

A **Manifest V3** browser extension for **Google Chrome** and **Microsoft Edge** that turns text inside any web image or screen region into selectable, copyable text (`Ctrl+C` / `Ctrl+V`) using an offline Tesseract.js v7 WASM engine.

---

## Key Features

- **Direct On-Image Selection:** Overlays a transparent, responsive text layer directly on top of images so you can highlight and copy lines naturally.
- **Region Capture (`Alt+Shift+O`):** Drag to extract text from backgrounds, `<canvas>`, `<video>`, or UI cards, with an editable result panel.
- **Offline & Private:** Bundles Tesseract.js v7 (WASM + relaxed-SIMD) with English and Vietnamese traineddata; 10 additional languages download on demand and cache locally.
- **Fast Engine:** ~0.85s average scan in Fast mode (pre-warmed on hover, raw PGM encoding, dual-pass big-text detection, and per-image result caching).
- **99% Crimson & Obsidian UI:** Clean, high-contrast dark interface with deep crimson accents.

---

## Installation (Chrome / Edge)

1. Open `chrome://extensions/` (or `edge://extensions/`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the extension root folder (`Copy-pastes-texts-from-pictures-extension-main`).

---

## Usage

- **Hover:** Move your cursor over any image (`>= 120x60px`) and click **Select Text** at the top-right corner.
- **Right-Click:** Right-click an image and select **Select text on this image (OCR)**, or right-click anywhere on a page and select **Scan text from selected region**.
- **Shortcut:** Press `Alt+Shift+O`, drag across any region, and copy from the floating result panel.
- **Playground:** Open `test.html` in your browser to test with the included `sample-quote.png`.

---

## Project Structure

```text
├── manifest.json          # Manifest V3 configuration (v1.2.0)
├── background.js          # Service worker: context menus, shortcuts, CORS fetch, tab capture
├── content.js             # Page overlay, hover trigger, region selector, copy handler
├── styles.css             # 99% Crimson & Obsidian injected UI styles
├── offscreen/             # Offscreen document hosting the Tesseract Web Worker
├── libs/                  # Tesseract.js v7, WASM core, and bundled eng/vie traineddata
├── popup/                 # Extension settings popup (language, scan mode, toggles)
├── docs/                  # Product documentation and real-world test results
└── test.html              # Local test playground
```

---

## Documentation

See [docs/PRODUCT_DOCS.md](docs/PRODUCT_DOCS.md) for architecture details, real-world test screenshots, known weaknesses with root-cause fixes, and the future roadmap.
