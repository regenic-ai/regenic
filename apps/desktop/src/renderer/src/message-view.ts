import type { InboxViewItem } from "./types";
import type { InboxThread } from "./inbox";
import { latestMessage } from "./inbox";

export type MessageRole = "user" | "assistant" | "system";

const SYSTEM_PATTERN =
  /current runtime context|dsh file policy|approval prompts are disabled|danger-full-access|workspace-write|read-only permission|you are (a |an )?(helpful )?(assistant|agent)/i;

const USER_PATTERN = /[?？]|\bplease\b|can you|请|帮/i;

export function messageRole(text: string | undefined): MessageRole {
  const value = text?.trim() ?? "";
  if (!value) {
    return "assistant";
  }
  if (SYSTEM_PATTERN.test(value.slice(0, 280))) {
    return "system";
  }
  if (SYSTEM_PATTERN.test(value) && value.length < 1200) {
    return "system";
  }
  if (value.length < 500 && USER_PATTERN.test(value)) {
    return "user";
  }
  return "assistant";
}

export function roleLabel(role: MessageRole): string {
  if (role === "user") {
    return "You";
  }
  if (role === "system") {
    return "Runtime";
  }
  return "Assistant";
}

export function firstLine(text: string | undefined, max = 80): string {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const line =
    lines.find((part) => !part.startsWith("```") && !isTableRow(part)) ??
    lines[0] ??
    "";
  let clean = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
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
  const human = thread.messages.find(
    (item) => messageRole(item.body_text) !== "system",
  );
  const source = human ?? latestMessage(thread);
  return firstLine(source.body_text, 88) || thread.label;
}

export function readingMessages(thread: InboxThread): InboxViewItem[] {
  return thread.messages.filter((item) => {
    const text = item.body_text?.trim() ?? "";
    return text.length > 0;
  });
}

export type RichBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; text: string };

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
  if (isUnorderedItem(line) || isOrderedItem(line) || isTableRow(line)) {
    return true;
  }
  return false;
}
