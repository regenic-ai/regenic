import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./chrome-api.js";

const apiOrigin = document.querySelector<HTMLInputElement>("#apiOrigin");
const apiKey = document.querySelector<HTMLInputElement>("#apiKey");
const allowSend = document.querySelector<HTMLInputElement>("#allowSend");
const save = document.querySelector<HTMLButtonElement>("#save");
const saved = document.querySelector<HTMLElement>("#saved");

void load();

save?.addEventListener("click", () => {
  void persist();
});

async function load(): Promise<void> {
  const settings = await loadSettings();
  if (apiOrigin) {
    apiOrigin.value = settings.apiOrigin;
  }
  if (apiKey) {
    apiKey.value = settings.apiKey;
  }
  if (allowSend) {
    allowSend.checked = settings.allowSend;
  }
}

async function persist(): Promise<void> {
  await saveSettings({
    apiOrigin: apiOrigin?.value.trim().replace(/\/$/, "") || DEFAULT_SETTINGS.apiOrigin,
    apiKey: apiKey?.value ?? "",
    allowSend: allowSend?.checked === true,
  });
  if (saved) {
    saved.textContent = "Saved";
    window.setTimeout(() => {
      saved.textContent = "";
    }, 1_500);
  }
}