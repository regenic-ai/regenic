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
  OutboundAttemptPut,
  OutboundAttemptRecord,
  RepointContentInput,
  SourceIdentity,
  SourceIdentityAliasBind,
  StoreClearResult,
  StoreFootprint,
  TombstoneEvent,
} from "./ingestion";
import { MemoryWorkStore } from "./memory-work-store";
import { type WorkStore } from "./work";
import {
  AuthorityConflictError,
  collectAvailableBlobs,
  putUniqueBlobs,
} from "./ingestion";
import {
  eventThreadId,
  headsScanQuery,
  matchesEventQuery,
  selectInboxItems,
  summarizeInboxItems,
} from "./inbox-query";
import { normalizeInboxListView } from "./list-surface";

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

  async clear(): Promise<void> {
    this.blobs.clear();
  }

  get size(): number {
    return this.blobs.size;
  }
}

function prefKey(orgId: string, threadId: string): string {
  return `${orgId}\0${threadId}`;
}

export class MemoryAuthorityStore
  extends MemoryWorkStore
  implements AuthorityStore, WorkStore
{
  private readonly currentBySource = new Map<string, EventRecord>();
  private readonly events: EventRecord[] = [];
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly dispositions = new Map<string, ArrangementDecision>();
  private readonly prefs = new Map<string, ConversationPref>();
  private readonly outboundAttempts = new Map<string, OutboundAttemptRecord>();
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
    const event = this.currentBySource.get(sourceKey(identity));
    return event ? cloneEvent(event) : null;
  }

  async bindSourceIdentityAliases(input: SourceIdentityAliasBind): Promise<void> {
    const event = this.events.find(
      (item) => item.org_id === input.org_id && item.id === input.event_id,
    );
    if (!event) {
      throw new Error(`Unknown event for identity alias: ${input.event_id}`);
    }
    for (const alias of input.aliases) {
      const externalId = alias.external_id.trim();
      if (!alias.source.trim() || !externalId) {
        continue;
      }
      const key = sourceKey({
        org_id: input.org_id,
        source: alias.source,
        external_id: externalId,
      });
      if (!this.currentBySource.has(key)) {
        this.currentBySource.set(key, event);
      }
    }
  }

  async getOutboundAttempt(
    orgId: string,
    clientRequestId: string,
  ): Promise<OutboundAttemptRecord | null> {
    const row = this.outboundAttempts.get(`${orgId}\0${clientRequestId}`);
    return row ? { ...row, channel_message_ids: row.channel_message_ids?.slice() } : null;
  }

  async putOutboundAttempt(
    input: OutboundAttemptPut,
  ): Promise<OutboundAttemptRecord> {
    const key = `${input.org_id}\0${input.client_request_id}`;
    const previous = this.outboundAttempts.get(key);
    const record: OutboundAttemptRecord = {
      org_id: input.org_id,
      client_request_id: input.client_request_id,
      thread_id: input.thread_id,
      event_id: input.event_id,
      status: input.status,
      channel_message_ids: input.channel_message_ids?.slice(),
      created_at: previous?.created_at ?? input.now,
      updated_at: input.now,
    };
    this.outboundAttempts.set(key, record);
    return {
      ...record,
      channel_message_ids: record.channel_message_ids?.slice(),
    };
  }

  async getEvent(orgId: string, eventId: string): Promise<EventRecord | null> {
    const event = this.events.find(
      (item) => item.org_id === orgId && item.id === eventId,
    );
    return event ? cloneEvent(event) : null;
  }

  async listEvents(
    orgId: string,
    query?: EventListQuery,
  ): Promise<EventRecord[]> {
    const matched = this.events
      .filter((event) => matchesEventQuery(event, orgId, query))
      .map(cloneEvent);
    const limit = query?.limit;
    if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
      return matched.slice(0, limit);
    }
    return matched;
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
    const useDecided =
      query?.siblings ||
      query?.heads ||
      normalizeInboxListView(query?.list) === "hidden";
    const items = useDecided
      ? await this.decidedInbox(orgId, headsScanQuery(query) ?? query)
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
    const hidden = this.hiddenThreadIds(orgId);
    return [...this.currentBySource.values()].flatMap((event) => {
      const decision = this.dispositions.get(event.id);
      if (event.org_id !== orgId || decision?.disposition !== "current_work") {
        return [];
      }
      if (hidden.has(eventThreadId(event))) {
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

  private async decidedInbox(
    orgId: string,
    query?: InboxQuery,
  ): Promise<InboxItem[]> {
    const scoped = Boolean(query?.source || query?.target || query?.thread_ids);
    const allowed = scoped
      ? undefined
      : normalizeInboxListView(query?.list) === "hidden"
        ? this.hiddenThreadIds(orgId)
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

  private hiddenThreadIds(orgId: string): Set<string> {
    return new Set(
      [...this.prefs.values()]
        .filter((pref) => pref.org_id === orgId && pref.hidden)
        .map((pref) => pref.thread_id),
    );
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
    const hidden =
      input.hidden !== undefined ? input.hidden : (current?.hidden ?? false);
    const next: ConversationPref = {
      org_id: input.org_id,
      thread_id: input.thread_id,
      title: input.title !== undefined ? input.title : (current?.title ?? null),
      pinned: input.pinned !== undefined ? input.pinned : (current?.pinned ?? false),
      hidden,
      hidden_reason: hidden
        ? input.hidden_reason !== undefined
          ? input.hidden_reason
          : (current?.hidden_reason ?? (input.hidden === true ? "human" : null))
        : null,
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

  async summarizeStore(orgId: string): Promise<StoreFootprint> {
    return this.storeFootprint(orgId);
  }

  async clearOperationalData(
    orgId: string,
    _now: string,
  ): Promise<StoreClearResult> {
    const before = this.storeFootprint(orgId);
    const hashes = new Set(
      this.events.flatMap((event) =>
        event.org_id === orgId && event.content_hash ? [event.content_hash] : [],
      ),
    );
    const keptEvents = this.events.filter((event) => event.org_id !== orgId);
    this.events.length = 0;
    this.events.push(...keptEvents);
    for (const [key, event] of [...this.currentBySource]) {
      if (event.org_id === orgId) {
        this.currentBySource.delete(key);
      }
    }
    for (const [eventId, decision] of [...this.dispositions]) {
      if (decision.org_id === orgId) {
        this.dispositions.delete(eventId);
      }
    }
    for (const [key, pref] of [...this.prefs]) {
      if (pref.org_id === orgId) {
        this.prefs.delete(key);
      }
    }
    this.dropOperationalWork(orgId);
    for (const hash of hashes) {
      if (!this.events.some((event) => event.content_hash === hash)) {
        this.blobs.delete(hash);
      }
    }
    const after = this.storeFootprint(orgId);
    return {
      cleared: {
        events: before.events,
        conversations: before.conversations,
        work_items: before.work_items,
        blobs: before.blobs,
        context_artifacts: before.context_artifacts,
        context_snapshots: before.context_snapshots,
        context_bundles: before.context_bundles,
        context_checkpoints: before.context_checkpoints,
      },
      kept: {
        recipes: after.recipes,
        connectors: after.connectors,
        executors: after.executors,
      },
    };
  }

  private storeFootprint(orgId: string): StoreFootprint {
    const events = this.events.filter((event) => event.org_id === orgId);
    return {
      events: events.length,
      conversations: new Set(events.map((event) => eventThreadId(event))).size,
      work_items: this.workItemCount(orgId),
      blobs: new Set(
        events.flatMap((event) => (event.content_hash ? [event.content_hash] : [])),
      ).size,
      context_artifacts: 0,
      context_snapshots: 0,
      context_bundles: 0,
      context_checkpoints: 0,
      recipes: this.recipeCount(orgId),
      connectors: 0,
      executors: this.executorCount(orgId),
    };
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
    return this.events.map(cloneEvent);
  }

  async repointContentHash(input: RepointContentInput): Promise<number> {
    this.rememberBlob({
      content_hash: input.new_content_hash,
      media_type: input.content_media_type,
      byte_size: input.content_byte_size,
    });
    for (const blob of input.extra_blobs ?? []) {
      this.rememberBlob(blob);
    }
    let updated = 0;
    for (const event of this.events) {
      if (event.content_hash === input.old_content_hash) {
        event.content_hash = input.new_content_hash;
        updated += 1;
      }
    }
    const stillUsed = this.events.some(
      (event) => event.content_hash === input.old_content_hash,
    );
    if (!stillUsed && input.old_content_hash !== input.new_content_hash) {
      this.blobs.delete(input.old_content_hash);
    }
    return updated;
  }

  async vacuumStore(): Promise<void> {}

  private rememberBlob(input: {
    content_hash: string;
    media_type: string;
    byte_size: number;
  }): void {
    if (this.blobs.has(input.content_hash)) {
      return;
    }
    this.blobs.set(input.content_hash, {
      content_hash: input.content_hash,
      media_type: input.media_type,
      byte_size: input.byte_size,
      created_at: new Date().toISOString(),
    });
  }

  private addContentEvent(
    input: NewEvent | EventRevision,
    operation: "create" | "revise",
  ): EventRecord {
    const current = this.currentBySource.get(sourceKey(input)) ?? null;
    this.assertExpectedHead(input.expected_head_id, current);
    this.rememberBlob({
      content_hash: input.content_hash,
      media_type: input.content_media_type,
      byte_size: input.content_byte_size,
    });
    for (const blob of input.extra_blobs ?? []) {
      this.rememberBlob(blob);
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
      Partial<
        Pick<
          EventRecord,
          | "id"
          | "content_hash"
          | "parent_event_id"
          | "thread_id"
          | "actor_id"
          | "required_scope_ids"
          | "direction_tags"
          | "weight_hints"
          | "attrs"
        >
      >,
  ): EventRecord {
    const event: EventRecord = {
      id: input.id ?? `event-${this.nextId++}`,
      org_id: input.org_id,
      source: input.source,
      external_id: input.external_id,
      operation: input.operation,
      content_hash: input.content_hash,
      parent_event_id: input.parent_event_id,
      thread_id: input.thread_id,
      actor_id: input.actor_id,
      required_scope_ids: input.required_scope_ids
        ? [...input.required_scope_ids]
        : undefined,
      direction_tags: input.direction_tags ? [...input.direction_tags] : undefined,
      weight_hints: input.weight_hints ? structuredClone(input.weight_hints) : undefined,
      attrs: input.attrs ? structuredClone(input.attrs) : undefined,
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

function cloneEvent(event: EventRecord): EventRecord {
  return {
    ...event,
    ...(event.required_scope_ids
      ? { required_scope_ids: [...event.required_scope_ids] }
      : {}),
    ...(event.direction_tags ? { direction_tags: [...event.direction_tags] } : {}),
    ...(event.weight_hints ? { weight_hints: structuredClone(event.weight_hints) } : {}),
    ...(event.attrs ? { attrs: structuredClone(event.attrs) } : {}),
  };
}