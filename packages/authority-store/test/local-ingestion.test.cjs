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
const { SqliteAuthorityStore } = require("../dist/sqlite");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../dist/sqlite/migrations");

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
  it("protects pre-reference blob rows during the schema migration", async () => {
    const root = await createRoot();
    const path = join(root, "legacy-authority.db");
    const legacy = new Database(path);
    legacy.function("conversation_id", (source, externalId, fallbackId) =>
      conversationId(source, externalId, fallbackId));
    try {
      for (const migration of MIGRATIONS.filter(({ version }) => version <= 71)) {
        legacy.exec(migration.sql);
      }
      legacy.prepare(
        `INSERT INTO blobs (content_hash, media_type, byte_size, created_at)
         VALUES (?, 'text/plain', 3, ?)`,
      ).run("e".repeat(64), "2026-08-24T00:00:00.000Z");
      legacy.pragma("user_version = 71");
    } finally {
      legacy.close();
    }

    const store = new SqliteAuthorityStore(path);
    const inspect = new Database(path);
    try {
      assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.equal(
        inspect.prepare(`SELECT state FROM blobs WHERE content_hash = ?`).get("e".repeat(64)).state,
        "protected",
      );
    } finally {
      inspect.close();
      store.close();
    }
  });

  it("records event body and attachment references atomically", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = new SqliteAuthorityStore(path);
    const inspect = new Database(path);
    const bodyHash = "a".repeat(64);
    const attachmentHash = "b".repeat(64);
    const event = {
      id: "blob-reference-event",
      org_id: "local-owner",
      source: "synthetic",
      external_id: "blob-reference-source",
      content_hash: bodyHash,
      content_media_type: "application/vnd.regenic.content-parts+json",
      content_byte_size: 10,
      extra_blobs: [{
        content_hash: attachmentHash,
        media_type: "image/png",
        byte_size: 4,
      }],
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    };
    try {
      await store.commitIngest({ appends: [event], dispositions: [] });
      assert.deepEqual(
        inspect.prepare(
          `SELECT reference_kind, content_hash FROM blob_references
           WHERE owner_org_id = ? AND owner_type = 'event' AND owner_id = ?
           ORDER BY reference_kind`,
        ).all(event.org_id, event.id),
        [
          { reference_kind: "attachment", content_hash: attachmentHash },
          { reference_kind: "body", content_hash: bodyHash },
        ],
      );
      assert.deepEqual(
        inspect.prepare(
          `SELECT content_hash, state FROM blobs WHERE content_hash IN (?, ?) ORDER BY content_hash`,
        ).all(attachmentHash, bodyHash),
        [
          { content_hash: bodyHash, state: "protected" },
          { content_hash: attachmentHash, state: "protected" },
        ],
      );

      const newBodyHash = "c".repeat(64);
      const newAttachmentHash = "d".repeat(64);
      assert.equal(await store.repointContentHash({
        old_content_hash: bodyHash,
        new_content_hash: newBodyHash,
        content_media_type: "application/vnd.regenic.content-parts+json",
        content_byte_size: 12,
        extra_blobs: [{
          content_hash: newAttachmentHash,
          media_type: "image/png",
          byte_size: 5,
        }],
      }), 1);
      assert.deepEqual(
        inspect.prepare(
          `SELECT reference_kind, content_hash FROM blob_references
           WHERE owner_org_id = ? AND owner_type = 'event' AND owner_id = ?
           ORDER BY reference_kind`,
        ).all(event.org_id, event.id),
        [
          { reference_kind: "attachment", content_hash: newAttachmentHash },
          { reference_kind: "body", content_hash: newBodyHash },
        ],
      );
      assert.notEqual(
        inspect.prepare(`SELECT unreferenced_at FROM blobs WHERE content_hash = ?`).get(bodyHash)
          .unreferenced_at,
        null,
      );

      inspect.exec(`
        CREATE TRIGGER reject_attachment_blob_reference
        BEFORE INSERT ON blob_references
        WHEN NEW.reference_kind = 'attachment'
        BEGIN
          SELECT RAISE(ABORT, 'injected blob reference failure');
        END
      `);
      const rejected = {
        ...event,
        id: "blob-reference-rollback",
        external_id: "blob-reference-rollback",
        content_hash: "e".repeat(64),
        extra_blobs: [{
          content_hash: "f".repeat(64),
          media_type: "image/png",
          byte_size: 4,
        }],
      };
      await assert.rejects(
        store.commitIngest({ appends: [rejected], dispositions: [] }),
        /injected blob reference failure/,
      );
      assert.equal(await store.getEvent(rejected.org_id, rejected.id), null);
      assert.equal(
        inspect.prepare(`SELECT COUNT(*) AS count FROM blobs WHERE content_hash IN (?, ?)`)
          .get("e".repeat(64), "f".repeat(64)).count,
        0,
      );

      await store.clearOperationalData(event.org_id, "2026-08-25T00:00:00.000Z");
      assert.equal(
        inspect.prepare(`SELECT COUNT(*) AS count FROM blob_references WHERE owner_org_id = ?`)
          .get(event.org_id).count,
        0,
      );
      assert.notEqual(
        inspect.prepare(`SELECT unreferenced_at FROM blobs WHERE content_hash = ?`)
          .get(newBodyHash).unreferenced_at,
        null,
      );
    } finally {
      inspect.close();
      store.close();
    }
  });

  it("commits compaction reservations with the Event reference repoint", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    const inspect = new Database(join(root, "authority.db"));
    const oldHash = "a".repeat(64);
    const newBodyHash = "c".repeat(64);
    const newAttachmentHash = "d".repeat(64);
    try {
      await store.commitIngest({
        appends: [{
          id: "compaction-reservation-event",
          org_id: "local-owner",
          source: "synthetic",
          external_id: "compaction-reservation-source",
          content_hash: oldHash,
          content_media_type: "application/vnd.regenic.content-parts+json",
          content_byte_size: 10,
          occurred_at: "2026-08-24T00:00:00.000Z",
          expected_head_id: null,
        }],
        dispositions: [],
      });
      const reservations = await store.reserveBlobWrites({
        owner_id: "content-compactor",
        lease_duration_ms: 60_000,
        blobs: [
          { content_hash: newBodyHash, media_type: "application/vnd.regenic.content-parts+json", byte_size: 12 },
          { content_hash: newAttachmentHash, media_type: "image/png", byte_size: 5 },
        ],
      });
      assert.equal(await store.repointContentHash({
        old_content_hash: oldHash,
        new_content_hash: newBodyHash,
        content_media_type: "application/vnd.regenic.content-parts+json",
        content_byte_size: 12,
        extra_blobs: [{ content_hash: newAttachmentHash, media_type: "image/png", byte_size: 5 }],
        blob_reservations: reservations,
      }), 1);
      assert.deepEqual(
        inspect.prepare(
          `SELECT reference_kind, content_hash FROM blob_references
           WHERE owner_type = 'event' AND owner_id = ? ORDER BY reference_kind`,
        ).all("compaction-reservation-event"),
        [
          { reference_kind: "attachment", content_hash: newAttachmentHash },
          { reference_kind: "body", content_hash: newBodyHash },
        ],
      );
      assert.deepEqual(
        inspect.prepare(`SELECT content_hash, state FROM blobs WHERE content_hash IN (?, ?) ORDER BY content_hash`)
          .all(newAttachmentHash, newBodyHash),
        [
          { content_hash: newBodyHash, state: "available" },
          { content_hash: newAttachmentHash, state: "available" },
        ],
      );
    } finally {
      inspect.close();
      store.close();
    }
  });

  it("uses a fenced reservation and releases it after a failed owner commit", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const { authorityStore, blobStore, service } = await createHarness(root);
    const inspect = new Database(path);
    try {
      inspect.exec(`
        CREATE TRIGGER reject_reserved_blob_reference
        BEFORE INSERT ON blob_references
        BEGIN
          SELECT RAISE(ABORT, 'injected reservation commit failure');
        END
      `);
      await assert.rejects(
        service.ingest(createBatch()),
        /injected reservation commit failure/,
      );
      const failedReservation = inspect
        .prepare(`SELECT content_hash, state, generation, write_claim_token FROM blobs`)
        .get();
      assert.equal(failedReservation.state, "reserved");
      assert.equal(failedReservation.generation, 1);
      assert.equal(failedReservation.write_claim_token, null);
      assert.equal(await blobStore.exists(failedReservation.content_hash), true);

      inspect.exec("DROP TRIGGER reject_reserved_blob_reference");
      const result = await service.ingest(createBatch());
      assert.equal(result.valid, true);
      assert.equal(result.records[0].status, "accepted");
      assert.deepEqual(
        inspect.prepare(
          `SELECT state, generation, write_claim_token FROM blobs WHERE content_hash = ?`,
        ).get(failedReservation.content_hash),
        { state: "available", generation: 2, write_claim_token: null },
      );
      assert.equal(
        inspect.prepare(
          `SELECT COUNT(*) AS count FROM blob_references WHERE content_hash = ?`,
        ).get(failedReservation.content_hash).count,
        1,
      );
    } finally {
      inspect.close();
      authorityStore.close();
    }
  });

  it("can add references to a verified protected legacy Blob without unprotecting it", async () => {
    const root = await createRoot();
    const { authorityStore, blobStore, service } = await createHarness(root);
    const body = Buffer.from("Persistent body.", "utf8");
    const { createHash } = require("node:crypto");
    const hash = createHash("sha256").update(body).digest("hex");
    const inspect = new Database(join(root, "authority.db"));
    try {
      await blobStore.put(hash, body, "text/plain");
      await authorityStore.commitIngest({
        appends: [{
          id: "legacy-protected-event",
          org_id: "local-owner",
          source: "legacy",
          external_id: "legacy-protected-event",
          content_hash: hash,
          content_media_type: "text/plain",
          content_byte_size: body.byteLength,
          occurred_at: "2026-08-24T00:00:00.000Z",
          expected_head_id: null,
        }],
        dispositions: [],
      });

      const result = await service.ingest(createBatch({
        external_id: "new-reference-to-legacy-blob",
      }));
      assert.equal(result.valid, true);
      assert.deepEqual(
        inspect.prepare(`SELECT state FROM blobs WHERE content_hash = ?`).get(hash),
        { state: "protected" },
      );
      assert.equal(
        inspect.prepare(
          `SELECT COUNT(*) AS count FROM blob_references WHERE content_hash = ?`,
        ).get(hash).count,
        2,
      );
    } finally {
      inspect.close();
      authorityStore.close();
    }
  });

  it("repairs stale current-work thread projections when upgrading version 69", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const { authorityStore: store } = await createHarness(root);
    const now = "2026-08-24T00:00:00.000Z";
    const decision = (id) => ({
      event_id: id, org_id: "local-owner", disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    });
    const append = (id, thread) => ({
      id, org_id: "local-owner", source: "synthetic", external_id: id, thread_id: thread,
      content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
      occurred_at: now, expected_head_id: null,
    });
    const first = append("old", "stale-thread");
    const aliasFirst = append("alias-old", "alias-thread");
    try {
      for (const event of [first, aliasFirst, append("live", "live-thread")]) {
        await store.commitIngest({ appends: [event], dispositions: [decision(event.id)] });
      }
      await store.bindSourceIdentityAliases({
        org_id: "local-owner", event_id: aliasFirst.id,
        aliases: [{ source: "synthetic", external_id: "alias-extra" }],
      });
      for (const event of [first, aliasFirst]) {
        const id = `${event.id}-deleted`;
        await store.markTombstone({
          id, org_id: event.org_id, source: event.source, external_id: event.external_id,
          thread_id: event.thread_id, expected_head_id: event.id, occurred_at: now,
          disposition: decision(id),
        });
      }
    } finally {
      store.close();
    }
    const legacy = new Database(path);
    try {
      legacy.prepare("UPDATE thread_heads SET has_current_work = 1 WHERE thread_id = ?").run("stale-thread");
      legacy.exec("ALTER TABLE connector_cursors DROP COLUMN lease_claim_token;");
      legacy.exec("ALTER TABLE work_runs DROP COLUMN hide_on_success;");
      legacy.exec("ALTER TABLE work_runs DROP COLUMN completion_policy_version;");
      legacy.exec("DROP TABLE blob_references;");
      legacy.exec("DROP INDEX blobs_gc_candidate_idx;");
      for (const column of [
        "gc_started_at",
        "gc_claim_token",
        "unreferenced_at",
        "write_lease_expires_at",
        "write_claim_token",
        "write_lease_owner",
        "generation",
        "state",
      ]) {
        legacy.exec(`ALTER TABLE blobs DROP COLUMN ${column};`);
      }
      legacy.pragma("user_version = 69");
    } finally {
      legacy.close();
    }
    const reopened = new SqliteAuthorityStore(path);
    const inspect = new Database(path);
    try {
      assert.equal(reopened.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.deepEqual(inspect.prepare("SELECT thread_id, has_current_work FROM thread_heads ORDER BY thread_id").all(), [
        { thread_id: "alias-thread", has_current_work: 1 },
        { thread_id: "live-thread", has_current_work: 1 },
        { thread_id: "stale-thread", has_current_work: 0 },
      ]);
      assert.equal((await reopened.summarizeInbox("local-owner")).count, 2);
      assert.equal((await reopened.getDisposition("old-deleted")).disposition, "current_work");
      assert.equal((await reopened.findBySourceIdentity({
        org_id: "local-owner", source: "synthetic", external_id: "alias-extra",
      })).id, aliasFirst.id);
    } finally {
      inspect.close();
      reopened.close();
    }
  });

  it("rolls back head changes when the old conversation projection cannot refresh", async () => {
    const root = await createRoot();
    const { authorityStore: store } = await createHarness(root);
    const inspect = new Database(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    const input = {
      id: "projection-first", org_id: "local-owner", source: "synthetic", external_id: "projection-source",
      thread_id: "projection-old", content_hash: "a".repeat(64), content_media_type: "text/plain",
      content_byte_size: 1, occurred_at: now, expected_head_id: null,
    };
    try {
      await store.commitIngest({
        appends: [input],
        dispositions: [{
          event_id: input.id, org_id: input.org_id, disposition: "current_work", layer: "L1_event",
          reason_codes: [], score: 1, decided_at: now,
        }],
      });
      inspect.exec(`CREATE TRIGGER reject_old_projection
        BEFORE UPDATE ON thread_heads WHEN OLD.thread_id = 'projection-old'
        BEGIN SELECT RAISE(ABORT, 'projection unavailable'); END`);
      await assert.rejects(store.appendRevision({
        ...input, id: "projection-next", thread_id: "projection-new",
        parent_event_id: input.id, expected_head_id: input.id,
      }), /projection unavailable/);
      assert.equal((await store.findBySourceIdentity(input)).id, input.id);
      assert.equal(await store.getEvent(input.org_id, "projection-next"), null);
      assert.equal((await store.summarizeInbox(input.org_id)).count, 1);
    } finally {
      inspect.close();
      store.close();
    }
  });

  it("upgrades rejection support without reclassifying existing attempt states or losing receipts", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const legacy = new Database(path);
    legacy.function("conversation_id", (source, externalId, fallbackId) =>
      conversationId(source, externalId, fallbackId));
    for (const migration of MIGRATIONS.filter((migration) => migration.version <= 51)) {
      legacy.exec(migration.sql);
      legacy.pragma(`user_version = ${migration.version}`);
    }
    const now = "2026-08-24T00:00:00.000Z";
    const states = ["pending", "failed", "accepted", "sent"];
    for (const status of states) {
      legacy.prepare(`
        INSERT INTO outbound_attempts (
          org_id, client_request_id, thread_id, status, channel_message_ids_json,
          recovery_hash, receipt_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("local-owner", status, "feishu:oc_1", status, '["native-id"]',
        "a".repeat(64), JSON.stringify({ accepted: true, rpc_id: "native-id" }), now, now);
    }
    legacy.close();
    const store = new SqliteAuthorityStore(path);
    try {
      for (const status of states) {
        const saved = await store.getOutboundAttempt("local-owner", status);
        assert.equal(saved.status, status);
        assert.equal(saved.recovery_hash, "a".repeat(64));
        assert.deepEqual(saved.receipt, { accepted: true, rpc_id: "native-id" });
        assert.deepEqual(saved.channel_message_ids, ["native-id"]);
        assert.equal(saved.created_at, now);
        assert.equal(saved.updated_at, now);
        assert.equal(await store.claimOutboundAttempt({
          org_id: "local-owner", client_request_id: status, thread_id: "feishu:oc_1", now,
        }), false);
      }
      const input = { org_id: "local-owner", client_request_id: "new-rejection", thread_id: "feishu:oc_1", now };
      await store.putOutboundAttempt({ ...input, status: "rejected" });
      assert.equal(await store.claimOutboundAttempt(input), true);
      assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
    } finally {
      store.close();
    }
    const inspected = new Database(path);
    try {
      assert.deepEqual(inspected.pragma("foreign_key_check"), []);
      assert.ok(inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'outbound_attempts_event_idx'").get());
      assert.equal(inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'outbound_attempts_next'").get(), undefined);
      assert.equal(inspected.prepare(`
        SELECT state FROM blobs WHERE content_hash = ?
      `).get("a".repeat(64)).state, "protected");
      assert.equal(inspected.prepare(`
        SELECT COUNT(*) AS count FROM blob_references
        WHERE owner_type = 'outbound_attempt' AND reference_kind = 'reply_recovery'
          AND content_hash = ?
      `).get("a".repeat(64)).count, states.length);
    } finally {
      inspected.close();
    }
  });

  it("fences outbound recovery references with the attempt owner transaction", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const store = new SqliteAuthorityStore(path);
    const inspect = new Database(path);
    const now = "2026-08-25T00:00:00.000Z";
    const metadata = (content_hash) => ({
      content_hash,
      media_type: "application/vnd.regenic.reply-recovery+json",
      byte_size: 12,
    });
    const reserve = (content_hash) => store.reserveBlobWrites({
      owner_id: `reply-${content_hash}`,
      lease_duration_ms: 60_000,
      blobs: [metadata(content_hash)],
    });
    try {
      const firstHash = "a".repeat(64);
      const [first] = await reserve(firstHash);
      assert.equal(await store.claimOutboundAttempt({
        org_id: "local-owner",
        client_request_id: "recovery",
        thread_id: "feishu:oc_1",
        recovery_hash: firstHash,
        blob_reservations: [first],
        now,
      }), true);
      assert.deepEqual(inspect.prepare(`
        SELECT owner_org_id, owner_type, owner_id, reference_kind, content_hash
        FROM blob_references WHERE owner_type = 'outbound_attempt'
      `).get(), {
        owner_org_id: "local-owner",
        owner_type: "outbound_attempt",
        owner_id: "recovery",
        reference_kind: "reply_recovery",
        content_hash: firstHash,
      });

      const secondHash = "b".repeat(64);
      const [second] = await reserve(secondHash);
      await store.putOutboundAttempt({
        org_id: "local-owner",
        client_request_id: "recovery",
        thread_id: "feishu:oc_1",
        status: "accepted",
        recovery_hash: secondHash,
        blob_reservations: [second],
        now: "2026-08-25T00:01:00.000Z",
      });
      assert.deepEqual(inspect.prepare(`
        SELECT content_hash FROM blob_references
        WHERE owner_type = 'outbound_attempt' AND owner_id = 'recovery'
      `).all(), [{ content_hash: secondHash }]);
      assert.equal(inspect.prepare(`
        SELECT unreferenced_at FROM blobs WHERE content_hash = ?
      `).get(firstHash).unreferenced_at, "2026-08-25T00:01:00.000Z");

      const staleHash = "c".repeat(64);
      const [stale] = await reserve(staleHash);
      await store.releaseBlobReservations([stale]);
      const [current] = await reserve(staleHash);
      const staleAttempt = {
        org_id: "local-owner",
        client_request_id: "stale-reservation",
        thread_id: "feishu:oc_1",
        recovery_hash: staleHash,
        now,
      };
      await assert.rejects(store.claimOutboundAttempt({
        ...staleAttempt,
        blob_reservations: [stale],
      }), /reservation/i);
      assert.equal(await store.getOutboundAttempt("local-owner", "stale-reservation"), null);
      assert.equal(await store.claimOutboundAttempt({
        ...staleAttempt,
        blob_reservations: [current],
      }), true);
    } finally {
      inspect.close();
      store.close();
    }
  });

  it("upgrades the previous outbound schema without losing existing attempts", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const legacy = new Database(path);
    legacy.function("conversation_id", (source, externalId, fallbackId) =>
      conversationId(source, externalId, fallbackId));
    for (const migration of MIGRATIONS.filter((migration) => migration.version <= 48)) {
      legacy.exec(migration.sql);
      legacy.pragma(`user_version = ${migration.version}`);
    }
    legacy.prepare(`
      INSERT INTO outbound_attempts (
        org_id, client_request_id, thread_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("local-owner", "legacy", "feishu:oc_1", "accepted",
      "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
    legacy.close();
    const store = new SqliteAuthorityStore(path);
    try {
      assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
      const attempt = await store.getOutboundAttempt("local-owner", "legacy");
      assert.equal(attempt.status, "accepted");
      assert.equal(attempt.recovery_hash, undefined);
      assert.equal(attempt.receipt, undefined);
      assert.equal(await store.claimOutboundAttempt({
        org_id: "local-owner", client_request_id: "legacy", thread_id: "feishu:oc_1",
        now: "2026-08-25T00:00:00.000Z",
      }), false);
      assert.equal(await store.claimOutboundAttempt({
        org_id: "local-owner", client_request_id: "new", thread_id: "feishu:oc_1",
        recovery_hash: "a".repeat(64), now: "2026-08-25T00:00:00.000Z",
      }), true);
    } finally {
      store.close();
    }
  });

  it("protects and references an existing recovery Blob during schema 73", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const legacy = new Database(path);
    legacy.function("conversation_id", (source, externalId, fallbackId) =>
      conversationId(source, externalId, fallbackId));
    for (const migration of MIGRATIONS.filter((migration) => migration.version <= 72)) {
      legacy.exec(migration.sql);
      legacy.pragma(`user_version = ${migration.version}`);
    }
    const hash = "d".repeat(64);
    const now = "2026-08-25T00:00:00.000Z";
    legacy.prepare(`
      INSERT INTO blobs (
        content_hash, media_type, byte_size, created_at, state, generation,
        unreferenced_at, gc_claim_token, gc_started_at
      ) VALUES (?, ?, ?, ?, 'available', 1, ?, 'old-gc-claim', ?)
    `).run(hash, "application/octet-stream", 12, now, now, now);
    legacy.prepare(`
      INSERT INTO outbound_attempts (
        org_id, client_request_id, thread_id, status, recovery_hash, created_at, updated_at
      ) VALUES (?, ?, ?, 'sent', ?, ?, ?)
    `).run("local-owner", "legacy-recovery", "feishu:oc_1", hash, now, now);
    legacy.close();

    const store = new SqliteAuthorityStore(path);
    const inspect = new Database(path);
    try {
      assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.deepEqual(inspect.prepare(`
        SELECT owner_org_id, owner_type, owner_id, reference_kind, content_hash
        FROM blob_references WHERE owner_id = 'legacy-recovery'
      `).get(), {
        owner_org_id: "local-owner",
        owner_type: "outbound_attempt",
        owner_id: "legacy-recovery",
        reference_kind: "reply_recovery",
        content_hash: hash,
      });
      assert.deepEqual(inspect.prepare(`
        SELECT state, unreferenced_at, gc_claim_token, gc_started_at
        FROM blobs WHERE content_hash = ?
      `).get(hash), {
        state: "protected",
        unreferenced_at: null,
        gc_claim_token: null,
        gc_started_at: null,
      });
    } finally {
      inspect.close();
      store.close();
    }
  });

  it("backfills and protects historical Event body references during schema 74", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const legacy = new Database(path);
    legacy.function("conversation_id", (source, externalId, fallbackId) =>
      conversationId(source, externalId, fallbackId));
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 71)) {
      legacy.exec(migration.sql);
    }
    const hash = "b".repeat(64);
    const now = "2026-08-25T00:00:00.000Z";
    legacy.prepare(`
      INSERT INTO blobs (content_hash, media_type, byte_size, created_at)
      VALUES (?, 'text/plain', 8, ?)
    `).run(hash, now);
    legacy.prepare(`
      INSERT INTO events (
        id, org_id, source, external_id, operation, content_hash, occurred_at, ingested_at
      ) VALUES (?, ?, ?, ?, 'create', ?, ?, ?)
    `).run("legacy-event", "local-owner", "synthetic", "legacy-event", hash, now, now);
    legacy.pragma("user_version = 71");
    legacy.close();

    const store = new SqliteAuthorityStore(path);
    const inspect = new Database(path);
    try {
      assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.deepEqual(inspect.prepare(`
        SELECT owner_org_id, owner_type, owner_id, reference_kind, content_hash
        FROM blob_references WHERE owner_id = 'legacy-event'
      `).get(), {
        owner_org_id: "local-owner",
        owner_type: "event",
        owner_id: "legacy-event",
        reference_kind: "body",
        content_hash: hash,
      });
      assert.deepEqual(inspect.prepare(`
        SELECT state, unreferenced_at, gc_claim_token, gc_started_at
        FROM blobs WHERE content_hash = ?
      `).get(hash), {
        state: "protected",
        unreferenced_at: null,
        gc_claim_token: null,
        gc_started_at: null,
      });
    } finally {
      inspect.close();
      store.close();
    }
  });

  it("backfills legacy ContextArtifact body and evidence references during schema 75", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const legacy = new Database(path);
    legacy.function("conversation_id", (source, externalId, fallbackId) =>
      conversationId(source, externalId, fallbackId));
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 74)) {
      legacy.exec(migration.sql);
    }
    const bodyHash = "c".repeat(64);
    const evidenceHash = "f".repeat(64);
    const manifestHash = "a".repeat(64);
    const now = "2026-08-26T00:00:00.000Z";
    legacy.prepare(`
      INSERT INTO blobs (
        content_hash, media_type, byte_size, created_at, state, generation,
        unreferenced_at, gc_claim_token, gc_started_at
      ) VALUES (?, 'application/octet-stream', 32, ?, 'available', 2, ?, 'old-claim', ?)
    `).run(evidenceHash, now, now, now);
    const insertArtifact = legacy.prepare(`
      INSERT INTO context_artifacts (
        org_id, id, kind, status, generation, recorded_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertArtifact.run("local-owner", "legacy-external-artifact", "thread_summary",
      "accepted", "generation-1", now, JSON.stringify({
        org_id: "local-owner",
        id: "legacy-external-artifact",
        body_hash: bodyHash,
        input_refs: [{ content_hash: evidenceHash }],
        recorded_at: now,
      }));
    insertArtifact.run("local-owner", "legacy-manifest-artifact", "thread_summary",
      "accepted", "generation-1", now, JSON.stringify({
        org_id: "local-owner",
        id: "legacy-manifest-artifact",
        body_hash: manifestHash,
        body_storage: "artifact",
        input_refs: [],
        recorded_at: now,
      }));
    legacy.pragma("user_version = 74");
    legacy.close();

    const store = new SqliteAuthorityStore(path);
    const inspect = new Database(path);
    try {
      assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.deepEqual(inspect.prepare(`
        SELECT owner_id, reference_kind, content_hash
        FROM blob_references
        WHERE owner_type = 'context_artifact'
        ORDER BY owner_id, reference_kind
      `).all(), [
        {
          owner_id: "legacy-external-artifact",
          reference_kind: "artifact_body",
          content_hash: bodyHash,
        },
        {
          owner_id: "legacy-external-artifact",
          reference_kind: "evidence",
          content_hash: evidenceHash,
        },
      ]);
      assert.equal(inspect.prepare("SELECT 1 FROM blobs WHERE content_hash = ?").get(manifestHash), undefined);
      assert.deepEqual(inspect.prepare(`
        SELECT content_hash, state, unreferenced_at, gc_claim_token, gc_started_at
        FROM blobs
        WHERE content_hash IN (?, ?) ORDER BY content_hash
      `).all(evidenceHash, bodyHash), [
        {
          content_hash: bodyHash,
          state: "protected",
          unreferenced_at: null,
          gc_claim_token: null,
          gc_started_at: null,
        },
        {
          content_hash: evidenceHash,
          state: "protected",
          unreferenced_at: null,
          gc_claim_token: null,
          gc_started_at: null,
        },
      ]);
    } finally {
      inspect.close();
      store.close();
    }
  });

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
    const deliveryVersion = inspect
      .prepare("PRAGMA table_info(work_deliveries)")
      .all()
      .find(({ name }) => name === "version");
    const dispositionVersion = inspect
      .prepare("PRAGMA table_info(message_dispositions)")
      .all()
      .find(({ name }) => name === "version");
    inspect.close();
    assert.equal(index.name, "ingest_attempts_installation_started_idx");
    assert.deepEqual(
      [deliveryVersion.type, deliveryVersion.notnull, deliveryVersion.dflt_value],
      ["INTEGER", 1, "0"],
    );
    assert.deepEqual(
      [dispositionVersion.type, dispositionVersion.notnull, dispositionVersion.dflt_value],
      ["INTEGER", 1, "0"],
    );
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

  it("rolls back disposition changes when their policy-unfold audit fails", async () => {
    const root = await createRoot();
    const harness = await createHarness(root);
    const inspect = new Database(join(root, "authority.db"));
    const now = "2026-08-24T00:00:00.000Z";
    try {
      for (const mode of ["transition", "restore"]) {
        const id = `event-${mode}`;
        const thread = `thread-${mode}`;
        await harness.authorityStore.append({
          id, org_id: "local-owner", source: "synthetic", external_id: id, thread_id: thread,
          content_hash: "a".repeat(64), content_media_type: "text/plain", content_byte_size: 1,
          occurred_at: now, expected_head_id: null,
        });
        const initial = {
          event_id: id, org_id: "local-owner", disposition: "outside_current_work",
          layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
        };
        if (mode === "transition") await harness.authorityStore.putDispositionIfAbsent(initial);
        const expected = await harness.authorityStore.getDisposition(id);
        await harness.authorityStore.setConversationPolicyHidden({
          org_id: "local-owner", thread_id: thread, expected_visibility_version: 0, updated_at: now,
        });
        const decision = { ...initial, disposition: "current_work" };
        const input = {
          expected, decision, command: {
            org_id: "local-owner", event_id: id, action: "triage", disposition: "current_work",
            command_id: `command-${mode}`, issued_at: now,
          },
        };
        inspect.exec(`CREATE TRIGGER reject_disposition_unfold
          BEFORE INSERT ON conversation_lifecycle_events
          WHEN NEW.event_type = 'visibility_changed'
          BEGIN SELECT RAISE(ABORT, 'unfold audit unavailable'); END`);
        await assert.rejects(mode === "transition"
          ? harness.authorityStore.transitionDisposition(input)
          : harness.authorityStore.putDispositionIfAbsent(decision), /unfold audit unavailable/);
        assert.deepEqual(await harness.authorityStore.getDisposition(id), expected);
        assert.equal((await harness.authorityStore.getConversationPref("local-owner", thread)).hidden, true);
        inspect.exec("DROP TRIGGER reject_disposition_unfold");
        if (mode === "transition") {
          assert.equal((await harness.authorityStore.transitionDisposition(input)).outcome, "applied");
        } else {
          assert.equal(await harness.authorityStore.putDispositionIfAbsent(decision), true);
        }
        assert.equal((await harness.authorityStore.getConversationPref("local-owner", thread)).hidden, false);
        const audit = inspect.prepare(`SELECT payload_json FROM conversation_lifecycle_events
          WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'
            AND json_extract(payload_json, '$.cause') = ?`).get("local-owner", thread,
          `current_work_disposition_${mode === "transition" ? "changed" : "restored"}`);
        assert.equal(JSON.parse(audit.payload_json).cause, `current_work_disposition_${mode === "transition" ? "changed" : "restored"}`);
      }
    } finally {
      inspect.close();
      harness.authorityStore.close();
    }
  });

  it("rolls back current-work ingestion when its policy-unfold audit fails", async () => {
    const root = await createRoot();
    const harness = await createHarness(root);
    const inspect = new Database(join(root, "authority.db"));
    const thread = "regenic:source-event-1";
    try {
      await harness.authorityStore.setConversationPolicyHidden({
        org_id: "local-owner", thread_id: thread, expected_visibility_version: 0,
        updated_at: "2026-08-24T00:00:00.000Z",
      });
      inspect.exec(`CREATE TRIGGER reject_unfold_audit
        BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.event_type = 'visibility_changed'
        BEGIN SELECT RAISE(ABORT, 'unfold audit unavailable'); END`);
      await assert.rejects(harness.service.ingest(createBatch({ type: "task" })),
        /unfold audit unavailable/);
      assert.equal((await harness.authorityStore.getConversationPref("local-owner", thread)).hidden, true);
      assert.equal(await harness.authorityStore.findBySourceIdentity({
        org_id: "local-owner", source: "regenic", external_id: "source-event-1",
      }), null);
      inspect.exec("DROP TRIGGER reject_unfold_audit");
      const ingested = await harness.service.ingest(createBatch({ type: "task" }));
      const eventId = ingested.records[0].event_id;
      assert.equal((await harness.authorityStore.getConversationPref("local-owner", thread)).hidden, false);
      const event = inspect.prepare(`SELECT aggregate_version, payload_json FROM conversation_lifecycle_events
        WHERE org_id = ? AND thread_id = ? AND event_type = 'visibility_changed'
          AND json_extract(payload_json, '$.cause') = 'current_work_ingested'`).get("local-owner", thread);
      assert.equal(event.aggregate_version, 0);
      assert.deepEqual(JSON.parse(event.payload_json), {
        hidden: false, hidden_reason: null, cause: "current_work_ingested", event_id: eventId,
      });
    } finally {
      inspect.close();
      harness.authorityStore.close();
    }
  });

  it("audits current-work ingestion in the event and disposition transaction", async () => {
    const root = await createRoot();
    const harness = await createHarness(root);
    const inspect = new Database(join(root, "authority.db"));
    try {
      const ingested = await harness.service.ingest(createBatch({ type: "task" }));
      const eventId = ingested.records[0].event_id;
      const decision = await harness.authorityStore.getDisposition(eventId);
      assert.equal(decision.disposition, "current_work");
      assert.deepEqual(inspect.prepare(`SELECT thread_id, aggregate_type, aggregate_id,
        aggregate_version, event_type, command_id, payload_json
        FROM conversation_lifecycle_events WHERE aggregate_id = ?`).get(eventId), {
        thread_id: "regenic:source-event-1",
        aggregate_type: "source_event",
        aggregate_id: eventId,
        aggregate_version: 1,
        event_type: "current_work_changed",
        command_id: null,
        payload_json: JSON.stringify({ source: "ingestion", previous: null, result: decision }),
      });

      inspect.exec(`CREATE TRIGGER reject_ingest_lifecycle_audit
        BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.aggregate_type = 'source_event' AND NEW.event_type = 'current_work_changed'
        BEGIN SELECT RAISE(ABORT, 'ingestion audit unavailable'); END`);
      await assert.rejects(
        harness.service.ingest(createBatch({
          external_id: "source-event-rollback",
          type: "task",
        })),
        /ingestion audit unavailable/,
      );
      assert.equal(await harness.authorityStore.findBySourceIdentity({
        org_id: "local-owner",
        source: "regenic",
        external_id: "source-event-rollback",
      }), null);
      assert.equal(inspect.prepare(`SELECT COUNT(*) AS count FROM message_dispositions
        WHERE event_id IN (SELECT id FROM events WHERE external_id = ?)`)
        .get("source-event-rollback").count, 0);
    } finally {
      inspect.close();
      harness.authorityStore.close();
    }
  });

  it("commits revision disposition and current-work audit with its source-head update", async () => {
    const root = await createRoot();
    const harness = await createHarness(root);
    const inspect = new Database(join(root, "authority.db"));
    try {
      const created = await harness.service.ingest(createBatch({ type: "task" }));
      const originalId = created.records[0].event_id;
      inspect.exec(`CREATE TRIGGER reject_revision_lifecycle_audit
        BEFORE INSERT ON conversation_lifecycle_events
        WHEN NEW.aggregate_type = 'source_event'
          AND NEW.event_type = 'current_work_changed'
          AND NEW.aggregate_id != '${originalId}'
        BEGIN SELECT RAISE(ABORT, 'revision audit unavailable'); END`);

      await assert.rejects(harness.service.ingest(createBatch({
        operation: "revise",
        revision_id: "revision-current-work",
        type: "text",
        content: [{ role: "body", media_type: "text/plain", text: "ok" }],
      })), /revision audit unavailable/);
      assert.equal((await harness.authorityStore.findBySourceIdentity({
        org_id: "local-owner",
        source: "regenic",
        external_id: "source-event-1",
      })).id, originalId);
      assert.equal(inspect.prepare(`SELECT COUNT(*) AS count FROM events
        WHERE external_id = ?`).get("source-event-1").count, 1);

      inspect.exec("DROP TRIGGER reject_revision_lifecycle_audit");
      const revised = await harness.service.ingest(createBatch({
        operation: "revise",
        revision_id: "revision-current-work",
        type: "text",
        content: [{ role: "body", media_type: "text/plain", text: "ok" }],
      }));
      const next = await harness.authorityStore.findBySourceIdentity({
        org_id: "local-owner",
        source: "regenic",
        external_id: "source-event-1",
      });
      assert.equal(revised.records[0].event_id, next.id);
      const decision = await harness.authorityStore.getDisposition(next.id);
      assert.equal(decision.disposition, "outside_current_work");
      const audit = inspect.prepare(`SELECT payload_json FROM conversation_lifecycle_events
        WHERE aggregate_id = ? AND event_type = 'current_work_changed'`).get(next.id);
      assert.equal(JSON.parse(audit.payload_json).previous.disposition, "current_work");
      assert.deepEqual(JSON.parse(audit.payload_json).result, decision);

      inspect.exec(`CREATE TRIGGER reject_tombstone_disposition
        BEFORE INSERT ON message_dispositions
        WHEN NEW.event_id IN (
          SELECT id FROM events WHERE external_id = 'source-event-1' AND operation = 'tombstone'
        )
        BEGIN SELECT RAISE(ABORT, 'tombstone disposition unavailable'); END`);
      await assert.rejects(harness.service.ingest(createBatch({
        operation: "tombstone",
        content: undefined,
      })), /tombstone disposition unavailable/);
      assert.equal((await harness.authorityStore.findBySourceIdentity({
        org_id: "local-owner",
        source: "regenic",
        external_id: "source-event-1",
      })).id, next.id);
      inspect.exec("DROP TRIGGER reject_tombstone_disposition");
      const tombstoned = await harness.service.ingest(createBatch({
        operation: "tombstone",
        content: undefined,
      }));
      const tombstone = await harness.authorityStore.findBySourceIdentity({
        org_id: "local-owner",
        source: "regenic",
        external_id: "source-event-1",
      });
      assert.equal(tombstoned.records[0].event_id, tombstone.id);
      assert.equal(tombstone.operation, "tombstone");
      assert.equal((await harness.authorityStore.getDisposition(tombstone.id)).disposition,
        "outside_current_work");
    } finally {
      inspect.close();
      harness.authorityStore.close();
    }
  });

  it("atomically recreates a tombstoned source identity", async () => {
    const root = await createRoot();
    const harness = await createHarness(root);
    const inspect = new Database(join(root, "authority.db"));
    try {
      const deleted = await harness.service.ingest(createBatch({
        operation: "tombstone",
        content: undefined,
      }));
      const originalTombstoneId = deleted.records[0].event_id;
      inspect.exec(`CREATE TRIGGER reject_recreated_tombstone_disposition
        BEFORE INSERT ON message_dispositions
        WHEN NEW.event_id IN (
          SELECT id FROM events
          WHERE external_id = 'source-event-1' AND operation = 'tombstone'
        ) AND NEW.event_id != '${originalTombstoneId}'
        BEGIN SELECT RAISE(ABORT, 'recreated disposition unavailable'); END`);

      await assert.rejects(harness.service.ingest(createBatch()), /recreated disposition unavailable/);
      assert.equal((await harness.authorityStore.findBySourceIdentity({
        org_id: "local-owner",
        source: "regenic",
        external_id: "source-event-1",
      })).id, originalTombstoneId);
      assert.equal(inspect.prepare(`SELECT COUNT(*) AS count FROM events
        WHERE external_id = ?`).get("source-event-1").count, 1);
      inspect.exec("DROP TRIGGER reject_recreated_tombstone_disposition");

      const recreated = await harness.service.ingest(createBatch());
      const events = await harness.authorityStore.listEvents("local-owner");
      assert.equal(recreated.records[0].event_id, events.at(-1).id);
      assert.deepEqual(events.map((event) => event.operation),
        ["tombstone", "create", "tombstone"]);
      assert.equal((await harness.authorityStore.findBySourceIdentity({
        org_id: "local-owner",
        source: "regenic",
        external_id: "source-event-1",
      })).id, events.at(-1).id);
      assert.equal((await harness.authorityStore.getDisposition(events.at(-1).id))
        .disposition, "outside_current_work");
    } finally {
      inspect.close();
      harness.authorityStore.close();
    }
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
    const recent = await authorityStore.listEvents("local-owner", { order: "recent", limit: 1 });
    assert.deepEqual(recent.map((event) => event.id), [events[2].id]);
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
    await store.setConversationVisibility({
      org_id: "local-owner",
      thread_id: "dsh:session-a",
      hidden: true,
      expected_version: 0,
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
      let lastId = "";
      let lastAt = occurred;
      let lastThread = "";
      for (let index = 0; index < 2500; index += 1) {
        const id = `evt-${String(index).padStart(4, "0")}`;
        const externalId = `oc_chat:${index}`;
        const at = new Date(Date.parse(occurred) + index).toISOString();
        const threadId = conversationId("feishu", externalId, id);
        insertEvent.run(
          id,
          externalId,
          at,
          at,
          threadId,
        );
        insertHead.run(externalId, id);
        insertDisposition.run(id, at);
        lastId = id;
        lastAt = at;
        lastThread = threadId;
      }
      db.prepare(
        `
          INSERT INTO thread_heads (
            org_id, thread_id, face_event_id, face_occurred_at, has_current_work
          ) VALUES ('local-owner', ?, ?, ?, 1)
        `,
      ).run(lastThread, lastId, lastAt);
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
    const lease = await authorityStore.acquireLease({
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
      claim_token: lease.claim_token,
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
      match: { record_class: "utterance" },
      trigger: { kind: "push", coalesce: true },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: false,
      include_context: false,
      enabled: true,
      max_concurrent: 3,
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
    });
    const savedRecipe = await authorityStore.getRecipe("local-owner", "keep-recipe");
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
    const createdWork = await authorityStore.createWorkItem({
      item: {
        id: "drop-work", org_id: "local-owner", recipe_id: "keep-recipe",
        thread_id: "regenic:source-event-1", unit_key: "unit-1",
        record_class: "utterance", thread_facet: "chat", status: "open",
        created_at: "2026-08-26T00:00:00.000Z", updated_at: "2026-08-26T00:00:00.000Z",
      },
      recipe: savedRecipe,
      expected_recipe: savedRecipe,
    });
    assert.equal(createdWork.outcome, "applied");
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
    const seeded = await authorityStore.listInbox("local-owner", { limit: 1 });
    await authorityStore.putDailyDigestCoverageAlert({
      id: "alert-clear",
      org_id: "local-owner",
      local_date: "2026-08-26",
      generation: "generation-1",
      event_id: seeded[0].event.id,
      reason_code: "omitted_high_signal",
      status: "open",
      created_at: "2026-08-26T00:00:00.000Z",
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
    assert.equal(recipes[0].max_concurrent, 3);
    assert.equal(installations[0].id, "keep-connector");
    assert.equal(attempts.length, 0);
    assert.equal(cursor.cursor, undefined);
    assert.ok(cursor.cursor_version > 1);
    assert.equal(syncCatalog.members.length, 0);
    assert.equal(syncCatalog.catalog, null);
    assert.equal(syncState, null);
    assert.deepEqual(
      await authorityStore.listDailyDigestCoverageAlerts({ org_id: "local-owner" }),
      [],
    );
    authorityStore.close();
  });

  it("audits and replays inbox disposition commands while fencing stale snapshots", async () => {
    const root = await createRoot();
    const harness = await createHarness(root);
    try {
      const ingested = await harness.service.ingest(createBatch());
      const eventId = ingested.records[0].event_id;
      const expected = await harness.authorityStore.getDisposition(eventId);
      assert.ok(expected);
      const decision = {
        ...expected,
        version: (expected.version ?? 0) + 1,
        disposition: "pending",
        reason_codes: [...expected.reason_codes, "human_triage"],
        decided_at: "2026-08-26T00:01:00.000Z",
      };
      const input = {
        expected,
        decision,
        command: {
          org_id: expected.org_id,
          event_id: eventId,
          action: "triage",
          disposition: "pending",
          command_id: "inbox-triage-local-1",
          issued_at: "2026-08-26T00:01:00.000Z",
        },
      };

      assert.equal((await harness.authorityStore.transitionDisposition(input)).outcome, "applied");
      const replay = await harness.authorityStore.transitionDisposition(input);
      assert.equal(replay.outcome, "replayed");
      assert.deepEqual(replay.decision, decision);
      assert.equal((await harness.authorityStore.transitionDisposition({
        ...input,
        command: { ...input.command, action: "reset", disposition: undefined },
      })).outcome, "command_conflict");
      const resetDecision = {
        ...decision,
        version: (decision.version ?? 0) + 1,
        disposition: "current_work",
        reason_codes: ["reset"],
        decided_at: "2026-08-26T00:02:00.000Z",
      };
      assert.equal((await harness.authorityStore.transitionDisposition({
        expected: decision,
        decision: resetDecision,
        command: {
          ...input.command,
          action: "reset",
          disposition: undefined,
          command_id: "inbox-triage-local-reset",
          issued_at: "2026-08-26T00:02:00.000Z",
        },
      })).outcome, "applied");
      const replayAfterReset = await harness.authorityStore.transitionDisposition(input);
      assert.equal(replayAfterReset.outcome, "replayed");
      assert.deepEqual(replayAfterReset.decision, decision);
      assert.equal((await harness.authorityStore.transitionDisposition({
        ...input,
        command: { ...input.command, command_id: "inbox-triage-local-2" },
      })).outcome, "conflict");
      assert.deepEqual(await harness.authorityStore.getDisposition(eventId), resetDecision);
      const audit = new Database(join(root, "authority.db"));
      try {
        audit.exec(`CREATE TRIGGER reject_inbox_disposition_audit
          BEFORE INSERT ON conversation_lifecycle_events
          WHEN NEW.command_id = 'inbox-triage-local-fail'
          BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
        await assert.rejects(harness.authorityStore.transitionDisposition({
          expected: resetDecision,
          decision: { ...resetDecision, disposition: "pending" },
          command: {
            ...input.command,
            disposition: "pending",
            command_id: "inbox-triage-local-fail",
            issued_at: "2026-08-26T00:03:00.000Z",
          },
        }), /audit unavailable/);
        assert.deepEqual(await harness.authorityStore.getDisposition(eventId), resetDecision);
        audit.exec("DROP TRIGGER reject_inbox_disposition_audit");
        const events = audit.prepare(`SELECT event_type, command_id, aggregate_type, aggregate_id
          FROM conversation_lifecycle_events WHERE command_id = ?`)
          .all(input.command.command_id);
        assert.deepEqual(events, [{
          event_type: "current_work_changed",
          command_id: input.command.command_id,
          aggregate_type: "source_event",
          aggregate_id: eventId,
        }]);
      } finally {
        audit.close();
      }
    } finally {
      harness.authorityStore.close();
    }
  });
});
