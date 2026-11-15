// offscreen.js - Tesseract OCR v7 worker pool, adaptive preprocessing, and smart noise filtering

const BUNDLED_LANGS = new Set(["eng", "vie"]);
const REMOTE_LANG_PATH = {
  fast: "https://tessdata.projectnaptha.com/4.0.0_fast",
  best: "https://tessdata.projectnaptha.com/4.0.0"
};
const IDLE_TERMINATE_MS = 5 * 60 * 1000;
const BIG_TEXT_PASS_SIDE = 420;
const MAX_WORKERS = 2;

const workerPool = new Map(); // key -> { worker, lastUsed }
const workerPromises = new Map(); // key -> Promise<worker>
let idleTimer = null;
let currentJobId = null;
let queue = Promise.resolve();

function sendProgress(status, progress) {
  if (!currentJobId) return;
  chrome.runtime.sendMessage({
    target: "background",
    action: "OCR_PROGRESS",
    jobId: currentJobId,
    status,
    progress: progress || 0
  }).catch(() => {});
}

async function disposeAllWorkers() {
  const entries = [...workerPool.values()];
  workerPool.clear();
  workerPromises.clear();
  for (const entry of entries) {
    try { await entry.worker.terminate(); } catch (e) { /* ignore */ }
  }
}

async function evictOldestWorkerIfNeeded() {
  while (workerPool.size >= MAX_WORKERS) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of workerPool.entries()) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    const entry = workerPool.get(oldestKey);
    workerPool.delete(oldestKey);
    try { await entry.worker.terminate(); } catch (e) { /* ignore */ }
  }
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(disposeAllWorkers, IDLE_TERMINATE_MS);
}

async function getWorker(lang, quality) {
  const key = `${lang}|${quality}`;
  const cached = workerPool.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.worker;
  }
  if (workerPromises.has(key)) return workerPromises.get(key);

  if (workerPool.size > 0) sendProgress("switching", 0);
  await evictOldestWorkerIfNeeded();

  const allLocal = lang.split("+").every((l) => BUNDLED_LANGS.has(l));
  const promise = Tesseract.createWorker(lang, 1, {
    workerPath: chrome.runtime.getURL("libs/worker.min.js"),
    corePath: chrome.runtime.getURL("libs/core"),
    langPath: allLocal ? chrome.runtime.getURL(`libs/lang/${quality}`) : REMOTE_LANG_PATH[quality],
    cachePath: quality,
    cacheMethod: allLocal ? "none" : "write",
    workerBlobURL: false,
    logger: (m) => sendProgress(m.status, m.progress)
  }).then((w) => {
    workerPool.set(key, { worker: w, lastUsed: Date.now() });
    workerPromises.delete(key);
    return w;
  }).catch((err) => {
    workerPromises.delete(key);
    throw err;
  });

  workerPromises.set(key, promise);
  return promise;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image data."));
    img.src = src;
  });
}

function renderScaledImageData(img, scale) {
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function toGrayscale(imageData) {
  const { width: w, height: h, data } = imageData;
  const len = w * h;
  const gray = new Uint8Array(len);
  let sum = 0;
  let darkCount = 0;
  const hist = new Uint32Array(256);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    gray[p] = g;
    sum += g;
    if (g < 105) darkCount++;
    hist[g]++;
  }

  return {
    w,
    h,
    gray,
    hist,
    mean: sum / Math.max(1, len),
    darkRatio: darkCount / Math.max(1, len)
  };
}

function contrastStretch(gray, hist) {
  const total = gray.length;
  const lowCut = total * 0.02;
  const highCut = total * 0.98;
  let acc = 0, minVal = 0, maxVal = 255;

  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= lowCut) { minVal = i; break; }
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += hist[i];
    if (acc >= total - highCut) { maxVal = i; break; }
  }

  const range = maxVal - minVal;
  if (range < 24) return new Uint8Array(gray);

  const out = new Uint8Array(total);
  const scale = 255 / range;
  for (let i = 0; i < total; i++) {
    const v = (gray[i] - minVal) * scale;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return out;
}

function invertGray(gray) {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = 255 - gray[i];
  return out;
}

/**
 * Fast integral-image adaptive threshold (Bradley-style) to isolate light text on dark/colored pills.
 * Returns a binarized inverted-safe buffer where foreground text is dark on white.
 */
function adaptiveBinarize(gray, w, h, invert = false) {
  const src = invert ? invertGray(gray) : gray;
  const integral = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      rowSum += src[rowOff + x];
      integral[rowOff + x] = (y > 0 ? integral[(y - 1) * w + x] : 0) + rowSum;
    }
  }

  const out = new Uint8Array(w * h);
  const s = Math.max(12, Math.round(Math.min(w, h) / 24));
  const half = s >> 1;
  const t = 0.12; // 12% darker than local neighborhood

  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(w - 1, x + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[y2 * w + x2] -
        (y1 > 0 ? integral[(y1 - 1) * w + x2] : 0) -
        (x1 > 0 ? integral[y2 * w + (x1 - 1)] : 0) +
        (y1 > 0 && x1 > 0 ? integral[(y1 - 1) * w + (x1 - 1)] : 0);
      const idx = y * w + x;
      out[idx] = src[idx] * count < sum * (1 - t) ? 0 : 255;
    }
  }
  return out;
}

function encodeGrayToPgm(gray, w, h) {
  const NL = String.fromCharCode(10);
  const head = new TextEncoder().encode("P5" + NL + w + " " + h + NL + "255" + NL);
  const out = new Uint8Array(head.length + w * h);
  out.set(head);
  out.set(gray, head.length);
  return new Blob([out], { type: "image/x-portable-graymap" });
}

function isAllowedWord(w, smartFilter) {
  const txt = (w.text || "").trim();
  if (!txt) return false;
  const bw = w.bbox ? w.bbox.x1 - w.bbox.x0 : 10;
  const bh = w.bbox ? w.bbox.y1 - w.bbox.y0 : 10;
  if (bw < 3 || bh < 5) return false;

  const conf = w.confidence || 0;
  if (!smartFilter) return conf >= 25;

  // Reject pure symbol/punctuation noise unless very high confidence or meaningful currency/operator
  const hasAlnum = /[\p{L}\p{N}]/u.test(txt);
  if (!hasAlnum) {
    const usefulSymbol = /^[$€£¥₫+\-–—&%/:°]+$/.test(txt);
    return usefulSymbol ? conf >= 55 : conf >= 82;
  }

  // Reject tiny 1-2 character low-confidence artifacts (e.g., icon fragments like "Kx", "Q", "@)")
  if (txt.length <= 2 && conf < 52 && !/^\d+$/.test(txt)) {
    return false;
  }

  return conf >= 36;
}

function cleanLineWords(words, smartFilter) {
  if (!smartFilter || !words.length) return words;
  const cleaned = [...words];
  // Trim leading/trailing pure-bracket or stray icon words
  const isTrailingArtifact = (t) => /^(?:[@©®™]\)|[\]\)}]+|[\(\[{]+|[\\/|;:•·*])$/.test(t);
  while (cleaned.length > 1 && isTrailingArtifact(cleaned[cleaned.length - 1].text.trim())) {
    cleaned.pop();
  }
  while (cleaned.length > 1 && isTrailingArtifact(cleaned[0].text.trim())) {
    cleaned.shift();
  }
  return cleaned;
}

function isNoiseLine(words, smartFilter) {
  if (!words.length) return true;
  const joined = words.map((w) => w.text).join(" ").trim();
  if (!joined) return true;
  const alnum = (joined.match(/[\p{L}\p{N}]/gu) || []).length;
  if (alnum === 0) return true;
  if (!smartFilter) return false;

  const avgConf = words.reduce((s, w) => s + (w.confidence || 0), 0) / words.length;
  if (joined.length <= 3 && avgConf < 58 && !/^\d+([.,]\d+)?%?$/.test(joined)) return true;

  const sym = (joined.match(/[\[\]\(\)\{\}\\<>~`^_*|@]/g) || []).length;
  if (sym >= 2 && avgConf < 68 && sym / joined.length > 0.25) return true;

  if (words.length >= 2 && words.every((w) => w.text.length <= 2) && avgConf < 65) return true;
  return false;
}

function extractLines(data, scale, smartFilter) {
  const norm = (b) => ({ x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale });
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        let words = (line.words || [])
          .filter((w) => isAllowedWord(w, smartFilter))
          .map((w) => ({ text: w.text.trim(), bbox: norm(w.bbox), confidence: w.confidence }));
        words = cleanLineWords(words, smartFilter);
        if (words.length && !isNoiseLine(words, smartFilter)) {
          out.push({ bbox: norm(line.bbox), words, confidence: line.confidence });
        }
      }
    }
  }
  return out;
}

function overlapRatio(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
}

function mergeExtraLines(lines, extraLines, minConf = 62) {
  for (const l of extraLines) {
    if ((l.confidence || 0) < minConf) continue;
    const overlaps = lines.some(
      (m) => overlapRatio(l.bbox, m.bbox) > 0.15 || overlapRatio(m.bbox, l.bbox) > 0.45
    );
    if (overlaps) continue;
    let i = lines.findIndex((m) => m.bbox.y0 > l.bbox.y0);
    if (i < 0) i = lines.length;
    lines.splice(i, 0, l);
  }
}

async function recognize(image, lang, quality, preprocessing = "auto", smartFilter = true) {
  clearTimeout(idleTimer);
  const t0 = performance.now();
  const img = await loadImage(image);
  const width = img.naturalWidth, height = img.naturalHeight;
  const maxSide = Math.max(width, height);

  let scale = 1;
  if (maxSide < 1000) scale = Math.min(3, 1600 / maxSide);
  else if (maxSide > 2600) scale = 2600 / maxSide;

  const scaledImgData = renderScaledImageData(img, scale);
  const { w, h, gray, hist, mean, darkRatio } = toGrayscale(scaledImgData);

  let primaryBuf;
  if (preprocessing === "standard") {
    primaryBuf = gray;
  } else if (preprocessing === "contrast") {
    primaryBuf = contrastStretch(gray, hist);
  } else if (preprocessing === "invert") {
    primaryBuf = invertGray(contrastStretch(gray, hist));
  } else {
    // auto: normalize contrast and invert if predominantly dark background
    const stretched = contrastStretch(gray, hist);
    primaryBuf = mean < 110 ? invertGray(stretched) : stretched;
  }

  const primaryPgm = encodeGrayToPgm(primaryBuf, w, h);
  const tPrep = performance.now();

  sendProgress("loading", 0);
  const worker = await getWorker(lang, quality);
  const tWorker = performance.now();

  const output = { text: false, blocks: true };
  const { data } = await worker.recognize(primaryPgm, {}, output);
  const lines = extractLines(data, scale, smartFilter);

  // Secondary inverted/adaptive pass in "auto" mode to catch white text on dark/colored pills & buttons
  const shouldRunInvertedPass =
    preprocessing === "auto" &&
    mean >= 110 &&
    darkRatio >= 0.06 &&
    darkRatio <= 0.88 &&
    (quality === "best" || lines.length < 25);

  if (shouldRunInvertedPass) {
    currentJobId = null;
    const invAdaptive = adaptiveBinarize(gray, w, h, true);
    const invRes = await worker.recognize(encodeGrayToPgm(invAdaptive, w, h), {}, output);
    const extraInv = extractLines(invRes.data, scale, smartFilter);
    mergeExtraLines(lines, extraInv, 62);
  }

  // Secondary downscaled pass for oversized headlines missed in pass 1
  if (maxSide * scale >= 900) {
    const s2 = BIG_TEXT_PASS_SIDE / maxSide;
    const smallData = renderScaledImageData(img, s2);
    const sg = toGrayscale(smallData);
    const smallBuf =
      preprocessing === "invert" || (preprocessing === "auto" && sg.mean < 110)
        ? invertGray(contrastStretch(sg.gray, sg.hist))
        : contrastStretch(sg.gray, sg.hist);
    currentJobId = null;
    const r2 = await worker.recognize(encodeGrayToPgm(smallBuf, sg.w, sg.h), {}, output);
    const minH = 0.05 * height;
    const bigLines = extractLines(r2.data, s2, smartFilter).filter(
      (l) => l.bbox.y1 - l.bbox.y0 >= minH
    );
    mergeExtraLines(lines, bigLines, 75);
  }

  const text = lines.map((l) => l.words.map((x) => x.text).join(" ")).join("\n");
  armIdleTimer();
  const tEnd = performance.now();
  return {
    text,
    lines,
    width,
    height,
    timings: {
      prepare: Math.round(tPrep - t0),
      engine: Math.round(tWorker - tPrep),
      recognize: Math.round(tEnd - tWorker)
    }
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return;

  if (msg.action === "OCR_PREWARM") {
    queue = queue.then(async () => {
      try {
        currentJobId = null;
        await getWorker(msg.lang, msg.quality || "fast");
        armIdleTimer();
      } catch (e) { /* surfaced on actual scan */ }
    });
    return;
  }

  if (msg.action === "OCR_RECOGNIZE") {
    queue = queue.then(async () => {
      currentJobId = msg.jobId;
      try {
        const result = await recognize(
          msg.image,
          msg.lang,
          msg.quality || "fast",
          msg.preprocessing || "auto",
          msg.smartFilter !== false
        );
        sendResponse({ success: true, result });
      } catch (err) {
        console.error("OCR error:", err);
        await disposeAllWorkers();
        sendResponse({ success: false, error: err.message || String(err) });
      } finally {
        currentJobId = null;
      }
    });
    return true;
  }
});
