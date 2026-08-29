import {
  commandTargetsActiveChat as commandTargetsChat,
  firstChatTitleFromLines,
  firstWhatsAppChatIdFromValues,
  isAuthorLabelText,
  isIgnorableChatListTitle,
  isLoadOlderMessagesText,
  isSendAriaLabel,
  jidFromReactLikeValue,
  namedChatFromRecord,
  type NamedWhatsAppChat,
  normalize,
  opaqueWhatsAppLiveMessageId,
  parseWhatsAppChatId,
  parseWhatsAppDataId,
  parseWhatsAppTimestamp,
  phoneDigitsFromDisplayTitle,
  phoneDigitsFromWhatsAppChatId,
  conversationJidFromCandidates,
  liveMessageBelongsToOpenChat,
  chatIdFromPhoneDisplayTitle,
  fromMeFromPrePlainText,
  groupSenderFromDomTexts,
  bubbleLooksOutgoing,
  isIncomingWhatsAppIcon,
  isOutgoingWhatsAppIcon,
  senderNameFromPrePlainText,
  stableGroupParticipantId,
  stableMessageId as pageStableMessageId,
  titlesReferToSameChat,
  uniqueJidForDisplayName,
} from "./page-logic.js";

interface HarvestedChat {
  title: string;
  jid: string | null;
}

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
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: { result?: string; protocol?: number }) => void,
        ) => boolean | void,
      ): void;
      removeListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: { result?: string; protocol?: number }) => void,
        ) => boolean | void,
      ): void;
    };
    sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
  };
};

const CONTENT_SCRIPT_PROTOCOL = 14;
const IDB_DATABASE = "model-storage";
const IDB_STORES = ["chat", "contact", "group-metadata"];
const IDB_MAX_RECORDS = 8_000;
const IDB_TTL_MS = 30_000;
const IDB_TIMEOUT_MS = 3_000;
const MAX_SYNC_CHATS = 50;
const SYNC_GAP_MS = 350;
const KNOWN_CHATS_KEY = "whatsAppKnownChats";
const CLIENT_ID = "regenic-whatsapp-web-extension";
const SEND_ATTEMPTS_KEY = "whatsAppSendAttempts";
const MAX_SEND_ATTEMPTS = 200;
const seenMessages = new Map<string, boolean>();
let pollingCommands = false;
let extensionContextValid = true;
let lastResolvedChat: { id: string; title: string } | null = null;
let namedChatsCache: { at: number; chats: NamedWhatsAppChat[] } | null = null;
let sessionBusy = false;
let paneGeneration = 0;
let lastScanResult = "no open chat";
const knownChatTitles = new Map<string, string>();
const localPushNames = new Set<string>();

const connectorGlobal = globalThis as typeof globalThis & {
  __regenicWhatsAppConnector?: { dispose(): void; protocol: number };
};
connectorGlobal.__regenicWhatsAppConnector?.dispose();
void hydrateKnownChats();
let messageObserver: MutationObserver;
let scanInterval = 0;
let commandInterval = 0;
const scanMessageListener = listenForScanRequests();
connectorGlobal.__regenicWhatsAppConnector = {
  protocol: CONTENT_SCRIPT_PROTOCOL,
  dispose() {
    extensionContextValid = false;
    messageObserver?.disconnect();
    window.clearInterval(scanInterval);
    window.clearInterval(commandInterval);
    try {
      chrome.runtime.onMessage.removeListener(scanMessageListener);
    } catch {
      // The previous listener may belong to an invalidated extension context.
    }
  },
};
messageObserver = observeMessages();
scanInterval = window.setInterval(() => {
  if (!sessionBusy) {
    void scanVisibleMessages();
  }
}, 2_500);
commandInterval = window.setInterval(() => void pollCommands(), 2_500);

function listenForScanRequests() {
  const listener = (
    message: unknown,
    _sender: unknown,
    sendResponse: (response: { result?: string; protocol?: number }) => void,
  ) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const type = (message as { type?: unknown }).type;
    if (type === "regenic.whatsapp.ping") {
      sendResponse({ protocol: CONTENT_SCRIPT_PROTOCOL });
      return false;
    }
    if (type !== "regenic.whatsapp.scan") {
      return false;
    }
    const mode = (message as { mode?: unknown }).mode === "all" ? "all" : "current";
    void (mode === "all" ? syncVisibleChats() : scanVisibleMessages()).then((result) => {
      sendResponse({ result, protocol: CONTENT_SCRIPT_PROTOCOL });
    });
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return listener;
}

function observeMessages(): MutationObserver {
  const observer = new MutationObserver(() => {
    if (!sessionBusy) {
      void scanVisibleMessages();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  void scanVisibleMessages();
  return observer;
}

async function scanVisibleMessages(): Promise<string> {
  if (sessionBusy) {
    return lastScanResult;
  }
  return ingestOpenChat();
}

async function ingestOpenChat(options?: {
  expectedId?: string;
  deepHistory?: boolean;
}): Promise<string> {
  if (!hasOpenConversation()) {
    lastResolvedChat = null;
    lastScanResult = "no open chat";
    return lastScanResult;
  }
  const chat = await resolveActiveChat();
  if (!chat) {
    lastScanResult = "no WhatsApp chat id";
    return lastScanResult;
  }
  if (options?.expectedId && chat.id !== options.expectedId) {
    lastScanResult = "chat changed";
    return lastScanResult;
  }
  void rememberKnownChat(chat.id, chat.title);
  const generation = paneGeneration;
  const stillThisChat = async (): Promise<boolean> => {
    if (generation !== paneGeneration) {
      return false;
    }
    const current = await resolveActiveChat();
    if (!current || current.id !== chat.id) {
      return false;
    }
    const paneJid = chatIdFromVisibleMessages();
    return liveMessageBelongsToOpenChat(chat.id, paneJid);
  };
  if (options?.deepHistory !== false) {
    await revealOlderMessages();
    if (!await stillThisChat()) {
      lastScanResult = "chat changed";
      return lastScanResult;
    }
  }
  let sent = 0;
  let visible = 0;
  const scroller = nearestScroller(conversationPane());
  const ingestPass = async () => {
    if (!await stillThisChat()) {
      return false;
    }
    const messages = visibleMessages();
    visible = Math.max(visible, messages.length);
    sent += postVisibleMessages(chat, messages);
    return true;
  };
  if (!await ingestPass()) {
    lastScanResult = "chat changed";
    return lastScanResult;
  }
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
    await delay(160);
    if (!await ingestPass()) {
      lastScanResult = "chat changed";
      return lastScanResult;
    }
    if (options?.deepHistory !== false) {
      for (let step = 0; step < 8; step += 1) {
        const height = scroller.scrollHeight;
        scroller.scrollTop = 0;
        await delay(220);
        if (!await ingestPass()) {
          lastScanResult = "chat changed";
          return lastScanResult;
        }
        if (scroller.scrollHeight <= height + 8 && scroller.scrollTop <= 2) {
          break;
        }
      }
    }
  }
  lastScanResult = `sent ${sent} new / ${visible} visible from ${chat.title}`;
  return lastScanResult;
}

function postVisibleMessages(
  chat: { id: string; title: string },
  messages: Array<{ element: HTMLElement; text: string }>,
): number {
  let sent = 0;
  const group = chat.id.endsWith("@g.us");
  for (const message of messages) {
    if (hasOutgoingAck(message.element) || parseWhatsAppDataId(dataIdOf(messageRoot(message.element)))?.from_me) {
      rememberLocalPushName(message.element);
    }
  }
  for (const message of messages) {
    const text = message.text;
    if (!text || isAuthorLabelText(text)) {
      continue;
    }
    const parsed = parseWhatsAppDataId(dataIdOf(message.element));
    const fromData = parsed?.chat_id ?? parseWhatsAppChatId(dataIdOf(message.element));
    if (!liveMessageBelongsToOpenChat(chat.id, fromData)) {
      continue;
    }
    const chatId = chat.id;
    const fromMe = isFromMe(message.element);
    const messageId = opaqueWhatsAppLiveMessageId(
      parsed?.message_id || stableMessageId(chatId, text, fromMe, message.element),
    );
    const seenKey = `${chatId}:${messageId}`;
    if (seenMessages.get(seenKey) === fromMe) {
      continue;
    }
    seenMessages.set(seenKey, fromMe);
    const senderHint = fromData && fromData !== chatId && !fromData.endsWith("@g.us") ? fromData : null;
    const participant = group && !fromMe ? groupSender(message.element, chatId, senderHint) : null;
    const senderId = fromMe
      ? "local-owner"
      : participant?.id ?? senderHint ?? extractSenderJid(message.element, chatId) ?? chatId;
    sent += 1;
    void postLiveMessage({
      client_id: CLIENT_ID,
      chat_id: chatId,
      chat_title: chat.title,
      message_id: messageId,
      sender_id: senderId,
      sender_name: fromMe ? "You" : participant?.name ?? (group ? senderId : chat.title),
      text,
      timestamp: messageTimestamp(message.element),
      from_me: fromMe,
      message_kind: "user",
    });
  }
  return sent;
}

async function pollCommands(): Promise<void> {
  if (!extensionContextValid || sessionBusy) {
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
  return withBusy(async () => {
    if (!await ensureConversationOpen(command.chat_id)) {
      return false;
    }
    if (command.delay_ms > 0) {
      await delay(command.delay_ms);
    }
    if (!await ensureConversationOpen(command.chat_id)) {
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
      if (!await ensureConversationOpen(command.chat_id)) {
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
      if (!await ensureConversationOpen(command.chat_id)) {
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
  });
}

async function withBusy<T>(work: () => Promise<T>): Promise<T> {
  sessionBusy = true;
  try {
    return await work();
  } finally {
    sessionBusy = false;
  }
}

async function ensureConversationOpen(chatId: string): Promise<boolean> {
  const current = await resolveActiveChat();
  if (commandTargetsChat(chatId, current?.id)) {
    return true;
  }
  if (!await openConversation(chatId)) {
    return false;
  }
  const opened = await resolveActiveChat();
  return commandTargetsChat(chatId, opened?.id);
}

function matchingOutgoingMessageIds(text: string): string[] {
  const expectedText = normalize(text);
  const chatId = lastResolvedChat?.id;
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

async function resolveActiveChat(): Promise<{ id: string; title: string } | null> {
  const title = firstChatTitle(rightmostVisibleHeader());
  const id =
    firstJidIn(selectedSidebarChat())
    ?? firstJidIn(conversationHeader())
    ?? chatIdFromVisibleMessages()
    ?? jidFromReactTree(conversationHeader())
    ?? jidFromReactTree(selectedSidebarChat())
    ?? jidFromReactTree(sidebarRowForTitle(title))
    ?? (title && lastResolvedChat?.title === title ? lastResolvedChat.id : null)
    ?? await jidFromIndexedDb(title)
    ?? chatIdFromPhoneDisplayTitle(title);
  if (!id) {
    if (lastResolvedChat && title && lastResolvedChat.title !== title) {
      lastResolvedChat = null;
    }
    return null;
  }
  lastResolvedChat = { id, title: title ?? id };
  return lastResolvedChat;
}

function hasOpenConversation(): boolean {
  return Boolean(
    document.querySelector('[data-testid="conversation-header"]')
    ?? document.querySelector("#main header")
    ?? conversationPane()?.querySelector("header")
    ?? composer(),
  );
}

function conversationPane(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>("#main")
    ?? document.querySelector('[data-testid="conversation-panel-wrapper"]')
    ?? document.querySelector('[data-testid="conversation-panel-body"]')
  );
}

function conversationHeader(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-testid="conversation-header"]')
    ?? document.querySelector<HTMLElement>("#main header")
    ?? conversationPane()?.querySelector("header")
    ?? null
  );
}

function selectedSidebarChat(): HTMLElement | null {
  const root = chatListRoot();
  const selected =
    root?.querySelector<HTMLElement>('[role="row"][aria-selected="true"]')
    ?? root?.querySelector<HTMLElement>('[aria-selected="true"]')
    ?? document.querySelector<HTMLElement>('[data-testid="cell-frame-container"][aria-selected="true"]')
    ?? sidebarRowForTitle(firstChatTitle(rightmostVisibleHeader()));
  if (!selected) {
    return null;
  }
  return selected.closest<HTMLElement>("[data-id], [role='listitem'], [role='row']") ?? selected;
}

function chatListRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-testid="chat-list"]')
    ?? document.querySelector<HTMLElement>('[aria-label="Chat list"]')
    ?? document.querySelector<HTMLElement>("#pane-side")
  );
}

function listChatRows(): HTMLElement[] {
  const root = chatListRoot();
  if (!root) {
    return [];
  }
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[role="row"]'));
  const items = rows.length
    ? rows
    : Array.from(root.querySelectorAll<HTMLElement>('[data-testid="cell-frame-container"]'));
  return items.filter((row) => {
    const title = sidebarRowTitle(row);
    return Boolean(title) && !isIgnorableChatListTitle(title);
  });
}

function sidebarRowForTitle(title: string | null): HTMLElement | null {
  const wanted = normalize(title ?? "");
  if (!wanted) {
    return null;
  }
  const matches = listChatRows().filter((row) =>
    titlesReferToSameChat(sidebarRowTitle(row), wanted),
  );
  return matches.length === 1 ? matches[0] : null;
}

function sidebarRowTitle(row: HTMLElement): string | null {
  const lines = (row.innerText || row.textContent || "").split(/\r?\n/).map(normalize).filter(Boolean);
  return firstChatTitleFromLines("", lines);
}

async function syncVisibleChats(): Promise<string> {
  if (sessionBusy) {
    return lastScanResult;
  }
  return withBusy(async () => {
    await ensureAllChatsTab();
    const chats = await harvestChatList();
    if (!chats.length) {
      lastScanResult = "no chat list";
      return lastScanResult;
    }
    let synced = 0;
    for (const item of chats) {
      const opened = await openHarvestedChat(item);
      if (!opened) {
        continue;
      }
      const result = await ingestOpenChat({
        expectedId: opened.id,
        deepHistory: false,
      });
      if (
        !result.includes("no WhatsApp chat id")
        && !result.includes("no open chat")
        && !result.includes("chat changed")
      ) {
        synced += 1;
      }
      await delay(SYNC_GAP_MS);
    }
    lastScanResult = `synced ${synced}/${chats.length} chats`;
    return lastScanResult;
  });
}

async function openHarvestedChat(
  item: HarvestedChat,
): Promise<{ id: string; title: string } | null> {
  if (item.jid && await openConversation(item.jid)) {
    return waitUntilPaneStable(item.title, item.jid);
  }
  if (!await openConversationByTitle(item.title)) {
    return null;
  }
  return waitUntilPaneStable(item.title, null);
}

async function openConversation(chatId: string): Promise<boolean> {
  if ((await resolveActiveChat())?.id === chatId) {
    return true;
  }
  let row = findRowByChatId(chatId);
  if (!row) {
    await revealMoreChatRows();
    row = findRowByChatId(chatId);
  }
  if (!row) {
    row = await searchChatList(chatId);
  }
  if (!row) {
    return false;
  }
  clickChatRow(row);
  const opened = await waitFor(async () => {
    const chat = await resolveActiveChat();
    return chat?.id === chatId ? chat : null;
  }, 8_000);
  return Boolean(opened);
}

function findRowByChatId(chatId: string): HTMLElement | null {
  const wantedTitle = knownChatTitles.get(chatId);
  for (const row of listChatRows()) {
    const jid = firstJidIn(row) ?? jidFromReactTree(row);
    if (jid === chatId) {
      return row;
    }
    const title = sidebarRowTitle(row);
    if (wantedTitle && titlesReferToSameChat(title, wantedTitle)) {
      return row;
    }
  }
  return null;
}

async function searchChatList(chatId: string): Promise<HTMLElement | null> {
  const query = phoneDigitsFromWhatsAppChatId(chatId) ?? knownChatTitles.get(chatId);
  const input = chatSearchInput();
  if (!query || !input) {
    return null;
  }
  clickElement(input);
  input.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(input);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, query);
  await delay(900);
  if (phoneDigitsFromWhatsAppChatId(chatId)) {
    return findRowByChatId(chatId) ?? listChatRows()[0] ?? null;
  }
  return findRowByChatId(chatId) ?? sidebarRowForTitle(query);
}

function chatSearchInput(): HTMLElement | null {
  const root = chatListRoot()?.parentElement ?? document;
  return (
    root.querySelector<HTMLElement>('[data-testid="chat-list-search"]')
    ?? document.querySelector<HTMLElement>('[contenteditable="true"][data-tab="3"]')
    ?? document.querySelector<HTMLElement>('[aria-label="Search input textbox"]')
    ?? document.querySelector<HTMLElement>('[aria-label="搜索输入文本框"]')
  );
}

async function revealMoreChatRows(): Promise<void> {
  const scroller = nearestScroller(chatListRoot());
  if (!scroller) {
    return;
  }
  for (let step = 0; step < 3; step += 1) {
    scroller.scrollTop = scroller.scrollHeight;
    await delay(220);
  }
}

async function harvestChatList(): Promise<HarvestedChat[]> {
  const scroller = nearestScroller(chatListRoot());
  const harvested = new Map<string, HarvestedChat>();
  const collect = () => {
    for (const row of listChatRows()) {
      const title = sidebarRowTitle(row);
      if (!title) {
        continue;
      }
      const jid = rowOwnJid(row);
      const existing = harvested.get(title);
      if (!existing) {
        harvested.set(title, { title, jid });
        continue;
      }
      if (!existing.jid && jid) {
        existing.jid = jid;
      }
    }
  };
  if (scroller) {
    scroller.scrollTop = 0;
    await delay(200);
  }
  collect();
  let idle = 0;
  let lastSize = harvested.size;
  for (let step = 0; step < 40 && harvested.size < MAX_SYNC_CHATS; step += 1) {
    if (scroller) {
      scroller.scrollTop += Math.max(scroller.clientHeight - 48, 80);
    }
    await delay(180);
    collect();
    if (harvested.size === lastSize) {
      idle += 1;
      const atEnd = scroller
        ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8
        : true;
      if (atEnd && idle >= 2) {
        break;
      }
      if (idle >= 5) {
        break;
      }
    } else {
      idle = 0;
      lastSize = harvested.size;
    }
  }
  if (scroller) {
    scroller.scrollTop = 0;
  }
  return [...harvested.values()];
}

async function openConversationByTitle(title: string): Promise<boolean> {
  if (titlesReferToSameChat(firstChatTitle(rightmostVisibleHeader()), title) && hasOpenConversation()) {
    return true;
  }
  let row =
    listChatRows().find((item) => titlesReferToSameChat(sidebarRowTitle(item), title)) ?? null;
  if (!row) {
    row = await searchChatListByQuery(title);
  }
  if (!row) {
    return false;
  }
  clickChatRow(row);
  const opened = await waitFor(
    () => titlesReferToSameChat(firstChatTitle(rightmostVisibleHeader()), title),
    8_000,
  );
  await clearChatSearch();
  return Boolean(opened);
}

async function waitUntilPaneStable(
  title: string,
  expectedJid: string | null,
): Promise<{ id: string; title: string } | null> {
  const generation = paneGeneration;
  return waitFor(async () => {
    if (generation !== paneGeneration) {
      return null;
    }
    const headerTitle = firstChatTitle(rightmostVisibleHeader());
    if (!titlesReferToSameChat(headerTitle, title)) {
      return null;
    }
    const chat = await resolveActiveChat();
    if (!chat) {
      return null;
    }
    if (expectedJid && chat.id !== expectedJid) {
      return null;
    }
    const paneJid = chatIdFromVisibleMessages();
    if (!liveMessageBelongsToOpenChat(chat.id, paneJid)) {
      return null;
    }
    await delay(300);
    if (generation !== paneGeneration) {
      return null;
    }
    const again = await resolveActiveChat();
    if (!again || again.id !== chat.id) {
      return null;
    }
    const paneJidAfter = chatIdFromVisibleMessages();
    if (!liveMessageBelongsToOpenChat(again.id, paneJidAfter)) {
      return null;
    }
    if (!titlesReferToSameChat(firstChatTitle(rightmostVisibleHeader()), title)) {
      return null;
    }
    return again;
  }, 7_000, 200);
}

async function searchChatListByQuery(query: string): Promise<HTMLElement | null> {
  const input = chatSearchInput();
  const searchText = phoneDigitsFromDisplayTitle(query) ?? query;
  if (!searchText || !input) {
    return null;
  }
  clickElement(input);
  input.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(input);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, searchText);
  await delay(900);
  return listChatRows().find((item) => titlesReferToSameChat(sidebarRowTitle(item), query)) ?? null;
}

async function clearChatSearch(): Promise<void> {
  const backIcon = document.querySelector<HTMLElement>('[data-icon="back"]');
  const back = backIcon?.closest<HTMLElement>("button")
    ?? document.querySelector<HTMLElement>('[data-testid="back"]')
    ?? document.querySelector<HTMLElement>('[aria-label="Back"], [aria-label="返回"]');
  if (back) {
    clickElement(back);
    await delay(200);
    return;
  }
  const input = chatSearchInput();
  if (!input) {
    return;
  }
  input.focus();
  document.execCommand("selectAll");
  document.execCommand("delete");
  await delay(150);
}

async function ensureAllChatsTab(): Promise<void> {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"], button'));
  const all = tabs.find((tab) => /^(all|全部)$/i.test(normalize(tab.innerText || tab.textContent || "")));
  if (all) {
    clickElement(all);
    await delay(250);
  }
}

function nearestScroller(root: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = root;
  for (let hops = 0; node && hops < 8; hops += 1) {
    const style = window.getComputedStyle(node);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll")
      && node.scrollHeight > node.clientHeight + 8
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return root;
}

function clickChatRow(row: HTMLElement): void {
  paneGeneration += 1;
  const cell = row.querySelector<HTMLElement>('[data-testid="cell-frame-container"]') ?? row;
  clickElement(cell);
}

function clickElement(element: HTMLElement): void {
  const opts: MouseEventInit = { bubbles: true, cancelable: true, view: window };
  element.dispatchEvent(new MouseEvent("mousedown", opts));
  element.dispatchEvent(new MouseEvent("mouseup", opts));
  element.dispatchEvent(new MouseEvent("click", opts));
  element.click();
}

async function waitFor<T>(
  probe: () => T | Promise<T | null | undefined> | null | undefined,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }
  return null;
}

async function rememberKnownChat(id: string, title: string): Promise<void> {
  knownChatTitles.set(id, title);
  const stored = await storageGet({ [KNOWN_CHATS_KEY]: {} });
  const current = stored[KNOWN_CHATS_KEY];
  const map = current && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, { title: string }>) }
    : {};
  map[id] = { title };
  await storageSet({ [KNOWN_CHATS_KEY]: map });
}

async function hydrateKnownChats(): Promise<void> {
  const stored = await storageGet({ [KNOWN_CHATS_KEY]: {} });
  const current = stored[KNOWN_CHATS_KEY];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return;
  }
  for (const [id, value] of Object.entries(current as Record<string, unknown>)) {
    if (value && typeof value === "object" && typeof (value as { title?: unknown }).title === "string") {
      knownChatTitles.set(id, (value as { title: string }).title);
    }
  }
}

function jidFromReactTree(root: HTMLElement | null): string | null {
  if (!root) {
    return null;
  }
  let current: HTMLElement | null = root;
  for (let hops = 0; current && hops < 10; hops += 1) {
    for (const value of reactValues(current)) {
      const id = jidFromReactLikeValue(value);
      if (id) {
        return id;
      }
    }
    current = current.parentElement;
  }
  return null;
}

function reactValues(element: HTMLElement): unknown[] {
  const values: unknown[] = [];
  for (const key of Object.keys(element)) {
    if (
      key.startsWith("__reactFiber$")
      || key.startsWith("__reactInternalInstance$")
      || key.startsWith("__reactProps$")
    ) {
      values.push((element as unknown as Record<string, unknown>)[key]);
    }
  }
  return values;
}

async function jidFromIndexedDb(title: string | null): Promise<string | null> {
  const chats = await loadNamedChats();
  return uniqueJidForDisplayName(title, chats);
}

async function loadNamedChats(): Promise<NamedWhatsAppChat[]> {
  if (namedChatsCache && Date.now() - namedChatsCache.at < IDB_TTL_MS) {
    return namedChatsCache.chats;
  }
  const chats = await withTimeout(readNamedChatsFromIdb(), IDB_TIMEOUT_MS, []);
  if (chats.length) {
    namedChatsCache = { at: Date.now(), chats };
  }
  return chats;
}

async function readNamedChatsFromIdb(): Promise<NamedWhatsAppChat[]> {
  const db = await openExistingDatabase(IDB_DATABASE);
  if (!db) {
    return [];
  }
  try {
    const chats: NamedWhatsAppChat[] = [];
    const seen = new Set<string>();
    for (const storeName of IDB_STORES) {
      for (const record of await readObjectStore(db, storeName)) {
        const named = namedChatFromRecord(record);
        if (!named || seen.has(`${named.id}:${named.names.join("|")}`)) {
          continue;
        }
        seen.add(`${named.id}:${named.names.join("|")}`);
        const existing = chats.find((item) => item.id === named.id);
        if (existing) {
          existing.names = [...new Set([...existing.names, ...named.names])];
        } else {
          chats.push(named);
        }
      }
    }
    return chats;
  } finally {
    db.close();
  }
}

function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    void (async () => {
      try {
        const listed = "databases" in indexedDB ? await indexedDB.databases() : [];
        const found = listed.find((item) => item.name === name && item.version);
        if ("databases" in indexedDB && !found) {
          resolve(null);
          return;
        }
        const request = found?.version
          ? indexedDB.open(name, found.version)
          : indexedDB.open(name);
        request.onupgradeneeded = () => {
          request.transaction?.abort();
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    })();
  });
}

function readObjectStore(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(storeName)) {
      resolve([]);
      return;
    }
    try {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll(
        undefined,
        IDB_MAX_RECORDS,
      );
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function chatIdFromVisibleMessages(): string | null {
  const ids: string[] = [];
  for (const message of visibleMessages()) {
    const parsed = parseWhatsAppDataId(dataIdOf(message.element));
    const chatId = parsed?.chat_id ?? parseWhatsAppChatId(dataIdOf(message.element));
    if (chatId) {
      ids.push(chatId);
    }
  }
  return conversationJidFromCandidates(ids);
}

function firstJidIn(root: ParentNode | null): string | null {
  if (!root) {
    return null;
  }
  const ids: string[] = [];
  if (root instanceof HTMLElement) {
    const own = chatIdFromElement(root);
    if (own) {
      ids.push(own);
    }
  }
  for (const node of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const id = chatIdFromElement(node);
    if (id) {
      ids.push(id);
    }
  }
  return conversationJidFromCandidates(ids);
}

function chatIdFromElement(element: HTMLElement): string | null {
  return firstWhatsAppChatIdFromValues(
    element.getAttributeNames().map((name) => element.getAttribute(name)),
  );
}

function rowOwnJid(row: HTMLElement): string | null {
  const cell = row.querySelector<HTMLElement>('[data-testid="cell-frame-container"]') ?? row;
  return chatIdFromElement(row) ?? chatIdFromElement(cell);
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
  const pane = conversationPane();
  if (!pane) {
    return [];
  }
  const hosts = [
    ...Array.from(pane.querySelectorAll<HTMLElement>("div.message-out, div.message-in")),
    ...Array.from(pane.querySelectorAll<HTMLElement>("[data-pre-plain-text]")),
    ...Array.from(pane.querySelectorAll<HTMLElement>('[role="row"]')),
  ];
  const messages: Array<{ element: HTMLElement; text: string }> = [];
  const seen = new Set<HTMLElement>();
  for (const host of hosts) {
    if (host.closest("header, #pane-side, [data-testid='conversation-header'], footer")) {
      continue;
    }
    if (isInsideQuoted(host)) {
      continue;
    }
    const element = messageElementFor(host) ?? host;
    if (seen.has(element)) {
      continue;
    }
    const text = messageBodyText(element);
    if (!text || isAuthorLabelText(text) || isLoadOlderMessagesText(text)) {
      continue;
    }
    seen.add(element);
    messages.push({ element, text });
  }
  return messages;
}

function messageBodyText(element: HTMLElement): string {
  const nodes = Array.from(
    element.querySelectorAll<HTMLElement>("span.selectable-text, span.copyable-text"),
  ).filter((node) => !isInsideQuoted(node) && !isAuthorLabelText(normalize(node.innerText || "")));
  const longest = nodes
    .map((node) => normalize(node.innerText || node.textContent || ""))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0];
  return longest ?? "";
}

function isInsideQuoted(element: HTMLElement): boolean {
  return Boolean(
    element.closest('[data-testid*="quoted"]')
    || element.closest('[aria-label*="Quoted" i]')
    || element.closest('[aria-label*="引用"]'),
  );
}

function messageElementFor(span: HTMLElement): HTMLElement | null {
  return (
    span.closest<HTMLElement>("div.message-out, div.message-in")
    ?? span.querySelector<HTMLElement>("div.message-out, div.message-in")
    ?? span.closest<HTMLElement>("[data-pre-plain-text], [data-id]")
    ?? span.closest<HTMLElement>('[role="row"]')
  );
}

function messagePrePlainText(element: HTMLElement): string {
  return (
    element.getAttribute("data-pre-plain-text")
    ?? element.closest("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text")
    ?? element.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text")
    ?? ""
  );
}

function messageTimestamp(element: HTMLElement): string {
  return parseWhatsAppTimestamp(messagePrePlainText(element));
}

function isFromMe(element: HTMLElement): boolean {
  const root = messageRoot(element);
  const dataId = dataIdOf(root);
  const parsed = parseWhatsAppDataId(dataId);
  if (parsed?.from_me || (!parsed && dataId.startsWith("true_"))) {
    rememberLocalPushName(root);
    return true;
  }
  if (hasOutgoingAck(root)) {
    rememberLocalPushName(root);
    return true;
  }
  if (root.classList.contains("message-out") || root.closest("div.message-out")) {
    rememberLocalPushName(root);
    return true;
  }
  const innerOut = root.querySelector<HTMLElement>("div.message-out");
  const innerIn = root.querySelector<HTMLElement>("div.message-in");
  if (innerOut && !innerIn) {
    rememberLocalPushName(root);
    return true;
  }
  if (
    hasIncomingTail(root)
    || (innerIn && !innerOut)
    || root.classList.contains("message-in")
    || root.closest("div.message-in")
  ) {
    return false;
  }
  if (parsed && !parsed.from_me) {
    return false;
  }
  const fromPre = fromMeFromPrePlainText(messagePrePlainText(root), [...localPushNames]);
  if (fromPre !== null) {
    return fromPre;
  }
  const bubble =
    innerOut
    ?? innerIn
    ?? root.querySelector<HTMLElement>("[data-pre-plain-text]")
    ?? root;
  const pane = conversationPane();
  if (pane && bubble !== pane) {
    const aligned = bubbleLooksOutgoing(pane.getBoundingClientRect(), bubble.getBoundingClientRect());
    if (aligned === true) {
      rememberLocalPushName(root);
      return true;
    }
    if (aligned === false) {
      return false;
    }
  }
  return false;
}

function messageRoot(element: HTMLElement): HTMLElement {
  return (
    element.closest<HTMLElement>('[role="row"]')
    ?? element.closest<HTMLElement>("div.message-out, div.message-in")
    ?? element.closest<HTMLElement>("[data-id]")
    ?? element
  );
}

function hasOutgoingAck(element: HTMLElement): boolean {
  const root = messageRoot(element);
  const icons = Array.from(root.querySelectorAll<HTMLElement>("[data-icon], [data-testid]"));
  for (const icon of icons) {
    if (isInsideQuoted(icon)) {
      continue;
    }
    if (
      isOutgoingWhatsAppIcon(icon.getAttribute("data-icon"))
      || isOutgoingWhatsAppIcon(icon.getAttribute("data-testid"))
    ) {
      return true;
    }
  }
  return false;
}

function hasIncomingTail(element: HTMLElement): boolean {
  const icons = Array.from(element.querySelectorAll<HTMLElement>("[data-icon]"));
  for (const icon of icons) {
    if (!isInsideQuoted(icon) && isIncomingWhatsAppIcon(icon.getAttribute("data-icon"))) {
      return true;
    }
  }
  return false;
}

function rememberLocalPushName(element: HTMLElement): void {
  const name = senderNameFromPrePlainText(messagePrePlainText(element));
  if (name) {
    localPushNames.add(name);
  }
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
    messageContext: messagePrePlainText(element),
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
    for (const value of reactValues(node)) {
      const fromReact = jidFromReactLikeValue(value);
      if (fromReact && fromReact !== chatId && !fromReact.endsWith("@g.us")) {
        return fromReact;
      }
    }
    node = node.parentElement;
  }
  return undefined;
}

function groupSender(
  element: HTMLElement,
  chatId: string,
  senderHint?: string | null,
): { id: string; name: string } {
  const texts = Array.from(element.querySelectorAll<HTMLElement>("span, div"))
    .filter((node) => !isInsideQuoted(node))
    .map((node) => normalize(node.innerText || ""))
    .filter(Boolean);
  const fromDom = groupSenderFromDomTexts(texts);
  const name =
    fromDom.name
    ?? senderNameFromPrePlainText(messagePrePlainText(element))
    ?? "";
  const phoneJid = fromDom.phone ? chatIdFromPhoneDisplayTitle(fromDom.phone) : null;
  const jid = senderHint && !senderHint.endsWith("@g.us")
    ? senderHint
    : phoneJid ?? extractSenderJid(element, chatId);
  const id = stableGroupParticipantId(chatId, name || fromDom.phone || "unknown", jid);
  return { id, name: name || fromDom.phone || id };
}

async function revealOlderMessages(): Promise<void> {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("div, span, button"));
  const loadOlder = candidates.find((node) => isLoadOlderMessagesText(node.innerText || node.textContent || ""));
  if (loadOlder) {
    clickElement(loadOlder);
    await delay(900);
  }
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
