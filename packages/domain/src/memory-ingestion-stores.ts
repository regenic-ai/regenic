import type { ArrangementDecision, InboxItem } from "./arrangement";
import type {
  AuthorityStore,
  BlobObject,
  BlobRecord,
  BlobStore,
  ConversationPref,
  ConversationPrefPatch,
  EventListQuery,
  EventRecord,
  EventRevision,
  InboxQuery,
  InboxSummary,
  IngestCommitRequest,
  NewEvent,
  SourceIdentity,
  TombstoneEvent,
} from "./ingestion";
import {
  AuthorityConflictError,
  collectAvailableBlobs,
  putUniqueBlobs,
} from "./ingestion";
import {
  eventThreadId,
  matchesEventQuery,
  selectInboxItems,
  summarizeInboxItems,
} from "./inbox-query";

function sourceKey(identity: SourceIdentity): string {
  return JSON.stringify([identity.org_id, identity.source, identity.external_id]);
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<
    string,
    { bytes: Uint8Array; media_type: string }
  >();

  async put(
    hash: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<void> {
    if (!this.blobs.has(hash)) {
      this.blobs.set(hash, {
        bytes: new Uint8Array(bytes),
        media_type: mediaType,
      });
    }
  }

  async putMany(items: readonly BlobObject[]): Promise<void> {
    await putUniqueBlobs(
      (hash, bytes, mediaType) => this.put(hash, bytes, mediaType),
      items,
    );
  }

  async get(hash: string): Promise<Uint8Array> {
    const blob = this.blobs.get(hash);
    if (!blob) {
      throw new Error(`Blob not found: ${hash}`);
    }

    return new Uint8Array(blob.bytes);
  }

  async getMany(hashes: readonly string[]): Promise<Map<string, Uint8Array>> {
    return collectAvailableBlobs((hash) => this.get(hash), hashes);
  }

  async delete(hash: string): Promise<void> {
    this.blobs.delete(hash);
  }

  async exists(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  get size(): number {
    return this.blobs.size;
  }
}

function prefKey(orgId: string, threadId: string): string {
  return `${orgId}\0${threadId}`;
}

export class MemoryAuthorityStore implements AuthorityStore {
  private readonly currentBySource = new Map<string, EventRecord>();
  private readonly events: EventRecord[] = [];
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly dispositions = new Map<string, ArrangementDecision>();
  private readonly prefs = new Map<string, ConversationPref>();
  private nextId = 1;

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    const blob = this.blobs.get(contentHash);
    return blob ? { ...blob } : null;
  }

  async findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>> {
    const found = new Map<string, BlobRecord>();
    for (const hash of new Set(contentHashes.filter((item) => item.length > 0))) {
      const blob = this.blobs.get(hash);
      if (blob) {
        found.set(hash, { ...blob });
      }
    }
    return found;
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.currentBySource.get(sourceKey(identity)) ?? null;
  }

  async getEvent(orgId: string, eventId: string): Promise<EventRecord | null> {
    const event = this.events.find(
      (item) => item.org_id === orgId && item.id === eventId,
    );
    return event ? { ...event } : null;
  }

  async listEvents(
    orgId: string,
    query?: EventListQuery,
  ): Promise<EventRecord[]> {
    return this.events
      .filter((event) => matchesEventQuery(event, orgId, query))
      .map((event) => ({ ...event }));
  }

  async putDisposition(decision: ArrangementDecision): Promise<void> {
    this.dispositions.set(decision.event_id, { ...decision, reason_codes: [...decision.reason_codes] });
  }

  async getDisposition(eventId: string): Promise<ArrangementDecision | null> {
    const decision = this.dispositions.get(eventId);
    return decision
      ? { ...decision, reason_codes: [...decision.reason_codes] }
      : null;
  }

  async listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    const items =
      query?.siblings || query?.heads
        ? this.decidedInbox(orgId, query)
        : this.currentWorkInbox(orgId);
    return selectInboxItems(items, query).sort((left, right) => {
      const byTime = left.event.occurred_at.localeCompare(right.event.occurred_at);
      if (byTime !== 0) {
        return byTime;
      }
      return left.event.id.localeCompare(right.event.id);
    });
  }

  async summarizeInbox(orgId: string): Promise<InboxSummary> {
    return summarizeInboxItems(
      this.currentWorkInbox(orgId),
      [...this.prefs.values()].filter((pref) => pref.org_id === orgId),
    );
  }

  private currentWorkInbox(orgId: string): InboxItem[] {
    return [...this.currentBySource.values()].flatMap((event) => {
      const decision = this.dispositions.get(event.id);
      if (event.org_id !== orgId || decision?.disposition !== "current_work") {
        return [];
      }
      return [
        {
          decision: {
            ...decision,
            reason_codes: [...decision.reason_codes],
          },
          event: { ...event },
        },
      ];
    });
  }

  private decidedInbox(orgId: string, query?: InboxQuery): InboxItem[] {
    const scoped = Boolean(query?.source || query?.target || query?.thread_ids);
    const allowed = scoped
      ? undefined
      : new Set(
          this.currentWorkInbox(orgId).map((item) => eventThreadId(item.event)),
        );
    if (allowed && allowed.size === 0) {
      return [];
    }
    return this.events.flatMap((event) => {
      if (!matchesEventQuery(event, orgId, query)) {
        return [];
      }
      if (allowed && !allowed.has(eventThreadId(event))) {
        return [];
      }
      const decision = this.dispositions.get(event.id);
      if (!decision) {
        return [];
      }
      return [
        {
          decision: {
            ...decision,
            reason_codes: [...decision.reason_codes],
          },
          event: { ...event },
        },
      ];
    });
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    return [...this.prefs.values()]
      .filter((pref) => pref.org_id === orgId)
      .map((pref) => ({ ...pref }));
  }

  async getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null> {
    const pref = this.prefs.get(prefKey(orgId, threadId));
    return pref ? { ...pref } : null;
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    const current = this.prefs.get(prefKey(input.org_id, input.thread_id));
    const next: ConversationPref = {
      org_id: input.org_id,
      thread_id: input.thread_id,
      title: input.title !== undefined ? input.title : (current?.title ?? null),
      pinned: input.pinned !== undefined ? input.pinned : (current?.pinned ?? false),
      last_read_at:
        input.last_read_at !== undefined
          ? input.last_read_at
          : (current?.last_read_at ?? null),
      last_read_external_id:
        input.last_read_external_id !== undefined
          ? input.last_read_external_id
          : (current?.last_read_external_id ?? null),
      updated_at: input.updated_at,
    };
    this.prefs.set(prefKey(input.org_id, input.thread_id), next);
    return { ...next };
  }

  async append(input: NewEvent): Promise<EventRecord> {
    return this.addContentEvent(input, "create");
  }

  async commitIngest(request: IngestCommitRequest): Promise<EventRecord[]> {
    const events = request.appends.map((input) =>
      this.addContentEvent(input, "create"),
    );
    for (const decision of request.dispositions) {
      this.dispositions.set(decision.event_id, {
        ...decision,
        reason_codes: [...decision.reason_codes],
      });
    }
    return events;
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    return this.addContentEvent(input, "revise");
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    const current = await this.findBySourceIdentity(input);
    this.assertExpectedHead(input.expected_head_id, current);
    return this.addEvent({
      ...input,
      operation: "tombstone",
      content_hash: current?.content_hash,
      parent_event_id: current?.id,
    });
  }

  allEvents(): readonly EventRecord[] {
    return this.events.map((event) => ({ ...event }));
  }

  private addContentEvent(
    input: NewEvent | EventRevision,
    operation: "create" | "revise",
  ): EventRecord {
    const current = this.currentBySource.get(sourceKey(input)) ?? null;
    this.assertExpectedHead(input.expected_head_id, current);
    if (!this.blobs.has(input.content_hash)) {
      this.blobs.set(input.content_hash, {
        content_hash: input.content_hash,
        media_type: input.content_media_type,
        byte_size: input.content_byte_size,
        created_at: new Date().toISOString(),
      });
    }
    return this.addEvent({
      ...input,
      operation,
      parent_event_id:
        operation === "revise" ? (input as EventRevision).parent_event_id : undefined,
    });
  }

  private addEvent(
    input: SourceIdentity &
      Pick<EventRecord, "operation" | "occurred_at"> &
      Partial<Pick<EventRecord, "id" | "content_hash" | "parent_event_id">>,
  ): EventRecord {
    const event: EventRecord = {
      id: input.id ?? `event-${this.nextId++}`,
      org_id: input.org_id,
      source: input.source,
      external_id: input.external_id,
      operation: input.operation,
      content_hash: input.content_hash,
      parent_event_id: input.parent_event_id,
      occurred_at: input.occurred_at,
      ingested_at: new Date().toISOString(),
    };
    this.events.push(event);
    this.currentBySource.set(sourceKey(input), event);
    return event;
  }

  private assertExpectedHead(
    expectedHeadId: string | null,
    current: EventRecord | null,
  ): void {
    if ((current?.id ?? null) !== expectedHeadId) {
      throw new AuthorityConflictError();
    }
  }
}