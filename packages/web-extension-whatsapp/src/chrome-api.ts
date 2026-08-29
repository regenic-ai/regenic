export interface ExtensionSettings {
  apiOrigin: string;
  apiKey: string;
  allowSend: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiOrigin: "http://127.0.0.1:4370",
  apiKey: "",
  allowSend: false,
};

declare const chrome: {
  storage: {
    local: {
      get(keys: string[] | object, callback?: (values: Record<string, unknown>) => void): Promise<Record<string, unknown>> | void;
      set(values: object, callback?: () => void): Promise<void> | void;
    };
  };
  runtime: {
    lastError?: { message?: string };
    openOptionsPage(): void;
    onMessage: {
      addListener(listener: (message: unknown) => void): void;
    };
    sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
  };
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await storageGet(DEFAULT_SETTINGS);
  return {
    apiOrigin: typeof stored.apiOrigin === "string" && stored.apiOrigin.trim()
      ? stored.apiOrigin.trim().replace(/\/$/, "")
      : DEFAULT_SETTINGS.apiOrigin,
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey : "",
    allowSend: stored.allowSend === true,
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await storageSet(settings);
}

export function openOptionsPage(): void {
  chrome.runtime.openOptionsPage();
}

export function onRuntimeMessage(listener: (message: unknown) => void): void {
  chrome.runtime.onMessage.addListener(listener);
}

export function sendRuntimeMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const result = chrome.runtime.sendMessage(message, resolve);
    if (isPromiseLike(result)) {
      result.then(resolve, () => resolve(undefined));
    }
  });
}

export async function scanActiveWhatsAppPage(settings: ExtensionSettings): Promise<string> {
  const response = await sendRuntimeMessage({ type: "regenic.whatsapp.popupScan", settings });
  if (response && typeof response === "object" && typeof (response as { result?: unknown }).result === "string") {
    return (response as { result: string }).result;
  }
  return chrome.runtime.lastError?.message ?? "no result";
}

function storageGet(defaults: object): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const result = chrome.storage.local.get(defaults, resolve);
    if (isPromiseLike(result)) {
      result.then(resolve, () => resolve({}));
    }
  });
}

function storageSet(values: object): Promise<void> {
  return new Promise((resolve) => {
    const result = chrome.storage.local.set(values, resolve);
    if (isPromiseLike(result)) {
      result.then(resolve, () => resolve());
    }
  });
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}