import type { InboxViewItem, MessageKind } from "./types";
import type { InboxThread } from "./inbox";

export type MessageRole = MessageKind;

export function messageRole(item: InboxViewItem | string | undefined): MessageRole {
  if (item && typeof item === "object") {
    if (item.kind === "user" || item.kind === "assistant" || item.kind === "system") {
      return item.kind;
    }
  }
  return "assistant";
}

export function roleLabel(
  role: MessageRole,
  channel?: string,
  actorLabel?: string | null,
): string {
  const named = actorLabel?.replace(/\s+/g, " ").trim();
  if (named) {
    return named;
  }
  if (role === "user") {
    return "You";
  }
  if (role === "system") {
    return "Runtime";
  }
  return channel === "dsh" ? "DSH Agent" : "Assistant";
}

export function receiptCopy(item: InboxViewItem): string | undefined {
  if (item.direction !== "outbound") {
    return undefined;
  }
  if (item.receipt?.state === "read") {
    return "Read";
  }
  if (item.receipt?.state === "sent" || item.can_receipt === true) {
    return "Sent";
  }
  return undefined;
}

export function conversationKindLabel(kind: string | null | undefined): string | null {
  if (kind === "group") {
    return "Group";
  }
  if (kind === "direct") {
    return "Direct";
  }
  if (kind && kind.trim()) {
    return kind.trim();
  }
  return null;
}

const SENT_WAIT_MS = 30 * 60 * 1000;

export function threadActivityOf(
  thread: InboxThread,
  now = Date.now(),
): InboxViewItem["activity"] | "sent" | undefined {
  const latest = thread.messages[thread.messages.length - 1];
  if (!latest) {
    return undefined;
  }
  if (latest.activity === "working") {
    if (!isRecentStamp(latest.event.occurred_at, now, SENT_WAIT_MS)) {
      return undefined;
    }
    const lastVisible = lastVisibleMessage(thread);
    if (lastVisible?.activity === "awaiting_user") {
      return "awaiting_user";
    }
    if (lastVisible?.kind === "assistant" && lastVisible.direction === "inbound") {
      return undefined;
    }
    return "working";
  }
  if (latest.activity) {
    return latest.activity;
  }
  if (
    thread.await_reply === true &&
    latest.kind === "user" &&
    latest.direction === "outbound" &&
    isRecentStamp(latest.event.occurred_at, now, SENT_WAIT_MS)
  ) {
    return "sent";
  }
  return undefined;
}

function isRecentStamp(stamp: string, now: number, windowMs: number): boolean {
  const at = Date.parse(stamp);
  return Number.isFinite(at) && now - at >= 0 && now - at < windowMs;
}

export function threadActivityCopy(
  activity: InboxViewItem["activity"] | "sent" | undefined,
): string | undefined {
  if (activity === "awaiting_user") {
    return "Waiting for your reply in the original channel.";
  }
  if (activity === "working") {
    return "The other side is still working.";
  }
  if (activity === "sent") {
    return "Sent. Waiting for a reply from the original channel.";
  }
  return undefined;
}

export function firstLine(text: string | undefined, max = 80): string {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const line =
    lines.find((part) => !part.startsWith("```") && !isTableRow(part) && !/^>\s?/.test(part)) ??
    lines[0] ??
    "";
  let clean = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/~~/g, "")
    .replace(/`/g, "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > max) {
    const sentence = clean.match(/^(.+?[.!?。！？])(?:\s|$)/);
    if (sentence && sentence[1].length <= max) {
      clean = sentence[1];
    }
  }
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

export function threadTitle(thread: InboxThread): string {
  const custom = thread.title?.replace(/\s+/g, " ").trim();
  if (custom) {
    return custom;
  }
  if (thread.list_title === "conversation") {
    return (
      thread.conversation_label?.replace(/\s+/g, " ").trim() || thread.label
    );
  }
  if (thread.list_title === "prompt") {
    const prompt =
      thread.conversation_label?.replace(/\s+/g, " ").trim() ||
      firstUserLine(thread);
    if (prompt) {
      return prompt;
    }
    const face = threadFace(thread);
    if (face.activity !== "working") {
      return firstLine(face.body_text, 120) || thread.label;
    }
    return thread.label;
  }
  const conversation = thread.conversation_label?.replace(/\s+/g, " ").trim();
  if (conversation) {
    return conversation;
  }
  if (thread.messages.length === 0) {
    return thread.label;
  }
  const face = threadFace(thread);
  if (face.activity === "working") {
    return thread.label;
  }
  return firstLine(face.body_text, 120) || thread.label;
}

export function threadPreview(thread: InboxThread): string {
  const activity = threadActivityCopy(threadActivityOf(thread));
  if (activity) {
    return activity;
  }
  const face = threadFace(thread);
  if (face && face.activity !== "working") {
    return firstLine(face.body_text, 96) || thread.label;
  }
  return thread.label;
}

function firstUserLine(thread: InboxThread): string {
  const user = thread.messages.find((item) => messageRole(item) === "user");
  return firstLine(user?.body_text, 120);
}

function lastVisibleMessage(thread: InboxThread): InboxViewItem | undefined {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const item = thread.messages[index];
    if (item.activity !== "working") {
      return item;
    }
  }
  return undefined;
}

export function threadFace(thread: InboxThread): InboxViewItem {
  const visible = thread.messages.filter((item) => item.activity !== "working");
  const pool = visible.length > 0 ? visible : thread.messages;
  const user = pool.find((item) => messageRole(item) === "user");
  const human = user ?? pool.find((item) => messageRole(item) !== "system");
  return human ?? pool[pool.length - 1] ?? thread.messages[0];
}

export function readingMessages(
  thread: InboxThread,
  previous?: { source: InboxViewItem[]; reading: InboxViewItem[] },
): InboxViewItem[] {
  const source = thread.messages;
  if (
    previous &&
    source.length >= previous.source.length &&
    previous.source.every((item, index) => item === source[index])
  ) {
    if (source.length === previous.source.length) {
      return previous.reading;
    }
    return appendReading(previous.reading, source.slice(previous.source.length).filter(isReadable));
  }
  return coalesceReading(source.filter(isReadable));
}

function isReadable(item: InboxViewItem): boolean {
  if (item.activity === "working") {
    return false;
  }
  const text = item.body_text?.trim() ?? "";
  return text.length > 0 || (item.attachments?.length ?? 0) > 0;
}

export function threadPaneEmptyCopy(
  opening: boolean,
  error?: string | null,
): string {
  if (opening) {
    return "Opening conversation…";
  }
  if (error) {
    return error;
  }
  return "This conversation has no displayable messages.";
}

export function threadLoadedCountCopy(input: {
  opening: boolean;
  loaded: number;
  hasOlder: boolean;
}): string {
  if (input.loaded === 0 && input.opening) {
    return "Opening…";
  }
  if (input.hasOlder) {
    return `${input.loaded} recent messages`;
  }
  return `${input.loaded} messages`;
}

export function sameSpeaker(left: InboxViewItem, right: InboxViewItem): boolean {
  return speakerKey(left) === speakerKey(right);
}

export function speakerMark(
  role: MessageRole,
  actorLabel?: string | null,
): string {
  const named = actorLabel?.replace(/\s+/g, " ").trim();
  if (named) {
    return named.slice(0, 1);
  }
  if (role === "user") {
    return "Y";
  }
  if (role === "system") {
    return "R";
  }
  return "A";
}

function speakerKey(item: InboxViewItem): string {
  const role = messageRole(item);
  const named = item.actor_label?.replace(/\s+/g, " ").trim();
  if (named) {
    return `${role}:${named}`;
  }
  return role;
}

function coalesceReading(items: InboxViewItem[]): InboxViewItem[] {
  return appendReading([], items);
}

function appendReading(
  previous: InboxViewItem[],
  added: InboxViewItem[],
): InboxViewItem[] {
  const merged = previous.length > 0 ? previous.slice() : [];
  for (const item of added) {
    const last = merged[merged.length - 1];
    if (last && sameSpeaker(last, item) && sameUtterance(last, item)) {
      continue;
    }
    merged.push(item);
  }
  return merged;
}

export function sameUtterance(left: InboxViewItem, right: InboxViewItem): boolean {
  const leftText = (left.body_text ?? "").replace(/\s+/g, " ").trim();
  const rightText = (right.body_text ?? "").replace(/\s+/g, " ").trim();
  return leftText.length > 0 && leftText === rightText;
}

export type RichBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; text: string };

export function splitQuoted(text: string): { quote?: string; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const quotes: string[] = [];
  let index = 0;
  while (index < lines.length && /^>\s?/.test(lines[index])) {
    quotes.push(lines[index].replace(/^>\s?/, ""));
    index += 1;
  }
  while (index < lines.length && lines[index].trim() === "") {
    index += 1;
  }
  return {
    quote: quotes.length > 0 ? quotes.join("\n") : undefined,
    body: lines.slice(index).join("\n"),
  };
}

export function parseRichBlocks(text: string): RichBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: RichBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const closed: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        closed.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", text: closed.join("\n") });
      continue;
    }
    if (isQuoteLine(line)) {
      const quotes: string[] = [];
      while (index < lines.length && isQuoteLine(lines[index])) {
        quotes.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quotes.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const rawLevel = heading[1].length;
      blocks.push({
        type: "heading",
        level: (rawLevel > 3 ? 3 : rawLevel) as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }
    if (
      isTableRow(line) &&
      index + 1 < lines.length &&
      (isTableDivider(lines[index + 1]) || isTableRow(lines[index + 1]))
    ) {
      const headers = splitTableRow(line);
      index += 1;
      if (isTableDivider(lines[index])) {
        index += 1;
      }
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index]) && !isTableDivider(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }
    if (isUnorderedItem(line)) {
      const items: string[] = [];
      while (index < lines.length && isUnorderedItem(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, "").trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }
    if (isOrderedItem(line)) {
      const items: string[] = [];
      while (index < lines.length && isOrderedItem(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, "").trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !isBlockBoundary(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks.length > 0 ? blocks : [{ type: "paragraph", text }];
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|", 1);
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isQuoteLine(line: string): boolean {
  return /^>\s?/.test(line);
}

function isUnorderedItem(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

function isOrderedItem(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function isBlockBoundary(line: string): boolean {
  if (line.trim() === "") {
    return true;
  }
  if (line.startsWith("```")) {
    return true;
  }
  if (/^(#{1,6})\s+/.test(line)) {
    return true;
  }
  if (isQuoteLine(line) || isUnorderedItem(line) || isOrderedItem(line) || isTableRow(line)) {
    return true;
  }
  return false;
}
