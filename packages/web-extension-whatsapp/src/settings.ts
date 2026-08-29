import { DEFAULT_SETTINGS, loadSettings, probeEngineLink, saveSettings } from "./chrome-api.js";
import { isLoopbackApiOrigin } from "./page-logic.js";
import { statusCopy, uiCopy, uiLang } from "./ui-copy.js";

const copy = uiCopy();
document.documentElement.lang = uiLang();

const title = document.querySelector("#title");
const intro = document.querySelector("#intro");
const pairingLabel = document.querySelector("#pairingLabel span");
const pairingHint = document.querySelector("#pairingHint");
const pairingInput = document.querySelector<HTMLInputElement>("#apiKey");
const sendTitle = document.querySelector("#sendTitle");
const sendHint = document.querySelector("#sendHint");
const allowSend = document.querySelector<HTMLInputElement>("#allowSend");
const advanced = document.querySelector("#advanced");
const originLabel = document.querySelector("#originLabel span");
const originHint = document.querySelector("#originHint");
const apiOrigin = document.querySelector<HTMLInputElement>("#apiOrigin");
const installIdLabel = document.querySelector("#installIdLabel span");
const installIdHint = document.querySelector("#installIdHint");
const installationId = document.querySelector<HTMLInputElement>("#installationId");
const save = document.querySelector<HTMLButtonElement>("#save");
const status = document.querySelector("#status");

if (title) title.textContent = copy.settingsTitle;
if (intro) intro.textContent = copy.intro;
if (pairingLabel) pairingLabel.textContent = copy.pairingLabel;
if (pairingHint) pairingHint.textContent = copy.pairingHint;
if (pairingInput) pairingInput.placeholder = copy.pairingPlaceholder;
if (sendTitle) sendTitle.textContent = copy.sendLabel;
if (sendHint) sendHint.textContent = copy.sendHint;
if (advanced) advanced.textContent = copy.advanced;
if (originLabel) originLabel.textContent = copy.originLabel;
if (originHint) originHint.textContent = copy.originHint;
if (installIdLabel) installIdLabel.textContent = copy.installIdLabel;
if (installIdHint) installIdHint.textContent = copy.installIdHint;
if (save) save.textContent = copy.saveAndTest;

void load();
save?.addEventListener("click", () => {
  void persist();
});

async function load(): Promise<void> {
  const settings = await loadSettings();
  if (apiOrigin) {
    apiOrigin.value = settings.apiOrigin;
  }
  if (pairingInput) {
    pairingInput.value = settings.apiKey;
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
    setStatus(copy.originError, true);
    return;
  }
  const pairing = pairingInput?.value.trim() ?? "";
  if (!pairing) {
    setStatus(copy.pairingMissing, true);
    return;
  }
  const next = {
    apiOrigin: origin,
    apiKey: pairing,
    installationId: installationId?.value.trim() ?? "",
    allowSend: allowSend?.checked === true,
  };
  await saveSettings(next);
  const link = await probeEngineLink(next);
  setStatus(statusCopy(link.kind, copy), link.kind !== "connected");
}

function setStatus(text: string, error: boolean): void {
  if (!status) {
    return;
  }
  status.className = error ? "error" : "ok";
  status.textContent = text;
}
