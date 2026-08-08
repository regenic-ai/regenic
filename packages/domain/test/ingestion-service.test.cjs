const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  INGEST_SCHEMA_VERSION,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
} = require("../dist");

function createBatch(recordOverrides = {}) {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: "local-owner",
    delivery_id: "delivery-1",
    received_at: "2026-08-08T00:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "regenic",
        external_id: "source-event-1",
        occurred_at: "2026-08-07T23:59:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          {
            role: "body",
            media_type: "text/plain",
            text: "Canonical body.\r\nSecond line.",
          },
        ],
        ...recordOverrides,
      },
    ],
  };
}

function createHarness() {
  const blobStore = new MemoryBlobStore();
  const authorityStore = new MemoryAuthorityStore();
  return {
    authorityStore,
    blobStore,
    service: new IngestionService(blobStore, authorityStore),
  };
}

describe("IngestionService", () => {
  it("rejects an invalid batch before writing any state", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const batch = createBatch();
    batch.records[0].occurred_at = "not-a-timestamp";

    const result = await service.ingest(batch);

    assert.equal(result.valid, false);
    assert.equal(result.error_code, "invalid_record");
    assert.equal(authorityStore.allEvents().length, 0);
    assert.equal(blobStore.size, 0);
  });

  it("persists a create and returns its stable Event on replay", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const batch = createBatch();

    const first = await service.ingest(batch);
    const replay = await service.ingest(batch);

    assert.equal(first.records[0].status, "accepted");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(replay.records[0].event_id, first.records[0].event_id);
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(blobStore.size, 1);
  });

  it("normalizes text newlines before hashing", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const first = createBatch();
    const replay = createBatch({
      content: [
        {
          role: "body",
          media_type: "text/plain",
          text: "Canonical body.\nSecond line.",
        },
      ],
    });

    await service.ingest(first);
    const result = await service.ingest(replay);

    assert.equal(result.records[0].status, "duplicate");
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(blobStore.size, 1);
  });

  it("quarantines a conflicting create without writing another Blob", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    await service.ingest(createBatch());

    const result = await service.ingest(
      createBatch({
        content: [
          { role: "body", media_type: "text/plain", text: "Changed body." },
        ],
      }),
    );

    assert.equal(result.records[0].status, "quarantined");
    assert.equal(result.records[0].error_code, "source_identity_conflict");
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(blobStore.size, 1);
  });

  it("deduplicates Blob bytes across distinct source identities", async () => {
    const { authorityStore, blobStore, service } = createHarness();

    await service.ingest(createBatch());
    const result = await service.ingest(
      createBatch({ external_id: "source-event-2" }),
    );

    assert.equal(result.records[0].status, "accepted");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 1);
  });

  it("isolates identical source IDs by authority boundary", async () => {
    const { authorityStore, blobStore, service } = createHarness();

    await service.ingest(createBatch());
    const otherOwnerBatch = createBatch();
    otherOwnerBatch.org_id = "other-local-owner";
    const result = await service.ingest(otherOwnerBatch);

    assert.equal(result.records[0].status, "accepted");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 1);
  });

  it("appends a revision linked to the previous Event", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const created = await service.ingest(createBatch());

    const revised = await service.ingest(
      createBatch({
        operation: "revise",
        revision_id: "revision-2",
        content: [
          { role: "body", media_type: "text/plain", text: "Revised body." },
        ],
      }),
    );
    const events = authorityStore.allEvents();

    assert.equal(revised.records[0].status, "accepted");
    assert.equal(events.length, 2);
    assert.equal(events[1].operation, "revise");
    assert.equal(events[1].parent_event_id, created.records[0].event_id);
    assert.equal(blobStore.size, 2);
  });

  it("tombstones an Event without deleting its Blob", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    await service.ingest(createBatch());

    const tombstoned = await service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );
    const replay = await service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );

    assert.equal(tombstoned.records[0].status, "accepted");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 1);
  });

  it("does not revive a tombstoned identity with different content", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    await service.ingest(createBatch());
    await service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );

    const result = await service.ingest(
      createBatch({
        content: [
          { role: "body", media_type: "text/plain", text: "Changed body." },
        ],
      }),
    );

    assert.equal(result.records[0].status, "quarantined");
    assert.equal(result.records[0].error_code, "source_identity_conflict");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 1);
  });

  it("keeps a create tombstoned when deletion arrives first", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const tombstone = createBatch({ operation: "tombstone", content: undefined });
    const create = createBatch();

    await service.ingest(tombstone);
    const created = await service.ingest(create);
    const replay = await service.ingest(create);
    const events = authorityStore.allEvents();

    assert.equal(created.records[0].status, "accepted");
    assert.equal(events.at(-1).operation, "tombstone");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(authorityStore.allEvents().length, 3);
    assert.equal(blobStore.size, 1);
  });

  it("quarantines unresolved external content", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const result = await service.ingest(
      createBatch({
        content: [
          {
            role: "attachment",
            media_type: "application/pdf",
            external_locator: "source://document/1",
          },
        ],
      }),
    );

    assert.equal(result.records[0].status, "quarantined");
    assert.equal(result.records[0].error_code, "content_unavailable");
    assert.equal(authorityStore.allEvents().length, 0);
    assert.equal(blobStore.size, 0);
  });
});