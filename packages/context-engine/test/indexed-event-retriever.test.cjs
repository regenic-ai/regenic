const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemoryContextArtifactStore,
  MemoryContextRetrieverRegistry,
} = require("@regenic/domain");
const {
  ContextEngineError,
  DeterministicContextEngine,
  IndexedEventRetriever,
} = require("../dist");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const POLICY_HASH = "c".repeat(64);

function event(id, externalId, hash, scope) {
  return {
    event: {
      event_id: id,
      org_id: "example-org",
      source: "synthetic",
      external_id: externalId,
      operation: "create",
      occurred_at: "2026-09-01T00:00:00.000Z",
      ingested_at: "2026-09-01T00:01:00.000Z",
      content_hash: hash,
    },
    thread_id: "thread-1",
    actor_id: "actor-1",
    required_scope_ids: [scope],
    content_media_type: "text/plain",
  };
}

function request() {
  return {
    schema_version: "1.0",
    id: "request-1",
    org_id: "example-org",
    principal: { actor_type: "human", actor_id: "person-1" },
    consumer_id: "test-consumer",
    purpose: "find an approved release",
    allowed_uses: ["display"],
    query: "发布批准",
    temporal: { mode: "current" },
    budget: {
      profile: "test-v1",
      max_tokens: 100,
      max_items: 10,
      max_raw_evidence: 10,
    },
    requested_kinds: ["event"],
  };
}

function policy() {
  return {
    async policyHash() { return POLICY_HASH; },
    async visible({ resource }) {
      return resource.required_scope_ids.every((scope) => scope === "scope-visible");
    },
    async protectedEventIds() { return []; },
    async canReplay() { return true; },
  };
}

function engineFixture(indexOverrides = {}, sourceOverrides = {}) {
  const visible = event("event-visible", "message-visible", HASH_A, "scope-visible");
  const hidden = event("event-hidden", "message-hidden", HASH_B, "scope-hidden");
  const materializedIds = [];
  const indexInputs = [];
  const source = {
    async openRead() {
      return {
        read_epoch: "authority:2",
        recorded_at: "2026-09-01T01:00:00.000Z",
        lifecycle_complete: true,
        lifecycle_heads: [
          { source: "synthetic", external_id: "message-visible", head_event_id: "event-visible" },
          { source: "synthetic", external_id: "message-hidden", head_event_id: "event-hidden" },
        ],
        events: [structuredClone(visible), structuredClone(hidden)],
      };
    },
    async materialize(events) {
      materializedIds.push(...events.map((value) => value.event.event_id));
      return events.map((value) => ({
        ...structuredClone(value),
        text: value.event.event_id === "event-visible" ? "发布批准计划" : "hidden secret",
      }));
    },
    ...sourceOverrides,
  };
  const index = {
    async matchAuthorized(input) {
      indexInputs.push(structuredClone(input));
      return {
        available: true,
        algorithm_version: "literal-unicode-v1",
        generation: "continuous-v1",
        watermark: "authority:2",
        covered: structuredClone(input.authorized),
        matched: structuredClone(input.authorized),
      };
    },
    ...indexOverrides,
  };
  const registry = new MemoryContextRetrieverRegistry();
  registry.register(new IndexedEventRetriever(index));
  return {
    engine: new DeterministicContextEngine({
      source,
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers: registry,
    }),
    materializedIds,
    indexInputs,
  };
}

describe("indexed Event retrieval", () => {
  it("materializes and indexes only the authorized lifecycle universe", async () => {
    const { engine, materializedIds, indexInputs } = engineFixture();

    const result = await engine.assemble(request());

    assert.deepEqual(materializedIds, ["event-visible"]);
    assert.deepEqual(indexInputs[0].authorized, [{
      event_id: "event-visible",
      content_hash: HASH_A,
    }]);
    assert.deepEqual(result.bundle.sections.flatMap((section) => section.items).map((item) => item.resource_id), [
      "event-visible",
    ]);
    assert.ok(!result.bundle.degradation_flags.includes("lexical_index_partial"));
  });

  it("falls back to local verification for uncovered authorized keys", async () => {
    const { engine } = engineFixture({
      async matchAuthorized() {
        return {
          available: true,
          algorithm_version: "literal-unicode-v1",
          generation: "continuous-v1",
          watermark: "authority:1",
          covered: [],
          matched: [],
        };
      },
    });

    const result = await engine.assemble(request());

    assert.deepEqual(result.bundle.sections.flatMap((section) => section.items).map((item) => item.resource_id), [
      "event-visible",
    ]);
    assert.ok(result.bundle.degradation_flags.includes("lexical_index_partial"));
  });

  it("rejects an index key outside the authorized allowlist", async () => {
    const { engine } = engineFixture({
      async matchAuthorized(input) {
        return {
          available: true,
          algorithm_version: "literal-unicode-v1",
          generation: "continuous-v1",
          watermark: "authority:2",
          covered: [...input.authorized, { event_id: "event-hidden", content_hash: HASH_B }],
          matched: [{ event_id: "event-hidden", content_hash: HASH_B }],
        };
      },
    });

    await assert.rejects(engine.assemble(request()), /unauthorized or duplicate Event key/);
  });

  it("keeps hidden lifecycle changes out of the authorized read epoch", async () => {
    const visible = event("event-visible", "message-visible", HASH_A, "scope-visible");
    const hidden = event("event-hidden", "message-hidden", HASH_B, "scope-hidden");
    const sourceRead = (rawEpoch, events) => ({
      read_epoch: rawEpoch,
      recorded_at: "2026-09-01T01:00:00.000Z",
      lifecycle_complete: true,
      lifecycle_heads: events.map((value) => ({
        source: value.event.source,
        external_id: value.event.external_id,
        head_event_id: value.event.event_id,
      })),
      events: structuredClone(events),
    });
    const first = engineFixture({}, {
      async openRead() { return sourceRead("authority:first", [visible]); },
    }).engine;
    const second = engineFixture({}, {
      async openRead() { return sourceRead("authority:second", [visible, hidden]); },
    }).engine;

    const [left, right] = await Promise.all([
      first.assemble(request()),
      second.assemble(request()),
    ]);

    assert.equal(left.snapshot.read_epoch, right.snapshot.read_epoch);
    assert.deepEqual(
      left.bundle.sections.flatMap((section) => section.items).map((item) => item.resource_id),
      right.bundle.sections.flatMap((section) => section.items).map((item) => item.resource_id),
    );
  });

  it("rejects a materializer that mutates authorized metadata", async () => {
    const { engine } = engineFixture({}, {
      async materialize(events) {
        return events.map((value) => ({
          ...structuredClone(value),
          required_scope_ids: ["scope-hidden"],
          text: "发布批准计划",
        }));
      },
    });

    await assert.rejects(
      engine.assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "source_boundary",
    );
  });
});
