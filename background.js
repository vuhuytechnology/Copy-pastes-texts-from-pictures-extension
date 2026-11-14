// background.js - Service Worker (Manifest V3)

const OFFSCREEN_URL = "offscreen/offscreen.html";
const jobTabs = new Map(); // jobId -> tabId (để chuyển tiếp tiến độ OCR về đúng tab)
let creatingOffscreen = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ocr-image-selection",
    title: "📝 Bôi đen chữ trên ảnh này (OCR)",
    contexts: ["image"]
  });
  chrome.contextMenus.create({
    id: "ocr-region-select",
    title: "✂️ Quét chữ theo vùng chọn trên trang",
    contexts: ["page", "selection", "video"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "ocr-image-selection") {
    chrome.tabs.sendMessage(tab.id, { action: "TRIGGER_OCR_FOR_IMAGE", srcUrl: info.srcUrl }).catch(() => {});
  } else if (info.menuItemId === "ocr-region-select") {
    chrome.tabs.sendMessage(tab.id, { action: "START_REGION_SELECT" }).catch(() => {});
  }
});

// Phím tắt (Alt+Shift+O): chọn vùng bất kỳ trên màn hình để quét chữ
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "ocr-region") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: "START_REGION_SELECT" }).catch(() => {});
});

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Chạy Tesseract OCR trong Web Worker"
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target === "offscreen") return; // dành cho offscreen document

  switch (request.action) {
    case "FETCH_IMAGE_AS_BASE64":
      fetchImageAsBase64(request.url)
        .then((base64) => sendResponse({ success: true, base64 }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case "OCR_RECOGNIZE":
      (async () => {
        try {
          await ensureOffscreen();
          if (sender.tab?.id != null) jobTabs.set(request.jobId, sender.tab.id);
          const res = await chrome.runtime.sendMessage({
            target: "offscreen",
            action: "OCR_RECOGNIZE",
            jobId: request.jobId,
            image: request.image,
            lang: request.lang,
            quality: request.quality
          });
          sendResponse(res || { success: false, error: "Engine OCR không phản hồi." });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        } finally {
          jobTabs.delete(request.jobId);
        }
      })();
      return true;

    case "OCR_PREWARM":
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({
          target: "offscreen",
          action: "OCR_PREWARM",
          lang: request.lang,
          quality: request.quality
        }))
        .catch(() => {});
      return;

    case "OCR_PROGRESS": {
      const tabId = jobTabs.get(request.jobId);
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, {
          action: "OCR_PROGRESS",
          jobId: request.jobId,
          status: request.status,
          progress: request.progress
        }).catch(() => {});
      }
      return;
    }

    case "CAPTURE_VISIBLE_TAB":
      chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "png" })
        .then((dataUrl) => sendResponse({ success: true, dataUrl }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
  }
});

/** Tải ảnh qua background (vượt CORS) và trả về Data URL */
async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Tải ảnh thất bại: HTTP ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
