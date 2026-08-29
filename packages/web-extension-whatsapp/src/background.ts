import { loadSettings } from "./chrome-api.js";

interface WhatsAppLiveMessage {
  type: "regenic.whatsapp.message";
  payload: Record<string, unknown>;
}

interface PollCommandsMessage {
  type: "regenic.whatsapp.pollCommands";
}

interface AckCommandMessage {
  type: "regenic.whatsapp.ack";
  id: string;
}

interface PopupScanMessage {
  type: "regenic.whatsapp.popupScan";
  mode?: "current" | "all";
}

interface BrowserTab {
  id?: number;
  url?: string;
}

interface PageScanResponse {
  result?: string;
  protocol?: number;
}

const CONTENT_SCRIPT_PROTOCOL = 14;
const CONNECTOR_TYPE = "whatsapp-web-live";

declare const chrome: {
  runtime: {
    lastError?: { message?: string };
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: Record<string, unknown>) => void,
        ) => boolean | void,
      ): void;
    };
  };
  tabs: {
    query(
      queryInfo: { active?: boolean; currentWindow?: boolean; url?: string | string[] },
      callback?: (tabs: BrowserTab[]) => void,
    ): Promise<BrowserTab[]> | void;
    update?(
      tabId: number,
      updateProperties: { active?: boolean },
      callback?: (tab: BrowserTab) => void,
    ): Promise<BrowserTab> | void;
    sendMessage(
      tabId: number,
      message: unknown,
      callback?: (response: PageScanResponse) => void,
    ): Promise<PageScanResponse> | void;
  };
  sidePanel?: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
  };
  scripting?: {
    executeScript(
      injection:
        | { target: { tabId: number }; files: string[]; world?: "ISOLATED" | "MAIN" }
        | { target: { tabId: number }; func: () => unknown; world?: "ISOLATED" | "MAIN" },
      callback?: (results: Array<{ result?: unknown }>) => void,
    ): Promise<Array<{ result?: unknown }>> | void;
  };
};

void Promise.resolve(
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }),
).catch(() => undefined);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isWhatsAppLiveMessage(message)) {
    void forwardMessage(message.payload).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  if (isPollCommandsMessage(message)) {
    void listCommands().then(
      (body) => sendResponse(body),
      () => sendResponse({ commands: [], allowSend: false }),
    );
    return true;
  }
  if (isAckCommandMessage(message)) {
    void acknowledge(message.id).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  if (isPopupScanMessage(message)) {
    void scanCurrentWhatsAppTab(message.mode === "all" ? "all" : "current").then(
      (result) => sendResponse({ result }),
      (error: unknown) => sendResponse({ result: error instanceof Error ? error.message : "scan failed" }),
    );
    return true;
  }
  return false;
});

async function liveHeaders(): Promise<Record<string, string>> {
  const settings = await loadSettings();
  return {
    "content-type": "application/json",
    ...(settings.apiKey ? { "x-regenic-live-key": settings.apiKey } : {}),
  };
}

async function resolveInstallationId(): Promise<string | null> {
  const settings = await loadSettings();
  if (settings.installationId) {
    return settings.installationId;
  }
  const response = await fetch(`${settings.apiOrigin}/v1/me/engine`, {
    headers: await liveHeaders(),
  });
  if (!response.ok) {
    return null;
  }
  const body = await response.json() as {
    installations?: Array<{ id?: string; connector_type?: string; status?: string }>;
  };
  const found = body.installations?.find(
    (item) => item.connector_type === CONNECTOR_TYPE && item.status === "enabled" && item.id,
  );
  return found?.id ?? null;
}

async function connectorUrl(path: string): Promise<string> {
  const settings = await loadSettings();
  const installationId = await resolveInstallationId();
  if (!installationId) {
    throw new Error("WhatsApp Web connector is not installed");
  }
  return `${settings.apiOrigin}/v1/me/connectors/${encodeURIComponent(installationId)}${path}`;
}

async function forwardMessage(payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(await connectorUrl("/webhook"), {
    method: "POST",
    headers: await liveHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`live message rejected: ${response.status}`);
  }
}

async function listCommands(): Promise<{ commands: unknown[]; allowSend: boolean }> {
  const settings = await loadSettings();
  const response = await fetch(await connectorUrl("/egress"), {
    headers: await liveHeaders(),
  });
  if (!response.ok) {
    return { commands: [], allowSend: settings.allowSend };
  }
  const body = await response.json() as { commands?: unknown[] };
  return {
    commands: Array.isArray(body.commands) ? body.commands : [],
    allowSend: settings.allowSend,
  };
}

async function acknowledge(id: string): Promise<void> {
  const response = await fetch(
    await connectorUrl(`/egress/${encodeURIComponent(id)}/ack`),
    { method: "POST", headers: await liveHeaders() },
  );
  if (!response.ok) {
    throw new Error(`ack rejected: ${response.status}`);
  }
}

function isWhatsAppLiveMessage(value: unknown): value is WhatsAppLiveMessage {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "regenic.whatsapp.message"
    && typeof (value as { payload?: unknown }).payload === "object"
    && (value as { payload?: unknown }).payload !== null,
  );
}

function isPollCommandsMessage(value: unknown): value is PollCommandsMessage {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "regenic.whatsapp.pollCommands",
  );
}

function isAckCommandMessage(value: unknown): value is AckCommandMessage {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "regenic.whatsapp.ack"
    && typeof (value as { id?: unknown }).id === "string"
    && (value as { id: string }).id.trim(),
  );
}

function isPopupScanMessage(value: unknown): value is PopupScanMessage {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "regenic.whatsapp.popupScan",
  );
}

const SCRIPT_READY_MS = 5_000;
const SCRIPT_POLL_MS = 80;

async function scanCurrentWhatsAppTab(mode: "current" | "all" = "current"): Promise<string> {
  if (!chrome.scripting?.executeScript) {
    return "scripting API unavailable";
  }
  const tab = await whatsAppTab();
  if (!tab?.id) {
    return "open WhatsApp tab first";
  }
  await focusTab(tab.id);
  const existing = await pingContentScript(tab.id);
  if (existing === CONTENT_SCRIPT_PROTOCOL) {
    return connectedScan(tab.id, mode);
  }
  let injectionError = "content script did not respond after injection";
  try {
    await injectContentScript(tab.id);
    if (await waitForContentScript(tab.id, SCRIPT_READY_MS)) {
      return connectedScan(tab.id, mode);
    }
  } catch (error) {
    injectionError = error instanceof Error ? error.message : String(error);
  }
  const [result] = await executePageProbe(tab.id);
  const probe = typeof result?.result === "string" ? result.result : chrome.runtime.lastError?.message ?? "no result";
  return `one-shot no ingest (${injectionError}): ${probe}`;
}

async function connectedScan(tabId: number, mode: "current" | "all"): Promise<string> {
  const response = await requestContentScriptScan(tabId, mode);
  if (response?.protocol === CONTENT_SCRIPT_PROTOCOL) {
    return `connected: ${response.result ?? "scan complete"}`;
  }
  return `one-shot no ingest (content script did not respond after injection): scan skipped`;
}

async function pingContentScript(tabId: number): Promise<number | null> {
  const response = await sendTabMessage(tabId, { type: "regenic.whatsapp.ping" });
  return typeof response?.protocol === "number" ? response.protocol : null;
}

async function waitForContentScript(tabId: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await pingContentScript(tabId) === CONTENT_SCRIPT_PROTOCOL) {
      return true;
    }
    await delay(SCRIPT_POLL_MS);
  }
  return (await pingContentScript(tabId)) === CONTENT_SCRIPT_PROTOCOL;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function whatsAppTab(): Promise<BrowserTab | null> {
  const [active] = await queryTabs({ active: true, currentWindow: true });
  if (active?.id && isWhatsAppTabUrl(active.url)) {
    return active;
  }
  const matches = await queryTabs({ url: "https://web.whatsapp.com/*" });
  return matches.find((tab) => tab.id) ?? null;
}

function isWhatsAppTabUrl(url: string | undefined): boolean {
  return Boolean(url?.startsWith("https://web.whatsapp.com/"));
}

function queryTabs(queryInfo: {
  active?: boolean;
  currentWindow?: boolean;
  url?: string | string[];
}): Promise<BrowserTab[]> {
  return new Promise((resolve) => {
    const result = chrome.tabs.query(queryInfo, resolve);
    if (isPromiseLike(result)) {
      result.then(resolve, () => resolve([]));
    }
  });
}

function focusTab(tabId: number): Promise<void> {
  const updateTab = chrome.tabs.update;
  if (!updateTab) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const result = updateTab(tabId, { active: true }, () => resolve());
    if (isPromiseLike(result)) {
      result.then(() => resolve(), () => resolve());
    }
  });
}

function requestContentScriptScan(
  tabId: number,
  mode: "current" | "all" = "current",
): Promise<PageScanResponse | null> {
  return sendTabMessage(tabId, { type: "regenic.whatsapp.scan", mode });
}

function sendTabMessage(tabId: number, message: unknown): Promise<PageScanResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PageScanResponse | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const result = chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime.lastError;
        finish(error ? null : response ?? null);
      });
      if (isPromiseLike(result)) {
        result.then((response) => finish(response ?? null), () => finish(null));
      }
    } catch {
      finish(null);
    }
  });
}

function injectContentScript(tabId: number): Promise<void> {
  return executeScript(tabId, { files: ["inject-loader.js"] }).then(() => undefined);
}

function executePageProbe(tabId: number): Promise<Array<{ result?: unknown }>> {
  return executeScript(tabId, { func: pageProbe });
}

function executeScript(
  tabId: number,
  injection: { files: string[] } | { func: () => unknown },
): Promise<Array<{ result?: unknown }>> {
  return new Promise((resolve, reject) => {
    if (!chrome.scripting?.executeScript) {
      reject(new Error("scripting API unavailable"));
      return;
    }
    let settled = false;
    const succeed = (value: Array<{ result?: unknown }> = []) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const result = chrome.scripting.executeScript(
      { target: { tabId }, world: "ISOLATED", ...injection },
      (results) => {
        const error = chrome.runtime.lastError;
        if (error) {
          fail(new Error(error.message ?? "content script injection failed"));
        } else {
          succeed(results ?? []);
        }
      },
    );
    if (isPromiseLike(result)) {
      result.then(succeed, fail);
    }
  });
}

function pageProbe(): string {
  const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
  const isPresence = (value: string) =>
    /^(last seen|online|typing|recording|click here)/i.test(value)
    || /^last seen /i.test(value)
    || /^(最后一次出现|最后上线|在线|正在输入|正在录音|点击这里)/.test(value);
  const header = Array.from(document.querySelectorAll<HTMLElement>("header"))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .sort((left, right) => right.getBoundingClientRect().left - left.getBoundingClientRect().left)[0];
  const explicitTitle = normalizeText(
    header?.querySelector<HTMLElement>('[data-testid="conversation-info-header-chat-title"]')?.innerText ?? "",
  );
  const title = (header?.innerText ?? header?.textContent ?? "")
    .split(/\r?\n/)
    .map(normalizeText)
    .filter((candidate) => candidate && !isPresence(candidate) && !candidate.startsWith("ic-"));
  const chatTitle = explicitTitle
    || (title.length > 1 && /^[A-Z]$/.test(title[0]) ? title[1] : title[0])
    || "active-chat";
  const visible = Array.from(document.querySelectorAll<HTMLElement>("span.selectable-text"))
    .filter((element) => Boolean(element.closest("[data-pre-plain-text]")))
    .map((element) => normalizeText(element.innerText || element.textContent || ""))
    .filter(Boolean)
    .length;
  return `visible ${visible} in ${chatTitle}; not ingested`;
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}
