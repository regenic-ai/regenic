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
    const response = await fetchLiveStatus(settings);
    if (status) {
      status.textContent = response.label;
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

async function fetchLiveStatus(settings: { apiOrigin: string; apiKey: string }): Promise<{
  ok: boolean;
  status: number;
  label: string;
}> {
  const response = await fetch(`${settings.apiOrigin}/v1/me/engine`, {
    headers: settings.apiKey ? { "x-regenic-live-key": settings.apiKey } : {},
  });
  if (!response.ok) {
    return { ok: false, status: response.status, label: "blocked" };
  }
  const body = await response.json() as {
    installations?: Array<{ connector_type?: string; status?: string }>;
  };
  const found = body.installations?.some(
    (item) => item.connector_type === "whatsapp-web-live" && item.status === "enabled",
  );
  return {
    ok: Boolean(found),
    status: response.status,
    label: found ? "connected" : "not installed",
  };
}

async function runSelfTest(): Promise<void> {
  const settings = await loadSettings();
  try {
    const response = await fetchLiveStatus(settings);
    if (testResult) {
      testResult.textContent = response.ok ? "ok" : `failed ${response.status}`;
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
    const result = await scanActiveWhatsAppPage();
    if (pageScanResult) {
      pageScanResult.textContent = result;
    }
  } catch (error) {
    if (pageScanResult) {
      pageScanResult.textContent = error instanceof Error ? error.message : "failed";
    }
  }
}
