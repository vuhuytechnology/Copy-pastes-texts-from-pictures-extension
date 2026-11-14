// content.js - Tương tác DOM, gọi OCR (qua background/offscreen), dựng lớp chữ bôi đen, quét theo vùng chọn

(() => {
  if (window.__imageTextSelectorLoaded) return;
  window.__imageTextSelectorLoaded = true;

  let lastRightClickedElement = null;
  const activeOverlays = new Map(); // Map<img, { remove() }>
  const progressHandlers = new Map(); // jobId -> callback
  let settings = { ocrLanguage: "vie+eng", ocrQuality: "fast", showHoverButton: true, autoCopy: false };
  const resultCache = new Map(); // "src|lang|quality" -> kết quả OCR (mở lại ảnh là có ngay)
  let lastPrewarm = 0;
  let jobCounter = 0;

  // ---------- Cài đặt ----------
  chrome.storage.sync.get(settings, (items) => { settings = { ...settings, ...items }; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    if (!settings.showHoverButton) hideHoverButton();
  });

  // Khởi động sẵn engine OCR khi người dùng sắp dùng tới => bấm quét là chạy ngay
  function prewarm() {
    const now = Date.now();
    if (now - lastPrewarm < 4 * 60 * 1000) return;
    lastPrewarm = now;
    chrome.runtime.sendMessage({
      action: "OCR_PREWARM",
      lang: settings.ocrLanguage || "vie+eng",
      quality: settings.ocrQuality || "fast"
    }).catch(() => {});
  }

  document.addEventListener("contextmenu", (e) => { lastRightClickedElement = e.target; }, true);

  // ---------- Nhận lệnh từ background ----------
  chrome.runtime.onMessage.addListener((request) => {
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
        else showToast("Không tìm thấy ảnh tương ứng trên trang để quét chữ.", "warning");
        break;
      }
      case "START_REGION_SELECT":
        if (window === window.top) startRegionSelect();
        break;
      case "OCR_PROGRESS": {
        const cb = progressHandlers.get(request.jobId);
        if (cb) cb(request);
        break;
      }
    }
  });

  // ---------- Nút hover trên ảnh ----------
  let hoverBtn = null;
  let currentHoverImg = null;

  function hideHoverButton() {
    if (hoverBtn) hoverBtn.style.display = "none";
  }

  // Tìm ảnh nằm dưới con trỏ, kể cả khi bị lớp phủ khác (lightbox, thanh công cụ...) che bên trên
  function findImageAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.classList && [...el.classList].some((c) => c.startsWith("ocr-"))) continue;
      if (el.tagName === "IMG" && el.clientWidth >= 120 && el.clientHeight >= 60) return el;
    }
    return null;
  }

  let hoverRaf = 0;
  document.addEventListener("mousemove", (e) => {
    if (!settings.showHoverButton || hoverRaf) return;
    const x = e.clientX, y = e.clientY;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (hoverBtn && hoverBtn.style.display !== "none" && currentHoverImg) {
        const b = hoverBtn.getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return; // đang trỏ vào nút
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
    hoverBtn.textContent = "📝 Bôi đen chữ";
    hoverBtn.title = "Bật chế độ bôi đen và copy chữ trên ảnh này";
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

  // ---------- OCR ----------
  const STATUS_TEXT = {
    "loading": "Đang khởi động engine OCR...",
    "loading tesseract core": "Đang nạp engine OCR...",
    "initializing tesseract": "Đang khởi tạo...",
    "loading language traineddata": "Đang nạp dữ liệu ngôn ngữ...",
    "loaded language traineddata": "Đang nạp dữ liệu ngôn ngữ...",
    "initializing api": "Đang khởi tạo...",
    "initialized api": "Đang khởi tạo..."
  };

  async function runOCR(imageDataUrl, onStatus) {
    const jobId = `job-${Date.now()}-${++jobCounter}`;
    progressHandlers.set(jobId, (p) => {
      if (!onStatus) return;
      if (p.status === "recognizing text") onStatus(`Đang nhận diện: ${Math.round((p.progress || 0) * 100)}%`);
      else if (STATUS_TEXT[p.status]) onStatus(STATUS_TEXT[p.status]);
    });
    try {
      const res = await chrome.runtime.sendMessage({
        action: "OCR_RECOGNIZE",
        jobId,
        image: imageDataUrl,
        lang: settings.ocrLanguage || "vie+eng",
        quality: settings.ocrQuality || "fast"
      });
      if (!res || !res.success) throw new Error(res?.error || "Engine OCR không phản hồi.");
      lastPrewarm = Date.now();
      console.debug("[Image Text Selector] OCR timings (ms):", res.result.timings);
      return res.result;
    } finally {
      progressHandlers.delete(jobId);
    }
  }

  function imageToDataUrlViaCanvas(img) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/png"); // ném lỗi nếu canvas bị tainted
  }

  async function getImageDataUrl(img) {
    const src = img.currentSrc || img.src;
    if (src.startsWith("data:")) return src;
    // blob: chỉ đọc được từ trang; ảnh cùng origin cũng vẽ canvas được
    try {
      return imageToDataUrlViaCanvas(img);
    } catch (e) { /* tainted -> fetch qua background */ }
    const response = await chrome.runtime.sendMessage({ action: "FETCH_IMAGE_AS_BASE64", url: src });
    if (response && response.success) return response.base64;
    throw new Error("Không tải được dữ liệu ảnh" + (response?.error ? `: ${response.error}` : "."));
  }

  async function processImageOCR(img) {
    if (activeOverlays.has(img)) {
      showToast("Lớp bôi đen chữ trên ảnh này đã được bật rồi!", "info");
      return;
    }
    const loader = showLoading(img.getBoundingClientRect(), "Đang nạp ảnh...");
    try {
      const cacheKey = `${img.currentSrc || img.src}|${settings.ocrLanguage}|${settings.ocrQuality}`;
      let result = resultCache.get(cacheKey);
      if (!result) {
        const dataUrl = await getImageDataUrl(img);
        loader.updateStatus("Đang khởi động engine OCR...");
        result = await runOCR(dataUrl, loader.updateStatus);
        if (cacheKey.length < 2000) {
          if (resultCache.size >= 30) resultCache.delete(resultCache.keys().next().value);
          resultCache.set(cacheKey, result);
        }
      }
      loader.remove();

      if (!result.lines.length) {
        showToast("Không tìm thấy văn bản nào trong ảnh này.", "warning");
        return;
      }
      renderTextOverlay(img, result);
      const wordCount = result.lines.reduce((n, l) => n + l.words.length, 0);
      if (settings.autoCopy) {
        await copyText(result.text);
        showToast(`Đã nhận diện ${wordCount} từ và tự động copy vào clipboard.`, "success");
      } else {
        showToast(`Đã nhận diện ${wordCount} từ. Quét chuột bôi đen để copy!`, "success");
      }
    } catch (error) {
      console.error("Lỗi OCR:", error);
      loader.remove();
      showToast("Lỗi khi quét ảnh: " + error.message, "error");
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

  // ---------- Lớp phủ chữ ----------
  function renderTextOverlay(img, ocrData) {
    const naturalW = ocrData.width || img.naturalWidth;
    const naturalH = ocrData.height || img.naturalHeight;

    // wrapper khớp kích thước ảnh trên màn hình
    const wrapper = document.createElement("div");
    wrapper.className = "ocr-text-overlay-container";

    // lớp chữ theo kích thước thật của ảnh, được co giãn bằng transform
    const layer = document.createElement("div");
    layer.className = "ocr-text-layer";
    layer.style.width = `${naturalW}px`;
    layer.style.height = `${naturalH}px`;
    wrapper.appendChild(layer);

    const toolbar = document.createElement("div");
    toolbar.className = "ocr-overlay-toolbar";
    toolbar.innerHTML = `
      <button class="ocr-tb-btn ocr-copy-all" title="Sao chép toàn bộ văn bản trong ảnh">📋 Copy toàn bộ</button>
      <button class="ocr-tb-btn ocr-toggle-visible" title="Chuyển chế độ chữ ẩn / hiện rõ">👁️ Hiện chữ</button>
      <button class="ocr-tb-btn ocr-close-btn" title="Đóng lớp bôi đen">✕</button>
    `;
    wrapper.appendChild(toolbar);

    toolbar.querySelector(".ocr-copy-all").addEventListener("click", async () => {
      const ok = await copyText(ocrData.text || "");
      showToast(ok ? "Đã copy toàn bộ văn bản vào bộ nhớ tạm!" : "Không thể copy vào clipboard.", ok ? "success" : "error");
    });

    let visible = false;
    const toggleBtn = toolbar.querySelector(".ocr-toggle-visible");
    toggleBtn.addEventListener("click", () => {
      visible = !visible;
      wrapper.classList.toggle("mode-visible-text", visible);
      toggleBtn.textContent = visible ? "🕶️ Chữ trong suốt" : "👁️ Hiện chữ";
    });

    toolbar.querySelector(".ocr-close-btn").addEventListener("click", () => removeOverlay(img));

    // Mỗi dòng là một block => Ctrl+C giữ nguyên xuống dòng
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

    ["mousedown", "mouseup", "click", "dblclick", "pointerdown", "pointerup", "touchstart", "touchend"]
      .forEach((t) => wrapper.addEventListener(t, (ev) => ev.stopPropagation()));
    document.body.appendChild(wrapper);

    // Co giãn ngang từng từ cho khít khung chữ gốc => vùng bôi đen khớp chữ trong ảnh
    wordEls.forEach((span) => {
      const target = parseFloat(span.dataset.w);
      const actual = span.offsetWidth;
      if (actual > 0 && target > 0) {
        span.style.transformOrigin = "left top";
        span.style.transform = `scaleX(${target / actual})`;
      }
    });

    // Đồng bộ vị trí/kích thước với ảnh
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
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();

    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(img);
    const poll = setInterval(schedule, 1000); // bắt các thay đổi bố cục không phát sự kiện

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

  // ---------- Quét theo vùng chọn (ảnh nền, canvas, video, ảnh chụp...) ----------
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
    hint.textContent = "Kéo chuột để chọn vùng chứa chữ · Esc để huỷ";
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
        showToast("Vùng chọn quá nhỏ.", "warning");
        return;
      }
      await ocrRegion(rect);
    });
  }

  // Ctrl+C trên lớp chữ: tự ghép text theo từ/dòng để luôn có dấu cách và xuống dòng chuẩn
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
    // chờ trình duyệt vẽ lại để lớp phủ chọn vùng biến mất khỏi ảnh chụp
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
    const loader = showLoading({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }, "Đang chụp vùng chọn...", true);
    try {
      const cap = await chrome.runtime.sendMessage({ action: "CAPTURE_VISIBLE_TAB" });
      if (!cap || !cap.success) throw new Error(cap?.error || "Không chụp được màn hình.");

      const full = await loadImage(cap.dataUrl);
      const sx = full.naturalWidth / window.innerWidth;
      const sy = full.naturalHeight / window.innerHeight;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(rect.w * sx);
      canvas.height = Math.round(rect.h * sy);
      canvas.getContext("2d").drawImage(full, rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy, 0, 0, canvas.width, canvas.height);

      const result = await runOCR(canvas.toDataURL("image/png"), loader.updateStatus);
      loader.remove();

      if (!result.text.trim()) {
        showToast("Không tìm thấy văn bản trong vùng đã chọn.", "warning");
        return;
      }
      showResultPanel(rect, result.text);
      if (settings.autoCopy) await copyText(result.text);
    } catch (err) {
      console.error("Lỗi OCR vùng chọn:", err);
      loader.remove();
      showToast("Lỗi khi quét vùng chọn: " + err.message, "error");
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Không đọc được ảnh chụp màn hình."));
      img.src = src;
    });
  }

  function showResultPanel(rect, text) {
    const panel = document.createElement("div");
    panel.className = "ocr-result-panel";
    panel.innerHTML = `
      <textarea class="ocr-result-text" spellcheck="false"></textarea>
      <div class="ocr-result-actions">
        <button class="ocr-tb-btn ocr-copy-all">📋 Copy</button>
        <button class="ocr-tb-btn ocr-close-btn">✕ Đóng</button>
      </div>`;
    const ta = panel.querySelector("textarea");
    ta.value = text;
    document.body.appendChild(panel);

    const pw = 340, ph = 190;
    const left = Math.max(8, Math.min(rect.x, window.innerWidth - pw - 8));
    let top = rect.y + rect.h + 8;
    if (top + ph > window.innerHeight) top = Math.max(8, rect.y - ph - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;

    panel.querySelector(".ocr-copy-all").addEventListener("click", async () => {
      const ok = await copyText(ta.value);
      showToast(ok ? "Đã copy văn bản!" : "Không thể copy vào clipboard.", ok ? "success" : "error");
    });
    panel.querySelector(".ocr-close-btn").addEventListener("click", () => panel.remove());
    ta.focus();
    ta.select();
  }

  // ---------- Loading & Toast ----------
  function showLoading(rect, initialText, fixed = false) {
    const box = document.createElement("div");
    box.className = "ocr-loader-container";
    box.style.position = "fixed";
    const offX = 0, offY = 0;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.top = `${rect.top + offY}px`;
    box.style.left = `${rect.left + offX}px`;
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
