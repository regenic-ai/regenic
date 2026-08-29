import { type ExtensionSettings, loadSettings } from "./chrome-api.js";

interface WhatsAppLiveMessage {
  type: "regenic.whatsapp.message";
  payload: Record<string, unknown>;
}

interface PopupScanMessage {
  type: "regenic.whatsapp.popupScan";
  settings: ExtensionSettings;
}

interface BrowserTab {
  id?: number;
  url?: string;
}

interface ScriptInjectionResult {
  result?: string;
}

interface PageScanResponse {
  result?: string;
  protocol?: number;
}

const CONTENT_SCRIPT_PROTOCOL = 6;

declare const chrome: {
  runtime: {
    lastError?: { message?: string };
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: { result: string }) => void,
        ) => boolean | void,
      ): void;
    };
  };
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }, callback?: (tabs: BrowserTab[]) => void): Promise<BrowserTab[]> | void;
    sendMessage(
      tabId: number,
      message: unknown,
      callback?: (response: PageScanResponse) => void,
    ): Promise<PageScanResponse> | void;
  };
  scripting?: {
    executeScript(
      injection:
        | { target: { tabId: number }; files: string[] }
        | { target: { tabId: number }; func: (apiOrigin: string, apiKey: string) => Promise<string>; args: string[] },
      callback?: (results: ScriptInjectionResult[]) => void,
    ): Promise<ScriptInjectionResult[]> | void;
  };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isWhatsAppLiveMessage(message)) {
    void forwardMessage(message.payload);
    return false;
  }
  if (isPopupScanMessage(message)) {
    void scanCurrentWhatsAppTab(message.settings).then(
      (result) => sendResponse({ result }),
      (error: unknown) => sendResponse({ result: error instanceof Error ? error.message : "scan failed" }),
    );
    return true;
  }
  return false;
});

async function forwardMessage(payload: Record<string, unknown>): Promise<void> {
  const settings = await loadSettings();
  await fetch(`${settings.apiOrigin}/v1/me/live/whatsapp/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { "x-regenic-live-key": settings.apiKey } : {}),
    },
    body: JSON.stringify(payload),
  });
}

function isWhatsAppLiveMessage(value: unknown): value is WhatsAppLiveMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "regenic.whatsapp.message" &&
      typeof (value as { payload?: unknown }).payload === "object" &&
      (value as { payload?: unknown }).payload !== null,
  );
}

function isPopupScanMessage(value: unknown): value is PopupScanMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "regenic.whatsapp.popupScan" &&
      typeof (value as { settings?: unknown }).settings === "object" &&
      (value as { settings?: unknown }).settings !== null,
  );
}

async function scanCurrentWhatsAppTab(settings: ExtensionSettings): Promise<string> {
  if (!chrome.scripting?.executeScript) {
    return "scripting API unavailable";
  }
  const [tab] = await activeTabs();
  if (!tab?.id) {
    return "no active tab";
  }
  if (!tab.url?.startsWith("https://web.whatsapp.com/")) {
    return "open WhatsApp tab first";
  }
  const existingConnection = await requestContentScriptScan(tab.id);
  if (existingConnection?.protocol === CONTENT_SCRIPT_PROTOCOL) {
    return `connected: ${existingConnection.result ?? "scan complete"}`;
  }
  let injectionError = "content script did not respond after injection";
  try {
    await injectContentScript(tab.id);
    const newConnection = await requestContentScriptScan(tab.id);
    if (newConnection?.protocol === CONTENT_SCRIPT_PROTOCOL) {
      return `connected: ${newConnection.result ?? "scan complete"}`;
    }
  } catch (error) {
    injectionError = error instanceof Error ? error.message : String(error);
  }
  const [result] = await executePageProbe(tab.id, settings);
  return `one-shot (${injectionError}): ${result?.result ?? chrome.runtime.lastError?.message ?? "no result"}`;
}

function activeTabs(): Promise<BrowserTab[]> {
  return new Promise((resolve) => {
    const result = chrome.tabs.query({ active: true, currentWindow: true }, resolve);
    if (isPromiseLike(result)) {
      result.then(resolve, () => resolve([]));
    }
  });
}

function requestContentScriptScan(tabId: number): Promise<PageScanResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PageScanResponse | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const result = chrome.tabs.sendMessage(tabId, { type: "regenic.whatsapp.scan" }, (response) => {
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
  return new Promise((resolve, reject) => {
    if (!chrome.scripting?.executeScript) {
      reject(new Error("scripting API unavailable"));
      return;
    }
    let settled = false;
    const succeed = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const result = chrome.scripting.executeScript(
      { target: { tabId }, files: ["content-script.js"] },
      () => {
        const error = chrome.runtime.lastError;
        if (error) {
          fail(new Error(error.message ?? "content script injection failed"));
        } else {
          succeed();
        }
      },
    );
    if (isPromiseLike(result)) {
      result.then(succeed, fail);
    }
  });
}

function executePageProbe(tabId: number, settings: ExtensionSettings): Promise<ScriptInjectionResult[]> {
  return new Promise((resolve, reject) => {
    const result = chrome.scripting?.executeScript(
      {
        target: { tabId },
        func: pageProbe,
        args: [settings.apiOrigin, settings.apiKey],
      },
      resolve,
    );
    if (isPromiseLike(result)) {
      result.then(resolve, reject);
    }
  });
}

async function pageProbe(apiOrigin: string, apiKey: string): Promise<string> {
  const headers = {
    "content-type": "application/json",
    ...(apiKey ? { "x-regenic-live-key": apiKey } : {}),
  };
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._@-]+/g, "-").replace(/^-|-$/g, "") || "active-chat";
  const hash = (value: string) => {
    let result = 0;
    for (let index = 0; index < value.length; index += 1) {
      result = Math.imul(31, result) + value.charCodeAt(index) | 0;
    }
    return String(Math.abs(result));
  };
  const isPresenceText = (value: string) => /^(last seen|online|typing|recording|click here)/i.test(value) || /^last seen /i.test(value);
  const header = Array.from(document.querySelectorAll<HTMLElement>("header"))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .sort((left, right) => right.getBoundingClientRect().left - left.getBoundingClientRect().left)[0];
  const explicitTitle = normalize(
    header?.querySelector<HTMLElement>('[data-testid="conversation-info-header-chat-title"]')?.innerText ?? "",
  );
  const title = (header?.innerText ?? header?.textContent ?? "")
    .split(/\r?\n/)
    .map(normalize)
    .filter((candidate) => candidate && !isPresenceText(candidate) && !candidate.startsWith("ic-"));
  const chatTitle = explicitTitle
    || (title.length > 1 && /^[A-Z]$/.test(title[0]) ? title[1] : title[0])
    || "active-chat";
  const chatId = slug(chatTitle);
  const post = async (payload: Record<string, unknown>) => {
    await fetch(`${apiOrigin}/v1/me/live/whatsapp/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  };
  const stamp = new Date().toISOString();
  await post({
    client_id: "regenic-whatsapp-popup-probe",
    chat_id: "extension-diagnostics",
    chat_title: "Extension Diagnostics",
    message_id: `popup-probe-${Date.now()}`,
    sender_id: "whatsapp-web-live-connector",
    sender_name: "WhatsApp",
    text: `Regenic WhatsApp popup page probe ready at ${stamp}`,
    timestamp: stamp,
    from_me: false,
    message_kind: "system",
  });
  const texts = Array.from(document.querySelectorAll<HTMLElement>("span.selectable-text"))
    .filter((element) => Boolean(element.closest("[data-pre-plain-text]")))
    .map((element) => normalize(element.innerText || element.textContent || ""))
    .filter(Boolean)
    .slice(-20);
  let sent = 0;
  for (const [index, text] of texts.entries()) {
    await post({
      client_id: "regenic-whatsapp-popup-probe",
      chat_id: chatId,
      chat_title: chatTitle,
      message_id: `popup-probe-${hash(`${chatId}:${index}:${text}`)}`,
      sender_id: chatId,
      sender_name: chatTitle,
      text,
      timestamp: new Date().toISOString(),
      from_me: false,
      message_kind: "user",
    });
    sent += 1;
  }
  return `sent ${sent} from ${chatTitle}`;
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}