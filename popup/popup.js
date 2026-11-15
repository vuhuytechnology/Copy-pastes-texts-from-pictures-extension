// popup.js - OCR settings and region capture trigger

const DEFAULTS = { ocrLanguage: "vie+eng", ocrQuality: "fast", showHoverButton: true, autoCopy: false };

document.addEventListener("DOMContentLoaded", () => {
  const languageSelect = document.getElementById("languageSelect");
  const qualitySelect = document.getElementById("qualitySelect");
  const showHover = document.getElementById("showHoverButton");
  const autoCopy = document.getElementById("autoCopy");
  const saveStatus = document.getElementById("saveStatus");
  const regionBtn = document.getElementById("regionBtn");
  const regionStatus = document.getElementById("regionStatus");

  chrome.storage.sync.get(DEFAULTS, (items) => {
    languageSelect.value = items.ocrLanguage;
    qualitySelect.value = items.ocrQuality;
    showHover.checked = items.showHoverButton;
    autoCopy.checked = items.autoCopy;
  });

  const flashSaved = () => {
    saveStatus.classList.add("show");
    setTimeout(() => saveStatus.classList.remove("show"), 1500);
  };
  const save = (obj) => chrome.storage.sync.set(obj, flashSaved);

  languageSelect.addEventListener("change", () => save({ ocrLanguage: languageSelect.value }));
  qualitySelect.addEventListener("change", () => save({ ocrQuality: qualitySelect.value }));
  showHover.addEventListener("change", () => save({ showHoverButton: showHover.checked }));
  autoCopy.addEventListener("change", () => save({ autoCopy: autoCopy.checked }));

  regionBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "START_REGION_SELECT" });
      window.close();
    } catch (e) {
      regionStatus.textContent = "Cannot run on this page. Reload the tab (F5) and try again.";
    }
  });
});
