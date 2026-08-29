import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./chrome-api.js";
import { isLoopbackApiOrigin } from "./page-logic.js";

const apiOrigin = document.querySelector<HTMLInputElement>("#apiOrigin");
const apiKey = document.querySelector<HTMLInputElement>("#apiKey");
const installationId = document.querySelector<HTMLInputElement>("#installationId");
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
  if (installationId) {
    installationId.value = settings.installationId;
  }
  if (allowSend) {
    allowSend.checked = settings.allowSend;
  }
}

async function persist(): Promise<void> {
  const origin = apiOrigin?.value.trim().replace(/\/$/, "") || DEFAULT_SETTINGS.apiOrigin;
  if (!isLoopbackApiOrigin(origin)) {
    if (saved) {
      saved.className = "error";
      saved.textContent = "API origin must be 127.0.0.1 or localhost";
    }
    return;
  }
  await saveSettings({
    apiOrigin: origin,
    apiKey: apiKey?.value ?? "",
    installationId: installationId?.value.trim() ?? "",
    allowSend: allowSend?.checked === true,
  });
  if (saved) {
    saved.className = "";
    saved.textContent = "Saved";
    window.setTimeout(() => {
      saved.textContent = "";
    }, 1_500);
  }
}
