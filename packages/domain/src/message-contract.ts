import { createHash } from "node:crypto";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  parseStoredContentParts,
  storedPartContentHash,
  storedPartText,
} from "./content-parts";
import type { ContentPart, IngestRecord } from "./ingestion";
import {
  readForwardedFrom,
  readForwardedTo,
} from "./forward-packet";
import {
  type ChannelId,
  type ForwardedFrom,
  type ForwardedTo,
  type MessageDirection,
  type MessageKind,
  type MessageSurface,
  type MessageTurn,
  type ThreadActivity,
  type ThreadFacet,
} from "@regenic/connector-contract";

export {
  channelRecord,
  conversationId,
  surfaceFromParts,
} from "@regenic/connector-contract";
export type {
  ChannelId,
  MessageDirection,
  MessageKind,
  MessageSurface,
  MessageTurn,
  ThreadActivity,
};

export interface ChannelDescriptor {
  id: ChannelId;
  label: string;
}

/** Builtin fallback labels when no live driver catalog is loaded. */
export const CHANNELS: Record<string, ChannelDescriptor> = {
  dsh: { id: "dsh", label: "DSH" },
  slack: { id: "slack", label: "Slack" },
  feishu: { id: "feishu", label: "Feishu" },
  "whatsapp-personal": { id: "whatsapp-personal", label: "WhatsApp" },
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
  if (mediaType === CONTENT_PARTS_MEDIA_TYPE) {
    const parts = parseStoredContentParts(bytes);
    if (!parts) {
      return undefined;
    }
    const body = parts.find((part) => part.role === "body") ?? parts[0];
    if (!body || body.role === "metadata") {
      return undefined;
    }
    return storedPartText(body);
  }
  if (mediaType.startsWith("text/") || mediaType === "application/json") {
    return Buffer.from(bytes).toString("utf8");
  }
  return undefined;
}

export function attachmentDigestsFromParts(
  parts: Array<{
    role?: string;
    bytes?: Uint8Array;
    bytes_base64?: string;
    content_hash?: string;
  }>,
): string[] {
  const digests: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.role !== "attachment") {
      continue;
    }
    const digest =
      storedPartContentHash(part) ??
      (part.bytes
        ? createHash("sha256").update(part.bytes).digest("hex")
        : part.bytes_base64
          ? createHash("sha256")
              .update(Buffer.from(part.bytes_base64, "base64"))
              .digest("hex")
          : undefined);
    if (!digest || seen.has(digest)) {
      continue;
    }
    seen.add(digest);
    digests.push(digest);
  }
  return digests;
}

export function attachmentDigestsFromStored(
  bytes: Uint8Array,
  mediaType: string,
): string[] {
  if (mediaType !== CONTENT_PARTS_MEDIA_TYPE) {
    return [];
  }
  const parts = parseStoredContentParts(bytes);
  return parts ? attachmentDigestsFromParts(parts) : [];
}

export function attachmentsCoveredBy(
  incoming: readonly string[],
  existing: readonly string[],
): boolean {
  if (incoming.length === 0 || existing.length === 0) {
    return false;
  }
  const have = new Set(existing);
  return incoming.every((digest) => have.has(digest));
}

export function channelLabel(channel: string | undefined): string {
  if (!channel) {
    return "Unknown";
  }
  return CHANNELS[channel]?.label ?? channel.toUpperCase();
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

function readSurface(
  value: MessageSurface,
  fallbackChannel?: string,
): MessageSurface {
  const conversationLabel = optionalLabel(value.conversation_label);
  const conversationKind = optionalLabel(value.conversation_kind);
  const unitKind = optionalLabel(value.unit_kind);
  const actorLabel = optionalLabel(value.actor_label);
  const activity = isActivity(value.activity) ? value.activity : undefined;
  const turn = readTurn(value.turn);
  const forwardedFrom = readForwardedFrom(value.forwarded_from);
  const forwardedTo = readForwardedTo(value.forwarded_to);
  return {
    channel: value.channel.trim() || fallbackChannel || value.channel,
    kind: value.kind,
    direction: value.direction,
    ...(conversationLabel ? { conversation_label: conversationLabel } : {}),
    ...(conversationKind ? { conversation_kind: conversationKind } : {}),
    ...(unitKind ? { unit_kind: unitKind } : {}),
    ...(actorLabel ? { actor_label: actorLabel } : {}),
    ...(activity ? { activity } : {}),
    ...(value.thread_facet ? { thread_facet: value.thread_facet } : {}),
    ...(typeof value.type === "string" && value.type.trim()
      ? { type: value.type.trim() }
      : {}),
    ...(turn ? { turn } : {}),
    ...(forwardedFrom ? { forwarded_from: forwardedFrom } : {}),
    ...(forwardedTo ? { forwarded_to: forwardedTo } : {}),
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

function readTurn(value: unknown): MessageTurn | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const turn = value as MessageTurn;
  if (turn.state === "open") {
    return { state: "open" };
  }
  if (turn.state !== "ended") {
    return undefined;
  }
  return {
    state: "ended",
    ok: turn.ok !== false,
    ...(typeof turn.reason === "string" && turn.reason.trim()
      ? { reason: turn.reason.trim() }
      : {}),
  };
}
