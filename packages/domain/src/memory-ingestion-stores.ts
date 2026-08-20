import type { ArrangementDecision, InboxItem } from "./arrangement";
import type {
  AuthorityStore,
  BlobRecord,
  BlobStore,
  EventRecord,
  EventRevision,
  NewEvent,
  SourceIdentity,
  TombstoneEvent,
} from "./ingestion";
import { AuthorityConflictError } from "./ingestion";

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

  async get(hash: string): Promise<Uint8Array> {
    const blob = this.blobs.get(hash);
    if (!blob) {
      throw new Error(`Blob not found: ${hash}`);
    }

    return new Uint8Array(blob.bytes);
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

export class MemoryAuthorityStore implements AuthorityStore {
  private readonly currentBySource = new Map<string, EventRecord>();
  private readonly events: EventRecord[] = [];
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly dispositions = new Map<string, ArrangementDecision>();
  private nextId = 1;

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    const blob = this.blobs.get(contentHash);
    return blob ? { ...blob } : null;
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.currentBySource.get(sourceKey(identity)) ?? null;
  }

  async findEvent(id: string): Promise<EventRecord | null> {
    return this.events.find((event) => event.id === id) ?? null;
  }

  async listEvents(orgId: string): Promise<EventRecord[]> {
    return this.events
      .filter((event) => event.org_id === orgId)
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

  async listInbox(orgId: string): Promise<InboxItem[]> {
    return [...this.currentBySource.values()]
      .flatMap((event) => {
        const decision = this.dispositions.get(event.id);
        if (event.org_id !== orgId || decision?.disposition !== "current_work") {
          return [];
        }
        return [{
          decision: { ...decision, reason_codes: [...decision.reason_codes] },
          event: { ...event },
        }];
      })
      .sort((left, right) =>
        right.event.occurred_at.localeCompare(left.event.occurred_at),
      );
  }

  async append(input: NewEvent): Promise<EventRecord> {
    return this.addContentEvent(input, "create");
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
      Partial<Pick<EventRecord, "content_hash" | "parent_event_id">>,
  ): EventRecord {
    const event: EventRecord = {
      id: `event-${this.nextId++}`,
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