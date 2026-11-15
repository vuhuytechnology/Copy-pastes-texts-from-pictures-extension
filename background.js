// background.js - Service Worker (Manifest V3)

const OFFSCREEN_URL = "offscreen/offscreen.html";
const MAX_HISTORY_ITEMS = 50;
const jobTabs = new Map();
let creatingOffscreen = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ocr-image-selection",
      title: "Select text on this image (OCR)",
      contexts: ["image"]
    });
    chrome.contextMenus.create({
      id: "ocr-region-select",
      title: "Scan text from selected region",
      contexts: ["page", "selection", "video"]
    });
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
      justification: "Run Tesseract OCR in a Web Worker"
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target === "offscreen") return;

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
            quality: request.quality,
            preprocessing: request.preprocessing,
            smartFilter: request.smartFilter
          });
          sendResponse(res || { success: false, error: "OCR engine did not respond." });
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

    case "TRANSLATE_TEXT":
      translateText(request.text, request.targetLang || "en")
        .then((data) => sendResponse({ success: true, ...data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case "CLOUD_VISION_OCR":
      runCloudVisionOCR(request.image)
        .then((text) => sendResponse({ success: true, text }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case "SAVE_SCAN_HISTORY":
      saveScanHistory(request.entry)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
  }
});

async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch image: HTTP ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function translateText(text, targetLang) {
  if (!text || !text.trim()) throw new Error("Nothing to translate.");
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text.slice(0, 4500))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Translation failed (HTTP ${res.status}).`);
  const data = await res.json();
  const translatedText = Array.isArray(data?.[0])
    ? data[0].map((seg) => seg?.[0] || "").join("")
    : "";
  if (!translatedText) throw new Error("Empty translation response.");
  return { translatedText, detectedLang: data?.[2] || "auto" };
}

async function runCloudVisionOCR(imageDataUrl) {
  const { aiSettings } = await chrome.storage.local.get({
    aiSettings: { provider: "disabled", apiKey: "", model: "", endpoint: "" }
  });

  if (!aiSettings || aiSettings.provider === "disabled" || !aiSettings.apiKey) {
    throw new Error("Cloud AI Vision is not configured. Open Extension -> AI tab to add your API key.");
  }

  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageDataUrl || "");
  if (!match) throw new Error("Invalid image data for Cloud Vision.");
  const mimeType = match[1];
  const base64Data = match[2];
  const prompt = "Extract all visible text from this image accurately. Preserve line breaks and table structure where applicable. Output only the extracted text without commentary.";

  if (aiSettings.provider === "gemini") {
    const model = aiSettings.model?.trim() || "gemini-2.5-flash";
    const base = (aiSettings.endpoint?.trim() || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(aiSettings.apiKey.trim())}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Data } }
          ]
        }]
      })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `Gemini API HTTP ${res.status}`);
    const out = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!out) throw new Error("Gemini returned no text.");
    return out;
  }

  if (aiSettings.provider === "openai") {
    const model = aiSettings.model?.trim() || "gpt-4o-mini";
    const endpoint = aiSettings.endpoint?.trim() || "https://api.openai.com/v1/chat/completions";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${aiSettings.apiKey.trim()}`
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl } }
          ]
        }],
        max_tokens: 2048
      })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `OpenAI API HTTP ${res.status}`);
    const out = json?.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error("Vision API returned no text.");
    return out;
  }

  throw new Error(`Unsupported AI provider: ${aiSettings.provider}`);
}

async function saveScanHistory(entry) {
  if (!entry || !entry.text || !entry.text.trim()) return;
  const { ocrHistory = [] } = await chrome.storage.local.get({ ocrHistory: [] });
  const normalizedText = entry.text.trim();
  const filtered = ocrHistory.filter(
    (item) => !(item.text === normalizedText && item.pageUrl === entry.pageUrl)
  );
  filtered.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text: normalizedText,
    lang: entry.lang || "eng",
    source: entry.source || "image",
    pageTitle: entry.pageTitle || "",
    pageUrl: entry.pageUrl || "",
    createdAt: Date.now()
  });
  await chrome.storage.local.set({ ocrHistory: filtered.slice(0, MAX_HISTORY_ITEMS) });
}
