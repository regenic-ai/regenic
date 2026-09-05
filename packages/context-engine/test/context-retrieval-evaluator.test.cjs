const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  evaluateContextRetrieval,
} = require("../dist");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function request(id) {
  return {
    schema_version: "1.0",
    id,
    org_id: "example-org",
    principal: { actor_type: "human", actor_id: "person-1" },
    consumer_id: "evaluation",
    purpose: "evaluate synthetic retrieval",
    allowed_uses: ["display"],
    temporal: { mode: "current" },
    budget: { profile: "eval-v1", max_tokens: 100, max_items: 10, max_raw_evidence: 10 },
    requested_kinds: ["event"],
  };
}

function evidence(eventId, hash) {
  return {
    event_id: eventId,
    source: "synthetic",
    external_id: eventId,
    operation: "create",
    occurred_at: "2026-09-01T00:00:00.000Z",
    content_hash: hash,
  };
}

function assembly(items, citations) {
  return {
    snapshot: { content_hash: "c".repeat(64) },
    bundle: {
      content_hash: "d".repeat(64),
      sections: [{
        kind: "evidence",
        tokens: items.length,
        items: items.map(({ id, hash }) => ({
          candidate_id: `event:${id}`,
          resource_id: id,
          kind: "event",
          text: id,
          content_hash: hash,
          evidence: [evidence(id, hash)],
          estimated_tokens: 1,
        })),
      }],
      citations: citations.map(({ id, hash }) => evidence(id, hash)),
    },
  };
}

function dataset() {
  return {
    schema_version: "1.0",
    id: "synthetic-lexical-v1",
    cases: [
      {
        id: "rank-and-safety",
        request: request("request-1"),
        relevant_event_ids: ["event-a", "event-c"],
        forbidden_event_ids: ["event-b"],
        stale_event_ids: ["event-b"],
      },
      {
        id: "empty-ground-truth",
        request: request("request-2"),
        relevant_event_ids: [],
      },
    ],
  };
}

describe("Context retrieval evaluator", () => {
  it("computes deterministic quality and safety metrics without timing data", async () => {
    const engine = {
      async assemble(value) {
        return value.id === "request-1"
          ? assembly([
            { id: "event-a", hash: HASH_A },
            { id: "event-b", hash: HASH_B },
          ], [{ id: "event-a", hash: HASH_A }])
          : assembly([], []);
      },
      async replay() { throw new Error("not used"); },
    };

    const first = await evaluateContextRetrieval(engine, dataset(), { k: 2 });
    const second = await evaluateContextRetrieval(engine, dataset(), { k: 2 });

    assert.deepEqual(first, second);
    assert.equal(first.cases[0].recall_at_k, 0.5);
    assert.equal(first.cases[0].reciprocal_rank_at_k, 1);
    assert.equal(first.cases[0].citation_coverage, 0.5);
    assert.equal(first.metrics.mean_recall_at_k, 0.5);
    assert.equal(first.metrics.positive_case_count, 1);
    assert.equal(first.metrics.negative_case_count, 1);
    assert.equal(first.metrics.negative_selection_rate, 0);
    assert.equal(first.metrics.unauthorized_selections, 1);
    assert.equal(first.metrics.stale_selections, 1);
    assert.equal(first.metrics.citation_coverage, 0.5);
    assert.equal(first.metrics.safety_passed, false);
    assert.match(first.content_hash, /^[a-f0-9]{64}$/);
    assert.ok(!Object.hasOwn(first, "duration"));
  });

  it("passes the safety gate only with complete citations and no forbidden or stale selections", async () => {
    const engine = {
      async assemble() {
        return assembly([{ id: "event-a", hash: HASH_A }], [{ id: "event-a", hash: HASH_A }]);
      },
      async replay() { throw new Error("not used"); },
    };
    const value = dataset();
    value.cases = [{
      id: "safe",
      request: request("request-safe"),
      relevant_event_ids: ["event-a"],
      forbidden_event_ids: ["event-hidden"],
      stale_event_ids: ["event-old"],
    }];

    const report = await evaluateContextRetrieval(engine, value);

    assert.deepEqual(report.metrics, {
      mean_recall_at_k: 1,
      mean_reciprocal_rank_at_k: 1,
      mean_ndcg_at_k: 1,
      citation_coverage: 1,
      positive_case_count: 1,
      negative_case_count: 0,
      negative_selection_rate: 0,
      unauthorized_selections: 0,
      stale_selections: 0,
      safety_passed: true,
    });
  });

  it("rejects ambiguous or duplicate ground truth", async () => {
    const value = dataset();
    value.cases[0].forbidden_event_ids = ["event-a"];
    const engine = { async assemble() { throw new Error("must not run"); } };

    await assert.rejects(evaluateContextRetrieval(engine, value), /Invalid Context evaluation case/);
  });
});
