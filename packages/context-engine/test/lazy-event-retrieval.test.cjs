const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemoryContextArtifactStore, MemoryContextRetrieverRegistry, embeddingGeneration,
} = require("@regenic/domain");
const {
  DeterministicContextEngine, DeterministicEventRetriever, IndexedEventRetriever, HybridEventRetriever,
} = require("../dist");

const hash = "a".repeat(64);
const request = {
  schema_version: "1.0", id: "lazy-test", org_id: "org",
  principal: { actor_type: "human", actor_id: "owner" },
  consumer_id: "test", purpose: "authorized retrieval", allowed_uses: ["display"],
  query: "needle", temporal: { mode: "current" }, requested_kinds: ["event"],
  budget: { profile: "test", max_tokens: 100, max_items: 5, max_raw_evidence: 5 },
};
const model = {
  model_id: "synthetic/test", model_revision: "b".repeat(40), tokenizer_revision: "b".repeat(40),
  dimensions: 2, max_input_tokens: 128, query_template: "query: ", document_template: "doc: ",
  normalization: "l2", similarity: "cosine", numeric_format: "float32",
};
const generation = embeddingGeneration(model, 32);

function sourceEvent(id, extra = {}) {
  return {
    event: {
      event_id: id, org_id: "org", source: "synthetic", external_id: id,
      operation: "create", occurred_at: "2026-10-16T00:00:00.000Z",
      ingested_at: "2026-10-16T00:00:00.000Z", content_hash: hash,
    },
    required_scope_ids: ["visible"], thread_id: "target", actor_id: "owner", ...extra,
  };
}

function fixture(events, options = {}) {
  const materializedIds = [];
  const policy = {
    metadata_only: options.metadataOnly !== false,
    async policyHash() { return "c".repeat(64); },
    async visible({ resource }) { return resource.required_scope_ids.every((scope) => scope === "visible"); },
    async protectedEventIds() { return []; },
    async canReplay() { return true; },
  };
  const index = {
    async matchAuthorized(input) {
      if (options.index) return options.index(input);
      return {
        available: true, algorithm_version: "literal-unicode-v1",
        generation: "continuous-v1", watermark: "authority:1",
        covered: input.authorized.filter((key) => key.event_id !== "uncovered"),
        matched: input.authorized.filter((key) => key.event_id === "hit"),
      };
    },
  };
  const registry = new MemoryContextRetrieverRegistry();
  registry.register(options.retriever ?? new IndexedEventRetriever(index));
  return {
    materializedIds, registry, index,
    engine: new DeterministicContextEngine({
      source: {
        async openRead() {
          return {
            read_epoch: "authority:1", recorded_at: "2026-10-17T00:00:00.000Z",
            lifecycle_complete: true,
            lifecycle_heads: events.map((source) => ({
              source: source.event.source, external_id: source.event.external_id,
              head_event_id: source.event.event_id,
            })),
            events,
          };
        },
        async materialize(values) {
          materializedIds.push(...values.map((source) => source.event.event_id));
          if (options.materialize) return options.materialize(values);
          return values.map((source) => ({
            ...source, text: source.event.event_id === "semantic" ? "deployment recovery" : "needle body",
          }));
        },
      },
      policy, artifacts: new MemoryContextArtifactStore(), retrievers: registry,
    }),
  };
}

describe("lazy authorized Event materialization", () => {
  it("does not read covered nonmatches or unauthorized bodies even above 10000 events", async () => {
    const events = Array.from({ length: 10001 }, (_, id) => sourceEvent(`miss-${id}`));
    events.push(sourceEvent("hit"), sourceEvent("hidden", { required_scope_ids: ["hidden"] }));
    const f = fixture(events, {
      materialize(values) {
        assert.deepEqual(values.map((source) => source.event.event_id), ["hit"]);
        return values.map((source) => ({ ...source, text: "needle body" }));
      },
    });
    const result = await f.engine.assemble(request);
    assert.deepEqual(f.materializedIds, ["hit"]);
    assert.equal(result.snapshot.selected[0].resource_id, "hit");
  });

  it("locally verifies uncovered keys but skips covered nonmatches", async () => {
    const f = fixture([sourceEvent("miss"), sourceEvent("uncovered"), sourceEvent("hit")]);
    const result = await f.engine.assemble(request);
    assert.deepEqual(f.materializedIds.sort(), ["hit", "uncovered"]);
    assert.equal(result.snapshot.selected.length, 2);
    assert.ok(result.bundle.degradation_flags.includes("lexical_index_partial"));
  });

  it("applies deterministic scope, anchor, and age filters before reading text", async () => {
    const old = sourceEvent("old");
    old.event.occurred_at = "2026-10-14T00:00:00.000Z";
    const f = fixture([
      sourceEvent("hit"),
      sourceEvent("wrong-thread", { thread_id: "other" }),
      sourceEvent("wrong-actor", { actor_id: "other" }),
      old,
    ], { retriever: new DeterministicEventRetriever() });
    await f.engine.assemble({
      ...request, filters: { thread_ids: ["target"], actor_ids: ["owner"] },
      anchors: [{ kind: "event", id: "hit" }], budget: { ...request.budget, max_age_days: 2 },
    });
    assert.deepEqual(f.materializedIds, ["hit"]);
    f.materializedIds.length = 0;
    await f.engine.assemble({ ...request, budget: { ...request.budget, max_age_days: 1 } });
    assert.deepEqual(f.materializedIds.sort(), ["hit", "wrong-actor", "wrong-thread"]);
  });

  it("keeps legacy text-dependent policies and retrievers on the eager compatibility path", async () => {
    const f = fixture([sourceEvent("hit"), sourceEvent("miss")], { metadataOnly: false });
    await f.engine.assemble(request);
    assert.deepEqual(f.materializedIds.sort(), ["hit", "miss"]);
    const legacy = fixture([sourceEvent("hit"), sourceEvent("miss")], {
      retriever: {
        id: "legacy", capabilities() {
          const { lazy_materialization, ...legacy } = new DeterministicEventRetriever().capabilities();
          return legacy;
        },
        async retrieve(plan) {
          assert.ok(plan.events.every((source) => typeof source.text === "string"));
          return new DeterministicEventRetriever().retrieve(plan);
        },
      },
    });
    await legacy.engine.assemble(request);
    assert.deepEqual(legacy.materializedIds.sort(), ["hit", "miss"]);
  });

  it("coalesces overlapping parallel materialization without sharing mutable returned material", async () => {
    const f = fixture([sourceEvent("hit")]);
    f.registry.register(new DeterministicEventRetriever());
    f.registry.register({
      id: "mutating-reader", capabilities: () => new DeterministicEventRetriever().capabilities(),
      async retrieve(_plan, materialize) {
        const events = await materialize(["hit"]);
        events[0].text = "forged";
        return [];
      },
    });
    await f.engine.assemble(request);
    assert.deepEqual(f.materializedIds, ["hit"]);
  });

  it("rejects unauthorized index and materializer requests before touching their bodies", async () => {
    const f = fixture([sourceEvent("hit")], {
      index: async () => ({
        available: true, algorithm_version: "literal-unicode-v1", generation: "v1",
        covered: [{ event_id: "hidden", content_hash: hash }], matched: [],
      }),
    });
    await assert.rejects(f.engine.assemble(request), /unauthorized or duplicate/);
    assert.deepEqual(f.materializedIds, []);
    const attacker = fixture([sourceEvent("hit")], {
      retriever: {
        id: "attacker", capabilities: () => new DeterministicEventRetriever().capabilities(),
        async retrieve(_plan, materialize) { await materialize(["hidden"]); return []; },
      },
    });
    await assert.rejects(attacker.engine.assemble(request), /unauthorized Event material/);
    assert.deepEqual(attacker.materializedIds, []);
  });

  it("fails closed on missing requested text or altered metadata", async () => {
    const missing = fixture([sourceEvent("hit")], {
      materialize() { throw new Error("missing Blob"); },
    });
    await assert.rejects(missing.engine.assemble(request), /missing Blob/);
    const altered = fixture([sourceEvent("hit")], {
      materialize(values) { return values.map((source) => ({ ...source, actor_id: "forged", text: "needle" })); },
    });
    await assert.rejects(altered.engine.assemble(request), /changed authorized Event metadata/);
  });

  it("loads lexical and semantic hits without reading other vector-covered bodies", async () => {
    const f = fixture([sourceEvent("hit"), sourceEvent("semantic"), sourceEvent("miss")]);
    f.registry.register(new HybridEventRetriever(new IndexedEventRetriever(f.index), {
      descriptor: model, async countTokens() { return [1]; }, async embed() { return [[1, 0]]; },
    }, {
      async matchAuthorized(input) {
        return {
          generation: generation.id, covered: input.authorized,
          matched: [{ event_id: "semantic", content_hash: hash, score: 1, chunk_ordinal: 0, start: 0, end: 10 }],
        };
      },
    }, generation));
    const result = await f.engine.assemble(request);
    assert.deepEqual(f.materializedIds.sort(), ["hit", "semantic"]);
    assert.deepEqual(result.snapshot.selected.map((value) => value.resource_id).sort(), ["hit", "semantic"]);
  });
});
