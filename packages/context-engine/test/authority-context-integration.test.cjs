const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { SqliteSplitAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const {
  contextRegistriesPlugin,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  MemoryContextRetrieverRegistry,
} = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  AuthorityContextEvidenceSource,
  DeterministicContextEngine,
  DeterministicEventRetriever,
  PersonalContextPolicyEvaluator,
  contextProjectionCoordinatorPlugin,
  deterministicEventRetrieverPlugin,
  personalContextEnginePlugin,
} = require("../dist");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-context-integration-"));
  roots.push(root);
  return root;
}

function ingestBatch(operation, text, deliveryId) {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "synthetic-chat",
    org_id: "local-owner",
    delivery_id: deliveryId,
    received_at: "2026-08-30T03:00:00.000Z",
    records: [{
      operation,
      source: "synthetic-chat",
      external_id: "chat-1:message-1",
      occurred_at: operation === "create"
        ? "2026-08-30T00:00:00.000Z"
        : operation === "revise"
          ? "2026-08-30T01:00:00.000Z"
          : "2026-08-30T02:00:00.000Z",
      actor: { id: operation === "revise" ? "reviewer" : "person-1" },
      scope: { id: "chat-1" },
      type: "message",
      ...(text === undefined
        ? {}
        : { content: [{ role: "body", media_type: "text/plain", text }] }),
    }],
  };
}

function contextRequest(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "request-1",
    org_id: "local-owner",
    principal: { actor_type: "human", actor_id: "local-owner" },
    consumer_id: "integration-test",
    purpose: "answer a synthetic release question",
    allowed_uses: ["display", "reason"],
    query: "release approved",
    anchors: [{ kind: "conversation", id: "synthetic-chat:chat-1" }],
    temporal: { mode: "current" },
    budget: {
      profile: "integration",
      max_tokens: 100,
      max_items: 5,
      max_raw_evidence: 5,
    },
    requested_kinds: ["event"],
    ...overrides,
  };
}

function createEngine(authority, blobs, sourceOverride) {
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(new DeterministicEventRetriever());
  return new DeterministicContextEngine({
    source: sourceOverride ?? new AuthorityContextEvidenceSource(authority, blobs),
    policy: new PersonalContextPolicyEvaluator({
      org_id: "local-owner",
      principal: { actor_type: "human", actor_id: "local-owner" },
    }),
    artifacts: authority,
    retrievers,
  });
}

describe("authority-backed context integration", () => {
  it("assembles current SQLite evidence and replays its bundle after restart", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobs = new FsBlobStore(join(root, "blobs"));
    let authority = await SqliteSplitAuthorityStore.open(database);
    const ingestion = new IngestionService(blobs, authority);
    await ingestion.ingest(ingestBatch("create", "The release is delayed.", "delivery-create"));
    await ingestion.ingest(ingestBatch("revise", "The release is approved.", "delivery-revise"));

    const engine = createEngine(authority, blobs);
    const assembled = await engine.assemble(contextRequest());
    assert.equal(assembled.bundle.sections.length, 1);
    assert.equal(assembled.bundle.sections[0].kind, "evidence");
    assert.equal(assembled.bundle.sections[0].items[0].text, "The release is approved.");
    assert.equal(assembled.bundle.sections[0].items[0].status, "current");

    await ingestion.ingest(ingestBatch("tombstone", undefined, "delivery-delete"));
    const afterDelete = await engine.assemble(contextRequest({
      id: "request-after-delete",
      query: undefined,
    }));
    assert.equal(afterDelete.bundle.sections.length, 0);
    await authority.close();

    authority = await SqliteSplitAuthorityStore.open(database);
    const replayOnly = createEngine(authority, blobs, {
      async openRead() {
        throw new Error("Replay must not consult the authority source");
      },
    });
    const replayed = await replayOnly.replay({
      org_id: "local-owner",
      snapshot_id: assembled.snapshot.id,
      principal: { actor_type: "human", actor_id: "local-owner" },
      consumer_id: "integration-test",
      purpose: "answer a synthetic release question",
      allowed_uses: ["display"],
    });
    assert.equal(replayed.content_hash, assembled.bundle.content_hash);
    assert.equal(replayed.sections[0].items[0].text, "The release is approved.");
    await authority.close();
  });

  it("excludes legacy Events that have no persisted ACL metadata", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobs = new FsBlobStore(join(root, "blobs"));
    const authority = await SqliteSplitAuthorityStore.open(database);
    const bytes = Buffer.from("Legacy body.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await blobs.put(hash, bytes, "text/plain");
    await authority.append({
      org_id: "local-owner",
      source: "legacy",
      external_id: "message-1",
      content_hash: hash,
      content_media_type: "text/plain",
      content_byte_size: bytes.byteLength,
      occurred_at: "2026-08-30T00:00:00.000Z",
      expected_head_id: null,
    });

    const read = await new AuthorityContextEvidenceSource(authority, blobs)
      .openRead(contextRequest({ query: undefined, anchors: undefined }));
    assert.deepEqual(read.events, []);
    assert.deepEqual(read.lifecycle_heads, []);
    await authority.close();
  });

  it("fails closed when a committed Event Blob is missing", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobs = new FsBlobStore(join(root, "blobs"));
    const authority = await SqliteSplitAuthorityStore.open(database);
    const ingestion = new IngestionService(blobs, authority);
    await ingestion.ingest(ingestBatch("create", "Required body.", "delivery-required"));
    const read = await authority.openContextRead("local-owner");
    await blobs.delete(read.events[0].content_hash);

    await assert.rejects(
      new AuthorityContextEvidenceSource(authority, blobs).openRead(
        contextRequest({ query: undefined, anchors: undefined }),
      ),
      /missing Blob/,
    );
    await authority.close();
  });

  it("mounts and disposes the personal context engine through plugin services", async () => {
    const root = await createRoot();
    const authority = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    const blobs = new FsBlobStore(join(root, "blobs"));
    const host = await createHost();
    const authorityPlugin = definePlugin({
      name: "test-context-authority",
      apply(ctx) {
        ctx.provide("context-authority", authority);
        ctx.provide("context-artifacts", authority);
        ctx.provide("blobs", blobs);
      },
    });
    await host.plugin(authorityPlugin);
    await host.plugin(contextRegistriesPlugin);
    await host.plugin(deterministicEventRetrieverPlugin);
    await host.plugin(contextProjectionCoordinatorPlugin);
    const handle = await host.plugin(personalContextEnginePlugin, {
      org_id: "local-owner",
    });
    assert.ok(host.get("context"));
    assert.ok(host.get("context-projections"));
    await handle.dispose();
    assert.throws(() => host.get("context"), /Service is not available/);
    await host.dispose();
    await authority.close();
  });
});
