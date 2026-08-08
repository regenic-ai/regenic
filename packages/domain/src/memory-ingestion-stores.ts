import type {
  AuthorityStore,
  BlobStore,
  EventRecord,
  EventRevision,
  NewEvent,
  SourceIdentity,
  TombstoneEvent,
} from "./ingestion";

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
  private nextId = 1;

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.currentBySource.get(sourceKey(identity)) ?? null;
  }

  async append(input: NewEvent): Promise<EventRecord> {
    return this.add({ ...input, operation: "create" });
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    return this.add({ ...input, operation: "revise" });
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    const current = await this.findBySourceIdentity(input);
    return this.add({
      ...input,
      operation: "tombstone",
      content_hash: current?.content_hash,
      parent_event_id: current?.id,
    });
  }

  allEvents(): readonly EventRecord[] {
    return this.events.map((event) => ({ ...event }));
  }

  private add(
    input: SourceIdentity &
      Pick<EventRecord, "operation" | "occurred_at"> &
      Partial<Pick<EventRecord, "content_hash" | "parent_event_id">>,
  ): EventRecord {
    const event: EventRecord = {
      ...input,
      id: `event-${this.nextId++}`,
      ingested_at: new Date().toISOString(),
    };
    this.events.push(event);
    this.currentBySource.set(sourceKey(input), event);
    return event;
  }
}