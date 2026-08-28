const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { FsBlobStore } = require("@regenic/blob-store");
const { createHash } = require("node:crypto");
const {
  AuthorityConflictError,
  CONTENT_PARTS_MEDIA_TYPE,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  compactEmbeddedContent,
  parseStoredContentParts,
} = require("@regenic/domain");
const {
  SqliteAuthorityStore,
  SqliteSplitAuthorityStore,
} = require("../dist");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-split-store-"));
  roots.push(root);
  return root;
}

function createBatch(externalId = "source-event-1") {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: "local-owner",
    delivery_id: `delivery-${externalId}`,
    received_at: "2026-08-24T00:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "regenic",
        external_id: externalId,
        occurred_at: "2026-08-24T00:00:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          { role: "body", media_type: "text/plain", text: "Split body." },
        ],
      },
    ],
  };
}

describe("sqlite read/write split", () => {
  it("opens a readonly connection after the writer migrates", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const writer = new SqliteAuthorityStore(path);
    assert.equal(writer.readonly, false);
    writer.close();
    const reader = new SqliteAuthorityStore(path, { readonly: true });
    assert.equal(reader.readonly, true);
    await assert.rejects(
      () =>
        reader.append({
          org_id: "local-owner",
          source: "regenic",
          external_id: "blocked",
          content_hash: "a".repeat(64),
          content_media_type: "text/plain",
          content_byte_size: 1,
          occurred_at: "2026-08-24T00:00:00.000Z",
          expected_head_id: null,
        }),
      /read-only/,
    );
    reader.close();
  });

  it("ingests on the writer and lists inbox from the reader", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    await service.ingest(createBatch());
    const inbox = await store.listInbox("local-owner");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.external_id, "source-event-1");
    assert.equal(store.readonly, true);
    await store.close();
  });

  it("lets the reader see a full thread as soon as the writer commits", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    for (let index = 0; index < 23; index += 1) {
      await service.ingest(createBatch(`oc_yiki:om_${index}`));
    }
    const inbox = await store.listInbox("local-owner");
    assert.equal(inbox.length, 23);
    await store.close();
  });

  it("commits one page of creates in a single writer transaction", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    const result = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "page-23",
      received_at: "2026-08-24T00:00:00.000Z",
      records: Array.from({ length: 23 }, (_, index) => ({
        operation: "create",
        source: "regenic",
        external_id: `oc_yiki:om_${index}`,
        occurred_at: `2026-08-24T00:00:00.${String(index).padStart(3, "0")}Z`,
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          {
            role: "body",
            media_type: "text/plain",
            text: `Page body ${index}.`,
          },
        ],
      })),
    });
    const inbox = await store.listInbox("local-owner");
    const hashes = inbox.map((item) => item.event.content_hash).filter(Boolean);
    const blobs = await store.findBlobs(hashes);
    assert.equal(result.valid, true);
    assert.equal(result.records.filter((record) => record.status === "accepted").length, 23);
    assert.equal(inbox.length, 23);
    assert.equal(blobs.size, hashes.length);
    await store.close();
  });

  it("rolls back a page when one append conflicts", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const existing = {
      org_id: "local-owner",
      source: "regenic",
      external_id: "already-there",
      content_hash: "b".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    };
    await store.append(existing);
    await assert.rejects(
      () =>
        store.commitIngest({
          appends: [
            {
              id: "kept-if-committed",
              org_id: "local-owner",
              source: "regenic",
              external_id: "new-event",
              content_hash: "c".repeat(64),
              content_media_type: "text/plain",
              content_byte_size: 1,
              occurred_at: "2026-08-24T00:00:01.000Z",
              expected_head_id: null,
            },
            {
              ...existing,
              id: "conflict",
            },
          ],
          dispositions: [],
        }),
      AuthorityConflictError,
    );
    assert.equal((await store.listEvents("local-owner")).length, 1);
    assert.equal(await store.getEvent("local-owner", "kept-if-committed"), null);
    await store.close();
  });

  it("does not make inbox wait when the writer is busy", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const service = new IngestionService(
      new FsBlobStore(join(root, "blobs")),
      store,
    );
    await service.ingest(createBatch());
    const held = store.stallWriter(120);
    const started = Date.now();
    const inbox = await store.listInbox("local-owner");
    const elapsed = Date.now() - started;
    assert.equal(inbox.length, 1);
    assert.ok(
      elapsed < 80,
      `inbox read waited ${elapsed}ms on the write thread`,
    );
    await held;
    await store.close();
  });

  it("revives an authority conflict from the write worker", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const event = {
      org_id: "local-owner",
      source: "regenic",
      external_id: "conflict-1",
      content_hash: "b".repeat(64),
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-24T00:00:00.000Z",
      expected_head_id: null,
    };
    await store.append(event);
    await assert.rejects(() => store.append(event), AuthorityConflictError);
    await store.close();
  });

  it("compacts inlined attachments through the write worker", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const blobs = new FsBlobStore(join(root, "blobs"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const envelope = Buffer.from(
      JSON.stringify([
        {
          role: "body",
          media_type: "text/plain",
          bytes_base64: Buffer.from("see this", "utf8").toString("base64"),
        },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "shot.png",
          bytes_base64: png.toString("base64"),
        },
      ]),
      "utf8",
    );
    const oldHash = createHash("sha256").update(envelope).digest("hex");
    await blobs.put(oldHash, envelope, CONTENT_PARTS_MEDIA_TYPE);
    const event = await store.append({
      org_id: "local-owner",
      source: "feishu",
      external_id: "oc_1:om_1",
      content_hash: oldHash,
      content_media_type: CONTENT_PARTS_MEDIA_TYPE,
      content_byte_size: envelope.byteLength,
      occurred_at: "2026-08-27T00:00:00.000Z",
      expected_head_id: null,
    });

    const result = await compactEmbeddedContent(store, blobs, "local-owner");
    const updated = await store.getEvent("local-owner", event.id);
    const parts = parseStoredContentParts(await blobs.get(updated.content_hash));
    const attachment = parts.find((part) => part.role === "attachment");

    assert.equal(result.rewritten, 1);
    assert.notEqual(updated.content_hash, oldHash);
    assert.equal(await blobs.exists(oldHash), false);
    assert.equal(parts.find((part) => part.role === "body").text, "see this");
    assert.deepEqual(Buffer.from(await blobs.get(attachment.content_hash)), png);
    await store.close();
  });

  it("reads the latest ingest attempt without waiting on the writer", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const installation = await store.createInstallation({
      id: "installation-latest",
      org_id: "local-owner",
      connector_type: "native-local",
      status: "enabled",
      config: {},
      created_at: "2026-08-28T00:00:00.000Z",
    });
    for (const index of [1, 2, 3]) {
      await store.beginAttempt({
        id: `attempt-${index}`,
        org_id: "local-owner",
        connector_installation_id: installation.id,
        stream_key: "personal",
        delivery_id: `page-${index}`,
        started_at: `2026-08-28T00:00:0${index}.000Z`,
      });
    }
    const held = store.stallWriter(120);
    const started = Date.now();
    const latest = await store.latestAttempt(installation.id);
    const elapsed = Date.now() - started;
    assert.equal(latest?.id, "attempt-3");
    assert.ok(
      elapsed < 80,
      `latestAttempt waited ${elapsed}ms on the write thread`,
    );
    await held;
    await store.close();
  });

  it("prunes old ingest attempts and checkpoints WAL on the writer", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const installation = await store.createInstallation({
      id: "installation-prune",
      org_id: "local-owner",
      connector_type: "native-local",
      status: "enabled",
      config: {},
      created_at: "2026-08-28T00:00:00.000Z",
    });
    for (let index = 0; index < 80; index += 1) {
      const stamp = `2026-08-28T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
      await store.beginAttempt({
        id: `attempt-${index}`,
        org_id: "local-owner",
        connector_installation_id: installation.id,
        stream_key: "personal",
        delivery_id: `page-${index}`,
        started_at: stamp,
      });
    }
    const result = await store.maintainStore();
    const remaining = await store.listAttempts(installation.id);
    const latest = await store.latestAttempt(installation.id);
    assert.equal(result.deleted, 16);
    assert.equal(remaining.length, 64);
    assert.equal(latest?.id, "attempt-79");
    await store.close();
  });
});
