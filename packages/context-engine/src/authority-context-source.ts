import {
  bodyTextFromStored,
  canonicalContextJson,
  type BlobStore,
  type ContextAuthorityRead,
  type ContextAuthorityReader,
  type ContextEvidenceSource,
  type ContextLifecycleHead,
  type ContextRequest,
  type ContextSourceEvent,
} from "@regenic/domain";

export class AuthorityContextEvidenceSource implements ContextEvidenceSource {
  constructor(
    private readonly authority: ContextAuthorityReader,
    private readonly blobs: BlobStore,
  ) {}

  async openRead(request: ContextRequest) {
    const read = structuredClone(await this.authority.openContextRead(request.org_id));
    validateAuthorityRead(request.org_id, read);
    const heads = new Map(
      read.lifecycle_heads.map((head) => [identityKey(head.source, head.external_id), head]),
    );
    const groups = groupEvents(read.events);
    const eligibleGroups = [...groups.entries()].filter(([key, events]) =>
      hasContextMetadata(events) && isClosedLifecycle(events, heads.get(key)),
    );
    const hashes = [
      ...new Set(
        eligibleGroups.flatMap(([, events]) =>
          events.flatMap((event) =>
            event.operation !== "tombstone" && event.content_hash
              ? [event.content_hash]
              : [],
          ),
        ),
      ),
    ];
    const bodies = await this.blobs.getMany(hashes);
    if (hashes.some((hash) => !bodies.has(hash))) {
      throw new Error("Context authority Event references a missing Blob");
    }

    const events: ContextSourceEvent[] = [];
    const lifecycleHeads: ContextLifecycleHead[] = [];
    for (const [key, lifecycle] of eligibleGroups) {
      const head = heads.get(key)!;
      lifecycleHeads.push(structuredClone(head));
      for (const source of lifecycle) {
        const tombstone = source.operation === "tombstone";
        const contentHash = tombstone ? undefined : source.content_hash;
        const bytes = contentHash ? bodies.get(contentHash) : undefined;
        const text = bytes && source.content_media_type
          ? bodyTextFromStored(bytes, source.content_media_type)
          : undefined;
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
          ...(text === undefined ? {} : { text }),
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
