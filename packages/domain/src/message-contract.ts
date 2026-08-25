import type { ContentPart, IngestRecord } from "./ingestion";
import type { ThreadFacet } from "./thread-facet";

export const SURFACE_MEDIA_TYPE = "application/vnd.regenic.surface+json";

export type ChannelId = string;
export type MessageKind = "user" | "assistant" | "system";
export type MessageDirection = "inbound" | "outbound";
export type ThreadActivity = "awaiting_user" | "working";

export interface MessageSurface {
  channel: ChannelId;
  kind: MessageKind;
  direction: MessageDirection;
  conversation_label?: string;
  conversation_kind?: string;
  actor_label?: string;
  activity?: ThreadActivity;
  thread_facet?: ThreadFacet;
  type?: string;
}

export interface ChannelDescriptor {
  id: ChannelId;
  label: string;
}

export const CHANNELS: Record<string, ChannelDescriptor> = {
  dsh: { id: "dsh", label: "DSH" },
  slack: { id: "slack", label: "Slack" },
  feishu: { id: "feishu", label: "Feishu" },
};

export function isLocalOutboundId(externalId: string): boolean {
  return externalId.includes(":out:");
}

export function normalizeUtterance(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export function bodyTextFromStored(
  bytes: Uint8Array,
  mediaType: string,
): string | undefined {
  if (mediaType === "application/vnd.regenic.content-parts+json") {
    try {
      const parts = JSON.parse(Buffer.from(bytes).toString("utf8")) as Array<{
        role?: string;
        media_type?: string;
        bytes_base64?: string;
      }>;
      const body = parts.find((part) => part.role === "body") ?? parts[0];
      if (body?.bytes_base64 && body.media_type?.startsWith("text/")) {
        return Buffer.from(body.bytes_base64, "base64").toString("utf8");
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (mediaType.startsWith("text/") || mediaType === "application/json") {
    return Buffer.from(bytes).toString("utf8");
  }
  return undefined;
}

export function conversationId(
  source: string,
  externalId: string,
  fallbackId = externalId,
): string {
  const cut = externalId.indexOf(":out:");
  const withoutOut = cut >= 0 ? externalId.slice(0, cut) : externalId;
  const colon = withoutOut.lastIndexOf(":");
  if (colon > 0) {
    return `${source}:${withoutOut.slice(0, colon)}`;
  }
  return `${source}:${withoutOut || fallbackId}`;
}

export function channelLabel(channel: string | undefined): string {
  if (!channel) {
    return "Unknown";
  }
  return CHANNELS[channel]?.label ?? channel.toUpperCase();
}

export function channelRecord(input: {
  channel: ChannelId;
  kind: MessageKind;
  direction: MessageDirection;
  external_id: string;
  occurred_at: string;
  actor_id: string;
  actor_label?: string;
  activity?: ThreadActivity;
  scope_id: string;
  scope_name?: string;
  conversation_kind?: string;
  thread_facet?: ThreadFacet;
  type?: string;
  parent_external_id?: string;
  thread_id?: string;
  text?: string;
  media_type?: string;
  content?: ContentPart[];
}): IngestRecord {
  const surface: MessageSurface = {
    channel: input.channel,
    kind: input.kind,
    direction: input.direction,
    ...(input.scope_name ? { conversation_label: input.scope_name } : {}),
    ...(input.conversation_kind
      ? { conversation_kind: input.conversation_kind }
      : {}),
    ...(input.actor_label ? { actor_label: input.actor_label } : {}),
    ...(input.activity ? { activity: input.activity } : {}),
    ...(input.thread_facet ? { thread_facet: input.thread_facet } : {}),
    ...(input.type ? { type: input.type } : {}),
  };
  const body = input.content ?? [];
  const hasBody = body.some((part) => part.role === "body");
  const prefixed: ContentPart[] =
    hasBody || input.text === undefined
      ? body
      : [
          {
            role: "body" as const,
            media_type: input.media_type ?? "text/plain",
            text: input.text,
          },
          ...body,
        ];
  const content: ContentPart[] = [
    ...prefixed,
    {
      role: "metadata" as const,
      media_type: SURFACE_MEDIA_TYPE,
      text: JSON.stringify(surface),
    },
  ];
  return {
    operation: "create",
    source: input.channel,
    external_id: input.external_id,
    occurred_at: input.occurred_at,
    actor: {
      id: input.actor_id,
      ...(input.actor_label ? { display_name: input.actor_label } : {}),
    },
    scope: {
      id: input.scope_id,
      name: input.scope_name,
    },
    type: input.type ?? "message",
    thread: input.thread_id ? { id: input.thread_id } : undefined,
    parent_external_id: input.parent_external_id,
    content,
    direction_tags: [input.direction],
  };
}

export function toReplyParts(input: {
  text?: string;
  attachments?: Array<{
    filename: string;
    media_type: string;
    bytes: Uint8Array;
  }>;
}): ContentPart[] {
  const parts: ContentPart[] = [];
  if (input.text && input.text.trim().length > 0) {
    parts.push({
      role: "body",
      media_type: "text/markdown",
      text: input.text,
    });
  }
  for (const attachment of input.attachments ?? []) {
    parts.push({
      role: "attachment",
      media_type: attachment.media_type,
      source_filename: attachment.filename,
      bytes: attachment.bytes,
    });
  }
  return parts;
}

export function surfaceFromParts(
  parts: Array<{ role?: string; media_type?: string; text?: string; bytes_base64?: string }>,
): MessageSurface | undefined {
  for (const part of parts) {
    if (part.role !== "metadata" || part.media_type !== SURFACE_MEDIA_TYPE) {
      continue;
    }
    const raw =
      typeof part.text === "string"
        ? part.text
        : part.bytes_base64
          ? Buffer.from(part.bytes_base64, "base64").toString("utf8")
          : "";
    const parsed = parseSurface(raw);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

export function resolveMessageSurface(input: {
  source: string;
  external_id: string;
  body_text?: string;
  stored?: MessageSurface;
}): MessageSurface {
  if (input.stored && isKind(input.stored.kind) && isDirection(input.stored.direction)) {
    return readSurface(input.stored, input.source);
  }
  return inferLegacySurface(input);
}

export function inferLegacySurface(input: {
  source: string;
  external_id: string;
  body_text?: string;
}): MessageSurface {
  if (isLocalOutboundId(input.external_id)) {
    return { channel: input.source, kind: "user", direction: "outbound" };
  }
  return { channel: input.source, kind: "assistant", direction: "inbound" };
}

function parseSurface(raw: string): MessageSurface | undefined {
  try {
    const value = JSON.parse(raw) as MessageSurface;
    if (
      typeof value.channel === "string" &&
      value.channel.trim().length > 0 &&
      isKind(value.kind) &&
      isDirection(value.direction)
    ) {
      return readSurface(value);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readSurface(
  value: MessageSurface,
  fallbackChannel?: string,
): MessageSurface {
  const conversationLabel = optionalLabel(value.conversation_label);
  const conversationKind = optionalLabel(value.conversation_kind);
  const actorLabel = optionalLabel(value.actor_label);
  const activity = isActivity(value.activity) ? value.activity : undefined;
  return {
    channel: value.channel.trim() || fallbackChannel || value.channel,
    kind: value.kind,
    direction: value.direction,
    ...(conversationLabel ? { conversation_label: conversationLabel } : {}),
    ...(conversationKind ? { conversation_kind: conversationKind } : {}),
    ...(actorLabel ? { actor_label: actorLabel } : {}),
    ...(activity ? { activity } : {}),
    ...(value.thread_facet ? { thread_facet: value.thread_facet } : {}),
    ...(typeof value.type === "string" && value.type.trim()
      ? { type: value.type.trim() }
      : {}),
  };
}

function optionalLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isKind(value: unknown): value is MessageKind {
  return value === "user" || value === "assistant" || value === "system";
}

function isDirection(value: unknown): value is MessageDirection {
  return value === "inbound" || value === "outbound";
}

function isActivity(value: unknown): value is ThreadActivity {
  return value === "awaiting_user" || value === "working";
}
