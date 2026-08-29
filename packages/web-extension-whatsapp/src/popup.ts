import {
  loadSettings,
  openOptionsPage,
  probeEngineLink,
  saveSettings,
  scanActiveWhatsAppPage,
} from "./chrome-api.js";
import { isOneShotScanResult } from "./page-logic.js";
import { statusCopy, uiCopy, uiLang } from "./ui-copy.js";

const copy = uiCopy();
document.documentElement.lang = uiLang();

const title = document.querySelector("#title");
const dockHint = document.querySelector("#dockHint");
const status = document.querySelector("#status");
const pairLabel = document.querySelector("#pairLabel");
const pairHint = document.querySelector("#pairHint");
const pairingCode = document.querySelector<HTMLInputElement>("#pairingCode");
const savePairing = document.querySelector<HTMLButtonElement>("#savePairing");
const sendMode = document.querySelector("#sendMode");
const testConnection = document.querySelector<HTMLButtonElement>("#testConnection");
const scanPage = document.querySelector<HTMLButtonElement>("#scanPage");
const openOptions = document.querySelector<HTMLButtonElement>("#openOptions");
const pageScanResult = document.querySelector("#pageScanResult");

if (title) title.textContent = copy.title;
if (dockHint) dockHint.textContent = copy.dockHint;
if (pairLabel) pairLabel.textContent = copy.pairingLabel;
if (pairHint) pairHint.textContent = copy.pairingHint;
if (pairingCode) pairingCode.placeholder = copy.pairingPlaceholder;
if (savePairing) savePairing.textContent = copy.savePairing;
if (testConnection) testConnection.textContent = copy.testConnection;
if (scanPage) scanPage.textContent = copy.reconnect;
if (openOptions) openOptions.textContent = copy.settings;
if (status) status.textContent = copy.statusChecking;
if (pageScanResult) pageScanResult.textContent = copy.scanIdle;

openOptions?.addEventListener("click", () => openOptionsPage());
testConnection?.addEventListener("click", () => {
  void testLink();
});
scanPage?.addEventListener("click", () => {
  void reconnectPage();
});
savePairing?.addEventListener("click", () => {
  void persistPairing();
});

void render();

async function render(): Promise<void> {
  const settings = await loadSettings();
  if (pairingCode) {
    pairingCode.value = settings.apiKey;
  }
  if (sendMode) {
    sendMode.textContent = settings.allowSend ? copy.sendClick : copy.sendDraft;
  }
  await refreshStatus();
}

async function refreshStatus(): Promise<void> {
  const link = await probeEngineLink();
  setStatus(statusCopy(link.kind, copy), link.kind !== "connected");
}

async function persistPairing(): Promise<void> {
  const pairing = pairingCode?.value.trim() ?? "";
  if (!pairing) {
    setStatus(copy.pairingMissing, true);
    return;
  }
  const settings = await loadSettings();
  const next = { ...settings, apiKey: pairing };
  await saveSettings(next);
  const link = await probeEngineLink(next);
  setStatus(
    link.kind === "connected" ? `${copy.pairingSaved} · ${copy.statusConnected}` : statusCopy(link.kind, copy),
    link.kind !== "connected",
  );
}

async function testLink(): Promise<void> {
  if (testConnection) {
    testConnection.disabled = true;
  }
  setStatus(copy.statusChecking, false);
  try {
    const pairing = pairingCode?.value.trim() ?? "";
    if (!pairing) {
      setStatus(copy.pairingMissing, true);
      pairingCode?.focus();
      return;
    }
    const settings = await loadSettings();
    const next = { ...settings, apiKey: pairing };
    await saveSettings(next);
    const link = await probeEngineLink(next);
    const ok = link.kind === "connected";
    setStatus(ok ? `${copy.testOk} · ${copy.statusConnected}` : statusCopy(link.kind, copy), !ok);
    if (pageScanResult) {
      pageScanResult.className = ok ? "ok" : "error";
      pageScanResult.textContent = ok ? copy.testOk : statusCopy(link.kind, copy);
    }
  } catch {
    setStatus(copy.statusOffline, true);
    if (pageScanResult) {
      pageScanResult.className = "error";
      pageScanResult.textContent = copy.statusOffline;
    }
  } finally {
    if (testConnection) {
      testConnection.disabled = false;
    }
  }
}

async function reconnectPage(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.apiKey.trim()) {
    setStatus(copy.pairingMissing, true);
    pairingCode?.focus();
    return;
  }
  if (pageScanResult) {
    pageScanResult.textContent = copy.scanRunning;
  }
  try {
    const result = await scanActiveWhatsAppPage();
    const text = humanScan(result);
    if (pageScanResult) {
      pageScanResult.className = scanFailed(text) ? "error" : "ok";
      pageScanResult.textContent = text;
    }
  } catch (error) {
    if (pageScanResult) {
      pageScanResult.className = "error";
      pageScanResult.textContent = error instanceof Error ? error.message : copy.statusOffline;
    }
  }
}

function humanScan(result: string): string {
  if (result.includes("open WhatsApp tab first") || result.includes("no active tab")) {
    return copy.needsWhatsAppTab;
  }
  if (result.includes("no open chat")) {
    return copy.scanNoOpenChat;
  }
  if (result.includes("no chat list")) {
    return copy.scanNoChatList;
  }
  const synced = result.match(/synced (\d+)\/(\d+)/i);
  if (synced) {
    return copy.scanSynced.replace("{ok}", synced[1]).replace("{total}", synced[2]);
  }
  if (result.includes("no WhatsApp chat id")) {
    return copy.scanNoChatId;
  }
  if (isOneShotScanResult(result)) {
    return copy.scanInjectFailed;
  }
  return result.replace(/^connected:\s*/i, "");
}

function scanFailed(text: string): boolean {
  return (
    text === copy.needsWhatsAppTab
    || text === copy.scanNoOpenChat
    || text === copy.scanNoChatList
    || text === copy.scanNoChatId
    || text === copy.scanInjectFailed
  );
}

function setStatus(text: string, error: boolean): void {
  if (!status) {
    return;
  }
  status.className = `status${error ? " error" : " ok"}`;
  status.textContent = text;
}
