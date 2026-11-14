// offscreen.js - Chạy Tesseract OCR trong trang của extension (đủ quyền tạo Worker, không phụ thuộc CSP của trang web)

const BUNDLED_LANGS = new Set(["eng", "vie"]);
const REMOTE_LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";
const IDLE_TERMINATE_MS = 90 * 1000;

let worker = null;
let workerLang = null;
let idleTimer = null;
let currentJobId = null;
let queue = Promise.resolve();

function sendProgress(status, progress) {
  chrome.runtime.sendMessage({
    target: "background",
    action: "OCR_PROGRESS",
    jobId: currentJobId,
    status,
    progress: progress || 0
  }).catch(() => {});
}

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  const allLocal = lang.split("+").every((l) => BUNDLED_LANGS.has(l));
  worker = await Tesseract.createWorker(lang, 1, {
    workerPath: chrome.runtime.getURL("libs/worker.min.js"),
    corePath: chrome.runtime.getURL("libs/core"),
    langPath: allLocal ? chrome.runtime.getURL("libs/lang") : REMOTE_LANG_PATH,
    workerBlobURL: false,
    logger: (m) => sendProgress(m.status, m.progress)
  });
  workerLang = lang;
  return worker;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Không đọc được dữ liệu ảnh."));
    img.src = src;
  });
}

/** Phóng to ảnh nhỏ + chuyển nền trắng để Tesseract đọc chính xác hơn */
async function prepareCanvas(src) {
  const img = await loadImage(src);
  const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
  let scale = 1;
  if (maxSide < 1000) scale = Math.min(3, 1400 / maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, scale, width: img.naturalWidth, height: img.naturalHeight };
}

async function recognize(image, lang) {
  clearTimeout(idleTimer);
  const { canvas, scale, width, height } = await prepareCanvas(image);
  sendProgress("loading", 0);
  const w = await getWorker(lang);
  const { data } = await w.recognize(canvas);

  const norm = (b) => ({
    x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale
  });

  const lines = (data.lines || [])
    .map((line) => ({
      text: (line.text || "").replace(/\s+$/, ""),
      bbox: norm(line.bbox),
      words: (line.words || [])
        .filter((wd) => wd.text && wd.text.trim() && wd.confidence >= 25)
        .map((wd) => ({ text: wd.text, bbox: norm(wd.bbox), confidence: wd.confidence }))
    }))
    .filter((l) => l.words.length > 0);

  const text = lines.map((l) => l.words.map((x) => x.text).join(" ")).join("\n");

  idleTimer = setTimeout(async () => {
    if (worker) {
      await worker.terminate();
      worker = null;
      workerLang = null;
    }
  }, IDLE_TERMINATE_MS);

  return { text, lines, width, height };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.action !== "OCR_RECOGNIZE") return;
  queue = queue.then(async () => {
    currentJobId = msg.jobId;
    try {
      const result = await recognize(msg.image, msg.lang);
      sendResponse({ success: true, result });
    } catch (err) {
      console.error("OCR error:", err);
      if (worker) {
        try { await worker.terminate(); } catch (e) { /* ignore */ }
        worker = null;
        workerLang = null;
      }
      sendResponse({ success: false, error: err.message || String(err) });
    }
  });
  return true;
});
