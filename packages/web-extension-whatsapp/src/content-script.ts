interface SendCommand {
  id: string;
  chat_id: string;
  text: string;
  send_now: boolean;
  delay_ms: number;
}

interface ExtensionSettings {
  apiOrigin: string;
  apiKey: string;
  allowSend: boolean;
}

interface SendAttempt {
  id: string;
  existing_message_ids: string[];
}

declare const chrome: {
  storage: {
    local: {
      get(keys: object, callback?: (values: Record<string, unknown>) => void): Promise<Record<string, unknown>> | void;
      set(values: object, callback?: () => void): Promise<void> | void;
    };
  };
  runtime: {
    lastError?: { message?: string };
    onMessage: {
      addListener(listener: (message: unknown, sender: unknown, sendResponse: (response: { result: string }) => void) => boolean | void): void;
      removeListener(listener: (message: unknown, sender: unknown, sendResponse: (response: { result: string; protocol?: number }) => void) => boolean | void): void;
    };
  };
};

{
const CONTENT_SCRIPT_PROTOCOL = 6;
const CLIENT_ID = "regenic-whatsapp-web-extension";
const SEND_ATTEMPTS_KEY = "whatsAppSendAttempts";
const MAX_SEND_ATTEMPTS = 200;
const DEFAULT_SETTINGS: ExtensionSettings = {
  apiOrigin: "http://127.0.0.1:4370",
  apiKey: "",
  allowSend: false,
};
const seenMessages = new Set<string>();
const announcedChats = new Set<string>();
let pollingCommands = false;
let extensionContextValid = true;

const connectorGlobal = globalThis as typeof globalThis & {
  __regenicWhatsAppConnector?: { dispose(): void; protocol: number };
};
connectorGlobal.__regenicWhatsAppConnector?.dispose();
const scanMessageListener = listenForScanRequests();
const messageObserver = observeMessages();
const scanInterval = window.setInterval(scanVisibleMessages, 2_500);
const commandInterval = window.setInterval(() => void pollCommands(), 2_500);
connectorGlobal.__regenicWhatsAppConnector = {
  protocol: CONTENT_SCRIPT_PROTOCOL,
  dispose() {
    extensionContextValid = false;
    messageObserver.disconnect();
    window.clearInterval(scanInterval);
    window.clearInterval(commandInterval);
    try {
      chrome.runtime.onMessage.removeListener(scanMessageListener);
    } catch {
      // The previous listener may belong to an invalidated extension context.
    }
  },
};
void announceScriptReady();

function listenForScanRequests() {
  const listener = (message: unknown, _sender: unknown, sendResponse: (response: { result: string; protocol?: number }) => void) => {
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "regenic.whatsapp.scan") {
      return false;
    }
    sendResponse({ result: scanVisibleMessages(), protocol: CONTENT_SCRIPT_PROTOCOL });
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return listener;
}

async function announceScriptReady(): Promise<void> {
  await postLiveMessage({
    client_id: CLIENT_ID,
    chat_id: "extension-diagnostics",
    chat_title: "Extension Diagnostics",
    message_id: `script-ready-${Date.now()}`,
    sender_id: "whatsapp-web-live-connector",
    sender_name: "WhatsApp",
    text: `Regenic WhatsApp content script ready at ${new Date().toISOString()}`,
    timestamp: new Date().toISOString(),
    from_me: false,
    message_kind: "system",
  });
}

function observeMessages(): MutationObserver {
  const observer = new MutationObserver(() => scanVisibleMessages());
  observer.observe(document.body, { childList: true, subtree: true });
  scanVisibleMessages();
  return observer;
}

function scanVisibleMessages(): string {
  const chat = activeChat();
  if (!chat) {
    return "no active chat";
  }
  announceChat(chat);
  const messages = visibleMessages();
  let sent = 0;
  for (const message of messages) {
    const text = message.text;
    if (!text) {
      continue;
    }
    const fromMe = isFromMe(message.element);
    const messageId = stableMessageId(chat.id, text, fromMe, message.element);
    if (seenMessages.has(messageId)) {
      continue;
    }
    seenMessages.add(messageId);
    sent += 1;
    void postLiveMessage({
      client_id: CLIENT_ID,
      chat_id: chat.id,
      chat_title: chat.title,
      message_id: messageId,
      sender_id: fromMe ? "local-user" : chat.id,
      sender_name: fromMe ? "You" : chat.title,
      text,
      timestamp: new Date().toISOString(),
      from_me: fromMe,
      message_kind: "user",
    });
  }
  return `sent ${sent} new / ${messages.length} visible from ${chat.title}`;
}

function announceChat(chat: { id: string; title: string }): void {
  if (announcedChats.has(chat.id)) {
    return;
  }
  announcedChats.add(chat.id);
  void postLiveMessage({
    client_id: CLIENT_ID,
    chat_id: chat.id,
    chat_title: chat.title,
    message_id: `attached-${Date.now()}`,
    sender_id: "whatsapp-web-live-connector",
    sender_name: "WhatsApp",
    text: `Regenic live connector attached to ${chat.title}`,
    timestamp: new Date().toISOString(),
    from_me: false,
    message_kind: "system",
  });
}

async function pollCommands(): Promise<void> {
  if (!extensionContextValid) {
    return;
  }
  if (pollingCommands) {
    return;
  }
  pollingCommands = true;
  try {
    const settings = await loadSettings();
    const response = await fetch(
      `${settings.apiOrigin}/v1/me/live/whatsapp/commands?client_id=${encodeURIComponent(CLIENT_ID)}`,
      { headers: settings.apiKey ? { "x-regenic-live-key": settings.apiKey } : {} },
    );
    if (!response.ok) {
      return;
    }
    const body = await response.json() as { commands?: SendCommand[] };
    for (const command of body.commands ?? []) {
      const previousAttempt = await sendAttempt(command.id);
      if (previousAttempt) {
        if (wasSendDelivered(command, previousAttempt)) {
          await acknowledge(command.id, settings);
        }
        continue;
      }
      const executed = await executeCommand(command, settings.allowSend);
      if (executed) {
        await acknowledge(command.id, settings);
      }
    }
  } catch {
    // Keep the observer alive; local API or extension reload failures are transient.
  } finally {
    pollingCommands = false;
  }
}

async function executeCommand(command: SendCommand, allowSend: boolean): Promise<boolean> {
  const chat = activeChat();
  if (!chat || chat.id !== command.chat_id) {
    return false;
  }
  if (command.delay_ms > 0) {
    await delay(command.delay_ms);
  }
  const input = composer();
  if (!input) {
    return false;
  }
  const expectedText = normalize(command.text);
  const currentText = normalize(input.innerText || input.textContent || "");
  if (currentText && currentText !== expectedText) {
    return false;
  }
  if (currentText !== expectedText) {
    input.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, command.text);
    await delay(0);
    if (normalize(input.innerText || input.textContent || "") !== expectedText) {
      return false;
    }
  }
  if (command.send_now && allowSend) {
    const button = sendButton();
    if (!button) {
      return false;
    }
    const attempt: SendAttempt = {
      id: command.id,
      existing_message_ids: matchingOutgoingMessageIds(command.text),
    };
    if (!await markSendAttempt(attempt)) {
      return false;
    }
    button.click();
    for (let check = 0; check < 20; check += 1) {
      await delay(250);
      if (wasSendDelivered(command, attempt)) {
        return true;
      }
    }
    return false;
  }
  return true;
}

function matchingOutgoingMessageIds(text: string): string[] {
  const expectedText = normalize(text);
  return visibleMessages()
    .filter((message) => isFromMe(message.element) && normalize(message.text) === expectedText)
    .map((message) => stableMessageId(activeChat()?.id ?? "active-chat", message.text, true, message.element));
}

function wasSendDelivered(command: SendCommand, attempt: SendAttempt): boolean {
  const previous = new Set(attempt.existing_message_ids);
  return matchingOutgoingMessageIds(command.text).some((id) => !previous.has(id));
}

async function sendAttempt(id: string): Promise<SendAttempt | undefined> {
  return (await sendAttempts()).find((attempt) => attempt.id === id);
}

async function sendAttempts(): Promise<SendAttempt[]> {
  const stored = await storageGet({ [SEND_ATTEMPTS_KEY]: [] });
  if (!Array.isArray(stored[SEND_ATTEMPTS_KEY])) {
    return [];
  }
  return stored[SEND_ATTEMPTS_KEY].filter((value): value is SendAttempt => Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    Array.isArray((value as { existing_message_ids?: unknown }).existing_message_ids),
  ));
}

async function markSendAttempt(attempt: SendAttempt): Promise<boolean> {
  const attempts = await sendAttempts();
  if (attempts.some((item) => item.id === attempt.id)) {
    return true;
  }
  return storageSet({
    [SEND_ATTEMPTS_KEY]: [...attempts.slice(-(MAX_SEND_ATTEMPTS - 1)), attempt],
  });
}

async function acknowledge(id: string, settings: { apiOrigin: string; apiKey: string }): Promise<void> {
  await fetch(`${settings.apiOrigin}/v1/me/live/whatsapp/commands/${encodeURIComponent(id)}/ack`, {
    method: "POST",
    headers: settings.apiKey ? { "x-regenic-live-key": settings.apiKey } : {},
  });
}

function activeChat(): { id: string; title: string } | null {
  const header = rightmostVisibleHeader();
  const title = firstChatTitle(header);
  if (!title) {
    return null;
  }
  return { id: slug(title), title };
}

function rightmostVisibleHeader(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>("header"))
    .filter((header) => {
      const rect = header.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .sort((left, right) => right.getBoundingClientRect().left - left.getBoundingClientRect().left)[0] ?? null;
}

function firstChatTitle(header: HTMLElement | null): string | null {
  const explicitTitle = normalize(
    header?.querySelector<HTMLElement>('[data-testid="conversation-info-header-chat-title"]')?.innerText ?? "",
  );
  if (explicitTitle) {
    return explicitTitle;
  }
  const lines = (header?.innerText ?? header?.textContent ?? "").split(/\r?\n/).map(normalize).filter(Boolean);
  const candidates = lines.filter((candidate) => !isPresenceText(candidate) && !candidate.startsWith("ic-"));
  if (candidates.length > 1 && /^[A-Z]$/.test(candidates[0])) {
    return candidates[1];
  }
  return candidates[0] ?? null;
}

function isPresenceText(value: string): boolean {
  return /^(last seen|online|typing|recording|click here)/i.test(value) || /^last seen /i.test(value);
}

function visibleMessages(): Array<{ element: HTMLElement; text: string }> {
  const spans = Array.from(document.querySelectorAll<HTMLElement>("span.selectable-text"));
  const messages: Array<{ element: HTMLElement; text: string }> = [];
  const seen = new Set<HTMLElement>();
  for (const span of spans) {
    const element = messageElementFor(span);
    if (!element || seen.has(element)) {
      continue;
    }
    seen.add(element);
    const text = normalize(span.innerText || span.textContent || "");
    if (text) {
      messages.push({ element, text });
    }
  }
  return messages;
}

function messageElementFor(span: HTMLElement): HTMLElement | null {
  return span.closest<HTMLElement>("[data-pre-plain-text], div.message-in, div.message-out, [data-id]");
}

function isFromMe(element: HTMLElement): boolean {
  if (element.closest("div.message-out")) {
    return true;
  }
  const dataId = element.getAttribute("data-id") ?? element.closest<HTMLElement>("[data-id]")?.getAttribute("data-id") ?? "";
  if (dataId.startsWith("true_") || dataId.includes("_true_")) {
    return true;
  }
  let ancestor: HTMLElement | null = element;
  while (ancestor && ancestor !== document.body) {
    const style = window.getComputedStyle(ancestor);
    if (style.display.includes("flex")) {
      if (style.alignItems === "flex-end") {
        return true;
      }
      if (style.alignItems === "flex-start") {
        return false;
      }
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

function composer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('footer div[contenteditable="true"][role="textbox"]');
}

function sendButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('footer button[aria-label="Send"], footer span[data-icon="send"]')?.closest("button") ?? null;
}

function stableMessageId(chatId: string, text: string, fromMe: boolean, element: HTMLElement): string {
  const dataId = element.getAttribute("data-id") ?? element.closest<HTMLElement>("[data-id]")?.getAttribute("data-id");
  const messageContext = element.getAttribute("data-pre-plain-text") ?? "";
  const raw = dataId ?? `${chatId}:${fromMe ? "out" : "in"}:${messageContext}:${text}`;
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = Math.imul(31, hash) + raw.charCodeAt(index) | 0;
  }
  return `${fromMe ? "out" : "in"}-${Math.abs(hash)}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._@-]+/g, "-").replace(/^-|-$/g, "") || "active-chat";
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await storageGet(DEFAULT_SETTINGS);
  return {
    apiOrigin: typeof stored.apiOrigin === "string" && stored.apiOrigin.trim()
      ? stored.apiOrigin.trim().replace(/\/$/, "")
      : DEFAULT_SETTINGS.apiOrigin,
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey : "",
    allowSend: stored.allowSend === true,
  };
}

async function postLiveMessage(payload: Record<string, unknown>): Promise<void> {
  try {
    const settings = await loadSettings();
    await fetch(`${settings.apiOrigin}/v1/me/live/whatsapp/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.apiKey ? { "x-regenic-live-key": settings.apiKey } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Ignore transient localhost/API failures. The next mutation or page reload retries.
  }
}

function storageGet(defaults: object): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    try {
      const result = chrome.storage.local.get(defaults, resolve);
      if (isPromiseLike(result)) {
        result.then(resolve, () => resolve({}));
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Extension context invalidated")) {
        extensionContextValid = false;
      }
      resolve({});
    }
  });
}

function storageSet(values: object): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (succeeded: boolean) => {
      if (!settled) {
        settled = true;
        resolve(succeeded);
      }
    };
    try {
      const result = chrome.storage.local.set(values, () => finish(!chrome.runtime.lastError));
      if (isPromiseLike(result)) {
        result.then(() => finish(true), () => finish(false));
      }
    } catch {
      finish(false);
    }
  });
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
}