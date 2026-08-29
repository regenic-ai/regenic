import { loadSettings, openOptionsPage, scanActiveWhatsAppPage } from "./chrome-api.js";

const status = document.querySelector<HTMLElement>("#status");
const buildInfo = document.querySelector<HTMLElement>("#buildInfo");
const endpoint = document.querySelector<HTMLElement>("#endpoint");
const sendMode = document.querySelector<HTMLElement>("#sendMode");
const testResult = document.querySelector<HTMLElement>("#testResult");
const pageScanResult = document.querySelector<HTMLElement>("#pageScanResult");
const testConnection = document.querySelector<HTMLButtonElement>("#testConnection");
const scanPage = document.querySelector<HTMLButtonElement>("#scanPage");
const openOptions = document.querySelector<HTMLButtonElement>("#openOptions");

openOptions?.addEventListener("click", () => openOptionsPage());
testConnection?.addEventListener("click", () => {
  void runSelfTest();
});
scanPage?.addEventListener("click", () => {
  void reconnectPage();
});

void render();

async function render(): Promise<void> {
  const settings = await loadSettings();
  if (buildInfo) {
    buildInfo.textContent = formattedBuildInfo();
  }
  if (endpoint) {
    endpoint.textContent = settings.apiOrigin;
  }
  if (sendMode) {
    sendMode.textContent = settings.allowSend ? "send allowed" : "draft only";
  }
  try {
    const response = await fetch(`${settings.apiOrigin}/v1/me/live/whatsapp/status`, {
      headers: settings.apiKey ? { "x-regenic-live-key": settings.apiKey } : {},
    });
    if (status) {
      status.textContent = response.ok ? "connected" : "blocked";
    }
  } catch {
    if (status) {
      status.textContent = "offline";
    }
  }
}

function formattedBuildInfo(): string {
  const build = (globalThis as { REGENIC_EXTENSION_BUILD?: { version?: string } }).REGENIC_EXTENSION_BUILD;
  if (!build) {
    return "unknown";
  }
  return build.version ?? "unknown";
}

async function runSelfTest(): Promise<void> {
  const settings = await loadSettings();
  const stamp = new Date().toISOString();
  try {
    const response = await fetch(`${settings.apiOrigin}/v1/me/live/whatsapp/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.apiKey ? { "x-regenic-live-key": settings.apiKey } : {}),
      },
      body: JSON.stringify({
        client_id: "regenic-whatsapp-popup",
        chat_id: "extension-self-test",
        chat_title: "Extension Self Test",
        message_id: `popup-${Date.now()}`,
        sender_id: "extension-popup",
        sender_name: "Regenic Extension",
        text: `Regenic extension popup self-test ${stamp}`,
        timestamp: stamp,
        from_me: false,
        message_kind: "system",
      }),
    });
    if (testResult) {
      testResult.textContent = response.ok ? "sent" : `failed ${response.status}`;
    }
  } catch {
    if (testResult) {
      testResult.textContent = "offline";
    }
  }
}

async function reconnectPage(): Promise<void> {
  if (pageScanResult) {
    pageScanResult.textContent = "running";
  }
  try {
    const result = await scanActiveWhatsAppPage(await loadSettings());
    if (pageScanResult) {
      pageScanResult.textContent = result;
    }
  } catch (error) {
    if (pageScanResult) {
      pageScanResult.textContent = error instanceof Error ? error.message : "failed";
    }
  }
}