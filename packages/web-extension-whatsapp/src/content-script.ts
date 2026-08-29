import {
  commandTargetsActiveChat as commandTargetsChat,
  firstChatTitleFromLines,
  isFromMeByDataId,
  isSendAriaLabel,
  normalize,
  parseWhatsAppChatId,
  parseWhatsAppDataId,
  parseWhatsAppTimestamp,
  stableMessageId as pageStableMessageId,
} from "./page-logic.js";

interface SendCommand {
  id: string;
  chat_id: string;
  text: string;
  send_now: boolean;
  delay_ms: number;
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
    sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
  };
};

const CONTENT_SCRIPT_PROTOCOL = 8;
const CLIENT_ID = "regenic-whatsapp-web-extension";
const SEND_ATTEMPTS_KEY = "whatsAppSendAttempts";
const MAX_SEND_ATTEMPTS = 200;
const seenMessages = new Set<string>();
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

function observeMessages(): MutationObserver {
  const observer = new MutationObserver(() => scanVisibleMessages());
  observer.observe(document.body, { childList: true, subtree: true });
  scanVisibleMessages();
  return observer;
}

function scanVisibleMessages(): string {
  const chat = activeChat();
  if (!chat) {
    return "no WhatsApp chat id";
  }
  const messages = visibleMessages();
  let sent = 0;
  for (const message of messages) {
    const text = message.text;
    if (!text) {
      continue;
    }
    const parsed = parseWhatsAppDataId(dataIdOf(message.element));
    const chatId = parsed?.chat_id ?? parseWhatsAppChatId(dataIdOf(message.element));
    if (!chatId || chatId !== chat.id) {
      continue;
    }
    const fromMe = parsed?.from_me ?? isFromMe(message.element);
    const messageId = parsed?.message_id || stableMessageId(chatId, text, fromMe, message.element);
    const seenKey = `${chatId}:${messageId}`;
    if (seenMessages.has(seenKey)) {
      continue;
    }
    seenMessages.add(seenKey);
    const senderId = fromMe
      ? "local-owner"
      : extractSenderJid(message.element, chatId) ?? (chatId.endsWith("@g.us") ? "" : chatId);
    if (!fromMe && !senderId) {
      continue;
    }
    sent += 1;
    void postLiveMessage({
      client_id: CLIENT_ID,
      chat_id: chatId,
      chat_title: chat.title,
      message_id: messageId,
      sender_id: senderId,
      sender_name: fromMe ? "You" : chat.title,
      text,
      timestamp: messageTimestamp(message.element),
      from_me: fromMe,
      message_kind: "user",
    });
  }
  return `sent ${sent} new / ${messages.length} visible from ${chat.title}`;
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
    const response = await sendBackgroundMessage({ type: "regenic.whatsapp.pollCommands" }) as {
      commands?: SendCommand[];
      allowSend?: boolean;
    } | undefined;
    const commands = response?.commands ?? [];
    const allowSend = response?.allowSend === true;
    for (const command of commands) {
      const previousAttempt = await sendAttempt(command.id);
      if (previousAttempt) {
        if (wasSendDelivered(command, previousAttempt)) {
          await acknowledge(command.id);
        }
        continue;
      }
      const executed = await executeCommand(command, allowSend);
      if (executed) {
        await acknowledge(command.id);
      }
    }
  } catch {
    // Keep the observer alive; local API or extension reload failures are transient.
  } finally {
    pollingCommands = false;
  }
}

async function executeCommand(command: SendCommand, allowSend: boolean): Promise<boolean> {
  if (!commandTargetsActiveChat(command.chat_id)) {
    return false;
  }
  if (command.delay_ms > 0) {
    await delay(command.delay_ms);
  }
  if (!commandTargetsActiveChat(command.chat_id)) {
    return false;
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
    if (!commandTargetsActiveChat(command.chat_id)) {
      return false;
    }
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
    if (!commandTargetsActiveChat(command.chat_id)) {
      return false;
    }
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

function commandTargetsActiveChat(commandChatId: string): boolean {
  return commandTargetsChat(commandChatId, activeChat()?.id);
}

function matchingOutgoingMessageIds(text: string): string[] {
  const expectedText = normalize(text);
  const chatId = activeChat()?.id;
  if (!chatId) {
    return [];
  }
  return visibleMessages()
    .filter((message) => isFromMe(message.element) && normalize(message.text) === expectedText)
    .map((message) => stableMessageId(chatId, message.text, true, message.element));
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
    value
    && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string"
    && Array.isArray((value as { existing_message_ids?: unknown }).existing_message_ids),
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

async function acknowledge(id: string): Promise<void> {
  await sendBackgroundMessage({ type: "regenic.whatsapp.ack", id });
}

function activeChat(): { id: string; title: string } | null {
  for (const message of visibleMessages()) {
    const parsed = parseWhatsAppDataId(dataIdOf(message.element));
    const chatId = parsed?.chat_id ?? parseWhatsAppChatId(dataIdOf(message.element));
    if (chatId) {
      return {
        id: chatId,
        title: firstChatTitle(rightmostVisibleHeader()) ?? chatId,
      };
    }
  }
  return null;
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
  return firstChatTitleFromLines(
    header?.querySelector<HTMLElement>('[data-testid="conversation-info-header-chat-title"]')?.innerText ?? "",
    (header?.innerText ?? header?.textContent ?? "").split(/\r?\n/),
  );
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

function messageTimestamp(element: HTMLElement): string {
  const context = element.getAttribute("data-pre-plain-text")
    ?? element.closest("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text")
    ?? "";
  return parseWhatsAppTimestamp(context);
}

function isFromMe(element: HTMLElement): boolean {
  if (element.closest("div.message-out")) {
    return true;
  }
  const dataId = dataIdOf(element);
  const parsed = parseWhatsAppDataId(dataId);
  if (parsed) {
    return parsed.from_me;
  }
  if (isFromMeByDataId(dataId)) {
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
  const icon = document.querySelector<HTMLElement>('footer span[data-icon="send"]');
  if (icon) {
    return icon.closest("button");
  }
  return Array.from(document.querySelectorAll<HTMLElement>("footer button[aria-label]"))
    .find((button) => isSendAriaLabel(button.getAttribute("aria-label")))
    ?? null;
}

function stableMessageId(chatId: string, text: string, fromMe: boolean, element: HTMLElement): string {
  return pageStableMessageId({
    chatId,
    text,
    fromMe,
    dataId: dataIdOf(element),
    messageContext: element.getAttribute("data-pre-plain-text")
      ?? element.closest("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text")
      ?? "",
  });
}

function dataIdOf(element: HTMLElement): string {
  return (
    element.getAttribute("data-id")
    ?? element.closest<HTMLElement>("[data-id]")?.getAttribute("data-id")
    ?? ""
  ).trim();
}

function extractSenderJid(element: HTMLElement, chatId: string): string | undefined {
  let node: HTMLElement | null = element;
  for (let depth = 0; node && depth < 8; depth += 1) {
    for (const name of node.getAttributeNames()) {
      const parsed = parseWhatsAppChatId(node.getAttribute(name) ?? undefined);
      if (parsed && parsed !== chatId && !parsed.endsWith("@g.us")) {
        return parsed;
      }
    }
    node = node.parentElement;
  }
  return undefined;
}

async function postLiveMessage(payload: Record<string, unknown>): Promise<void> {
  await sendBackgroundMessage({ type: "regenic.whatsapp.message", payload });
}

async function sendBackgroundMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const result = chrome.runtime.sendMessage(message, resolve);
      if (isPromiseLike(result)) {
        result.then(resolve, () => resolve(undefined));
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Extension context invalidated")) {
        extensionContextValid = false;
      }
      resolve(undefined);
    }
  });
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
