const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ContextProjectionCoordinator,
} = require("../dist");
const {
  MemoryContextArtifactStore,
  MemoryContextProjectorRegistry,
  hashContextArtifactInputs,
} = require("@regenic/domain");

const HASH = "a".repeat(64);
const event = {
  id: "event-1", org_id: "example-org", source: "synthetic", external_id: "message-1",
  operation: "create", content_hash: HASH, thread_id: "thread-1", actor_id: "person-1",
  required_scope_ids: ["scope-1"], occurred_at: "2026-09-01T00:00:00.000Z",
  ingested_at: "2026-09-01T00:01:00.000Z",
};

function authority() {
  return {
    async openContextRead() {
      return { read_epoch: "authority:1", recorded_at: "2026-09-01T00:01:00.000Z", events: [event], lifecycle_heads: [] };
    },
  };
}

function projector(transform = (artifact) => artifact) {
  return {
    id: "test-projector",
    algorithm_version: "rules-v1",
    capabilities: () => ({ artifact_kinds: ["thread_summary"], incremental: true, rebuild: true, requires_model: false }),
    async project(input) {
      const artifact = {
        id: "artifact-1", org_id: input.org_id, kind: "thread_summary", schema_version: "1.0",
        algorithm_version: "rules-v1", generation: input.generation, input_refs: input.evidence,
        input_hash: hashContextArtifactInputs({ input_refs: input.evidence }), status: "proposed",
        required_scope_ids: ["scope-1"], recorded_at: "2026-09-01T00:01:00.000Z",
      };
      return [transform(artifact)];
    },
  };
}

describe("ContextProjectionCoordinator", () => {
  it("stores bounded proposals once and advances an append-only checkpoint", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const registry = new MemoryContextProjectorRegistry();
    registry.register(projector());
    const coordinator = new ContextProjectionCoordinator(authority(), artifacts, registry);

    assert.deepEqual(await coordinator.project("example-org", "generation-1"), [{
      projector_id: "test-projector", projected_events: 1, stored_artifacts: 1, checkpoint_sequence: 1,
    }]);
    assert.equal((await artifacts.listArtifacts({ org_id: "example-org" })).length, 1);
    assert.deepEqual(await coordinator.project("example-org", "generation-1"), [{
      projector_id: "test-projector", projected_events: 0, stored_artifacts: 0, checkpoint_sequence: 1,
    }]);
  });

  it("rejects proposals that do not preserve authority evidence scopes", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const registry = new MemoryContextProjectorRegistry();
    registry.register(projector((artifact) => ({ ...artifact, required_scope_ids: [] })));
    await assert.rejects(
      new ContextProjectionCoordinator(authority(), artifacts, registry).project("example-org", "generation-1"),
      /scope/,
    );
    assert.equal(await artifacts.getCheckpoint("example-org", "test-projector", "generation-1"), null);
  });

  it("rejects an artifact kind outside the projector's declared capabilities", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const registry = new MemoryContextProjectorRegistry();
    registry.register(projector((artifact) => ({ ...artifact, kind: "daily_digest" })));
    await assert.rejects(
      new ContextProjectionCoordinator(authority(), artifacts, registry).project("example-org", "generation-1"),
      /invalid context artifact proposal/,
    );
    assert.equal(await artifacts.getCheckpoint("example-org", "test-projector", "generation-1"), null);
  });

  it("rejects an artifact proposal without authority evidence", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const registry = new MemoryContextProjectorRegistry();
    registry.register(projector((artifact) => ({
      ...artifact,
      input_refs: [],
      input_hash: hashContextArtifactInputs({ input_refs: [] }),
      required_scope_ids: [],
    })));
    await assert.rejects(
      new ContextProjectionCoordinator(authority(), artifacts, registry).project("example-org", "generation-1"),
      /invalid context artifact proposal/,
    );
    assert.equal(await artifacts.getCheckpoint("example-org", "test-projector", "generation-1"), null);
  });

  it("rejects a cross-organization Event before calling a projector", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const registry = new MemoryContextProjectorRegistry();
    let called = false;
    registry.register({
      ...projector(),
      async project() {
        called = true;
        return [];
      },
    });
    await assert.rejects(
      new ContextProjectionCoordinator({
        async openContextRead() {
          return { ...await authority().openContextRead(), events: [{ ...event, org_id: "other-org" }] };
        },
      }, artifacts, registry).project("example-org", "generation-1"),
      /another organization/,
    );
    assert.equal(called, false);
    assert.equal(await artifacts.getCheckpoint("example-org", "test-projector", "generation-1"), null);
  });

  it("rejects an invalid authority read boundary before calling a projector", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const registry = new MemoryContextProjectorRegistry();
    let called = false;
    registry.register({
      ...projector(),
      async project() {
        called = true;
        return [];
      },
    });
    await assert.rejects(
      new ContextProjectionCoordinator({
        async openContextRead() {
          return { ...await authority().openContextRead(), read_epoch: "", recorded_at: "not-a-time" };
        },
      }, artifacts, registry).project("example-org", "generation-1"),
      /invalid read boundary/,
    );
    assert.equal(called, false);
    assert.equal(await artifacts.getCheckpoint("example-org", "test-projector", "generation-1"), null);
  });
});