// popup.js - v2.0 settings, scan history, batch trigger, and Cloud AI Vision config

const SYNC_DEFAULTS = {
  ocrLanguage: "auto",
  ocrQuality: "fast",
  preprocessing: "auto",
  smartFilter: true,
  showHoverButton: true,
  autoCopy: false,
  translateTarget: "en",
  aiAutoFallback: false
};

const AI_DEFAULTS = {
  provider: "disabled",
  apiKey: "",
  model: "",
  endpoint: ""
};

document.addEventListener("DOMContentLoaded", () => {
  // Tabs
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "history") loadHistory();
    });
  });

  // Scan tab controls
  const languageSelect = document.getElementById("languageSelect");
  const qualitySelect = document.getElementById("qualitySelect");
  const prepSelect = document.getElementById("prepSelect");
  const showHover = document.getElementById("showHoverButton");
  const autoCopy = document.getElementById("autoCopy");
  const smartFilter = document.getElementById("smartFilter");
  const saveStatus = document.getElementById("saveStatus");
  const regionBtn = document.getElementById("regionBtn");
  const batchBtn = document.getElementById("batchBtn");
  const regionStatus = document.getElementById("regionStatus");

  // AI & Tools controls
  const translateTargetSelect = document.getElementById("translateTargetSelect");
  const aiProviderSelect = document.getElementById("aiProviderSelect");
  const aiConfigFields = document.getElementById("aiConfigFields");
  const aiApiKey = document.getElementById("aiApiKey");
  const aiModel = document.getElementById("aiModel");
  const aiEndpoint = document.getElementById("aiEndpoint");
  const aiAutoFallback = document.getElementById("aiAutoFallback");
  const aiSaveStatus = document.getElementById("aiSaveStatus");

  // History controls
  const historySearch = document.getElementById("historySearch");
  const historyList = document.getElementById("historyList");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");

  chrome.storage.sync.get(SYNC_DEFAULTS, (items) => {
    languageSelect.value = items.ocrLanguage;
    qualitySelect.value = items.ocrQuality;
    prepSelect.value = items.preprocessing;
    showHover.checked = items.showHoverButton;
    autoCopy.checked = items.autoCopy;
    smartFilter.checked = items.smartFilter;
    translateTargetSelect.value = items.translateTarget;
    aiAutoFallback.checked = items.aiAutoFallback;
  });

  chrome.storage.local.get({ aiSettings: AI_DEFAULTS }, ({ aiSettings }) => {
    const a = { ...AI_DEFAULTS, ...aiSettings };
    aiProviderSelect.value = a.provider;
    aiApiKey.value = a.apiKey;
    aiModel.value = a.model;
    aiEndpoint.value = a.endpoint;
    toggleAiFields(a.provider);
  });

  function toggleAiFields(provider) {
    aiConfigFields.style.display = provider === "disabled" ? "none" : "block";
    aiModel.placeholder = provider === "openai" ? "gpt-4o-mini" : "gemini-2.5-flash";
  }

  const flash = (el) => {
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 1500);
  };

  const saveSync = (obj, statusEl = saveStatus) => chrome.storage.sync.set(obj, () => flash(statusEl));

  languageSelect.addEventListener("change", () => saveSync({ ocrLanguage: languageSelect.value }));
  qualitySelect.addEventListener("change", () => saveSync({ ocrQuality: qualitySelect.value }));
  prepSelect.addEventListener("change", () => saveSync({ preprocessing: prepSelect.value }));
  showHover.addEventListener("change", () => saveSync({ showHoverButton: showHover.checked }));
  autoCopy.addEventListener("change", () => saveSync({ autoCopy: autoCopy.checked }));
  smartFilter.addEventListener("change", () => saveSync({ smartFilter: smartFilter.checked }));
  translateTargetSelect.addEventListener("change", () => saveSync({ translateTarget: translateTargetSelect.value }, aiSaveStatus));
  aiAutoFallback.addEventListener("change", () => saveSync({ aiAutoFallback: aiAutoFallback.checked }, aiSaveStatus));

  const saveAiSettings = () => {
    const aiSettings = {
      provider: aiProviderSelect.value,
      apiKey: aiApiKey.value.trim(),
      model: aiModel.value.trim(),
      endpoint: aiEndpoint.value.trim()
    };
    toggleAiFields(aiSettings.provider);
    chrome.storage.local.set({ aiSettings }, () => flash(aiSaveStatus));
  };

  aiProviderSelect.addEventListener("change", saveAiSettings);
  aiApiKey.addEventListener("change", saveAiSettings);
  aiModel.addEventListener("change", saveAiSettings);
  aiEndpoint.addEventListener("change", saveAiSettings);

  async function triggerActiveTabAction(action) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { action });
      window.close();
    } catch (e) {
      regionStatus.textContent = "Cannot run on this page. Reload the tab (F5) and try again.";
    }
  }

  regionBtn.addEventListener("click", () => triggerActiveTabAction("START_REGION_SELECT"));
  batchBtn.addEventListener("click", () => triggerActiveTabAction("START_BATCH_SCAN"));

  // History rendering
  let cachedHistory = [];

  function loadHistory() {
    chrome.storage.local.get({ ocrHistory: [] }, ({ ocrHistory }) => {
      cachedHistory = ocrHistory || [];
      renderHistory();
    });
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function renderHistory() {
    const q = (historySearch.value || "").trim().toLowerCase();
    const items = q
      ? cachedHistory.filter((h) => h.text.toLowerCase().includes(q) || (h.pageTitle || "").toLowerCase().includes(q))
      : cachedHistory;

    historyList.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = q ? "No matching scans." : "No scans recorded yet.";
      historyList.appendChild(empty);
      return;
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "history-item";
      row.innerHTML = `
        <div class="history-meta">
          <span class="history-badge">${escapeHtml(item.source || "ocr")} · ${escapeHtml(item.lang || "")}</span>
          <span>${escapeHtml(formatTime(item.createdAt))}</span>
        </div>
        <div class="history-preview"></div>
        <div class="history-actions">
          <button class="hist-btn hist-copy" type="button">Copy</button>
          <button class="hist-btn hist-del" type="button">Delete</button>
        </div>
      `;
      row.querySelector(".history-preview").textContent = item.text;
      row.querySelector(".hist-copy").addEventListener("click", async (e) => {
        await navigator.clipboard.writeText(item.text);
        e.target.textContent = "Copied!";
        setTimeout(() => { e.target.textContent = "Copy"; }, 1200);
      });
      row.querySelector(".hist-del").addEventListener("click", () => {
        cachedHistory = cachedHistory.filter((h) => h.id !== item.id);
        chrome.storage.local.set({ ocrHistory: cachedHistory }, renderHistory);
      });
      historyList.appendChild(row);
    }
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

  historySearch.addEventListener("input", renderHistory);
  clearHistoryBtn.addEventListener("click", () => {
    cachedHistory = [];
    chrome.storage.local.set({ ocrHistory: [] }, renderHistory);
  });
});
