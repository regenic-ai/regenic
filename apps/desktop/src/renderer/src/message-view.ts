import { t } from "../../shared/i18n.ts";
import type { InboxViewItem, MessageDirection, MessageKind } from "./types";
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
  direction?: MessageDirection | null,
): string {
  const named = actorLabel?.replace(/\s+/g, " ").trim();
  if (named) {
    return named;
  }
  if (role === "user") {
    return direction === "outbound" ? t("label.you") : t("label.participant");
  }
  if (role === "system") {
    return t("label.runtime");
  }
  return channel === "dsh" ? t("label.dshAgent") : t("label.assistant");
}

export function messageSpeakerLabel(
  item: Pick<InboxViewItem, "kind" | "channel" | "actor_label" | "direction">,
): string {
  return roleLabel(item.kind, item.channel, item.actor_label, item.direction);
}

export function messageSpeakerMark(
  item: Pick<InboxViewItem, "kind" | "actor_label" | "direction">,
): string {
  return speakerMark(item.kind, item.actor_label, item.direction);
}

export function receiptCopy(item: InboxViewItem): string | undefined {
  if (item.direction !== "outbound") {
    return undefined;
  }
  if (item.receipt?.state === "read") {
    return t("label.read");
  }
  if (item.receipt?.state === "sent" || item.can_receipt === true) {
    return t("label.sent");
  }
  return undefined;
}

export function threadFacetLabel(facet: string | null | undefined): string | null {
  if (facet === "ticket") {
    return t("label.ticket");
  }
  if (facet === "agent") {
    return t("label.agent");
  }
  return null;
}

export function workStatusLabel(
  work:
    | string
    | {
        status?: string;
        delivery?: { status?: string; write_back?: string };
      }
    | null
    | undefined,
): string | null {
  if (!work) {
    return null;
  }
  if (typeof work !== "string") {
    const delivery = work.delivery;
    if (delivery?.status === "dead") {
      return t("work.dead");
    }
    if (delivery?.write_back === "failed") {
      return t("work.writeBackFailed");
    }
    if (delivery?.status === "write_back") {
      return t("work.writeBack");
    }
    if (delivery?.status === "queued") {
      return t("work.queued");
    }
    if (delivery?.status === "acked" && delivery.write_back === "sent") {
      return t("work.acked");
    }
    return workStatusLabel(work.status);
  }
  switch (work) {
    case "running":
      return t("work.running");
    case "waiting_human":
      return t("work.waiting");
    case "failed":
      return t("work.failed");
    case "done":
      return t("work.done");
    default:
      return null;
  }
}

export function heldFollowUpCount(thread: {
  work?: { status?: string; head_event_id?: string; updated_at?: string };
  messages?: Array<{
    event: { id: string; occurred_at: string };
    direction?: string;
    kind?: string;
  }>;
}): number {
  const work = thread.work;
  if (work?.status !== "running" && work?.status !== "waiting_human") {
    return 0;
  }
  const messages = thread.messages ?? [];
  const headIndex = work.head_event_id
    ? messages.findIndex((item) => item.event.id === work.head_event_id)
    : -1;
  const later =
    headIndex >= 0
      ? messages.slice(headIndex + 1)
      : work.updated_at
        ? messages.filter(
            (item) =>
              Date.parse(item.event.occurred_at) > Date.parse(work.updated_at ?? ""),
          )
        : [];
  return later.filter(
    (item) => item.direction === "inbound" && item.kind === "user",
  ).length;
}

export function deliveryNeedsYou(delivery?: {
  status?: string;
  write_back?: string;
} | null): boolean {
  return delivery?.status === "dead" || delivery?.write_back === "failed";
}

export function workNextStepCopy(thread: {
  work?: {
    status?: string;
    recipe_id?: string;
    head_event_id?: string;
    updated_at?: string;
    can_write_back?: boolean;
    delivery?: { status?: string; write_back?: string; last_error?: string };
  };
  record_class?: string;
  thread_facet?: string;
  messages?: Array<{
    event: { id: string; occurred_at: string };
    direction?: string;
    kind?: string;
  }>;
}): string | null {
  const status = thread.work?.status;
  if (!thread.work) {
    if (thread.record_class === "task" || thread.thread_facet === "ticket") {
      return t("work.hint.task");
    }
    return null;
  }
  const delivery = thread.work.delivery;
  if (delivery?.status === "dead") {
    return t("work.hint.dead");
  }
  if (delivery?.write_back === "failed") {
    return t("work.hint.writeBackFailed");
  }
  if (delivery?.status === "write_back") {
    return t("work.hint.writeBack");
  }
  if (delivery?.status === "queued") {
    return t("work.hint.queued");
  }
  switch (status) {
    case "open":
      return t("work.hint.open");
    case "failed":
      return t("work.hint.failed");
    case "running": {
      const held = heldFollowUpCount(thread);
      return held > 0
        ? t("work.hint.held", { count: held })
        : t("work.hint.running");
    }
    case "waiting_human":
      return t("work.hint.waiting");
    case "done":
      return delivery?.write_back === "sent"
        ? t("work.hint.acked")
        : thread.work.can_write_back
          ? t("work.hint.doneWrite")
          : t("work.hint.done");
    case "skipped":
      return t("work.hint.skipped");
    default:
      return thread.work.recipe_id ? null : t("work.hint.noRecipe");
  }
}

export function conversationKindLabel(kind: string | null | undefined): string | null {
  if (kind === "group") {
    return t("label.group");
  }
  // direct and raw kinds (e.g. "order") are not list faces — they only widen the row.
  return null;
}

export function unitKindChip(thread: {
  unit_kind?: string | null;
  unit_kind_label?: string | null;
}): string | null {
  const label = thread.unit_kind_label?.replace(/\s+/g, " ").trim();
  if (label) {
    return label;
  }
  const id = thread.unit_kind?.trim();
  return id || null;
}

export type ThreadFaceTag =
  | { key: "channel"; label: string; channel: string }
  | { key: "unit"; label: string }
  | { key: "conversation"; label: string }
  | { key: "facet"; label: string }
  | { key: "work"; label: string; status: string };

/**
 * Compact face chips for list + thread header.
 * Drops raw conversation kinds and ticket-when-unit (e.g. order + 工单).
 */
export function threadFaceTags(thread: {
  channel: string;
  channel_label: string;
  conversation_kind?: string | null;
  thread_facet?: string | null;
  unit_kind?: string | null;
  unit_kind_label?: string | null;
  work?:
    | string
    | {
        status?: string;
        delivery?: { status?: string; write_back?: string };
      }
    | null;
}): ThreadFaceTag[] {
  const tags: ThreadFaceTag[] = [
    {
      key: "channel",
      label: thread.channel_label,
      channel: thread.channel,
    },
  ];
  const unit = unitKindChip(thread);
  if (unit) {
    tags.push({ key: "unit", label: unit });
  }
  const kind = conversationKindLabel(thread.conversation_kind);
  if (kind) {
    tags.push({ key: "conversation", label: kind });
  }
  const facet = thread.thread_facet;
  if (facet === "agent") {
    tags.push({ key: "facet", label: t("label.agent") });
  } else if (facet === "ticket" && !unit) {
    // Unit kind already says what kind of ticket this is.
    tags.push({ key: "facet", label: t("label.ticket") });
  }
  const work = workStatusLabel(thread.work);
  if (work) {
    const status =
      typeof thread.work === "string"
        ? thread.work
        : (thread.work?.status ?? "");
    tags.push({ key: "work", label: work, status });
  }
  return tags;
}

const SENT_WAIT_MS = 30 * 60 * 1000;
const WORKING_WAIT_MS = 24 * 60 * 60 * 1000;

export function threadActivityOf(
  thread: InboxThread,
  now = Date.now(),
): InboxViewItem["activity"] | "sent" | undefined {
  const working = liveWorkingOf(thread, now);
  if (working) {
    const lastVisible = lastVisibleMessage(thread);
    if (lastVisible?.activity === "awaiting_user") {
      return "awaiting_user";
    }
    if (lastVisible?.kind === "assistant" && lastVisible.direction === "inbound") {
      return undefined;
    }
    return "working";
  }
  const latest = thread.messages[thread.messages.length - 1];
  if (!latest) {
    return undefined;
  }
  if (latest.activity && latest.activity !== "working") {
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

function isThreadStatusRow(item: InboxViewItem): boolean {
  return (
    item.activity === "working"
    || item.decision.reason_codes.includes("thread_status")
  );
}

function latestThreadStatus(thread: InboxThread): InboxViewItem | undefined {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const item = thread.messages[index];
    if (isThreadStatusRow(item)) {
      return item;
    }
  }
  return undefined;
}

function liveWorkingOf(
  thread: InboxThread,
  now: number,
): InboxViewItem | undefined {
  if (thread.hold_while_working === true) {
    return latestLiveWorking(thread, now);
  }
  const latest = thread.messages[thread.messages.length - 1];
  if (latest?.activity !== "working") {
    return undefined;
  }
  if (!isRecentStamp(latest.event.occurred_at, now, SENT_WAIT_MS)) {
    return undefined;
  }
  return latest;
}

function latestLiveWorking(
  thread: InboxThread,
  now: number,
): InboxViewItem | undefined {
  const status = latestThreadStatus(thread);
  if (status?.activity !== "working") {
    return undefined;
  }
  if (!isRecentStamp(status.event.occurred_at, now, WORKING_WAIT_MS)) {
    return undefined;
  }
  return status;
}

export function heldWhileWorkingCount(thread: InboxThread, now = Date.now()): number {
  if (thread.hold_while_working !== true) {
    return 0;
  }
  const working = latestLiveWorking(thread, now);
  if (!working) {
    return 0;
  }
  const index = thread.messages.lastIndexOf(working);
  if (index < 0) {
    return 0;
  }
  return thread.messages.slice(index + 1).filter(
    (item) => item.kind === "user" && item.direction === "outbound",
  ).length;
}

export function threadActivityNote(
  thread: InboxThread,
  now = Date.now(),
): string | undefined {
  const activity = threadActivityOf(thread, now);
  if (activity === "working") {
    const held = heldWhileWorkingCount(thread, now);
    if (held > 0) {
      return t("work.hint.held", { count: held });
    }
  }
  return threadActivityCopy(activity);
}

function isRecentStamp(stamp: string, now: number, windowMs: number): boolean {
  const at = Date.parse(stamp);
  return Number.isFinite(at) && now - at >= 0 && now - at < windowMs;
}

export function threadActivityCopy(
  activity: InboxViewItem["activity"] | "sent" | undefined,
): string | undefined {
  if (activity === "awaiting_user") {
    return t("activity.awaiting");
  }
  if (activity === "working") {
    return t("activity.working");
  }
  if (activity === "sent") {
    return t("activity.sent");
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
    if (face && face.activity !== "working") {
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
  if (!face || face.activity === "working") {
    return thread.label;
  }
  return firstLine(face.body_text, 120) || thread.label;
}

export function threadPreview(thread: InboxThread): string {
  const activity = threadActivityNote(thread);
  if (activity) {
    return activity;
  }
  const face = threadFace(thread);
  if (face && face.activity !== "working") {
    return firstLine(face.body_text, 96) || thread.label;
  }
  return thread.label;
}

export function listPreview(thread: InboxThread, title: string): string | null {
  const resultLine = firstLine(thread.work?.result_summary, 88);
  if (resultLine && !sameListLine(title, resultLine)) {
    return resultLine;
  }
  const latest = lastVisibleMessage(thread);
  if (!latest) {
    return null;
  }
  const line = firstLine(latest.body_text, 88);
  if (!line) {
    return null;
  }
  const heading = title.replace(/\s+/g, " ").trim();
  if (!heading || sameListLine(heading, line)) {
    return null;
  }
  return line;
}

function sameListLine(title: string, line: string): boolean {
  if (title === line) {
    return true;
  }
  if (!title.startsWith(line) && !line.startsWith(title)) {
    return false;
  }
  const shorter = Math.min(title.length, line.length);
  const longer = Math.max(title.length, line.length);
  return shorter / longer > 0.72;
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

export function threadFace(thread: InboxThread): InboxViewItem | undefined {
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
    return t("thread.openingConversation");
  }
  if (error) {
    return error;
  }
  return t("thread.noMessages");
}

export function threadLoadedCountCopy(input: {
  opening: boolean;
  loaded: number;
  hasOlder: boolean;
}): string {
  if (input.loaded === 0 && input.opening) {
    return t("thread.opening");
  }
  if (input.hasOlder) {
    return t("thread.recentMessages", { count: input.loaded });
  }
  return t("thread.messages", { count: input.loaded });
}

export function sameSpeaker(left: InboxViewItem, right: InboxViewItem): boolean {
  return speakerKey(left) === speakerKey(right);
}

export function speakerMark(
  role: MessageRole,
  actorLabel?: string | null,
  direction?: MessageDirection | null,
): string {
  const named = actorLabel?.replace(/\s+/g, " ").trim();
  if (named) {
    return named.slice(0, 1);
  }
  if (role === "user") {
    return direction === "outbound"
      ? "Y"
      : t("label.participant").slice(0, 1);
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
  if (role === "user") {
    return `${role}:${item.direction ?? "unknown"}`;
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
    if (isThematicBreak(line)) {
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

function isThematicBreak(line: string): boolean {
  return /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isBlockBoundary(line: string): boolean {
  if (line.trim() === "") {
    return true;
  }
  if (isThematicBreak(line)) {
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
