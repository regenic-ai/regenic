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

    assert.equal(authorityStore.schemaVersion, 5);
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

  it("lists append-only Event history in insertion order for one authority", async () => {
    const root = await createRoot();
    const { authorityStore, service } = await createHarness(root);
    await service.ingest(createBatch());
    await service.ingest(createBatch({
      operation: "revise",
      revision_id: "revision-1",
      content: [{ role: "body", media_type: "text/plain", text: "Revision." }],
    }));
    await service.ingest(createBatch({ operation: "tombstone", content: undefined }));

    const events = await authorityStore.listEvents("local-owner");

    assert.deepEqual(events.map((event) => event.operation), ["create", "revise", "tombstone"]);
    assert.equal(events[1].parent_event_id, events[0].id);
    assert.equal(events[2].parent_event_id, events[1].id);
    authorityStore.close();
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
    database.pragma("user_version = 6");
    database.close();

    assert.throws(
      () => new SqliteAuthorityStore(path),
      /schema 6 is newer than supported 5/,
    );
  });

  it("persists inbox decisions across restart", async () => {
    const root = await createRoot();
    let harness = await createHarness(root);
    const ingested = await harness.service.ingest(
      createBatch({
        content: [
          { role: "body", media_type: "text/plain", text: "Please confirm the release." },
        ],
      }),
    );
    harness.authorityStore.close();

    harness = await createHarness(root);
    const inbox = await harness.authorityStore.listInbox("local-owner");
    const decision = await harness.authorityStore.getDisposition(
      ingested.records[0].event_id,
    );

    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.external_id, "source-event-1");
    assert.equal(decision.disposition, "current_work");
    assert.deepEqual(decision.reason_codes, ["actionable"]);

    await harness.service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );
    harness.authorityStore.close();
    harness = await createHarness(root);

    assert.equal((await harness.authorityStore.listInbox("local-owner")).length, 0);
    harness.authorityStore.close();
  });

  it("keeps conversation title and pin after reopen", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    let store = new SqliteAuthorityStore(path);
    await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      title: "Release desk",
      pinned: true,
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    store.close();

    store = new SqliteAuthorityStore(path);
    const pref = await store.getConversationPref("local-owner", "dsh:session-a");
    const listed = await store.listConversationPrefs("local-owner");
    assert.equal(pref.title, "Release desk");
    assert.equal(pref.pinned, true);
    assert.equal(listed.length, 1);
    await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      title: null,
      updated_at: "2026-08-22T00:01:00.000Z",
    });
    const cleared = await store.getConversationPref("local-owner", "dsh:session-a");
    assert.equal(cleared.title, null);
    assert.equal(cleared.pinned, true);
    store.close();
  });

  it("lists inbox heads, thread siblings, and a digest without a full scan API", async () => {
    const root = await createRoot();
    const { authorityStore, service } = await createHarness(root);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "heads-1",
      received_at: "2026-08-23T00:00:00.000Z",
      records: [
        {
          operation: "create",
          source: "dsh",
          external_id: "session-x:1",
          occurred_at: "2026-08-23T00:00:00.000Z",
          actor: { id: "user" },
          scope: { id: "session-x" },
          type: "message",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "Please confirm the release.",
            },
          ],
        },
        {
          operation: "create",
          source: "dsh",
          external_id: "session-x:2",
          occurred_at: "2026-08-23T00:00:01.000Z",
          actor: { id: "assistant" },
          scope: { id: "session-x" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "later" }],
        },
        {
          operation: "create",
          source: "dsh",
          external_id: "session-z:1",
          occurred_at: "2026-08-23T00:00:02.000Z",
          actor: { id: "user" },
          scope: { id: "session-z" },
          type: "message",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "Please review the rollout.",
            },
          ],
        },
      ],
    });

    const current = await authorityStore.listInbox("local-owner");
    const heads = await authorityStore.listInbox("local-owner", { heads: true });
    const thread = await authorityStore.listInbox("local-owner", {
      siblings: true,
      source: "dsh",
      target: "session-x",
    });
    const summary = await authorityStore.summarizeInbox("local-owner");
    const threads = new Set(
      heads.map((item) => `${item.event.source}:${item.event.external_id.split(":")[0]}`),
    );

    assert.equal(heads.length, threads.size);
    assert.ok(heads.length >= 2);
    assert.ok(thread.length >= 2);
    assert.equal(summary.count, heads.length);
    assert.equal(summary.digest.startsWith(`${heads.length}:`), true);
    assert.ok(current.length >= heads.length);

    const beforePref = summary.digest;
    await authorityStore.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-x",
      title: "Release",
      pinned: true,
      updated_at: "2026-08-23T00:10:00.000Z",
    });
    const afterPref = await authorityStore.summarizeInbox("local-owner");
    assert.equal(afterPref.count, heads.length);
    assert.notEqual(afterPref.digest, beforePref);

    const wildcard = await authorityStore.listInbox("local-owner", {
      siblings: true,
      source: "dsh",
      target: "session_x",
    });
    assert.equal(wildcard.length, 0);
    authorityStore.close();
  });

  it("keeps a working marker off the list face when heads are requested", async () => {
    const root = await createRoot();
    const { authorityStore, service } = await createHarness(root);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "working-head-1",
      received_at: "2026-08-22T10:44:00.000Z",
      records: [
        {
          operation: "create",
          source: "dsh",
          external_id: "session-w:1",
          occurred_at: "2026-08-22T10:43:00.000Z",
          actor: { id: "user" },
          scope: { id: "session-w" },
          type: "message",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "只用一句话回复: pong",
            },
          ],
        },
        {
          operation: "create",
          source: "dsh",
          external_id: "session-w:2",
          occurred_at: "2026-08-22T10:44:00.000Z",
          actor: { id: "assistant" },
          scope: { id: "session-w" },
          type: "thread_status",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "Still working.",
            },
          ],
        },
      ],
    });
    const heads = await authorityStore.listInbox("local-owner", { heads: true });
    assert.deepEqual(
      heads.map((item) => item.event.external_id).sort(),
      ["session-w:1", "session-w:2"],
    );
    assert.equal(
      heads.find((item) => item.event.external_id === "session-w:2")
        ?.decision.reason_codes.includes("thread_status"),
      true,
    );
    authorityStore.close();
  });

  it("uses a message outside current work as the heads face", async () => {
    const root = await createRoot();
    const { authorityStore, service } = await createHarness(root);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "working-face-1",
      received_at: "2026-08-22T10:44:00.000Z",
      records: [
        {
          operation: "create",
          source: "dsh",
          external_id: "session-n:1",
          occurred_at: "2026-08-22T10:43:00.000Z",
          actor: { id: "user" },
          scope: { id: "session-n" },
          type: "message",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "thanks",
            },
          ],
        },
        {
          operation: "create",
          source: "dsh",
          external_id: "session-n:2",
          occurred_at: "2026-08-22T10:44:00.000Z",
          actor: { id: "assistant" },
          scope: { id: "session-n" },
          type: "thread_status",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "Still working.",
            },
          ],
        },
      ],
    });
    const heads = await authorityStore.listInbox("local-owner", { heads: true });
    assert.deepEqual(
      heads.map((item) => item.event.external_id).sort(),
      ["session-n:1", "session-n:2"],
    );
    authorityStore.close();
  });

  it("does not treat LIKE wildcards in a thread target as a match-all", async () => {
    const root = await createRoot();
    const { authorityStore, service } = await createHarness(root);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "like-1",
      received_at: "2026-08-23T00:00:00.000Z",
      records: [
        {
          operation: "create",
          source: "dsh",
          external_id: "axb:1",
          occurred_at: "2026-08-23T00:00:00.000Z",
          actor: { id: "user" },
          scope: { id: "axb" },
          type: "message",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "Please confirm the release.",
            },
          ],
        },
        {
          operation: "create",
          source: "dsh",
          external_id: "a_b:1",
          occurred_at: "2026-08-23T00:00:01.000Z",
          actor: { id: "user" },
          scope: { id: "a_b" },
          type: "message",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "Please review the rollout.",
            },
          ],
        },
      ],
    });
    const matched = await authorityStore.listInbox("local-owner", {
      siblings: true,
      source: "dsh",
      target: "a_b",
    });
    assert.equal(matched.length, 1);
    assert.equal(matched[0].event.external_id, "a_b:1");
    authorityStore.close();
  });
});
