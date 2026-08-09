const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { FsBlobStore } = require("@regenic/blob-store");
const {
  INGEST_SCHEMA_VERSION,
  IngestionService,
} = require("@regenic/domain");
const { SqliteAuthorityStore } = require("../dist");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createHarness(root) {
  const authorityStore = new SqliteAuthorityStore(join(root, "authority.db"));
  const blobStore = new FsBlobStore(join(root, "blobs"));
  return {
    authorityStore,
    blobStore,
    service: new IngestionService(blobStore, authorityStore),
  };
}

function createBatch(recordOverrides = {}) {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: "local-owner",
    delivery_id: "delivery-1",
    received_at: "2026-08-09T00:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "regenic",
        external_id: "source-event-1",
        occurred_at: "2026-08-08T23:59:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          { role: "body", media_type: "text/plain", text: "Persistent body." },
        ],
        ...recordOverrides,
      },
    ],
  };
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-local-store-"));
  roots.push(root);
  return root;
}

describe("local ingestion persistence", () => {
  it("migrates a new SQLite authority database", async () => {
    const root = await createRoot();
    const { authorityStore } = await createHarness(root);

    assert.equal(authorityStore.schemaVersion, 1);
    authorityStore.close();
  });

  it("returns the same Event when a create is replayed after restart", async () => {
    const root = await createRoot();
    let harness = await createHarness(root);
    const first = await harness.service.ingest(createBatch());
    const eventId = first.records[0].event_id;
    harness.authorityStore.close();

    harness = await createHarness(root);
    const replay = await harness.service.ingest(createBatch());
    const current = await harness.authorityStore.findBySourceIdentity({
      org_id: "local-owner",
      source: "regenic",
      external_id: "source-event-1",
    });

    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(replay.records[0].event_id, eventId);
    assert.equal(current.id, eventId);
    assert.equal(await harness.blobStore.exists(current.content_hash), true);
    const blob = await harness.authorityStore.findBlob(current.content_hash);
    assert.equal(blob.media_type, "text/plain");
    assert.equal(blob.byte_size, Buffer.byteLength("Persistent body."));
    harness.authorityStore.close();
  });

  it("allows only one concurrent revision to advance the source head", async () => {
    const root = await createRoot();
    const firstHarness = await createHarness(root);
    const secondHarness = await createHarness(root);
    await firstHarness.service.ingest(createBatch());

    const [first, second] = await Promise.all([
      firstHarness.service.ingest(
        createBatch({
          operation: "revise",
          revision_id: "revision-a",
          content: [
            { role: "body", media_type: "text/plain", text: "Revision A." },
          ],
        }),
      ),
      secondHarness.service.ingest(
        createBatch({
          operation: "revise",
          revision_id: "revision-b",
          content: [
            { role: "body", media_type: "text/plain", text: "Revision B." },
          ],
        }),
      ),
    ]);
    const statuses = [first.records[0].status, second.records[0].status].sort();

    assert.deepEqual(statuses, ["accepted", "retryable_failure"]);
    firstHarness.authorityStore.close();
    secondHarness.authorityStore.close();
  });

  it("persists revision and tombstone history across restart", async () => {
    const root = await createRoot();
    let harness = await createHarness(root);
    const first = await harness.service.ingest(createBatch());
    const revision = await harness.service.ingest(
      createBatch({
        operation: "revise",
        revision_id: "revision-2",
        content: [
          { role: "body", media_type: "text/plain", text: "Revised body." },
        ],
      }),
    );
    assert.notEqual(revision.records[0].event_id, first.records[0].event_id);
    harness.authorityStore.close();

    harness = await createHarness(root);
    const tombstone = await harness.service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );
    harness.authorityStore.close();

    harness = await createHarness(root);
    const replay = await harness.service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );
    const current = await harness.authorityStore.findBySourceIdentity({
      org_id: "local-owner",
      source: "regenic",
      external_id: "source-event-1",
    });

    assert.equal(tombstone.records[0].status, "accepted");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(current.operation, "tombstone");
    assert.equal(current.parent_event_id, revision.records[0].event_id);
    assert.equal(await harness.blobStore.exists(current.content_hash), true);
    harness.authorityStore.close();
  });

  it("keeps a create tombstoned when the tombstone survives a restart first", async () => {
    const root = await createRoot();
    let harness = await createHarness(root);
    await harness.service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );
    harness.authorityStore.close();

    harness = await createHarness(root);
    const created = await harness.service.ingest(createBatch());
    harness.authorityStore.close();

    harness = await createHarness(root);
    const replay = await harness.service.ingest(createBatch());
    const current = await harness.authorityStore.findBySourceIdentity({
      org_id: "local-owner",
      source: "regenic",
      external_id: "source-event-1",
    });

    assert.equal(created.records[0].status, "accepted");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(current.operation, "tombstone");
    assert.equal(await harness.blobStore.exists(current.content_hash), true);
    harness.authorityStore.close();
  });

  it("rejects a database created by a newer schema version", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const database = new Database(path);
    database.pragma("user_version = 2");
    database.close();

    assert.throws(
      () => new SqliteAuthorityStore(path),
      /schema 2 is newer than supported 1/,
    );
  });
});