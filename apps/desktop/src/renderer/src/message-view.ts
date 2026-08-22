import type { InboxViewItem, MessageKind } from "./types";
import type { InboxThread } from "./inbox";
import { latestMessage } from "./inbox";

export type MessageRole = MessageKind;

export function messageRole(item: InboxViewItem | string | undefined): MessageRole {
  if (item && typeof item === "object") {
    if (item.kind === "user" || item.kind === "assistant" || item.kind === "system") {
      return item.kind;
    }
  }
  return "assistant";
}

export function roleLabel(role: MessageRole, channel?: string): string {
  if (role === "user") {
    return "You";
  }
  if (role === "system") {
    return "Runtime";
  }
  return channel === "dsh" ? "DSH Agent" : "Assistant";
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
  if (thread.messages.length === 0) {
    return thread.label;
  }
  return firstLine(threadFace(thread).body_text, 120) || thread.label;
}

function threadFace(thread: InboxThread): InboxViewItem {
  const user = thread.messages.find((item) => messageRole(item) === "user");
  const human =
    user ?? thread.messages.find((item) => messageRole(item) !== "system");
  return human ?? latestMessage(thread) ?? thread.messages[0];
}

export function readingMessages(thread: InboxThread): InboxViewItem[] {
  const visible = thread.messages.filter((item) => {
    const text = item.body_text?.trim() ?? "";
    return text.length > 0 || (item.attachments?.length ?? 0) > 0;
  });
  return coalesceReading(visible);
}

function coalesceReading(items: InboxViewItem[]): InboxViewItem[] {
  const merged: InboxViewItem[] = [];
  for (const item of items) {
    const role = messageRole(item);
    const previous = merged[merged.length - 1];
    if (
      previous &&
      messageRole(previous) === role &&
      role !== "system"
    ) {
      if (sameUtterance(previous, item)) {
        continue;
      }
      merged[merged.length - 1] = joinReading(previous, item);
      continue;
    }
    merged.push(item);
  }
  return merged;
}

function sameUtterance(left: InboxViewItem, right: InboxViewItem): boolean {
  const leftText = (left.body_text ?? "").replace(/\s+/g, " ").trim();
  const rightText = (right.body_text ?? "").replace(/\s+/g, " ").trim();
  return leftText.length > 0 && leftText === rightText;
}

function joinReading(left: InboxViewItem, right: InboxViewItem): InboxViewItem {
  const leftText = left.body_text?.trim() ?? "";
  const rightText = right.body_text?.trim() ?? "";
  const body = [leftText, rightText].filter((part) => part.length > 0).join("\n\n");
  const attachments = [...(left.attachments ?? []), ...(right.attachments ?? [])];
  return {
    ...left,
    body_text: body.length > 0 ? body : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
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
