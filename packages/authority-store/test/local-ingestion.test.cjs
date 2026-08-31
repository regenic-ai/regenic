const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { FsBlobStore } = require("@regenic/blob-store");
const {
  conversationId,
  INGEST_SCHEMA_VERSION,
  IngestionService,
} = require("@regenic/domain");
const { SqliteAuthorityStore } = require("../dist");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../dist/migrations");

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

    assert.equal(authorityStore.schemaVersion, LATEST_SCHEMA_VERSION);
    const inspect = new Database(join(root, "authority.db"));
    const index = inspect
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'ingest_attempts_installation_started_idx'`,
      )
      .get();
    inspect.close();
    assert.equal(index.name, "ingest_attempts_installation_started_idx");
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
    assert.equal(current.thread_id, "regenic:source-event-1");
    assert.equal(current.actor_id, "local-owner");
    assert.deepEqual(current.required_scope_ids, ["regenic:personal"]);
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

  it("shows only the current revision in an inbox thread", async () => {
    const root = await createRoot();
    const { authorityStore, service } = await createHarness(root);
    await service.ingest(createBatch());
    await service.ingest(createBatch({
      operation: "revise",
      revision_id: "revision-1",
      content: [{ role: "body", media_type: "text/plain", text: "Revision." }],
    }));

    const thread = await authorityStore.listInbox("local-owner", {
      siblings: true,
      source: "regenic",
      target: "source-event-1",
    });

    assert.equal(thread.length, 1);
    assert.equal(thread[0].event.operation, "revise");
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
    const futureVersion = LATEST_SCHEMA_VERSION + 1;
    database.pragma(`user_version = ${futureVersion}`);
    database.close();

    assert.throws(
      () => new SqliteAuthorityStore(path),
      new RegExp(`schema ${futureVersion} is newer than supported ${LATEST_SCHEMA_VERSION}`),
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
    const hidden = await harness.authorityStore.listInbox("local-owner", {
      heads: true,
      list: "hidden",
    });
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].event.operation, "create");
    assert.equal(hidden[0].event.external_id, "source-event-1");
    const pref = await harness.authorityStore.getConversationPref(
      "local-owner",
      "regenic:source-event-1",
    );
    assert.equal(pref.hidden, true);
    assert.equal(pref.hidden_reason, "policy");
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
    assert.equal(pref.hidden, false);
    assert.equal(listed.length, 1);
    await store.putConversationPref({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: true,
      hidden_reason: "human",
      updated_at: "2026-08-22T00:00:30.000Z",
    });
    const folded = await store.getConversationPref("local-owner", "dsh:session-a");
    assert.equal(folded.hidden, true);
    assert.equal(folded.hidden_reason, "human");
    assert.equal(folded.pinned, true);
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
    const paged = await authorityStore.listInbox("local-owner", {
      heads: true,
      limit: 1,
    });
    assert.equal(paged.length, 1);
    const olderHeads = await authorityStore.listInbox("local-owner", {
      heads: true,
      limit: 1,
      before: paged[0].event.occurred_at,
      before_id: paged[0].event.id,
    });
    assert.equal(olderHeads.length, 1);
    assert.notEqual(olderHeads[0].event.id, paged[0].event.id);
    assert.ok(thread.length >= 2);
    const byThreadId = await authorityStore.listInbox("local-owner", {
      siblings: true,
      thread_ids: ["dsh:session-x"],
    });
    assert.equal(byThreadId.length, thread.length);
    const recent = await authorityStore.listInbox("local-owner", {
      siblings: true,
      source: "dsh",
      target: "session-x",
      limit: 1,
    });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].event.external_id, "session-x:2");
    const older = await authorityStore.listInbox("local-owner", {
      siblings: true,
      source: "dsh",
      target: "session-x",
      before: recent[0].event.occurred_at,
      before_id: recent[0].event.id,
      limit: 1,
    });
    assert.equal(older.length, 1);
    assert.equal(older[0].event.external_id, "session-x:1");
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

  it("backfills thread_id when opening a v5 authority database", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const legacy = new Database(path);
    for (const migration of MIGRATIONS) {
      if (migration.version > 5) {
        continue;
      }
      legacy.exec(migration.sql);
      legacy.pragma(`user_version = ${migration.version}`);
    }
    const occurred = "2026-08-24T00:00:00.000Z";
    legacy
      .prepare(
        `
          INSERT INTO events (
            id, org_id, source, external_id, operation,
            occurred_at, ingested_at
          ) VALUES (?, ?, ?, ?, 'create', ?, ?)
        `,
      )
      .run("evt-1", "local-owner", "feishu", "oc_chat:om_1", occurred, occurred);
    legacy
      .prepare(
        `
          INSERT INTO source_heads (
            org_id, source, external_id, current_event_id
          ) VALUES (?, ?, ?, ?)
        `,
      )
      .run("local-owner", "feishu", "oc_chat:om_1", "evt-1");
    legacy
      .prepare(
        `
          INSERT INTO message_dispositions (
            event_id, org_id, disposition, layer, reason_codes_json, score, decided_at
          ) VALUES (?, ?, 'current_work', 'L1_event', ?, 1, ?)
        `,
      )
      .run("evt-1", "local-owner", JSON.stringify(["actionable"]), occurred);
    legacy.close();

    const store = new SqliteAuthorityStore(path);
    const inspect = new Database(path);
    const row = inspect
      .prepare("SELECT thread_id FROM events WHERE id = ?")
      .get("evt-1");
    inspect.close();
    assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal(row.thread_id, conversationId("feishu", "oc_chat:om_1", "evt-1"));
    const heads = await store.listInbox("local-owner", { heads: true });
    assert.equal(heads.length, 1);
    assert.equal(heads[0].event.id, "evt-1");
    store.close();
  });

  it("collapses thousands of source identities onto one conversation head", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = new SqliteAuthorityStore(path);
    const db = new Database(path);
    const occurred = "2026-08-24T00:00:00.000Z";
    const insertEvent = db.prepare(
      `
        INSERT INTO events (
          id, org_id, source, external_id, operation,
          occurred_at, ingested_at, thread_id
        ) VALUES (?, 'local-owner', 'feishu', ?, 'create', ?, ?, ?)
      `,
    );
    const insertHead = db.prepare(
      `
        INSERT INTO source_heads (
          org_id, source, external_id, current_event_id
        ) VALUES ('local-owner', 'feishu', ?, ?)
      `,
    );
    const insertDisposition = db.prepare(
      `
        INSERT INTO message_dispositions (
          event_id, org_id, disposition, layer, reason_codes_json, score, decided_at
        ) VALUES (?, 'local-owner', 'current_work', 'L1_event', '["actionable"]', 1, ?)
      `,
    );
    const seed = db.transaction(() => {
      for (let index = 0; index < 2500; index += 1) {
        const id = `evt-${String(index).padStart(4, "0")}`;
        const externalId = `oc_chat:${index}`;
        const at = new Date(Date.parse(occurred) + index).toISOString();
        insertEvent.run(
          id,
          externalId,
          at,
          at,
          conversationId("feishu", externalId, id),
        );
        insertHead.run(externalId, id);
        insertDisposition.run(id, at);
      }
    });
    seed();
    const latestPlan = db
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT e.ingested_at, e.id
          FROM events e
          JOIN message_dispositions d ON d.event_id = e.id
          WHERE e.org_id = 'local-owner'
            AND d.disposition = 'current_work'
            AND EXISTS (
              SELECT 1 FROM source_heads h
              WHERE h.current_event_id = e.id
            )
          ORDER BY e.ingested_at DESC, e.id DESC
          LIMIT 1
        `,
      )
      .all()
      .map((row) => row.detail)
      .join("\n");
    db.close();
    assert.match(latestPlan, /source_heads_current_event_idx/);
    assert.doesNotMatch(latestPlan, /\bSCAN h\b/);

    const heads = await store.listInbox("local-owner", { heads: true });
    const summary = await store.summarizeInbox("local-owner");
    assert.equal(heads.length, 1);
    assert.equal(heads[0].event.external_id, "oc_chat:2499");
    assert.equal(summary.count, 1);
    store.close();
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
      heads.map((item) => item.event.external_id),
      ["session-w:1"],
    );
    authorityStore.close();
  });

  it("does not list a conversation that is only a working marker", async () => {
    const root = await createRoot();
    const { authorityStore, service } = await createHarness(root);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "working-only-1",
      received_at: "2026-08-22T10:43:00.000Z",
      records: [
        {
          operation: "create",
          source: "dsh",
          external_id: "session-empty:2",
          occurred_at: "2026-08-22T10:43:00.000Z",
          actor: { id: "assistant" },
          scope: { id: "session-empty" },
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
    const summary = await authorityStore.summarizeInbox("local-owner");
    assert.deepEqual(heads, []);
    assert.equal(summary.count, 0);
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
          external_id: "session-n:0",
          occurred_at: "2026-08-22T10:42:00.000Z",
          actor: { id: "user" },
          scope: { id: "session-n" },
          type: "message",
          content: [
            {
              role: "body",
              media_type: "text/plain",
              text: "Please review the ticket.",
            },
          ],
        },
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
      heads.map((item) => item.event.external_id),
      ["session-n:1"],
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

  it("clears operational data and keeps connectors and recipes", async () => {
    const root = await createRoot();
    const { authorityStore, service } = await createHarness(root);
    await service.ingest(createBatch());
    await authorityStore.createInstallation({
      id: "keep-connector",
      org_id: "local-owner",
      connector_type: "fake-poll",
      status: "enabled",
      config: { scope: "personal" },
      created_at: "2026-08-26T00:00:00.000Z",
    });
    await authorityStore.acquireLease({
      installation_id: "keep-connector",
      stream_key: "personal",
      lease_owner: "worker-a",
      now: "2026-08-26T00:00:00.000Z",
      lease_duration_ms: 30_000,
    });
    await authorityStore.beginAttempt({
      id: "attempt-clear",
      org_id: "local-owner",
      connector_installation_id: "keep-connector",
      stream_key: "personal",
      delivery_id: "page-1",
      started_at: "2026-08-26T00:00:00.000Z",
    });
    await authorityStore.settleAttempt({
      attempt_id: "attempt-clear",
      installation_id: "keep-connector",
      stream_key: "personal",
      lease_owner: "worker-a",
      finished_at: "2026-08-26T00:00:01.000Z",
      accepted_count: 1,
      duplicate_count: 0,
      quarantined_count: 0,
      retryable_failure_count: 0,
      next_cursor: "cursor-keep",
      quarantines: [],
    });
    await authorityStore.putRecipe({
      id: "keep-recipe",
      org_id: "local-owner",
      name: "Keep me",
      match: { record_class: "task" },
      trigger: { kind: "push", coalesce: true },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: false,
      include_context: false,
      enabled: true,
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    await authorityStore.putExecutorInstallation({
      id: "keep-executor",
      org_id: "local-owner",
      kind: "http",
      name: "Remote",
      status: "enabled",
      config: { base_url: "https://agent.example" },
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    await authorityStore.putWorkItem({
      id: "drop-work",
      org_id: "local-owner",
      thread_id: "regenic:source-event-1",
      unit_key: "unit-1",
      record_class: "utterance",
      thread_facet: "chat",
      status: "open",
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    await authorityStore.applySyncCatalogPage({
      installation_id: "keep-connector",
      members: [
        {
          stream_key: "personal",
          thread_id: "dsh:personal",
          label: "Personal",
        },
      ],
      now: "2026-08-26T00:00:00.000Z",
      complete: true,
    });
    await authorityStore.putSyncState({
      installation_id: "keep-connector",
      stream_key: "personal",
      phase: "live",
      live_cursor: "10",
      history_cursor: "10",
      media_pending: false,
      generation: 1,
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    const before = await authorityStore.summarizeStore("local-owner");
    assert.ok(before.events >= 1);
    assert.ok(before.conversations >= 1);
    assert.equal(before.work_items, 1);
    assert.equal(before.recipes, 1);
    assert.equal(before.connectors, 1);
    assert.equal(before.executors, 1);

    const cleared = await authorityStore.clearOperationalData(
      "local-owner",
      "2026-08-26T00:01:00.000Z",
    );
    const after = await authorityStore.summarizeStore("local-owner");
    const cursor = await authorityStore.getCursor("keep-connector", "personal");
    const recipes = await authorityStore.listRecipes("local-owner");
    const installations = await authorityStore.listInstallations("local-owner");
    const attempts = await authorityStore.listAttempts("keep-connector");
    const syncCatalog = await authorityStore.getSyncCatalog("keep-connector");
    const syncState = await authorityStore.getSyncState(
      "keep-connector",
      "personal",
    );

    assert.equal(cleared.cleared.events, before.events);
    assert.equal(cleared.cleared.work_items, 1);
    assert.equal(cleared.kept.recipes, 1);
    assert.equal(cleared.kept.connectors, 1);
    assert.equal(cleared.kept.executors, 1);
    assert.equal(after.events, 0);
    assert.equal(after.conversations, 0);
    assert.equal(after.work_items, 0);
    assert.equal(after.blobs, 0);
    assert.equal(after.recipes, 1);
    assert.equal(after.connectors, 1);
    assert.equal(after.executors, 1);
    assert.equal(recipes[0].id, "keep-recipe");
    assert.equal(installations[0].id, "keep-connector");
    assert.equal(attempts.length, 0);
    assert.equal(cursor.cursor, undefined);
    assert.ok(cursor.cursor_version > 1);
    assert.equal(syncCatalog.members.length, 0);
    assert.equal(syncCatalog.catalog, null);
    assert.equal(syncState, null);
    authorityStore.close();
  });
});
