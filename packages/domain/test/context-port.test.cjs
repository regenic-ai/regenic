const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemoryContextArtifactStore,
  MemoryContextProjectorRegistry,
  MemoryContextRetrieverRegistry,
  contextRuntimePlugin,
  hashContextArtifactInputs,
  hashContextBundle,
  hashContextSnapshot,
} = require("../dist");
const { createHost } = require("@regenic/plugin-host");

const HASH_A = "a".repeat(64);

function artifact(overrides = {}) {
  return {
    id: "artifact-1",
    org_id: "example-org",
    kind: "thread_summary",
    schema_version: "1.0",
    algorithm_version: "rules-v1",
    generation: "generation-1",
    input_refs: [],
    input_hash: hashContextArtifactInputs({ input_refs: [] }),
    status: "proposed",
    required_scope_ids: [],
    recorded_at: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("context ports", () => {
  it("registers context capabilities deterministically and disposes exact values", () => {
    const projectors = new MemoryContextProjectorRegistry();
    const retrievers = new MemoryContextRetrieverRegistry();
    const projector = {
      id: "summary",
      algorithm_version: "1",
      capabilities: () => ({ artifact_kinds: ["thread_summary"], incremental: true, rebuild: true, requires_model: false }),
      project: async () => [],
    };
    const retriever = {
      id: "events",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      retrieve: async () => [],
    };
    const disposeProjector = projectors.register(projector);
    const disposeRetriever = retrievers.register(retriever);

    assert.equal(projectors.get("summary"), projector);
    assert.equal(retrievers.get("events"), retriever);
    assert.deepEqual(projectors.list().map((item) => item.id), ["summary"]);
    assert.throws(() => projectors.register(projector), /already registered/);

    disposeProjector();
    disposeRetriever();
    assert.equal(projectors.get("summary"), undefined);
    assert.equal(retrievers.get("events"), undefined);
  });

  it("stores immutable values by clone and advances checkpoints monotonically", async () => {
    const store = new MemoryContextArtifactStore();
    const value = artifact();
    await store.putArtifact(value);
    value.kind = "daily_digest";

    const stored = await store.getArtifact("example-org", "artifact-1");
    assert.equal(stored.kind, "thread_summary");
    assert.equal((await store.listArtifacts({ org_id: "example-org" })).length, 1);
    stored.kind = "daily_digest";
    assert.equal((await store.getArtifact("example-org", "artifact-1")).kind, "thread_summary");
    await assert.rejects(
      store.putArtifact({ ...artifact(), algorithm_version: "rules-v2" }),
      /Cannot replace immutable context artifact/,
    );

    await store.putCheckpoint({
      org_id: "example-org",
      projector_id: "summary",
      algorithm_version: "1",
      generation: "generation-1",
      sequence: 2,
      watermark: "0002",
      updated_at: "2026-08-30T00:00:00.000Z",
    });
    await assert.rejects(
      store.putCheckpoint({
        org_id: "example-org",
        projector_id: "summary",
        algorithm_version: "1",
        generation: "generation-1",
        sequence: 1,
        watermark: "later-looking-but-older-position",
        updated_at: "2026-08-30T00:01:00.000Z",
      }),
      /cannot move backwards/,
    );
    await assert.rejects(
      store.putCheckpoint({
        org_id: "example-org",
        projector_id: "summary",
        algorithm_version: "2",
        generation: "generation-1",
        sequence: 3,
        watermark: "0003",
        updated_at: "2026-08-30T00:02:00.000Z",
      }),
      /algorithm cannot change/,
    );
    await store.putCheckpoint({
      org_id: "example-org",
      projector_id: "summary",
      algorithm_version: "1",
      generation: "generation-1",
      sequence: 2,
      watermark: "changed-at-same-position",
      updated_at: "2026-08-30T00:03:00.000Z",
    });
    await assert.rejects(
      store.putCheckpoint({
        org_id: "example-org",
        projector_id: "summary",
        algorithm_version: "1",
        generation: "generation-1",
        sequence: 2,
        watermark: "stale-concurrent-position",
        updated_at: "2026-08-30T00:02:30.000Z",
      }),
      /cannot regress at the same sequence/,
    );
    assert.equal(
      (await store.getCheckpoint("example-org", "summary", "generation-1")).watermark,
      "changed-at-same-position",
    );

    const malformed = [
      {
        org_id: "example-org",
        projector_id: "malformed",
        algorithm_version: "1",
        generation: "generation-1",
        sequence: 1,
        watermark: "0001",
        updated_at: 0,
      },
      {
        org_id: "example-org",
        projector_id: "malformed",
        algorithm_version: "1",
        generation: "generation-1",
        sequence: 1,
        watermark: "0001",
        updated_at: "not-a-timestamp",
      },
      {
        org_id: "example-org",
        projector_id: "malformed",
        algorithm_version: "1",
        generation: "generation-1",
        sequence: 1,
        watermark: "0001",
        updated_at: "2026-08-30T00:00:00.000Z",
        unexpected: { secret: "must-not-persist" },
      },
      null,
    ];
    for (const checkpoint of malformed) {
      await assert.rejects(
        store.putCheckpoint(checkpoint),
        /Invalid context projection checkpoint/,
      );
    }
    assert.equal(
      await store.getCheckpoint("example-org", "malformed", "generation-1"),
      null,
    );
  });

  it("does not collide bundle keys across delimiter-bearing identities", async () => {
    const store = new MemoryContextArtifactStore();
    const ledger = {
      profile: "empty",
      max_tokens: 1,
      max_items: 1,
      max_raw_evidence: 0,
      requested_tokens: 0,
      selected_tokens: 0,
      reserved_tokens: 0,
      selected_items: 0,
      truncated_items: 0,
      sections: [],
    };
    const snapshot = {
      schema_version: "1.0",
      id: "snapshot-1",
      org_id: "example-org",
      request_hash: HASH_A,
      principal_policy_hash: HASH_A,
      read_epoch: "authority:1",
      retrieval_profile_version: "test",
      assembly_profile_version: "test",
      bundle_payload_hash: HASH_A,
      selected: [],
      budget_ledger: ledger,
      degradation_flags: [],
      content_hash: "",
      created_at: "2026-08-30T00:00:00.000Z",
    };
    snapshot.content_hash = hashContextSnapshot(snapshot);
    snapshot.id = `context-snapshot:${snapshot.content_hash}`;
    const bundle = {
      schema_version: "2.0",
      snapshot_id: snapshot.id,
      org_id: snapshot.org_id,
      principal: { actor_type: "human", actor_id: "a\u0000b" },
      consumer_id: "c",
      purpose: "test",
      allowed_uses: ["display"],
      sections: [],
      citations: [],
      conflicts: [],
      redactions: [],
      budget_ledger: ledger,
      degradation_flags: [],
      content_hash: "",
    };
    bundle.content_hash = hashContextBundle(bundle);
    await store.putSnapshot(snapshot);
    await store.putBundle(bundle);

    assert.ok(await store.getBundle({
      org_id: "example-org",
      snapshot_id: snapshot.id,
      principal: { actor_type: "human", actor_id: "a\u0000b" },
      consumer_id: "c",
    }));
    assert.equal(await store.getBundle({
      org_id: "example-org",
      snapshot_id: snapshot.id,
      principal: { actor_type: "human", actor_id: "a" },
      consumer_id: "b\u0000c",
    }), null);
  });

  it("mounts and removes context runtime services with the plugin fiber", async () => {
    const host = await createHost();
    const handle = await host.plugin(contextRuntimePlugin);

    assert.ok(host.get("context-artifacts"));
    assert.ok(host.get("context-projectors"));
    assert.ok(host.get("context-retrievers"));

    await handle.dispose();
    assert.throws(() => host.get("context-artifacts"), /Service is not available/);
    assert.throws(() => host.get("context-projectors"), /Service is not available/);
    assert.throws(() => host.get("context-retrievers"), /Service is not available/);
    await host.dispose();
  });
});