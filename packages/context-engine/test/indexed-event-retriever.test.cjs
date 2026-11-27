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
        algorithm_version: "segment-bm25-v1",
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
  it("searches from the index without loading the authority into memory", async () => {
    let opened = false;
    let authorizedCalls = 0;
    const visible = event("event-visible", "message-visible", HASH_A, "scope-visible");
    const materializedIds = [];
    const source = {
      databasePath: () => "/tmp/regenic-authority.db",
      async openReadStamp() { return "9:1"; },
      async openRead() { opened = true; throw new Error("full authority read"); },
      async loadCurrentEvents(_orgId, ids) {
        assert.deepEqual(ids, ["event-visible"]);
        return [structuredClone(visible)];
      },
      async materialize(events) {
        materializedIds.push(...events.map((value) => value.event.event_id));
        return events.map((value) => ({ ...structuredClone(value), text: "发布批准计划" }));
      },
    };
    const index = {
      async matchAuthorized() { authorizedCalls += 1; throw new Error("key list"); },
      async matchRanked(input) {
        assert.equal(input.authority_path, "/tmp/regenic-authority.db");
        assert.equal(input.stamp, "9:1");
        assert.ok(input.limit >= 50);
        return {
          available: true,
          generation: "continuous-v1",
          matched: [{ event_id: "event-visible", content_hash: HASH_A }],
          authorized_count: 2,
          covered_count: 1,
        };
      },
    };
    const registry = new MemoryContextRetrieverRegistry();
    registry.register(new IndexedEventRetriever(index));
    const engine = new DeterministicContextEngine({
      source, policy: policy(), artifacts: new MemoryContextArtifactStore(), retrievers: registry,
    });
    const result = await engine.assemble({
      ...request(),
      consumer_id: "personal-context-search",
    });
    assert.equal(opened, false);
    assert.equal(authorizedCalls, 0);
    assert.deepEqual(materializedIds, ["event-visible"]);
    assert.equal(result.snapshot.read_epoch, `authorized-stamp:9:1:${POLICY_HASH}`);
    assert.deepEqual(result.bundle.sections.flatMap((section) => section.items).map((item) => item.resource_id), [
      "event-visible",
    ]);
    assert.ok(result.bundle.degradation_flags.includes("lexical_index_partial"));
  });

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

  it("accepts a compact complete coverage proof bound to the authorization set", async () => {
    let compactInput;
    const { engine } = engineFixture({
      async matchAuthorized(input) {
        compactInput = structuredClone(input);
        return {
          available: true,
          algorithm_version: "segment-bm25-v1",
          generation: "continuous-v1",
          watermark: "authority:2",
          covered: [],
          coverage: {
            authorization_hash: input.authorization_hash,
            authorized_count: input.authorized.length,
            covered_count: input.authorized.length,
            complete: true,
            uncovered: [],
          },
          matched: structuredClone(input.authorized),
        };
      },
    });

    const result = await engine.assemble(request());

    assert.match(compactInput.authorization_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      result.bundle.sections.flatMap((section) => section.items)
        .map((item) => item.resource_id),
      ["event-visible"],
    );
    assert.ok(!result.bundle.degradation_flags.includes("lexical_index_partial"));
  });

  it("rejects a compact coverage proof for another authorization set", async () => {
    const { engine } = engineFixture({
      async matchAuthorized(input) {
        return {
          available: true,
          algorithm_version: "segment-bm25-v1",
          generation: "continuous-v1",
          watermark: "authority:2",
          covered: [],
          coverage: {
            authorization_hash: HASH_B,
            authorized_count: input.authorized.length,
            covered_count: input.authorized.length,
            complete: true,
            uncovered: [],
          },
          matched: [],
        };
      },
    });

    await assert.rejects(engine.assemble(request()), /invalid coverage proof/);
  });

  it("falls back to local verification for uncovered authorized keys", async () => {
    const { engine } = engineFixture({
      async matchAuthorized() {
        return {
          available: true,
          algorithm_version: "segment-bm25-v1",
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
          algorithm_version: "segment-bm25-v1",
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

  it("ranks a rare materialized word above a word shared by the loaded bodies", async () => {
    const sourceFor = (id, hash) => ({
      event: {
        event_id: id,
        org_id: "example-org",
        source: "synthetic",
        external_id: id,
        operation: "create",
        occurred_at: "2026-09-01T00:00:00.000Z",
        ingested_at: "2026-09-01T00:01:00.000Z",
        content_hash: hash,
      },
      thread_id: "thread-1",
      required_scope_ids: ["scope-visible"],
    });
    const events = [
      sourceFor("event-common-a", "a".repeat(64)),
      sourceFor("event-common-b", "b".repeat(64)),
      sourceFor("event-rare", "d".repeat(64)),
    ];
    const text = {
      "event-common-a": "团队 会议",
      "event-common-b": "团队 周报",
      "event-rare": "火箭 发射",
    };
    const result = await new IndexedEventRetriever({
      async matchAuthorized(input) {
        return {
          available: true,
          algorithm_version: "segment-bm25-v1",
          generation: "continuous-v1",
          watermark: "authority:1",
          covered: structuredClone(input.authorized),
          matched: structuredClone(input.authorized),
        };
      },
    }).retrieve({
      request: { ...request(), query: "火箭 团队" },
      read_epoch: "authority:1",
      recorded_at: "2026-09-02T00:00:00.000Z",
      principal_policy_hash: POLICY_HASH,
      events,
    }, async (ids) => ids.map((id) => ({
      ...events.find((value) => value.event.event_id === id),
      text: text[id],
    })));

    const lexical = (id) => result.candidates.find((value) => value.candidate.resource_id === id).candidate.scores.lexical;
    assert.ok(lexical("event-rare") > lexical("event-common-a"));
  });

  it("loads index hits for a desktop search instead of every authorized event", async () => {
    const loaded = [];
    const otherHash = "d".repeat(64);
    const visible = event("event-visible", "message-visible", HASH_A, "scope-visible");
    const other = event("event-other", "message-other", otherHash, "scope-visible");
    const sources = [visible, other].map((source) => ({ ...source, status: "current" }));
    const retriever = new IndexedEventRetriever({
      async matchAuthorized(input) {
        return {
          available: true,
          algorithm_version: "segment-bm25-v1",
          generation: "continuous-v1",
          watermark: "authority:1",
          covered: [],
          coverage: {
            authorization_hash: input.authorization_hash,
            authorized_count: input.authorized.length,
            covered_count: input.authorized.length,
            complete: true,
            uncovered: [],
          },
          matched: [{ event_id: "event-visible", content_hash: HASH_A }],
        };
      },
    });

    const result = await retriever.retrieve({
      request: { ...request(), search_kind: "all" },
      read_epoch: "authority:1",
      recorded_at: "2026-09-02T00:00:00.000Z",
      principal_policy_hash: POLICY_HASH,
      events: sources,
    }, async (ids) => {
      loaded.push(...ids);
      return ids.map((id) => {
        const source = sources.find((value) => value.event.event_id === id);
        const text = id === "event-visible" ? "发布批准计划" : "无关内容";
        return { ...source, text, search_body: text };
      });
    });

    assert.deepEqual(loaded, ["event-visible"]);
    assert.deepEqual(result.candidates.map((value) => value.candidate.resource_id), ["event-visible"]);
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
