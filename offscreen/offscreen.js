// offscreen.js - Chạy Tesseract OCR (v7) trong trang của extension.
// Worker được giữ "nóng" giữa các lần quét để không phải khởi tạo lại.

const BUNDLED_LANGS = new Set(["eng", "vie"]);
const REMOTE_LANG_PATH = {
  fast: "https://tessdata.projectnaptha.com/4.0.0_fast",
  best: "https://tessdata.projectnaptha.com/4.0.0"
};
const IDLE_TERMINATE_MS = 5 * 60 * 1000;
const BIG_TEXT_PASS_SIDE = 420; // cạnh dài của ảnh thu nhỏ dùng để bắt chữ cỡ rất lớn

let worker = null;
let workerKey = null;
let workerPromise = null;
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

async function disposeWorker() {
  const w = worker;
  worker = null;
  workerKey = null;
  workerPromise = null;
  if (w) {
    try { await w.terminate(); } catch (e) { /* ignore */ }
  }
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(disposeWorker, IDLE_TERMINATE_MS);
}

async function getWorker(lang, quality) {
  const key = `${lang}|${quality}`;
  if (worker && workerKey === key) return worker;
  if (workerPromise && workerKey === key) return workerPromise;
  await disposeWorker();

  const allLocal = lang.split("+").every((l) => BUNDLED_LANGS.has(l));
  workerKey = key;
  workerPromise = Tesseract.createWorker(lang, 1, {
    workerPath: chrome.runtime.getURL("libs/worker.min.js"),
    corePath: chrome.runtime.getURL("libs/core"),
    langPath: allLocal ? chrome.runtime.getURL(`libs/lang/${quality}`) : REMOTE_LANG_PATH[quality],
    cachePath: quality, // tách cache IndexedDB giữa bộ "fast" và "best"
    cacheMethod: allLocal ? "none" : "write",
    workerBlobURL: false,
    logger: (m) => sendProgress(m.status, m.progress)
  }).then((w) => {
    if (workerKey === key) worker = w;
    return w;
  });
  try {
    return await workerPromise;
  } catch (e) {
    workerKey = null;
    workerPromise = null;
    throw e;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image data."));
    img.src = src;
  });
}

// Trả về ảnh đã co giãn dưới dạng Blob PGM (ảnh xám, không nén).
// - canvas.toBlob()/convertToBlob() trong trang ẩn (offscreen document) bị trình duyệt trì hoãn
//   ~1 giây mỗi lần gọi, nên tự đóng gói từ getImageData() (chạy ngay lập tức).
// - PGM được Tesseract đọc trực tiếp, không tốn thời gian giải nén (BMP lại rơi vào nhánh xử lý chậm).
function drawScaled(img, scale) {
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff"; // ảnh PNG trong suốt -> nền trắng
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return encodePgm(ctx.getImageData(0, 0, w, h));
}

function encodePgm(imageData) {
  const { width: w, height: h, data } = imageData;
  const NL = String.fromCharCode(10);
  const head = new TextEncoder().encode("P5" + NL + w + " " + h + NL + "255" + NL);
  const out = new Uint8Array(head.length + w * h);
  out.set(head);
  let d = head.length;
  for (let i = 0; i < data.length; i += 4) {
    out[d++] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return new Blob([out], { type: "image/x-portable-graymap" });
}

function extractLines(data, scale) {
  const norm = (b) => ({ x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale });
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || [])
          .filter((w) => w.text && w.text.trim() && w.confidence >= 25)
          .map((w) => ({ text: w.text, bbox: norm(w.bbox), confidence: w.confidence }));
        if (words.length) out.push({ bbox: norm(line.bbox), words, confidence: line.confidence });
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

async function recognize(image, lang, quality) {
  clearTimeout(idleTimer);
  const t0 = performance.now();
  const img = await loadImage(image);
  const width = img.naturalWidth, height = img.naturalHeight;
  const maxSide = Math.max(width, height);

  // Ảnh nhỏ: phóng to để chữ đủ nét. Ảnh quá lớn: thu nhỏ để quét nhanh.
  let scale = 1;
  if (maxSide < 1000) scale = Math.min(3, 1600 / maxSide);
  else if (maxSide > 2600) scale = 2600 / maxSide;
  const canvas = drawScaled(img, scale);
  const tPrep = performance.now();

  sendProgress("loading", 0);
  const w = await getWorker(lang, quality);
  const tWorker = performance.now();

  const output = { text: false, blocks: true };
  const { data } = await w.recognize(canvas, {}, output);
  let lines = extractLines(data, scale);

  // Lượt 2 trên ảnh thu nhỏ: bắt tiêu đề cỡ chữ rất lớn mà lượt 1 bỏ sót
  if (maxSide * scale >= 900) {
    const s2 = BIG_TEXT_PASS_SIDE / maxSide;
    const small = drawScaled(img, s2);
    currentJobId = null; // không báo tiến độ cho lượt phụ
    const r2 = await w.recognize(small, {}, output);
    const minH = 0.05 * height;
    const extra = extractLines(r2.data, s2).filter((l) =>
      l.confidence >= 75 &&
      (l.bbox.y1 - l.bbox.y0) >= minH &&
      !lines.some((m) => overlapRatio(l.bbox, m.bbox) > 0.15 || overlapRatio(m.bbox, l.bbox) > 0.5)
    );
    for (const l of extra) {
      let i = lines.findIndex((m) => m.bbox.y0 > l.bbox.y0);
      if (i < 0) i = lines.length;
      lines.splice(i, 0, l);
    }
  }

  const text = lines.map((l) => l.words.map((x) => x.text).join(" ")).join("\n");
  armIdleTimer();
  const tEnd = performance.now();
  return {
    text, lines, width, height,
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
      } catch (e) { /* sẽ báo lỗi ở lần quét thật */ }
    });
    return;
  }

  if (msg.action === "OCR_RECOGNIZE") {
    queue = queue.then(async () => {
      currentJobId = msg.jobId;
      try {
        const result = await recognize(msg.image, msg.lang, msg.quality || "fast");
        sendResponse({ success: true, result });
      } catch (err) {
        console.error("OCR error:", err);
        await disposeWorker();
        sendResponse({ success: false, error: err.message || String(err) });
      } finally {
        currentJobId = null;
      }
    });
    return true;
  }
});
