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

function authority(overrides = {}) {
  const base = {
    read_epoch: "authority:1",
    recorded_at: "2026-09-01T00:01:00.000Z",
    events: [event],
    lifecycle_heads: [],
  };
  const read = { ...base, ...overrides };
  return {
    async openContextRead() {
      return read;
    },
    async openContextReadForThread(_orgId, threadId) {
      return {
        ...read,
        events: read.events.filter((item) => item.thread_id === threadId),
      };
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

  it("bootstraps and incrementally advances the lexical index from committed Events", async () => {
    const registry = new MemoryContextProjectorRegistry();
    const calls = { replacements: [], upserts: [] };
    let generation;
    const index = {
      async getStatus() {
        return {
          available: true,
          algorithm_version: "literal-unicode-v1",
          ...(generation ? { generation, watermark: "authority:1" } : {}),
        };
      },
      async replaceOrganization(input) {
        calls.replacements.push(structuredClone(input));
        generation = input.generation;
      },
      async upsertDocuments(input) {
        calls.upserts.push(structuredClone(input));
      },
    };
    const blobs = {
      async getMany() { return new Map([[HASH, Buffer.from("Indexed body")]]); },
    };
    const indexedAuthority = {
      async openContextRead() {
        return {
          ...await authority().openContextRead(),
          events: [{ ...event, content_media_type: "text/plain" }],
        };
      },
    };
    const coordinator = new ContextProjectionCoordinator(
      indexedAuthority,
      new MemoryContextArtifactStore(),
      registry,
      blobs,
      index,
    );

    await coordinator.syncLexicalIndex("example-org", "continuous-v1");
    await coordinator.syncLexicalIndex("example-org", "continuous-v1", ["event-1"]);

    assert.deepEqual(calls.replacements[0].documents, [{
      event_id: "event-1",
      content_hash: HASH,
      text: "Indexed body",
    }]);
    assert.deepEqual(calls.upserts[0].documents, calls.replacements[0].documents);
    await assert.rejects(
      coordinator.syncLexicalIndex("example-org", "continuous-v1", ["event-unknown"]),
      /outside the authority read/,
    );
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
        async openContextReadForThread() {
          return authority().openContextRead();
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
        async openContextReadForThread() {
          return authority().openContextRead();
        },
      }, artifacts, registry).project("example-org", "generation-1"),
      /invalid read boundary/,
    );
    assert.equal(called, false);
    assert.equal(await artifacts.getCheckpoint("example-org", "test-projector", "generation-1"), null);
  });

  it("rejects blank projection namespaces before reading authority", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const registry = new MemoryContextProjectorRegistry();
    let readCalls = 0;
    const coordinator = new ContextProjectionCoordinator({
      async openContextRead() {
        readCalls += 1;
        return authority().openContextRead();
      },
      async openContextReadForThread() {
        readCalls += 1;
        return authority().openContextRead();
      },
    }, artifacts, registry);

    await assert.rejects(coordinator.project(" ", "generation-1"), /organization and generation/);
    await assert.rejects(coordinator.project("example-org", " "), /organization and generation/);
    assert.equal(readCalls, 0);
  });

  it("projects one thread through a scoped authority read", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const registry = new MemoryContextProjectorRegistry();
    registry.register(projector());
    let scopedThread = null;
    const coordinator = new ContextProjectionCoordinator({
      async openContextRead() {
        throw new Error("full org read should not run");
      },
      async openContextReadForThread(_orgId, threadId) {
        scopedThread = threadId;
        return authority().openContextReadForThread(_orgId, threadId);
      },
    }, artifacts, registry);

    assert.deepEqual(
      await coordinator.projectThread("example-org", "continuous-v1", "thread-1"),
      [{
        projector_id: "test-projector",
        projected_events: 1,
        stored_artifacts: 1,
        checkpoint_sequence: 1,
      }],
    );
    assert.equal(scopedThread, "thread-1");
    assert.equal(
      (await artifacts.getCheckpoint(
        "example-org",
        "test-projector",
        "continuous-v1@thread:thread-1",
      ))?.sequence,
      1,
    );
  });
});