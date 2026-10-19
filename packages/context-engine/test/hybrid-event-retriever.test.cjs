const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { it } = require("node:test");
const {
  embeddingGeneration, EmbeddingError, ContextVectorUnavailableError,
  MemoryContextArtifactStore, MemoryContextRetrieverRegistry, validateContextSnapshot,
} = require("@regenic/domain");
const {
  HybridEventRetriever, DeterministicEventRetriever, DeterministicContextEngine, HYBRID_RETRIEVAL_PROFILE,
} = require("../dist");

const descriptor = {
  model_id: "synthetic/test", model_revision: "a".repeat(40), tokenizer_revision: "a".repeat(40),
  dimensions: 2, max_input_tokens: 128, query_template: "query: ", document_template: "doc: ",
  normalization: "l2", similarity: "cosine", numeric_format: "float32",
};
const generation = embeddingGeneration(descriptor, 32);
const request = {
  schema_version: "1.0", id: "hybrid-test", org_id: "org",
  principal: { actor_type: "human", actor_id: "owner" }, consumer_id: "test",
  purpose: "retrieve authorized text", allowed_uses: ["display"], query: "rollback",
  temporal: { mode: "current" }, requested_kinds: ["event"],
  budget: { profile: "test-v1", max_tokens: 1000, max_items: 10, max_raw_evidence: 10 },
};
function event(id, text) {
  return {
    event: {
      event_id: id, org_id: "org", source: "synthetic", external_id: id, operation: "create",
      occurred_at: "2026-10-16T00:00:00.000Z", ingested_at: "2026-10-16T00:00:00.000Z",
      content_hash: createHash("sha256").update(text).digest("hex"),
    }, text, thread_id: "thread", required_scope_ids: ["visible"], status: "current",
  };
}
const events = [event("semantic", "部署失败时恢复上一版本。"), event("literal", "rollback RG-2048")];
function fixture(options = {}) {
  let calls = 0;
  let epoch = "authority:1";
  const provider = {
    descriptor, async countTokens() { return [12]; }, async health() { return { status: "ok" }; },
    async embed() { calls++; if (options.changeEpoch) epoch = "authority:2";
      if (options.error) throw options.error; return [[1, 0]]; },
  };
  const index = {
    async matchAuthorized(input) {
      assert.deepEqual(input.authorized.map((key) => key.event_id).sort(), ["literal", "semantic"]);
      if (options.indexError) throw options.indexError;
      const result = {
        generation: generation.id,
        covered: events.map((source) => ({ event_id: source.event.event_id, content_hash: source.event.content_hash })),
        matched: [{ event_id: "semantic", content_hash: events[0].event.content_hash, score: 0.9,
          chunk_ordinal: 0, start: 0, end: events[0].text.length, ...options.hit }],
      };
      if (options.partial) result.covered = result.covered.slice(0, 1);
      if (options.duplicate) result.matched.push({ ...result.matched[0] });
      return result;
    },
  };
  const retriever = new HybridEventRetriever(new DeterministicEventRetriever(), provider,
    options.absent ? undefined : index, generation);
  const registry = new MemoryContextRetrieverRegistry();
  registry.register(retriever);
  const engine = new DeterministicContextEngine({
    source: { async openRead() { return {
      read_epoch: epoch, recorded_at: "2026-10-17T00:00:00.000Z", lifecycle_complete: true,
      lifecycle_heads: events.map((source) => ({
        source: "synthetic", external_id: source.event.external_id, head_event_id: source.event.event_id,
      })), events,
    }; } },
    policy: {
      async policyHash() { return "b".repeat(64); }, async visible() { return true; },
      async protectedEventIds() { return []; }, async canReplay() { return true; },
    },
    artifacts: new MemoryContextArtifactStore(), retrievers: registry,
    retrieval_profile: HYBRID_RETRIEVAL_PROFILE,
  });
  const plan = { request, events, read_epoch: "authorized:1", recorded_at: "2026-10-17T00:00:00.000Z",
    principal_policy_hash: "b".repeat(64) };
  return { engine, retriever, plan, get calls() { return calls; } };
}

it("admits semantic zero-lexical evidence, deduplicates and pins replayable retrieval trace", async () => {
  const f = fixture();
  const result = await f.engine.assemble(request);
  assert.deepEqual(result.snapshot.selected.map((value) => value.resource_id).sort(), ["literal", "semantic"]);
  assert.equal(result.snapshot.retrieval_profile_version, HYBRID_RETRIEVAL_PROFILE.version);
  const [trace] = result.snapshot.retrieval_trace;
  assert.equal(trace.generation, generation.id);
  assert.equal(trace.model_revision, descriptor.model_revision);
  assert.equal(trace.covered_count, 2);
  assert.equal(trace.routes.find((route) => route.event_id === "semantic").lexical_rank, undefined);
  assert.equal(trace.routes.find((route) => route.event_id === "semantic").vector_rank, 1);
  assert.ok(validateContextSnapshot(result.snapshot).success);
  assert.deepEqual(await f.engine.assemble(request), result);
});

it("preserves lexical candidates and records explicit model/index degradation", async () => {
  for (const [options, flag] of [
    [{ error: new EmbeddingError("timeout", true) }, "embedding_timeout"],
    [{ error: new EmbeddingError("model_mismatch", false) }, "embedding_unavailable"],
    [{ absent: true }, "vector_index_absent"],
    [{ indexError: new ContextVectorUnavailableError("unbuilt") }, "vector_index_unbuilt"],
    [{ indexError: new ContextVectorUnavailableError("corrupt") }, "vector_index_corrupt"],
  ]) {
    const result = await fixture(options).engine.assemble(request);
    assert.deepEqual(result.snapshot.selected.map((value) => value.resource_id), ["literal"]);
    assert.ok(result.bundle.degradation_flags.includes(flag));
    assert.equal(result.snapshot.retrieval_trace[0].mode, "lexical");
    assert.equal(result.snapshot.retrieval_trace[0].generation, undefined);
  }
});

it("does not run query inference for browsing/history or non-Event requests", async () => {
  for (const override of [
    { query: undefined }, { temporal: { mode: "history" } }, { requested_kinds: ["artifact"] },
  ]) {
    const f = fixture();
    await f.retriever.retrieve({ ...f.plan, request: { ...request, ...override } });
    assert.equal(f.calls, 0);
  }
});

it("fails closed on foreign keys, hash mismatches, duplicate/out-of-bounds or invalid scores", async () => {
  for (const hit of [
    { event_id: "hidden" }, { content_hash: "f".repeat(64) }, { end: 10000 },
    { score: NaN }, { score: 1.1 }, { start: -1 }, { chunk_ordinal: -1 },
  ]) await assert.rejects(fixture({ hit }).engine.assemble(request));
  await assert.rejects(fixture({ duplicate: true }).engine.assemble(request));
});

it("preserves uncovered lexical hits and reports partial authorized coverage", async () => {
  const f = fixture({ partial: true });
  const result = await f.engine.assemble(request);
  assert.deepEqual(result.snapshot.selected.map((value) => value.resource_id).sort(), ["literal", "semantic"]);
  assert.ok(result.bundle.degradation_flags.includes("vector_index_partial"));
  assert.equal(result.snapshot.retrieval_trace[0].covered_count, 1);
});

it("rejects an authoritative change observed after model inference instead of storing stale evidence", async () => {
  await assert.rejects(fixture({ changeEpoch: true }).engine.assemble(request),
    (error) => error.code === "source_boundary");
});

it("does not disguise invalid/oversized query input as a successful lexical fallback", async () => {
  for (const code of ["input_too_large", "invalid_input"]) {
    await assert.rejects(fixture({ error: new EmbeddingError(code, false) }).engine.assemble(request),
      (error) => error.code === code);
  }
});
