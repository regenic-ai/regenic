import { createHash } from "node:crypto";

export const FORWARD_MAX_TEXT = 32_000;
export const FORWARD_MODES = ["messages", "transcript"] as const;
export type ForwardMode = (typeof FORWARD_MODES)[number];

export interface ForwardedFrom {
  thread_id: string;
  event_ids: string[];
  source: string;
  channel_label?: string;
}

export type ForwardedTo = ForwardedFrom;

export interface ForwardUtterance {
  event_id: string;
  occurred_at: string;
  channel_label: string;
  actor_label?: string | null;
  body_text?: string;
  attachments?: Array<{
    filename: string;
    media_type: string;
    bytes?: Uint8Array;
  }>;
}

export interface CompileForwardInput {
  source_thread_id: string;
  source: string;
  mode: ForwardMode;
  attribution?: boolean;
  title?: string;
  utterances: ForwardUtterance[];
}

export interface PortableForwardPacket {
  text: string;
  attachments: Array<{
    filename: string;
    media_type: string;
    bytes: Uint8Array;
  }>;
  forwarded_from: ForwardedFrom;
  truncated: boolean;
}

export function isForwardMode(value: unknown): value is ForwardMode {
  return value === "messages" || value === "transcript";
}

export function readForwardedFrom(value: unknown): ForwardedFrom | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as ForwardedFrom;
  const threadId = typeof raw.thread_id === "string" ? raw.thread_id.trim() : "";
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  if (!threadId || !source || !Array.isArray(raw.event_ids)) {
    return undefined;
  }
  const eventIds = raw.event_ids
    .map((id) => (typeof id === "string" ? id.trim() : ""))
    .filter((id) => id.length > 0);
  if (eventIds.length === 0) {
    return undefined;
  }
  return { thread_id: threadId, event_ids: eventIds, source };
}

export const readForwardedTo = readForwardedFrom;

export function latestForwardedTo(
  traces: Array<{
    id: string;
    occurred_at: string;
    forwarded_to?: ForwardedFrom;
  }>,
): Map<string, ForwardedFrom> {
  const ranked = traces
    .filter((row): row is typeof row & { forwarded_to: ForwardedFrom } =>
      Boolean(row.forwarded_to),
    )
    .sort((left, right) => {
      if (left.occurred_at !== right.occurred_at) {
        return left.occurred_at < right.occurred_at ? -1 : 1;
      }
      return left.id < right.id ? -1 : 1;
    });
  const latest = new Map<string, ForwardedFrom>();
  for (const row of ranked) {
    for (const eventId of row.forwarded_to.event_ids) {
      latest.set(eventId, row.forwarded_to);
    }
  }
  return latest;
}

export function formatForwardTime(occurredAt: string): string {
  const stamp = occurredAt.trim();
  if (stamp.length >= 16 && stamp[10] === "T") {
    return `${stamp.slice(0, 10)} ${stamp.slice(11, 16)}`;
  }
  return stamp;
}

export function formatForwardAttribution(input: {
  channel_label?: string | null;
  actor_label?: string | null;
  occurred_at?: string;
}): string {
  return [
    input.channel_label?.replace(/\s+/g, " ").trim(),
    input.actor_label?.replace(/\s+/g, " ").trim(),
    input.occurred_at ? formatForwardTime(input.occurred_at) : "",
  ]
    .filter((part) => part && part.length > 0)
    .join(" · ");
}

export function compileForwardPacket(
  input: CompileForwardInput,
): PortableForwardPacket {
  const attribution = input.attribution !== false;
  const eventIds = input.utterances.map((item) => item.event_id);
  const blocks: string[] = [];
  if (input.mode === "transcript") {
    const title = input.title?.replace(/\s+/g, " ").trim();
    if (title) {
      blocks.push(title);
    }
  }
  const attachments: PortableForwardPacket["attachments"] = [];
  const seen = new Set<string>();
  for (const utterance of input.utterances) {
    const body = (utterance.body_text ?? "").trim();
    const files = utterance.attachments ?? [];
    const lines: string[] = [];
    if (attribution) {
      const who = formatForwardAttribution(utterance);
      if (who) {
        lines.push(who);
      }
    }
    if (body) {
      lines.push(body);
    }
    for (const marker of attachedMarkers(files)) {
      if (!lines.includes(marker)) {
        lines.push(marker);
      }
    }
    if (lines.length > 0) {
      blocks.push(lines.join("\n"));
    }
    for (const file of files) {
      const filename = file.filename?.trim();
      if (!filename || !file.bytes || file.bytes.byteLength === 0) {
        continue;
      }
      const key = `${filename}\t${file.media_type}\t${file.bytes.byteLength}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      attachments.push({
        filename,
        media_type: file.media_type,
        bytes: file.bytes,
      });
    }
  }
  let text = blocks.join("\n\n").trim();
  let truncated = false;
  if (text.length > FORWARD_MAX_TEXT) {
    truncated = true;
    const notice = `Truncated. Showing the start of ${input.utterances.length} messages.\n\n`;
    const budget = Math.max(0, FORWARD_MAX_TEXT - notice.length);
    text = `${notice}${text.slice(0, budget)}`.trimEnd();
  }
  return {
    text,
    attachments,
    forwarded_from: {
      thread_id: input.source_thread_id,
      event_ids: eventIds,
      source: input.source,
    },
    truncated,
  };
}

export function attachedMarker(filename: string): string {
  return `[Attached: ${filename.replace(/\s+/g, " ").trim()}]`;
}

export function attachedMarkers(
  files: Array<{ filename?: string | null }>,
): string[] {
  const seen = new Set<string>();
  const markers: string[] = [];
  for (const file of files) {
    const filename = file.filename?.replace(/\s+/g, " ").trim();
    if (!filename || seen.has(filename)) {
      continue;
    }
    seen.add(filename);
    markers.push(attachedMarker(filename));
  }
  return markers;
}

export function appendMissingAttachedLines(
  text: string,
  filenames: readonly string[],
): string {
  const extra = attachedMarkers(filenames.map((filename) => ({ filename }))).filter(
    (line) => !text.includes(line),
  );
  return extra.length > 0 ? [text, ...extra].join("\n") : text;
}

export function forwardIdempotencyKey(input: {
  org_id: string;
  source_thread_id: string;
  event_ids: readonly string[];
  target: string;
  mode: ForwardMode;
}): string {
  return createHash("sha256")
    .update(
      [
        input.org_id,
        input.source_thread_id,
        input.event_ids.join(","),
        input.target,
        input.mode,
      ].join("\n"),
    )
    .digest("hex");
}
