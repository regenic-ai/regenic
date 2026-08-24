const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { FsBlobStore } = require("@regenic/blob-store");
const {
  AuthorityConflictError,
  INGEST_SCHEMA_VERSION,
  IngestionService,
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
});
