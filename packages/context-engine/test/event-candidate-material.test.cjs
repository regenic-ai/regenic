const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");
const {
  MemoryContextArtifactStore,
  MemoryContextRetrieverRegistry,
} = require("@regenic/domain");
const {
  DeterministicContextEngine,
  eligibleEventSources,
  eventCandidateFor,
  eventCandidateMaterialFor,
} = require("../dist");

const text = "部署异常时先撤回版本，再恢复上一版服务。";
const source = {
  event: {
    event_id: "event-rollback",
    org_id: "example-org",
    source: "synthetic",
    external_id: "rollback",
    operation: "create",
    occurred_at: "2026-10-14T00:00:00.000Z",
    ingested_at: "2026-10-14T00:01:00.000Z",
    content_hash: createHash("sha256").update(text).digest("hex"),
  },
  thread_id: "thread-1",
  required_scope_ids: ["scope-visible"],
  status: "current",
  text,
};

function request(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "material-test",
    org_id: "example-org",
    principal: { actor_type: "human", actor_id: "person-1" },
    consumer_id: "test",
    purpose: "test semantic candidate material",
    allowed_uses: ["display"],
    query: "rollback",
    temporal: { mode: "current" },
    budget: { profile: "test-v1", max_tokens: 1000, max_items: 5, max_raw_evidence: 5 },
    requested_kinds: ["event"],
    ...overrides,
  };
}

function semanticEngine(mutate = () => {}) {
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register({
    id: "semantic-test-double",
    capabilities: () => ({
      candidate_kinds: ["event"],
      lexical: false,
      vector: true,
      graph: false,
      rerank: false,
      multilingual: true,
    }),
    async retrieve(plan) {
      return eligibleEventSources(plan).map((event) => {
        const material = eventCandidateMaterialFor(event, plan.request, plan.recorded_at);
        material.candidate.scores = { semantic: 1 };
        mutate(material);
        return material;
      });
    },
  });
  return new DeterministicContextEngine({
    source: {
      async openRead() {
        return {
          read_epoch: "authority:1",
          recorded_at: "2026-10-15T00:00:00.000Z",
          lifecycle_complete: true,
          lifecycle_heads: [{
            source: source.event.source,
            external_id: source.event.external_id,
            head_event_id: source.event.event_id,
          }],
          events: [structuredClone(source)],
        };
      },
    },
    policy: {
      async policyHash() { return "a".repeat(64); },
      async visible({ resource }) {
        return resource.required_scope_ids.every((scope) => scope === "scope-visible");
      },
      async protectedEventIds() { return []; },
      async canReplay() { return true; },
    },
    artifacts: new MemoryContextArtifactStore(),
    retrievers,
    retrieval_profile: { version: "semantic-test-v1", score_weights: { semantic: 1 } },
  });
}

describe("Event candidate material", () => {
  it("separates lexical admission from full evidence construction", () => {
    const original = structuredClone(source);
    assert.equal(eventCandidateFor(source, request(), "2026-10-15T00:00:00.000Z"), null);
    const material = eventCandidateMaterialFor(source, request(), "2026-10-15T00:00:00.000Z");
    assert.equal(material.candidate.scores.lexical, 0);
    assert.equal(material.candidate.candidate_id, "event:event-rollback");
    assert.equal(material.item.resource_id, source.event.event_id);
    assert.equal(material.item.text, text);
    assert.equal(material.item.content_hash, source.event.content_hash);
    assert.deepEqual(material.candidate.required_scope_ids, source.required_scope_ids);
    assert.deepEqual(material.item.evidence, material.candidate.evidence);
    assert.equal(material.item.evidence[0].content_hash, source.event.content_hash);
    assert.deepEqual(source, original);
  });

  it("preserves lexical and no-query candidates and requires an evidence hash", () => {
    for (const query of [undefined, "部署异常"]) {
      const value = request({ query });
      assert.deepEqual(
        eventCandidateFor(source, value, "2026-10-15T00:00:00.000Z"),
        eventCandidateMaterialFor(source, value, "2026-10-15T00:00:00.000Z"),
      );
    }
    const unhashed = structuredClone(source);
    delete unhashed.event.content_hash;
    assert.equal(eventCandidateMaterialFor(unhashed, request(), "2026-10-15T00:00:00.000Z"), null);
  });

  it("assembles a zero-lexical semantic hit without weakening binding or budget", async () => {
    const result = await semanticEngine().assemble(request());
    assert.equal(result.bundle.sections[0].items[0].text, text);
    assert.equal(result.bundle.citations[0].event_id, source.event.event_id);
    const limited = await semanticEngine().assemble(request({
      budget: { profile: "tiny-v1", max_tokens: 1, max_items: 1, max_raw_evidence: 1 },
    }));
    assert.deepEqual(limited.bundle.sections.flatMap((section) => section.items), []);
    const filtered = await semanticEngine().assemble(request({ filters: { thread_ids: ["other-thread"] } }));
    assert.deepEqual(filtered.bundle.sections, []);
  });

  it("still rejects snippets and forged hashes as Event evidence", async () => {
    for (const mutate of [
      (material) => { material.item.text = "部署异常"; },
      (material) => { material.item.content_hash = "b".repeat(64); },
      (material) => { material.candidate.evidence[0].event_id = "event-hidden"; },
    ]) {
      await assert.rejects(semanticEngine(mutate).assemble(request()), (error) => error.code === "invalid_candidate");
    }
  });
});
