import type { ContentPart, IngestRecord } from "./ingest";

export const SURFACE_MEDIA_TYPE = "application/vnd.regenic.surface+json";

export type ThreadFacet = "chat" | "agent" | "ticket";

export interface ForwardedFrom {
  thread_id: string;
  event_ids: string[];
  source: string;
  channel_label?: string;
}

export type ForwardedTo = ForwardedFrom;

export function normalizeUnitKind(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim();
  return id.length > 0 ? id : undefined;
}

export type ChannelId = string;
export type MessageKind = "user" | "assistant" | "system";
export type MessageDirection = "inbound" | "outbound";
export type ThreadActivity = "awaiting_user" | "working";

export interface MessageTurn {
  state: "open" | "ended";
  ok?: boolean;
  reason?: string;
}

export interface MessageSurface {
  channel: ChannelId;
  kind: MessageKind;
  direction: MessageDirection;
  conversation_label?: string;
  conversation_kind?: string;
  unit_kind?: string;
  actor_label?: string;
  activity?: ThreadActivity;
  thread_facet?: ThreadFacet;
  type?: string;
  turn?: MessageTurn;
  forwarded_from?: ForwardedFrom;
  forwarded_to?: ForwardedTo;
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
  turn?: MessageTurn;
  scope_id: string;
  scope_name?: string;
  conversation_kind?: string;
  unit_kind?: string;
  thread_facet?: ThreadFacet;
  type?: string;
  parent_external_id?: string;
  thread_id?: string;
  text?: string;
  media_type?: string;
  content?: ContentPart[];
  forwarded_from?: ForwardedFrom;
  forwarded_to?: ForwardedTo;
}): IngestRecord {
  const unitKind = normalizeUnitKind(input.unit_kind);
  const surface: MessageSurface = {
    channel: input.channel,
    kind: input.kind,
    direction: input.direction,
    ...(input.scope_name ? { conversation_label: input.scope_name } : {}),
    ...(input.conversation_kind
      ? { conversation_kind: input.conversation_kind }
      : {}),
    ...(unitKind ? { unit_kind: unitKind } : {}),
    ...(input.actor_label ? { actor_label: input.actor_label } : {}),
    ...(input.activity ? { activity: input.activity } : {}),
    ...(input.turn ? { turn: input.turn } : {}),
    ...(input.thread_facet ? { thread_facet: input.thread_facet } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.forwarded_from ? { forwarded_from: input.forwarded_from } : {}),
    ...(input.forwarded_to ? { forwarded_to: input.forwarded_to } : {}),
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

export function conversationId(
  source: string,
  externalId: string,
  fallbackId = externalId,
): string {
  const cut = externalId.indexOf(":out:");
  if (cut >= 0) {
    const target = externalId.slice(0, cut).trim();
    return `${source}:${target || fallbackId}`;
  }
  const colon = externalId.lastIndexOf(":");
  if (colon > 0) {
    return `${source}:${externalId.slice(0, colon)}`;
  }
  return `${source}:${externalId || fallbackId}`;
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

export function surfaceFromParts(
  parts: Array<{
    role?: string;
    media_type?: string;
    text?: string;
    bytes_base64?: string;
  }>,
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

function readSurface(value: MessageSurface): MessageSurface {
  const conversationLabel = optionalLabel(value.conversation_label);
  const conversationKind = optionalLabel(value.conversation_kind);
  const unitKind = optionalLabel(value.unit_kind);
  const actorLabel = optionalLabel(value.actor_label);
  const activity = isActivity(value.activity) ? value.activity : undefined;
  const turn = readTurn(value.turn);
  const forwardedFrom = readForwardedFrom(value.forwarded_from);
  const forwardedTo = readForwardedTo(value.forwarded_to);
  return {
    channel: value.channel.trim(),
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
