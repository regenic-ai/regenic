import { normalizeLoopbackApiOrigin } from "./page-logic.js";

export interface ExtensionSettings {
  apiOrigin: string;
  apiKey: string;
  installationId: string;
  allowSend: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiOrigin: "http://127.0.0.1:4370",
  apiKey: "",
  installationId: "",
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
    apiOrigin: normalizeLoopbackApiOrigin(
      typeof stored.apiOrigin === "string" ? stored.apiOrigin : undefined,
      DEFAULT_SETTINGS.apiOrigin,
    ),
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey : "",
    installationId: typeof stored.installationId === "string" ? stored.installationId.trim() : "",
    allowSend: stored.allowSend === true,
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await storageSet({
    ...settings,
    apiOrigin: normalizeLoopbackApiOrigin(settings.apiOrigin, DEFAULT_SETTINGS.apiOrigin),
  });
}

export type EngineLinkKind =
  | "needs_pairing"
  | "offline"
  | "blocked"
  | "not_installed"
  | "connected";

export async function probeEngineLink(
  settings?: ExtensionSettings,
): Promise<{ kind: EngineLinkKind; status?: number }> {
  const current = settings ?? (await loadSettings());
  if (!current.apiKey.trim()) {
    return { kind: "needs_pairing" };
  }
  try {
    const response = await fetch(`${current.apiOrigin}/v1/me/engine`, {
      headers: { "x-regenic-live-key": current.apiKey },
    });
    if (!response.ok) {
      return { kind: "blocked", status: response.status };
    }
    const body = (await response.json()) as {
      installations?: Array<{ connector_type?: string; status?: string }>;
    };
    const found = body.installations?.some(
      (item) => item.connector_type === "whatsapp-web-live" && item.status === "enabled",
    );
    return found ? { kind: "connected" } : { kind: "not_installed" };
  } catch {
    return { kind: "offline" };
  }
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

export async function scanActiveWhatsAppPage(mode: "current" | "all" = "all"): Promise<string> {
  const response = await sendRuntimeMessage({ type: "regenic.whatsapp.popupScan", mode });
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
