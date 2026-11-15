# Product Documentation — Image Text Selector (v2.0.0)

## 1. Product Overview

**Image Text Selector** is a privacy-first, offline-capable Chrome/Edge (Manifest V3) extension that converts text inside web images, `<video>`, `<canvas>`, and UI cards into selectable, copyable, translatable, and structured text.

### Design & UX Identity
- **99% Crimson & Obsidian Theme:** High-contrast obsidian black surfaces (`#070709`, `#101014`) paired with deep crimson (`#991b1b`–`#dc2626`) accents across the 3-tab popup, floating image toolbar, inline drawer, region capture panel, and batch export dialog.
- **Offline Default + Optional AI Fallback:** Local Tesseract.js v7 (WASM + relaxed-SIMD) handles all OCR offline with zero network calls; users may optionally attach their own **Google Gemini** or **OpenAI-compatible** Vision API key for handwritten notes, formulas, or complex graphics.

---

## 2. System Architecture (v2.0.0)

| Component | File(s) | Responsibility |
| :--- | :--- | :--- |
| **Service Worker** | `background.js` | Registers context menus & `Alt+Shift+O` shortcut; bypasses image CORS via `fetchImageAsBase64`; captures visible tabs; manages the offscreen document; handles `TRANSLATE_TEXT`, `CLOUD_VISION_OCR`, and `SAVE_SCAN_HISTORY` (`chrome.storage.local`, up to 50 items). |
| **Offscreen Worker Pool** | `offscreen/offscreen.html`, `offscreen/offscreen.js` | Maintains a 2-worker LRU Tesseract.js v7 pool (`MAX_WORKERS = 2`) with 5-minute idle eviction. Runs contrast stretching, dark-background polarity inversion, integral-image adaptive binarization (for white text on colored/dark UI pills), raw **PGM** encoding, dual-pass big-text scanning, and word/line confidence + icon-artifact filtering. |
| **Shared Utilities** | `utils/ocr-utils.js` | Line-level symbol artifact cleanup (`cleanLineText`), structured entity extraction (`extractEntities`: prices, emails, URLs, phones), and geometric table structure recognition (`extractTableFromLines` → Markdown / TSV / CSV). |
| **Content Script** | `content.js`, `styles.css` | Auto-detects page language when set to `auto`; extracts `<canvas>`/`<video>` sub-frames directly before falling back to DPR-safe `captureVisibleTab`; renders the word-level transparent overlay, quick-switch toolbar, inline drawer (Table / Translate / AI / Entity chips), and Batch Page OCR exporter (`.md` / `.csv`). |
| **3-Tab Popup** | `popup/popup.html`, `popup/popup.css`, `popup/popup.js` | **Scan** (language, speed/accuracy, preprocessing, region/batch triggers, noise filter toggle), **History** (searchable local log), and **AI & Tools** (translation target, Gemini/OpenAI Vision config, quick guide). |

---

## 3. Baseline Test Case & Evaluation (v1.2.0 → v2.0.0)

### Real-World E-Commerce Product Card Test

![E-commerce product card OCR test](assets/test-ebay-chair-ocr.jpg)

**Test Input:** An eBay product listing card (`Alienware S5000 Gaming Swivel Chair - Black/White`) containing mixed typography, colored UI pills (`IN 4 CARTS`, `Buy It Now`, `Apple Pay`), vector icons (heart, stars, info `i`), seller rating, dual currency prices (`16,452,480.00 VND`, `$640.00`), and condition label.

**Observed v1.2.0 Output (Notepad on the right):**
```text
bà wi] ]
( (4
18 Q
Alienware S5000 Gaming Swivel Chair -
Black/White
* Kx 5.0 4 product ratings
mitmaxim (714) (
M 100% positive \ Message ;
Approx.
16,452,480.00 VND
$640.00
Condition New @)
```

---

## 4. Weaknesses Identified & Resolved in v2.0.0

All 6 architectural and OCR quality weaknesses identified in v1.2.0 have been addressed in **v2.0.0**:

| # | v1.2.0 Weakness | Root Cause | v2.0.0 Fix Implemented |
| :--- | :--- | :--- | :--- |
| **1** | **UI icons & badges produce garbled text** (`bà wi] ]`, `* Kx`, `@)`) | `extractLines()` accepted any word with `confidence >= 25` without checking symbol density or bounding box geometry. | `isAllowedWord()`, `cleanLineWords()`, and `isNoiseLine()` in `offscreen.js` + `OcrUtils.cleanLineText()` enforce higher thresholds for 1–2 char fragments (`>= 52`) and pure symbols (`>= 82`), reject tiny icon boxes (`< 3x5px`), strip trailing/leading orphan brackets (`(`, `] ]`, `@)`), and drop low-confidence symbol-heavy lines. Toggleable via **Smart Noise Filter**. |
| **2** | **Vietnamese diacritic hallucination on English UIs** | Default `ocrLanguage` was `vie+eng`, causing English UI noise to map to Vietnamese characters (`bà`). | Default is now **`auto`** (`resolveLanguage()` inspects `document.documentElement.lang` / `navigator.language`, selecting `eng` on English pages and `vie+eng` on Vietnamese pages). Added a **1-click Language Switcher** directly on the floating image toolbar (`ENG`, `VIE+ENG`, `CHI`, `JPN`, `KOR`). |
| **3** | **White text on dark/colored buttons missed** (`IN 4 CARTS`, `Apple Pay`) | Direct RGB-to-grayscale conversion without contrast normalization or polarity inversion. | `offscreen.js` now performs 2%–98% **contrast stretching**, automatic dark-background **polarity inversion** (`mean < 110`), and in `auto` mode runs a secondary **integral-image adaptive binarization** pass (`adaptiveBinarize(..., invert=true)`) when mixed dark/light UI regions are detected, merging high-confidence lines (`>= 62`). Also exposed manually via `Pre: Auto / Contrast / Invert / Raw`. |
| **4** | **Single-worker sequential penalty on language switch** | One global `worker` was terminated on every language or quality change. | Upgraded to a **2-worker LRU pool** (`MAX_WORKERS = 2`) in `offscreen.js` with `"Switching language model..."` status reporting so toggling between two modes/languages stays warm. |
| **5** | **Region OCR viewport/DPR drift & indirect media capture** | `captureVisibleTab` assumed clean viewport proportions even for `<canvas>` and `<video>` elements. | `tryDirectMediaCapture()` in `content.js` extracts exact native-resolution frames directly from same-origin `<canvas>` and `<video>` elements when the selection falls inside them, and safely clamps `captureVisibleTab` crop bounds across zoom/DPR levels. |
| **6** | **No text post-processing** | Raw Tesseract lines were concatenated verbatim. | Added `OcrUtils.cleanLineText()` post-processing, structured entity extraction (`prices`, `emails`, `urls`, `phones`), and `Table` layout reconstruction. |

---

## 5. Implemented Feature Set (v1.3 → v2.0.0)

### Preprocessing & Precision (v1.3)
- **Smart Noise Filter:** Enabled by default; toggleable in popup settings.
- **Toolbar Quick Switchers:** Change language (`ENG`, `VIE+ENG`, `CHI`, `JPN`, `KOR`) and preprocessing (`Auto`, `Contrast`, `Invert`, `Raw`) on the fly above any scanned image.
- **Adaptive Preprocessing:** Contrast stretch, dark-mode inversion, and Bradley-style local adaptive thresholding.

### Productivity & Workflow (v1.4)
- **Instant Translate:** One-click translation drawer inside the image toolbar and region result panel with configurable target language (`en`, `vi`, `ja`, `ko`, `zh-CN`, `fr`, `de`, `es`).
- **Structured Data Extraction:** Automatically extracts Prices, Emails, URLs, and Phone Numbers as 1-click copy pills.
- **Local Scan History:** Stores the last 50 scans in `chrome.storage.local` with instant search, copy, and delete in the **History** tab.

### Advanced Extraction & AI (v2.0.0)
- **Batch / Full-Page Scan:** Scans all qualifying images (`>= 120x60px`) on the active tab with live progress, Copy All, **Export `.md`**, and **Export `.csv`**.
- **Table Structure Recognition:** Clusters word bounding boxes into rows and global column anchors to export **Markdown tables** and **TSV** (pasteable directly into Excel / Google Sheets).
- **Optional Cloud AI Vision Fallback:** Supports **Google Gemini** (`gemini-2.5-flash`, etc.) and **OpenAI-compatible** Vision endpoints (`gpt-4o-mini`, custom base URLs) using the user's locally stored API key, available both on-demand (`AI` button) and as an optional auto-fallback when local OCR detects 0 words.

---

## 6. Local Playground Verification

Open `test.html` directly in Chrome or Edge to test:
1. Hover trigger (`Select Text`) and right-click context menu OCR on `sample-quote.png`.
2. Quick language / preprocessing switches on the floating toolbar.
3. Table / Translate / Entity chip drawers and `Ctrl+C` line preservation.
4. `Alt+Shift+O` region capture and **Batch Page OCR** from the popup.
