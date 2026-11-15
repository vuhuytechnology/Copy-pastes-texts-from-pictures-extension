// content.js - DOM overlay, region/canvas/video OCR, toolbar tools (lang/preprocess/table/translate/AI), and batch scan

(() => {
  if (window.__imageTextSelectorLoaded) return;
  window.__imageTextSelectorLoaded = true;

  const DEFAULT_SETTINGS = {
    ocrLanguage: "auto",
    ocrQuality: "fast",
    preprocessing: "auto",
    smartFilter: true,
    showHoverButton: true,
    autoCopy: false,
    translateTarget: "en",
    aiAutoFallback: false
  };

  let settings = { ...DEFAULT_SETTINGS };
  let aiConfigured = false;
  let lastRightClickedElement = null;
  const activeOverlays = new Map(); // Map<img, { remove() }>
  const progressHandlers = new Map(); // jobId -> callback
  const resultCache = new Map(); // "src|lang|quality|prep|filter" -> result
  let lastPrewarm = 0;
  let jobCounter = 0;

  // ---------- Settings & Storage Sync ----------
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    settings = { ...DEFAULT_SETTINGS, ...items };
  });
  chrome.storage.local.get({ aiSettings: { provider: "disabled", apiKey: "" } }, ({ aiSettings }) => {
    aiConfigured = Boolean(aiSettings && aiSettings.provider !== "disabled" && aiSettings.apiKey);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      if (!settings.showHoverButton) hideHoverButton();
    } else if (area === "local" && changes.aiSettings) {
      const a = changes.aiSettings.newValue;
      aiConfigured = Boolean(a && a.provider !== "disabled" && a.apiKey);
    }
  });

  function resolveLanguage(langSetting) {
    if (langSetting && langSetting !== "auto") return langSetting;
    const docLang = (document.documentElement.lang || navigator.language || "en").toLowerCase();
    if (docLang.startsWith("vi")) return "vie+eng";
    if (docLang.startsWith("zh-tw") || docLang.startsWith("zh-hant")) return "chi_tra+eng";
    if (docLang.startsWith("zh")) return "chi_sim+eng";
    if (docLang.startsWith("ja")) return "jpn+eng";
    if (docLang.startsWith("ko")) return "kor+eng";
    if (docLang.startsWith("fr")) return "fra+eng";
    if (docLang.startsWith("de")) return "deu+eng";
    if (docLang.startsWith("es")) return "spa+eng";
    if (docLang.startsWith("ru")) return "rus+eng";
    if (docLang.startsWith("th")) return "tha+eng";
    return "eng";
  }

  function prewarm() {
    const now = Date.now();
    if (now - lastPrewarm < 4 * 60 * 1000) return;
    lastPrewarm = now;
    chrome.runtime.sendMessage({
      action: "OCR_PREWARM",
      lang: resolveLanguage(settings.ocrLanguage),
      quality: settings.ocrQuality || "fast"
    }).catch(() => {});
  }

  document.addEventListener("contextmenu", (e) => { lastRightClickedElement = e.target; }, true);

  // ---------- Background Message Handler ----------
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    switch (request.action) {
      case "TRIGGER_OCR_FOR_IMAGE": {
        let targetImg = null;
        if (lastRightClickedElement && lastRightClickedElement.tagName === "IMG") {
          targetImg = lastRightClickedElement;
        } else {
          targetImg = Array.from(document.querySelectorAll("img"))
            .find((img) => img.src === request.srcUrl || img.currentSrc === request.srcUrl);
        }
        if (targetImg) processImageOCR(targetImg);
        else showToast("Could not locate the target image on this page.", "warning");
        break;
      }
      case "START_REGION_SELECT":
        if (window === window.top) startRegionSelect();
        break;
      case "START_BATCH_SCAN":
        if (window === window.top) {
          startBatchScan();
          sendResponse({ started: true });
        }
        break;
      case "OCR_PROGRESS": {
        const cb = progressHandlers.get(request.jobId);
        if (cb) cb(request);
        break;
      }
    }
  });

  // ---------- Hover Trigger Button ----------
  let hoverBtn = null;
  let currentHoverImg = null;
  let hoverRaf = 0;

  function hideHoverButton() {
    if (hoverBtn) hoverBtn.style.display = "none";
  }

  function findImageAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.classList && [...el.classList].some((c) => c.startsWith("ocr-"))) continue;
      if (el.tagName === "IMG" && el.clientWidth >= 120 && el.clientHeight >= 60) return el;
    }
    return null;
  }

  document.addEventListener("mousemove", (e) => {
    if (!settings.showHoverButton || hoverRaf) return;
    const x = e.clientX, y = e.clientY;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (hoverBtn && hoverBtn.style.display !== "none" && currentHoverImg) {
        const b = hoverBtn.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return;
      }
      const img = findImageAt(x, y);
      if (img && !activeOverlays.has(img)) {
        currentHoverImg = img;
        ensureHoverButton();
        positionHoverButton(img);
        prewarm();
      } else {
        hideHoverButton();
      }
    });
  }, { passive: true });

  function ensureHoverButton() {
    if (hoverBtn) return;
    hoverBtn = document.createElement("button");
    hoverBtn.className = "ocr-hover-trigger-btn";
    hoverBtn.textContent = "Select Text";
    hoverBtn.title = "Enable text selection & copy on this image";
    document.body.appendChild(hoverBtn);
    hoverBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (currentHoverImg) {
        hideHoverButton();
        processImageOCR(currentHoverImg);
      }
    });
  }

  function positionHoverButton(img) {
    const rect = img.getBoundingClientRect();
    hoverBtn.style.display = "flex";
    const top = Math.max(rect.top, 0) + 8;
    const right = Math.min(rect.right, window.innerWidth);
    hoverBtn.style.top = `${top}px`;
    hoverBtn.style.left = `${Math.max(right - hoverBtn.offsetWidth - 8, 0)}px`;
  }

  // ---------- OCR Execution ----------
  const STATUS_TEXT = {
    "loading": "Starting OCR engine...",
    "switching": "Switching language model...",
    "loading tesseract core": "Loading OCR core...",
    "initializing tesseract": "Initializing...",
    "loading language traineddata": "Loading language data...",
    "loaded language traineddata": "Loading language data...",
    "initializing api": "Initializing...",
    "initialized api": "Initializing..."
  };

  async function runOCR(imageDataUrl, onStatus, overrides = {}) {
    const lang = resolveLanguage(overrides.lang ?? settings.ocrLanguage);
    const quality = overrides.quality ?? settings.ocrQuality ?? "fast";
    const preprocessing = overrides.preprocessing ?? settings.preprocessing ?? "auto";
    const smartFilter = overrides.smartFilter ?? settings.smartFilter ?? true;
    const jobId = `job-${Date.now()}-${++jobCounter}`;

    progressHandlers.set(jobId, (p) => {
      if (!onStatus) return;
      if (p.status === "recognizing text") onStatus(`Recognizing: ${Math.round((p.progress || 0) * 100)}%`);
      else if (STATUS_TEXT[p.status]) onStatus(STATUS_TEXT[p.status]);
    });

    try {
      const res = await chrome.runtime.sendMessage({
        action: "OCR_RECOGNIZE",
        jobId,
        image: imageDataUrl,
        lang,
        quality,
        preprocessing,
        smartFilter
      });
      if (!res || !res.success) throw new Error(res?.error || "OCR engine did not respond.");
      lastPrewarm = Date.now();
      return { ...res.result, langUsed: lang };
    } finally {
      progressHandlers.delete(jobId);
    }
  }

  function imageToDataUrlViaCanvas(img) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  async function getImageDataUrl(img) {
    const src = img.currentSrc || img.src;
    if (src.startsWith("data:")) return src;
    try {
      return imageToDataUrlViaCanvas(img);
    } catch (e) { /* tainted -> fetch via background */ }
    const response = await chrome.runtime.sendMessage({ action: "FETCH_IMAGE_AS_BASE64", url: src });
    if (response && response.success) return response.base64;
    throw new Error("Failed to load image data" + (response?.error ? `: ${response.error}` : "."));
  }

  function postProcessResult(result) {
    if (!result || !result.lines) return result;
    const cleanLines = result.lines.map((l) => {
      const text = window.OcrUtils
        ? window.OcrUtils.cleanLineText(l.words.map((w) => w.text).join(" "))
        : l.words.map((w) => w.text).join(" ");
      return { ...l, cleanText: text };
    }).filter((l) => l.cleanText);
    return {
      ...result,
      lines: cleanLines,
      text: cleanLines.map((l) => l.cleanText).join("\n")
    };
  }

  function logHistory(text, lang, source) {
    if (!text || !text.trim()) return;
    chrome.runtime.sendMessage({
      action: "SAVE_SCAN_HISTORY",
      entry: {
        text,
        lang,
        source,
        pageTitle: document.title || "",
        pageUrl: location.href
      }
    }).catch(() => {});
  }

  async function processImageOCR(img, overrides = {}, forceRescan = false) {
    if (!forceRescan && activeOverlays.has(img)) {
      showToast("Text overlay is already active on this image.", "info");
      return;
    }
    if (forceRescan) removeOverlay(img);

    const effectiveLang = resolveLanguage(overrides.lang ?? settings.ocrLanguage);
    const effectivePrep = overrides.preprocessing ?? settings.preprocessing ?? "auto";
    const effectiveFilter = overrides.smartFilter ?? settings.smartFilter ?? true;

    const loader = showLoading(img.getBoundingClientRect(), "Loading image...");
    try {
      const dataUrl = await getImageDataUrl(img);
      const cacheKey = `${img.currentSrc || img.src}|${effectiveLang}|${settings.ocrQuality}|${effectivePrep}|${effectiveFilter}`;
      let result = !forceRescan ? resultCache.get(cacheKey) : null;

      if (!result) {
        loader.updateStatus("Starting OCR engine...");
        const raw = await runOCR(dataUrl, loader.updateStatus, {
          lang: effectiveLang,
          preprocessing: effectivePrep,
          smartFilter: effectiveFilter
        });
        result = postProcessResult(raw);

        // Optional Cloud AI Vision fallback if local OCR found nothing
        if (!result.lines.length && settings.aiAutoFallback && aiConfigured) {
          loader.updateStatus("Running AI Vision fallback...");
          const aiRes = await chrome.runtime.sendMessage({ action: "CLOUD_VISION_OCR", image: dataUrl });
          if (aiRes?.success && aiRes.text?.trim()) {
            loader.remove();
            logHistory(aiRes.text, "AI Vision", "image-ai");
            showResultPanel(img.getBoundingClientRect(), { text: aiRes.text, lines: [] }, dataUrl);
            showToast("Extracted via Cloud AI Vision fallback.", "success");
            return;
          }
        }

        if (cacheKey.length < 2000) {
          if (resultCache.size >= 30) resultCache.delete(resultCache.keys().next().value);
          resultCache.set(cacheKey, result);
        }
      }
      loader.remove();

      if (!result.lines.length) {
        showToast("No text detected in this image.", "warning");
        return;
      }

      renderTextOverlay(img, result, dataUrl, {
        lang: effectiveLang,
        preprocessing: effectivePrep
      });
      logHistory(result.text, effectiveLang, "image");

      const wordCount = result.lines.reduce((n, l) => n + l.words.length, 0);
      if (settings.autoCopy) {
        await copyText(result.text);
        showToast(`Detected ${wordCount} words and copied to clipboard.`, "success");
      } else {
        showToast(`Detected ${wordCount} words. Highlight text to copy!`, "success");
      }
    } catch (error) {
      console.error("OCR error:", error);
      loader.remove();
      showToast("OCR scan failed: " + error.message, "error");
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  // ---------- Shared Inspector Drawer Builder (Entities / Table / Translate / AI) ----------
  function buildExtrasHtml(showTableBtn) {
    return `
      <div class="ocr-extras-box" style="display:none;">
        <div class="ocr-extras-header">
          <span class="ocr-extras-title"></span>
          <div class="ocr-extras-actions">
            <button class="ocr-tb-btn ocr-extras-copy" type="button">Copy</button>
            <button class="ocr-tb-btn ocr-extras-close" type="button">✕</button>
          </div>
        </div>
        <pre class="ocr-extras-content"></pre>
      </div>
    `;
  }

  function renderEntityChips(container, text) {
    if (!window.OcrUtils) return;
    const entities = window.OcrUtils.extractEntities(text);
    const items = [
      ...entities.prices.map((v) => ({ label: "Price", value: v })),
      ...entities.emails.map((v) => ({ label: "Email", value: v })),
      ...entities.urls.map((v) => ({ label: "URL", value: v })),
      ...entities.phones.map((v) => ({ label: "Phone", value: v }))
    ].slice(0, 8);

    container.innerHTML = "";
    if (!items.length) {
      container.style.display = "none";
      return;
    }
    container.style.display = "flex";
    for (const item of items) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ocr-entity-chip";
      chip.title = `Click to copy ${item.label}: ${item.value}`;
      chip.innerHTML = `<span class="ocr-entity-tag">${item.label}</span><span class="ocr-entity-val"></span>`;
      chip.querySelector(".ocr-entity-val").textContent = item.value;
      chip.addEventListener("click", async () => {
        const ok = await copyText(item.value);
        showToast(ok ? `Copied ${item.label}: ${item.value}` : "Failed to copy.", ok ? "success" : "error");
      });
      container.appendChild(chip);
    }
  }

  // ---------- Image Text Overlay ----------
  function renderTextOverlay(img, ocrData, imageDataUrl, activeOpts) {
    const naturalW = ocrData.width || img.naturalWidth;
    const naturalH = ocrData.height || img.naturalHeight;

    const wrapper = document.createElement("div");
    wrapper.className = "ocr-text-overlay-container";

    const layer = document.createElement("div");
    layer.className = "ocr-text-layer";
    layer.style.width = `${naturalW}px`;
    layer.style.height = `${naturalH}px`;
    wrapper.appendChild(layer);

    const toolbar = document.createElement("div");
    toolbar.className = "ocr-overlay-toolbar";
    toolbar.innerHTML = `
      <button class="ocr-tb-btn ocr-copy-all" title="Copy all detected text">Copy All</button>
      <select class="ocr-tb-select ocr-lang-switch" title="Quick language switch & re-scan">
        <option value="eng">ENG</option>
        <option value="vie+eng">VIE+ENG</option>
        <option value="chi_sim+eng">CHI</option>
        <option value="jpn+eng">JPN</option>
        <option value="kor+eng">KOR</option>
      </select>
      <select class="ocr-tb-select ocr-prep-switch" title="Image preprocessing mode">
        <option value="auto">Pre: Auto</option>
        <option value="contrast">Contrast</option>
        <option value="invert">Invert</option>
        <option value="standard">Raw</option>
      </select>
      <button class="ocr-tb-btn ocr-table-btn" title="Reconstruct rows & columns as Markdown table">Table</button>
      <button class="ocr-tb-btn ocr-translate-btn" title="Translate detected text">Translate</button>
      <button class="ocr-tb-btn ocr-ai-btn" title="Re-scan using Cloud AI Vision">AI</button>
      <button class="ocr-tb-btn ocr-toggle-visible" title="Toggle visible text overlay">Show</button>
      <button class="ocr-tb-btn ocr-close-btn" title="Close overlay">✕</button>
    `;
    wrapper.appendChild(toolbar);

    // Inline drawer for Table / Translate / AI / Entities
    const drawer = document.createElement("div");
    drawer.className = "ocr-overlay-drawer";
    drawer.style.display = "none";
    drawer.innerHTML = `
      <div class="ocr-entities-row" style="display:none;"></div>
      <div class="ocr-drawer-head">
        <span class="ocr-drawer-title">Output</span>
        <div class="ocr-drawer-btns">
          <button class="ocr-tb-btn ocr-drawer-copy-tsv" style="display:none;" type="button">Copy TSV</button>
          <button class="ocr-tb-btn ocr-drawer-copy" type="button">Copy</button>
          <button class="ocr-tb-btn ocr-drawer-close" type="button">✕</button>
        </div>
      </div>
      <textarea class="ocr-drawer-text" spellcheck="false"></textarea>
    `;
    wrapper.appendChild(drawer);

    const langSelect = toolbar.querySelector(".ocr-lang-switch");
    if ([...langSelect.options].some((o) => o.value === activeOpts.lang)) {
      langSelect.value = activeOpts.lang;
    } else {
      const opt = document.createElement("option");
      opt.value = activeOpts.lang;
      opt.textContent = activeOpts.lang.toUpperCase();
      langSelect.appendChild(opt);
      langSelect.value = activeOpts.lang;
    }

    const prepSelect = toolbar.querySelector(".ocr-prep-switch");
    prepSelect.value = activeOpts.preprocessing || "auto";

    langSelect.addEventListener("change", () => {
      processImageOCR(img, { lang: langSelect.value, preprocessing: prepSelect.value }, true);
    });
    prepSelect.addEventListener("change", () => {
      processImageOCR(img, { lang: langSelect.value, preprocessing: prepSelect.value }, true);
    });

    toolbar.querySelector(".ocr-copy-all").addEventListener("click", async () => {
      const ok = await copyText(ocrData.text || "");
      showToast(ok ? "Copied all text to clipboard!" : "Failed to copy to clipboard.", ok ? "success" : "error");
    });

    const drawerTitle = drawer.querySelector(".ocr-drawer-title");
    const drawerArea = drawer.querySelector(".ocr-drawer-text");
    const drawerCopyTsv = drawer.querySelector(".ocr-drawer-copy-tsv");
    const entitiesRow = drawer.querySelector(".ocr-entities-row");
    renderEntityChips(entitiesRow, ocrData.text);

    const openDrawer = (title, content, tsvData = null) => {
      drawerTitle.textContent = title;
      drawerArea.value = content;
      drawerCopyTsv.style.display = tsvData ? "inline-flex" : "none";
      drawerCopyTsv.onclick = async () => {
        const ok = await copyText(tsvData);
        showToast(ok ? "Copied TSV table (paste into Excel/Sheets)!" : "Copy failed.", ok ? "success" : "error");
      };
      drawer.style.display = "block";
    };

    drawer.querySelector(".ocr-drawer-copy").addEventListener("click", async () => {
      const ok = await copyText(drawerArea.value);
      showToast(ok ? "Copied to clipboard!" : "Failed to copy.", ok ? "success" : "error");
    });
    drawer.querySelector(".ocr-drawer-close").addEventListener("click", () => {
      drawer.style.display = "none";
    });

    toolbar.querySelector(".ocr-table-btn").addEventListener("click", () => {
      if (!window.OcrUtils) return;
      const tbl = window.OcrUtils.extractTableFromLines(ocrData.lines);
      openDrawer(
        tbl.isTable ? "Table Structure (Markdown)" : "Structured Lines (Markdown)",
        tbl.markdown || ocrData.text,
        tbl.tsv
      );
    });

    toolbar.querySelector(".ocr-translate-btn").addEventListener("click", async () => {
      openDrawer(`Translating to ${settings.translateTarget || "en"}...`, "Translating...");
      const res = await chrome.runtime.sendMessage({
        action: "TRANSLATE_TEXT",
        text: ocrData.text,
        targetLang: settings.translateTarget || "en"
      });
      if (res?.success) {
        openDrawer(`Translation (${res.detectedLang} → ${settings.translateTarget || "en"})`, res.translatedText);
      } else {
        openDrawer("Translation Error", res?.error || "Translation failed.");
      }
    });

    toolbar.querySelector(".ocr-ai-btn").addEventListener("click", async () => {
      openDrawer("Cloud AI Vision", "Analyzing image with AI Vision...");
      const res = await chrome.runtime.sendMessage({
        action: "CLOUD_VISION_OCR",
        image: imageDataUrl
      });
      if (res?.success) {
        openDrawer("Cloud AI Vision Output", res.text);
        renderEntityChips(entitiesRow, res.text);
        logHistory(res.text, "AI Vision", "image-ai");
      } else {
        openDrawer("AI Vision", res?.error || "Cloud AI Vision failed.");
      }
    });

    let visible = false;
    const toggleBtn = toolbar.querySelector(".ocr-toggle-visible");
    toggleBtn.addEventListener("click", () => {
      visible = !visible;
      wrapper.classList.toggle("mode-visible-text", visible);
      toggleBtn.textContent = visible ? "Hide" : "Show";
    });

    toolbar.querySelector(".ocr-close-btn").addEventListener("click", () => removeOverlay(img));

    // Render word spans per line
    const wordEls = [];
    ocrData.lines.forEach((line) => {
      const lineEl = document.createElement("div");
      lineEl.className = "ocr-text-line";
      const lx = line.bbox.x0, ly = line.bbox.y0;
      lineEl.style.left = `${lx}px`;
      lineEl.style.top = `${ly}px`;
      lineEl.style.width = `${line.bbox.x1 - lx}px`;
      lineEl.style.height = `${line.bbox.y1 - ly}px`;

      line.words.forEach((word, i) => {
        const span = document.createElement("span");
        span.className = "ocr-text-word";
        span.textContent = word.text;
        const h = Math.max(word.bbox.y1 - word.bbox.y0, 8);
        span.style.left = `${word.bbox.x0 - lx}px`;
        span.style.top = `${word.bbox.y0 - ly}px`;
        span.style.height = `${h}px`;
        span.style.lineHeight = `${h}px`;
        span.style.fontSize = `${h * 0.85}px`;
        span.dataset.w = String(word.bbox.x1 - word.bbox.x0);
        lineEl.appendChild(span);
        wordEls.push(span);
        if (i < line.words.length - 1) lineEl.appendChild(document.createTextNode(" "));
      });
      layer.appendChild(lineEl);
    });

    ["mousedown", "mouseup", "click", "dblclick", "pointerdown", "pointerup", "touchstart", "touchend", "keydown"]
      .forEach((t) => wrapper.addEventListener(t, (ev) => ev.stopPropagation()));
    document.body.appendChild(wrapper);

    wordEls.forEach((span) => {
      const target = parseFloat(span.dataset.w);
      const actual = span.offsetWidth;
      if (actual > 0 && target > 0) {
        span.style.transformOrigin = "left top";
        span.style.transform = `scaleX(${target / actual})`;
      }
    });

    let raf = 0;
    const update = () => {
      raf = 0;
      if (!document.body.contains(img)) { removeOverlay(img); return; }
      const r = img.getBoundingClientRect();
      wrapper.style.top = `${r.top}px`;
      wrapper.style.left = `${r.left}px`;
      wrapper.style.width = `${r.width}px`;
      wrapper.style.height = `${r.height}px`;
      layer.style.transform = `scale(${r.width / naturalW}, ${r.height / naturalH})`;
      // Keep toolbar visible if image is near top edge
      toolbar.style.top = r.top < 46 ? "8px" : "-42px";
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();

    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(img);
    const poll = setInterval(schedule, 1000);

    activeOverlays.set(img, {
      remove() {
        window.removeEventListener("resize", schedule);
        window.removeEventListener("scroll", schedule, { capture: true });
        ro.disconnect();
        clearInterval(poll);
        if (raf) cancelAnimationFrame(raf);
        wrapper.remove();
      }
    });
  }

  function removeOverlay(img) {
    const o = activeOverlays.get(img);
    if (o) {
      o.remove();
      activeOverlays.delete(img);
    }
  }

  // ---------- Region Capture (Direct Canvas/Video + DPR-safe Tab Capture) ----------
  let regionActive = false;

  function startRegionSelect() {
    if (regionActive) return;
    regionActive = true;
    prewarm();

    const mask = document.createElement("div");
    mask.className = "ocr-region-mask";
    const box = document.createElement("div");
    box.className = "ocr-region-box";
    box.style.display = "none";
    const hint = document.createElement("div");
    hint.className = "ocr-region-hint";
    hint.textContent = "Drag to select a text region · Esc to cancel";
    mask.append(box, hint);
    document.body.appendChild(mask);

    let startX = 0, startY = 0, dragging = false;

    const cleanup = () => {
      mask.remove();
      document.removeEventListener("keydown", onKey, true);
      regionActive = false;
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(); }
    };
    document.addEventListener("keydown", onKey, true);

    mask.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      box.style.display = "block";
      updateBox(e);
    });
    const updateBox = (e) => {
      const x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
      box.style.left = `${x}px`; box.style.top = `${y}px`;
      box.style.width = `${Math.abs(e.clientX - startX)}px`;
      box.style.height = `${Math.abs(e.clientY - startY)}px`;
    };
    mask.addEventListener("mousemove", (e) => { if (dragging) updateBox(e); });
    mask.addEventListener("mouseup", async (e) => {
      if (!dragging) return;
      dragging = false;
      const rect = {
        x: Math.min(startX, e.clientX), y: Math.min(startY, e.clientY),
        w: Math.abs(e.clientX - startX), h: Math.abs(e.clientY - startY)
      };
      cleanup();
      if (rect.w < 12 || rect.h < 12) {
        showToast("Selected region is too small.", "warning");
        return;
      }
      await ocrRegion(rect);
    });
  }

  // Direct <canvas> / <video> frame crop when selection lies inside a non-tainted element
  function tryDirectMediaCapture(rect) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    for (const el of document.elementsFromPoint(cx, cy)) {
      if (el.tagName !== "CANVAS" && el.tagName !== "VIDEO") continue;
      const b = el.getBoundingClientRect();
      if (
        rect.x >= b.left - 2 &&
        rect.y >= b.top - 2 &&
        rect.x + rect.w <= b.right + 2 &&
        rect.y + rect.h <= b.bottom + 2 &&
        b.width > 0 && b.height > 0
      ) {
        try {
          const natW = el.tagName === "VIDEO" ? el.videoWidth : el.width;
          const natH = el.tagName === "VIDEO" ? el.videoHeight : el.height;
          if (!natW || !natH) continue;
          const sx = natW / b.width;
          const sy = natH / b.height;
          const cropX = Math.max(0, (rect.x - b.left) * sx);
          const cropY = Math.max(0, (rect.y - b.top) * sy);
          const cropW = Math.min(natW - cropX, Math.max(1, rect.w * sx));
          const cropH = Math.min(natH - cropY, Math.max(1, rect.h * sy));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(cropW);
          canvas.height = Math.round(cropH);
          canvas.getContext("2d").drawImage(el, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/png");
        } catch (err) {
          return null; // tainted canvas/video -> fallback to captureVisibleTab
        }
      }
    }
    return null;
  }

  // Ctrl+C on transparent overlay: preserve clean line breaks & spaces
  document.addEventListener("copy", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const layer = anchorEl && anchorEl.closest && anchorEl.closest(".ocr-text-layer");
    if (!layer) return;
    const lines = [];
    layer.querySelectorAll(".ocr-text-line").forEach((lineEl) => {
      const words = [];
      lineEl.querySelectorAll(".ocr-text-word").forEach((w) => {
        if (sel.containsNode(w, true)) words.push(w.textContent);
      });
      if (words.length) lines.push(words.join(" "));
    });
    if (!lines.length) return;
    e.clipboardData.setData("text/plain", lines.join("\n"));
    e.preventDefault();
  }, true);

  async function ocrRegion(rect) {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
    const loader = showLoading({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }, "Capturing region...");
    try {
      let croppedDataUrl = tryDirectMediaCapture(rect);

      if (!croppedDataUrl) {
        const cap = await chrome.runtime.sendMessage({ action: "CAPTURE_VISIBLE_TAB" });
        if (!cap || !cap.success) throw new Error(cap?.error || "Failed to capture visible tab.");
        const full = await loadImage(cap.dataUrl);
        const sx = full.naturalWidth / Math.max(1, window.innerWidth);
        const sy = full.naturalHeight / Math.max(1, window.innerHeight);
        const cropX = Math.max(0, Math.min(full.naturalWidth - 1, Math.round(rect.x * sx)));
        const cropY = Math.max(0, Math.min(full.naturalHeight - 1, Math.round(rect.y * sy)));
        const cropW = Math.max(1, Math.min(full.naturalWidth - cropX, Math.round(rect.w * sx)));
        const cropH = Math.max(1, Math.min(full.naturalHeight - cropY, Math.round(rect.h * sy)));
        const canvas = document.createElement("canvas");
        canvas.width = cropW;
        canvas.height = cropH;
        canvas.getContext("2d").drawImage(full, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        croppedDataUrl = canvas.toDataURL("image/png");
      }

      const raw = await runOCR(croppedDataUrl, loader.updateStatus);
      const result = postProcessResult(raw);

      if (!result.text.trim() && settings.aiAutoFallback && aiConfigured) {
        loader.updateStatus("Running AI Vision fallback...");
        const aiRes = await chrome.runtime.sendMessage({ action: "CLOUD_VISION_OCR", image: croppedDataUrl });
        if (aiRes?.success && aiRes.text?.trim()) {
          loader.remove();
          logHistory(aiRes.text, "AI Vision", "region-ai");
          showResultPanel(rect, { text: aiRes.text, lines: [] }, croppedDataUrl);
          if (settings.autoCopy) await copyText(aiRes.text);
          return;
        }
      }

      loader.remove();
      if (!result.text.trim()) {
        showToast("No text found in the selected region.", "warning");
        return;
      }
      logHistory(result.text, result.langUsed || settings.ocrLanguage, "region");
      showResultPanel(rect, result, croppedDataUrl);
      if (settings.autoCopy) await copyText(result.text);
    } catch (err) {
      console.error("Region OCR error:", err);
      loader.remove();
      showToast("Region OCR failed: " + err.message, "error");
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to decode captured screenshot."));
      img.src = src;
    });
  }

  function showResultPanel(rect, ocrData, imageDataUrl) {
    const panel = document.createElement("div");
    panel.className = "ocr-result-panel";
    panel.innerHTML = `
      <textarea class="ocr-result-text" spellcheck="false"></textarea>
      <div class="ocr-entities-row" style="display:none;"></div>
      ${buildExtrasHtml(Boolean(ocrData.lines?.length))}
      <div class="ocr-result-actions">
        <button class="ocr-tb-btn ocr-table-btn" type="button" title="Format as Markdown / TSV table">Table</button>
        <button class="ocr-tb-btn ocr-translate-btn" type="button" title="Translate extracted text">Translate</button>
        <button class="ocr-tb-btn ocr-ai-btn" type="button" title="Re-scan with Cloud AI Vision">AI</button>
        <button class="ocr-tb-btn ocr-copy-all" type="button">Copy</button>
        <button class="ocr-tb-btn ocr-close-btn" type="button">✕ Close</button>
      </div>`;

    const ta = panel.querySelector(".ocr-result-text");
    ta.value = ocrData.text || "";

    const entitiesRow = panel.querySelector(".ocr-entities-row");
    renderEntityChips(entitiesRow, ta.value);

    const extrasBox = panel.querySelector(".ocr-extras-box");
    const extrasTitle = panel.querySelector(".ocr-extras-title");
    const extrasContent = panel.querySelector(".ocr-extras-content");
    const tableBtn = panel.querySelector(".ocr-table-btn");
    if (!ocrData.lines?.length) tableBtn.style.display = "none";

    document.body.appendChild(panel);

    const pw = 380, ph = 240;
    const left = Math.max(8, Math.min(rect.x ?? rect.left ?? 16, window.innerWidth - pw - 8));
    const baseBottom = (rect.y ?? rect.top ?? 16) + (rect.h ?? rect.height ?? 40);
    let top = baseBottom + 8;
    if (top + ph > window.innerHeight) top = Math.max(8, (rect.y ?? rect.top ?? 40) - ph - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;

    panel.querySelector(".ocr-extras-copy").addEventListener("click", async () => {
      const ok = await copyText(extrasContent.textContent);
      showToast(ok ? "Copied to clipboard!" : "Failed to copy.", ok ? "success" : "error");
    });
    panel.querySelector(".ocr-extras-close").addEventListener("click", () => {
      extrasBox.style.display = "none";
    });

    tableBtn.addEventListener("click", () => {
      if (!window.OcrUtils) return;
      const tbl = window.OcrUtils.extractTableFromLines(ocrData.lines);
      extrasTitle.textContent = tbl.isTable ? "Table (Markdown)" : "Structured Lines";
      extrasContent.textContent = tbl.markdown || ta.value;
      extrasBox.style.display = "block";
    });

    panel.querySelector(".ocr-translate-btn").addEventListener("click", async () => {
      extrasTitle.textContent = `Translating (${settings.translateTarget || "en"})...`;
      extrasContent.textContent = "Translating...";
      extrasBox.style.display = "block";
      const res = await chrome.runtime.sendMessage({
        action: "TRANSLATE_TEXT",
        text: ta.value,
        targetLang: settings.translateTarget || "en"
      });
      if (res?.success) {
        extrasTitle.textContent = `Translation (${res.detectedLang} → ${settings.translateTarget || "en"})`;
        extrasContent.textContent = res.translatedText;
      } else {
        extrasTitle.textContent = "Translation Error";
        extrasContent.textContent = res?.error || "Translation failed.";
      }
    });

    panel.querySelector(".ocr-ai-btn").addEventListener("click", async () => {
      if (!imageDataUrl) return;
      extrasTitle.textContent = "Cloud AI Vision";
      extrasContent.textContent = "Processing with AI Vision...";
      extrasBox.style.display = "block";
      const res = await chrome.runtime.sendMessage({ action: "CLOUD_VISION_OCR", image: imageDataUrl });
      if (res?.success) {
        ta.value = res.text;
        renderEntityChips(entitiesRow, res.text);
        logHistory(res.text, "AI Vision", "region-ai");
        extrasBox.style.display = "none";
        showToast("Updated with Cloud AI Vision output.", "success");
      } else {
        extrasTitle.textContent = "AI Vision";
        extrasContent.textContent = res?.error || "AI Vision failed.";
      }
    });

    panel.querySelector(".ocr-copy-all").addEventListener("click", async () => {
      const ok = await copyText(ta.value);
      showToast(ok ? "Copied to clipboard!" : "Failed to copy to clipboard.", ok ? "success" : "error");
    });
    panel.querySelector(".ocr-close-btn").addEventListener("click", () => panel.remove());
    ta.focus();
    ta.select();
  }

  // ---------- Batch / Full-Page Image Scan (v2.0) ----------
  let batchCancelled = false;

  async function startBatchScan() {
    const imgs = Array.from(document.querySelectorAll("img")).filter((img) => {
      const r = img.getBoundingClientRect();
      return img.complete && img.naturalWidth > 0 && r.width >= 120 && r.height >= 60;
    });

    if (!imgs.length) {
      showToast("No qualifying images (>= 120x60) found on this page.", "warning");
      return;
    }

    batchCancelled = false;
    const existing = document.querySelector(".ocr-batch-panel");
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.className = "ocr-batch-panel";
    panel.innerHTML = `
      <div class="ocr-batch-head">
        <div>
          <div class="ocr-batch-title">Batch Page OCR</div>
          <div class="ocr-batch-status">Scanning 0 / ${imgs.length} images...</div>
        </div>
        <button class="ocr-tb-btn ocr-close-btn" type="button">✕</button>
      </div>
      <div class="ocr-batch-bar"><div class="ocr-batch-fill"></div></div>
      <textarea class="ocr-batch-output" spellcheck="false" placeholder="Extracted text from page images will appear here..."></textarea>
      <div class="ocr-batch-actions">
        <button class="ocr-tb-btn ocr-batch-md" type="button">Export .md</button>
        <button class="ocr-tb-btn ocr-batch-csv" type="button">Export .csv</button>
        <button class="ocr-tb-btn ocr-copy-all" type="button">Copy All</button>
      </div>
    `;
    document.body.appendChild(panel);

    const statusEl = panel.querySelector(".ocr-batch-status");
    const fillEl = panel.querySelector(".ocr-batch-fill");
    const outEl = panel.querySelector(".ocr-batch-output");

    panel.querySelector(".ocr-close-btn").addEventListener("click", () => {
      batchCancelled = true;
      panel.remove();
    });

    const entries = [];
    for (let i = 0; i < imgs.length; i++) {
      if (batchCancelled) return;
      statusEl.textContent = `Scanning ${i + 1} / ${imgs.length}...`;
      fillEl.style.width = `${Math.round(((i + 1) / imgs.length) * 100)}%`;
      try {
        const dataUrl = await getImageDataUrl(imgs[i]);
        const raw = await runOCR(dataUrl, null);
        const res = postProcessResult(raw);
        if (res.text.trim()) {
          entries.push({
            index: i + 1,
            alt: imgs[i].alt || `Image #${i + 1}`,
            src: imgs[i].currentSrc || imgs[i].src,
            text: res.text
          });
          outEl.value = entries.map((e) => `## ${e.alt}\n${e.text}`).join("\n\n");
        }
      } catch (e) {
        /* skip failed cross-origin or unreadable image */
      }
    }

    if (batchCancelled) return;
    statusEl.textContent = `Completed: extracted text from ${entries.length} / ${imgs.length} images.`;
    if (entries.length) {
      logHistory(outEl.value, resolveLanguage(settings.ocrLanguage), "batch");
    }

    panel.querySelector(".ocr-copy-all").addEventListener("click", async () => {
      const ok = await copyText(outEl.value);
      showToast(ok ? "Copied batch output!" : "Copy failed.", ok ? "success" : "error");
    });

    panel.querySelector(".ocr-batch-md").addEventListener("click", () => {
      const md = `# Page OCR Export — ${document.title}\nSource: ${location.href}\n\n` +
        entries.map((e) => `## ${e.index}. ${e.alt}\n\n${e.text}`).join("\n\n---\n\n");
      downloadTextFile("page-ocr-export.md", md, "text/markdown");
    });

    panel.querySelector(".ocr-batch-csv").addEventListener("click", () => {
      const esc = window.OcrUtils ? window.OcrUtils.escapeCsvCell : (v) => `"${String(v).replace(/"/g, '""')}"`;
      const csv = ["ImageIndex,Alt,Source,ExtractedText"]
        .concat(entries.map((e) => [e.index, e.alt, e.src, e.text].map(esc).join(",")))
        .join("\n");
      downloadTextFile("page-ocr-export.csv", csv, "text/csv");
    });
  }

  function downloadTextFile(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- Loading & Toast ----------
  function showLoading(rect, initialText) {
    const box = document.createElement("div");
    box.className = "ocr-loader-container";
    box.style.position = "fixed";
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.top = `${rect.top}px`;
    box.style.left = `${rect.left}px`;
    box.innerHTML = `<div class="ocr-spinner"></div><div class="ocr-status-text"></div>`;
    box.querySelector(".ocr-status-text").textContent = initialText;
    document.body.appendChild(box);
    return {
      updateStatus(txt) {
        const el = box.querySelector(".ocr-status-text");
        if (el) el.textContent = txt;
      },
      remove() { box.remove(); }
    };
  }

  function showToast(message, type = "info") {
    let container = document.querySelector(".ocr-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "ocr-toast-container";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = `ocr-toast-item ocr-toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("fade-out");
      setTimeout(() => toast.remove(), 400);
    }, 3200);
  }
})();
