import { createHash } from "node:crypto";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  bodyTextFromStored,
  canonicalContextJson,
  isTextFilename,
  isTextMediaType,
  parseStoredContentParts,
  storedPartBytes,
  storedPartContentHash,
  storedPartText,
  type BlobStore,
  type AuthorizedContextSourceEvent,
  type ContextAuthorityRead,
  type ContextEmbeddingMaterial,
  type EmbeddingGeneration,
  type ContextAuthorityReader,
  type ContextEvidenceSource,
  type ContextLifecycleHead,
  type ContextRequest,
  type ContextSourceEvent,
  type StoredContentPart,
  type ContextSearchPart,
} from "@regenic/domain";

export class ContextTextMaterialError extends Error {}

export class AuthorityContextEvidenceSource implements ContextEvidenceSource {
  constructor(
    private readonly authority: ContextAuthorityReader,
    private readonly blobs: BlobStore,
    private readonly strictText = false,
  ) {}

  async openRead(request: ContextRequest) {
    const read = structuredClone(await this.authority.openContextRead(request.org_id, {
      filters: request.filters,
      anchors: request.anchors,
    }));
    validateAuthorityRead(request.org_id, read);
    const heads = new Map(
      read.lifecycle_heads.map((head) => [identityKey(head.source, head.external_id), head]),
    );
    const groups = groupEvents(read.events);
    const eligibleGroups = [...groups.entries()].filter(([key, events]) =>
      hasContextMetadata(events) && isClosedLifecycle(events, heads.get(key)),
    );
    const events: ContextSourceEvent[] = [];
    const lifecycleHeads: ContextLifecycleHead[] = [];
    for (const [key, lifecycle] of eligibleGroups) {
      const head = heads.get(key)!;
      lifecycleHeads.push(structuredClone(head));
      for (const source of lifecycle) {
        const tombstone = source.operation === "tombstone";
        const contentHash = tombstone ? undefined : source.content_hash;
        events.push({
          event: {
            event_id: source.id,
            org_id: source.org_id,
            source: source.source,
            external_id: source.external_id,
            operation: source.operation,
            occurred_at: source.occurred_at,
            ingested_at: source.ingested_at,
            ...(contentHash ? { content_hash: contentHash } : {}),
            ...(source.parent_event_id
              ? { parent_event_id: source.parent_event_id }
              : {}),
          },
          thread_id: source.thread_id!,
          actor_id: source.actor_id!,
          required_scope_ids: [...source.required_scope_ids!],
          ...(source.direction_tags
            ? { direction_tags: [...source.direction_tags] }
            : {}),
          ...(source.weight_hints
            ? { weight_hints: structuredClone(source.weight_hints) }
            : {}),
          ...(source.attrs ? { attrs: structuredClone(source.attrs) } : {}),
          ...(source.content_media_type
            ? { content_media_type: source.content_media_type }
            : {}),
        });
      }
    }

    return {
      read_epoch: read.read_epoch,
      recorded_at: read.recorded_at,
      lifecycle_complete: true as const,
      lifecycle_heads: lifecycleHeads.sort(compareHeads),
      events,
    };
  }

  async materialize(
    events: AuthorizedContextSourceEvent[],
  ): Promise<AuthorizedContextSourceEvent[]> {
    return this.materializeStored(events, true);
  }

  private async materializeStored(
    events: AuthorizedContextSourceEvent[],
    includeAttachments: boolean,
  ): Promise<AuthorizedContextSourceEvent[]> {
    const hashes = [...new Set(events.flatMap((source) =>
      source.event.content_hash ? [source.event.content_hash] : [],
    ))];
    const bodies = await this.blobs.getMany(hashes);
    if (hashes.some((hash) => !bodies.has(hash))) {
      throw new Error("Context authority Event references a missing Blob");
    }
    const textAttachments = new Map<string, StoredContentPart[]>();
    for (const source of events) {
      const contentHash = source.event.content_hash;
      const bytes = contentHash ? bodies.get(contentHash) : undefined;
      if (!contentHash || !bytes || source.content_media_type !== CONTENT_PARTS_MEDIA_TYPE) continue;
      const parts = parseStoredContentParts(bytes);
      if (!parts) continue;
      const attachments = includeAttachments ? parts.filter(isTextAttachment) : [];
      if (attachments.length > 0) textAttachments.set(contentHash, attachments);
    }
    const attachmentHashes = [...new Set(
      [...textAttachments.values()].flatMap((parts) =>
        parts.flatMap((part) => {
          const hash = storedPartContentHash(part);
          return hash ? [hash] : [];
        }),
      ),
    )];
    const attachmentBlobs = await this.blobs.getMany(attachmentHashes);
    if (attachmentHashes.some((hash) => !attachmentBlobs.has(hash))) {
      throw new Error("Context authority Event references a missing text Attachment Blob");
    }
    return events.map((source) => {
      const contentHash = source.event.content_hash;
      const bytes = contentHash ? bodies.get(contentHash) : undefined;
      if (this.strictText && bytes) {
        if (createHash("sha256").update(bytes).digest("hex") !== contentHash) {
          throw new ContextTextMaterialError("Stored text hash mismatch");
        }
        if (source.content_media_type) validateTextEncoding(bytes, source.content_media_type);
      }
      const text = bytes && source.content_media_type
        ? materializedText(
            bytes,
            source.content_media_type,
            contentHash ? textAttachments.get(contentHash) ?? [] : [],
            attachmentBlobs,
            this.strictText,
          )
        : undefined;
      const searchParts: ContextSearchPart[] = [];
      if (includeAttachments && bytes && source.content_media_type === CONTENT_PARTS_MEDIA_TYPE) {
        const parts = parseStoredContentParts(bytes) ?? [];
        const body = bodyTextFromStored(bytes, source.content_media_type);
        let cursor = body?.length ?? 0;
        let hasText = body !== undefined;
        for (const [partIndex, part] of parts.entries()) {
          if (part.role !== "attachment") continue;
          const hash = storedPartContentHash(part);
          const embedded = storedPartBytes(part) ??
            (typeof part.text === "string" ? Buffer.from(part.text, "utf8") : undefined);
          const attachmentText = isTextAttachment(part)
            ? attachmentTextFor(part, attachmentBlobs, this.strictText)
            : undefined;
          const projectionStart = attachmentText === undefined ? undefined : cursor + (hasText ? 2 : 0);
          if (attachmentText !== undefined) {
            cursor = projectionStart! + attachmentText.length;
            hasText = true;
          }
          searchParts.push({
            part_index: partIndex,
            media_type: part.media_type ?? "application/octet-stream",
            ...(part.source_filename ? { filename: part.source_filename } : {}),
            ...(hash || embedded ? { content_hash: hash ?? createHash("sha256").update(embedded!).digest("hex") } : {}),
            ...(attachmentText === undefined ? {} : { text: attachmentText, projection_start: projectionStart }),
          });
        }
      } else if (includeAttachments && bytes && source.content_media_type &&
        (!isTextMediaType(source.content_media_type) || hasBinarySignature(bytes))) {
        searchParts.push({ part_index: -1, media_type: source.content_media_type, content_hash: contentHash });
      }
      return {
        ...structuredClone(source),
        ...(text === undefined ? {} : { text }),
        ...(includeAttachments ? {
          search_parts: searchParts,
          search_body: bytes && source.content_media_type && !hasBinarySignature(bytes)
            ? (source.content_media_type === CONTENT_PARTS_MEDIA_TYPE
              ? storedPartText((parseStoredContentParts(bytes) ?? []).find((part) => part.role === "body") ?? {})
              : bodyTextFromStored(bytes, source.content_media_type)) ?? "" : "",
        } : {}),
      };
    });
  }

  async materializeForEmbedding(
    events: AuthorizedContextSourceEvent[],
    extractorVersion: EmbeddingGeneration["extractor_version"] = "stored-body-and-attachments-v2",
  ): Promise<ContextEmbeddingMaterial[]> {
    const materialized = await this.materializeStored(
      events, extractorVersion === "stored-body-and-attachments-v2",
    );
    if (extractorVersion === "stored-body-text-v1") {
      return materialized.map((source) => ({
        event_id: source.event.event_id,
        ...(source.text === undefined ? {} : { text: source.text }),
        attachments: [],
      }));
    }
    const bodyHashes = [...new Set(events.flatMap((source) =>
      source.event.content_hash ? [source.event.content_hash] : [],
    ))];
    const bodies = await this.blobs.getMany(bodyHashes);
    for (const hash of bodyHashes) {
      const bytes = bodies.get(hash);
      if (!bytes) throw new Error("Context authority Event references a missing Blob");
      if (this.strictText && createHash("sha256").update(bytes).digest("hex") !== hash) {
        throw new ContextTextMaterialError("Stored content hash mismatch");
      }
    }
    const attachmentHashes = new Set<string>();
    const partsByEvent = new Map<string, StoredContentPart[]>();

    for (const source of events) {
      const eventId = source.event.event_id;
      const contentHash = source.event.content_hash;
      const bytes = contentHash ? bodies.get(contentHash) : undefined;
      if (!bytes || source.content_media_type !== CONTENT_PARTS_MEDIA_TYPE) continue;
      const parts = parseStoredContentParts(bytes) ?? [];
      const attachments = parts.filter((part) =>
        part.role === "attachment",
      );
      partsByEvent.set(eventId, parts);
      for (const part of attachments) {
        const hash = storedPartContentHash(part);
        if (hash) attachmentHashes.add(hash);
      }
    }

    const attachmentBlobs = await this.blobs.getMany([...attachmentHashes]);
    if ([...attachmentHashes].some((hash) => !attachmentBlobs.has(hash))) {
      throw new Error("Context authority Event references a missing Attachment Blob");
    }
    const materializedById = new Map(
      materialized.map((source) => [source.event.event_id, source]),
    );

    return events.map((source) => {
      const eventId = source.event.event_id;
      const event = materializedById.get(eventId);
      if (!event) throw new Error("Embedding materialization changed the authorized Event set");
      const directBlob = source.event.content_hash && source.content_media_type &&
          source.content_media_type !== CONTENT_PARTS_MEDIA_TYPE &&
          (!isTextMediaType(source.content_media_type) ||
            hasBinarySignature(bodies.get(source.event.content_hash)!))
        ? bodies.get(source.event.content_hash)
        : undefined;
      const attachments = (partsByEvent.get(eventId) ?? []).flatMap((part, partIndex) => {
        if (part.role !== "attachment") return [];
        const storedHash = storedPartContentHash(part);
        const bytes = storedHash ? attachmentBlobs.get(storedHash) : storedPartBytes(part);
        if (!bytes) return [];
        if (isTextAttachment(part) && !hasBinarySignature(bytes)) return [];
        const contentHash = storedHash ?? createHash("sha256").update(bytes).digest("hex");
        if (
          this.strictText &&
          createHash("sha256").update(bytes).digest("hex") !== contentHash
        ) {
          throw new ContextTextMaterialError("Stored attachment hash mismatch");
        }
        return [{
          part_index: partIndex,
          content_hash: contentHash,
          media_type: part.media_type ?? "application/octet-stream",
          ...(part.source_filename ? { source_filename: part.source_filename } : {}),
          bytes: new Uint8Array(bytes),
        }];
      });
      if (
        directBlob && source.event.content_hash && source.content_media_type
      ) {
        if (
          this.strictText &&
          createHash("sha256").update(directBlob).digest("hex") !== source.event.content_hash
        ) {
          throw new ContextTextMaterialError("Stored attachment hash mismatch");
        }
        attachments.unshift({
          part_index: -1,
          content_hash: source.event.content_hash,
          media_type: source.content_media_type,
          bytes: new Uint8Array(directBlob),
        });
      }
      return {
        event_id: eventId,
        ...(event.text === undefined ? {} : { text: event.text }),
        search_parts: event.search_parts,
        attachments,
      };
    });
  }
}

function materializedText(
  bytes: Uint8Array,
  mediaType: string,
  attachments: StoredContentPart[],
  attachmentBlobs: ReadonlyMap<string, Uint8Array>,
  strictText: boolean,
): string | undefined {
  if (hasBinarySignature(bytes)) return undefined;
  const body = bodyTextFromStored(bytes, mediaType);
  const texts = body === undefined ? [] : [body];
  for (const attachment of attachments) {
    const text = attachmentTextFor(attachment, attachmentBlobs, strictText);
    if (text !== undefined) texts.push(text);
  }
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function attachmentTextFor(
  attachment: StoredContentPart,
  blobs: ReadonlyMap<string, Uint8Array>,
  strict: boolean,
): string | undefined {
  const hash = storedPartContentHash(attachment);
  const bytes = hash ? blobs.get(hash) : storedPartBytes(attachment) ??
    (typeof attachment.text === "string" ? Buffer.from(attachment.text, "utf8") : undefined);
  if (!bytes) return undefined;
  if (strict && hash && createHash("sha256").update(bytes).digest("hex") !== hash) {
    throw new ContextTextMaterialError("Stored text attachment hash mismatch");
  }
  if (hasBinarySignature(bytes)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new ContextTextMaterialError("Invalid UTF-8 text attachment");
    throw error;
  }
}

function isTextAttachment(part: StoredContentPart): boolean {
  if (part.role !== "attachment") return false;
  if (part.media_type && isTextMediaType(part.media_type)) return true;
  return isTextFilename(part.source_filename);
}

function hasBinarySignature(bytes: Uint8Array): boolean {
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const hex = prefix.toString("hex");
  return /^(89504e470d0a1a0a|ffd8ff|255044462d|504b0304|504b0506|504b0708|474946383761|474946383961)/.test(hex) ||
    prefix.subarray(4, 8).toString("ascii") === "ftyp" ||
    (prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
      prefix.subarray(8, 12).toString("ascii") === "WEBP");
}

function validateTextEncoding(bytes: Uint8Array, mediaType: string): void {
  if (hasBinarySignature(bytes)) return;
  if (!isTextMediaType(mediaType) && mediaType !== CONTENT_PARTS_MEDIA_TYPE) return;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(bytes);
    if (mediaType === CONTENT_PARTS_MEDIA_TYPE) {
      const parts = parseStoredContentParts(bytes);
      if (!parts) throw new ContextTextMaterialError("Invalid stored text envelope");
      const body = parts.find((part) => part.role === "body") ?? parts[0];
      if (body?.media_type && isTextMediaType(body.media_type)) {
        const embedded = storedPartBytes(body);
        if (embedded && !hasBinarySignature(embedded)) decoder.decode(embedded);
      }
      for (const part of parts.filter(isTextAttachment)) {
        const embedded = storedPartBytes(part);
        if (embedded && !hasBinarySignature(embedded)) decoder.decode(embedded);
      }
    }
  } catch (error) {
    if (error instanceof TypeError) throw new ContextTextMaterialError("Invalid UTF-8 text");
    throw error;
  }
}

function validateAuthorityRead(orgId: string, read: ContextAuthorityRead): void {
  const eventIds = new Set<string>();
  const headIdentities = new Set<string>();
  if (
    !read ||
    typeof read.read_epoch !== "string" ||
    !read.read_epoch.trim() ||
    typeof read.recorded_at !== "string" ||
    Number.isNaN(Date.parse(read.recorded_at)) ||
    !Array.isArray(read.events) ||
    !Array.isArray(read.lifecycle_heads)
  ) {
    throw new Error("Context authority returned an invalid read boundary");
  }
  for (const event of read.events) {
    if (
      !event ||
      event.org_id !== orgId ||
      typeof event.id !== "string" ||
      !event.id.trim() ||
      eventIds.has(event.id) ||
      typeof event.source !== "string" ||
      !event.source.trim() ||
      typeof event.external_id !== "string" ||
      !event.external_id.trim() ||
      !["create", "revise", "tombstone"].includes(event.operation) ||
      typeof event.occurred_at !== "string" ||
      Number.isNaN(Date.parse(event.occurred_at)) ||
      typeof event.ingested_at !== "string" ||
      Number.isNaN(Date.parse(event.ingested_at))
    ) {
      throw new Error("Context authority returned an invalid Event");
    }
    eventIds.add(event.id);
  }
  for (const head of read.lifecycle_heads) {
    if (
      !head ||
      typeof head.source !== "string" ||
      !head.source.trim() ||
      typeof head.external_id !== "string" ||
      !head.external_id.trim() ||
      typeof head.head_event_id !== "string" ||
      !head.head_event_id.trim()
    ) {
      throw new Error("Context authority returned an invalid lifecycle head");
    }
    const key = identityKey(head.source, head.external_id);
    if (headIdentities.has(key)) {
      throw new Error("Context authority returned duplicate lifecycle heads");
    }
    headIdentities.add(key);
  }
}

function hasContextMetadata(events: ContextAuthorityRead["events"]): boolean {
  return events.every((event) =>
    typeof event.thread_id === "string" &&
    event.thread_id.trim().length > 0 &&
    typeof event.actor_id === "string" &&
    event.actor_id.trim().length > 0 &&
    Array.isArray(event.required_scope_ids) &&
    event.required_scope_ids.length > 0 &&
    event.required_scope_ids.every((scope) =>
      typeof scope === "string" && scope.trim().length > 0,
    ) &&
    (event.operation === "tombstone" ||
      (typeof event.content_hash === "string" &&
        typeof event.content_media_type === "string" &&
        event.content_media_type.trim().length > 0)),
  );
}

function isClosedLifecycle(
  events: ContextAuthorityRead["events"],
  head: ContextLifecycleHead | undefined,
): boolean {
  if (!head || events.length === 0) {
    return false;
  }
  const byId = new Map(events.map((event) => [event.id, event]));
  const roots = events.filter((event) => !event.parent_event_id);
  if (
    roots.length !== 1 ||
    roots[0].operation !== "create" ||
    events.some((event) =>
      event.operation === "create"
        ? Boolean(event.parent_event_id)
        : !event.parent_event_id || !byId.has(event.parent_event_id),
    )
  ) {
    return false;
  }
  const children = new Map<string, string[]>();
  for (const event of events) {
    if (!event.parent_event_id) {
      continue;
    }
    const values = children.get(event.parent_event_id) ?? [];
    values.push(event.id);
    children.set(event.parent_event_id, values);
  }
  if ([...children.values()].some((values) => values.length !== 1)) {
    return false;
  }
  const visited = new Set<string>();
  let current = roots[0];
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const childId = children.get(current.id)?.[0];
    if (!childId) {
      break;
    }
    current = byId.get(childId)!;
  }
  return visited.size === events.length && current.id === head.head_event_id;
}

function groupEvents(
  events: ContextAuthorityRead["events"],
): Map<string, ContextAuthorityRead["events"]> {
  const groups = new Map<string, ContextAuthorityRead["events"]>();
  for (const event of events) {
    const key = identityKey(event.source, event.external_id);
    const values = groups.get(key) ?? [];
    values.push(event);
    groups.set(key, values);
  }
  return groups;
}

function identityKey(source: string, externalId: string): string {
  return canonicalContextJson([source, externalId]);
}

function compareHeads(left: ContextLifecycleHead, right: ContextLifecycleHead): number {
  const leftKey = identityKey(left.source, left.external_id);
  const rightKey = identityKey(right.source, right.external_id);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
