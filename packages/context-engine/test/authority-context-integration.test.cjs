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
  MemoryContextProjectorRegistry,
  canonicalContextJson,
} = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  AuthorityContextEvidenceSource,
  AcceptedThreadSummaryRetriever,
  ContextProjectionCoordinator,
  DeterministicThreadSummaryProjector,
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
  it("preserves full shared summaries and old snapshot replay across revision, tombstone, and restart", async (t) => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    let authority = await SqliteSplitAuthorityStore.open(path);
    t.after(() => authority.close());
    const blobs = new FsBlobStore(join(root, "blobs"));
    const ingestion = new IngestionService(blobs, authority);
    await ingestion.ingest(ingestBatch("create", "The release is approved.", "shared-create"));
    const projectors = new MemoryContextProjectorRegistry();
    projectors.register(new DeterministicThreadSummaryProjector());
    const coordinator = new ContextProjectionCoordinator(authority, authority, projectors, blobs);
    await coordinator.project("local-owner", "continuous-v2");
    const [original] = await authority.listArtifacts({ org_id: "local-owner" });
    assert.equal(original.body_storage, "artifact");
    assert.equal(original.attrs.messages[0].text, "The release is approved.");
    assert.equal(await blobs.exists(original.body_hash), false);
    await authority.decideArtifact({
      org_id: "local-owner", artifact_id: original.id, status: "accepted", decided_at: original.recorded_at,
    });
    function summaryEngine() {
      const retrievers = new MemoryContextRetrieverRegistry();
      retrievers.register(new AcceptedThreadSummaryRetriever(authority, blobs));
      return new DeterministicContextEngine({
        source: new AuthorityContextEvidenceSource(authority, blobs),
        policy: new PersonalContextPolicyEvaluator({
          org_id: "local-owner", principal: { actor_type: "human", actor_id: "local-owner" },
        }),
        artifacts: authority, retrievers,
      });
    }
    const assembled = await summaryEngine().assemble(contextRequest({
      requested_kinds: ["artifact"],
      budget: { profile: "shared-summary", max_tokens: 2_000, max_items: 5, max_raw_evidence: 5 },
    }));
    assert.equal(assembled.bundle.sections[0].items[0].text, canonicalContextJson(original.attrs));
    await ingestion.ingest(ingestBatch("revise", "The release is postponed.", "shared-revise"));
    await coordinator.project("local-owner", "continuous-v2");
    const summaries = await authority.listArtifacts({ org_id: "local-owner" });
    const revised = summaries.find((value) => value.id !== original.id);
    assert.equal(revised.attrs.messages[0].text, "The release is postponed.");
    assert.equal(revised.input_refs.length, 2);
    await ingestion.ingest(ingestBatch("tombstone", undefined, "shared-tombstone"));
    await coordinator.project("local-owner", "continuous-v2");
    const deleted = (await authority.listArtifacts({ org_id: "local-owner" }))
      .find((value) => value.input_refs.length === 3);
    assert.deepEqual(deleted.attrs.messages, []);
    assert.deepEqual((await authority.getArtifact("local-owner", original.id)).attrs, original.attrs);
    await authority.close();
    authority = await SqliteSplitAuthorityStore.open(path);
    const replayed = await summaryEngine().replay({
      org_id: "local-owner", snapshot_id: assembled.snapshot.id,
      principal: { actor_type: "human", actor_id: "local-owner" }, consumer_id: "integration-test",
      purpose: "answer a synthetic release question", allowed_uses: ["display"],
    });
    assert.equal(replayed.content_hash, assembled.bundle.content_hash);
    assert.equal(replayed.sections[0].items[0].text, canonicalContextJson(original.attrs));
    assert.deepEqual((await authority.getArtifact("local-owner", deleted.id)).attrs.messages, []);
  });

  it("preserves exact JavaScript time-filter boundaries despite SQLite fractional-second rounding", async (t) => {
    const root = await createRoot();
    const authority = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    t.after(() => authority.close());
    const blobs = new FsBlobStore(join(root, "blobs"));
    const ingestion = new IngestionService(blobs, authority);
    const batch = ingestBatch("create", "The release is approved.", "fractional-time");
    batch.records[0].occurred_at = "2026-08-30T00:00:00.9999Z";
    const target = await ingestion.ingest(batch);
    const later = ingestBatch("create", "The release is approved.", "next-second");
    later.records[0].external_id = "chat-1:message-2";
    later.records[0].occurred_at = "2026-08-30T00:00:01.000Z";
    await ingestion.ingest(later);
    const result = await createEngine(authority, blobs).assemble(contextRequest({
      filters: {
        occurred_after: "2026-08-30T08:00:00.999+08:00",
        occurred_before: "2026-08-30T00:00:00.999Z",
      },
    }));
    assert.deepEqual(result.snapshot.selected.map((item) => item.resource_id), [target.records[0].event_id]);
  });

  it("pushes request scope through the split reader and never opens unrelated bodies", async (t) => {
    const root = await createRoot();
    const authority = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    t.after(() => authority.close());
    const blobs = new FsBlobStore(join(root, "blobs"));
    const ingestion = new IngestionService(blobs, authority);
    const target = await ingestion.ingest(ingestBatch("create", "The release is approved.", "target"));
    const other = ingestBatch("create", "Unrelated body.", "other");
    other.records[0].external_id = "chat-2:message-2";
    other.records[0].scope.id = "chat-2";
    const unrelated = await ingestion.ingest(other);
    const unrelatedEvent = await authority.getEvent("local-owner", unrelated.records[0].event_id);
    await blobs.delete(unrelatedEvent.content_hash);
    const requested = [];
    const source = new AuthorityContextEvidenceSource(authority, {
      async getMany(hashes) {
        requested.push(...hashes);
        return blobs.getMany(hashes);
      },
    });
    const scoped = await source.openRead(contextRequest());
    assert.deepEqual(scoped.events.map((event) => event.event.event_id), [target.records[0].event_id]);
    const result = await createEngine(authority, blobs, source).assemble(contextRequest());
    assert.equal(result.snapshot.selected[0].resource_id, target.records[0].event_id);
    assert.equal(requested.length, 1);
    assert.notEqual(requested[0], unrelatedEvent.content_hash);
  });

  it("fails closed rather than resurrecting a version whose revision moves outside the requested thread", async (t) => {
    const root = await createRoot();
    const authority = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    t.after(() => authority.close());
    const blobs = new FsBlobStore(join(root, "blobs"));
    const ingestion = new IngestionService(blobs, authority);
    await ingestion.ingest(ingestBatch("create", "The release is approved.", "before-move"));
    const moved = ingestBatch("revise", "The release is delayed.", "after-move");
    moved.records[0].scope.id = "chat-2";
    await ingestion.ingest(moved);
    const source = new AuthorityContextEvidenceSource(authority, blobs);
    assert.equal((await source.openRead(contextRequest())).events.length, 2);
    const engine = createEngine(authority, blobs, source);
    await assert.rejects(engine.assemble(contextRequest()), /parent crosses identity or time order/);
    await assert.rejects(
      engine.assemble(contextRequest({ temporal: { mode: "history" } })),
      /parent crosses identity or time order/,
    );
  });

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

    const source = new AuthorityContextEvidenceSource(authority, blobs);
    const metadata = await source.openRead(
      contextRequest({ query: undefined, anchors: undefined }),
    );
    assert.equal(metadata.events[0].text, undefined);
    await assert.rejects(
      source.materialize(metadata.events.map((event) => ({
        ...event,
        status: "current",
      }))),
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
