const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryContextArtifactStore, MemoryContextRetrieverRegistry } = require("@regenic/domain");
const {
  DeterministicContextEngine,
  DeterministicEventRetriever,
  evaluateContextRetrieval,
} = require("../dist");
const { semanticSearchMemoryFixture } = require("./fixtures/semantic-search-memory.cjs");

function engine(fixture) {
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(new DeterministicEventRetriever());
  return new DeterministicContextEngine({
    source: fixture.source,
    policy: fixture.policy,
    artifacts: new MemoryContextArtifactStore(),
    retrievers,
  });
}

describe("Semantic search memory baseline", () => {
  it("scores the LongMemEval subset at k=10", async (t) => {
    const fixture = semanticSearchMemoryFixture();
    const counts = Object.fromEntries(["lookup", "anaphora", "aggregate", "temporal", "update"].map((task) => [
      task,
      fixture.labels.cases.filter((value) => value.task === task && value.relevant_event_ids.length > 0).length,
    ]));
    assert.deepEqual(counts, { lookup: 12, anaphora: 12, aggregate: 12, temporal: 12, update: 8 });
    assert.equal(fixture.labels.cases.filter((value) => value.relevant_event_ids.length === 0).length, 6);
    const report = await evaluateContextRetrieval(engine(fixture), fixture.dataset, { k: 10 });
    t.diagnostic(JSON.stringify({
      recall: report.metrics.mean_recall_at_k,
      ndcg: report.metrics.mean_ndcg_at_k,
      mrr: report.metrics.mean_reciprocal_rank_at_k,
      positive: report.metrics.positive_case_count,
      negative: report.metrics.negative_case_count,
      negative_selection_rate: report.metrics.negative_selection_rate,
      safety: report.metrics.safety_passed,
      by_task: report.metrics.by_task,
    }));
    assert.equal(report.dataset_id, "semantic-search-memory-v1");
    assert.equal(report.k, 10);
    assert.equal(report.metrics.positive_case_count, 56);
    assert.equal(report.metrics.negative_case_count, 6);
    assert.equal(report.metrics.unauthorized_selections, 0);
    assert.equal(report.metrics.stale_selections, 0);
    assert.equal(report.metrics.citation_coverage, 1);
    assert.equal(report.metrics.negative_selection_rate, 1);
    assert.equal(report.metrics.safety_passed, false);
    assert.equal(report.metrics.mean_recall_at_k, 0.482142857143);
    assert.equal(report.metrics.mean_ndcg_at_k, 0.355574589933);
    assert.equal(report.metrics.mean_reciprocal_rank_at_k, 0.349007936508);
    assert.deepEqual(report.metrics.by_task, {
      lookup: {
        positive_case_count: 12,
        mean_recall_at_k: 0.666666666667,
        mean_reciprocal_rank_at_k: 0.371527777778,
        mean_ndcg_at_k: 0.444931990923,
      },
      anaphora: {
        positive_case_count: 12,
        mean_recall_at_k: 0.333333333333,
        mean_reciprocal_rank_at_k: 0.236111111111,
        mean_ndcg_at_k: 0.260910812798,
      },
      aggregate: {
        positive_case_count: 12,
        mean_recall_at_k: 0.375,
        mean_reciprocal_rank_at_k: 0.27662037037,
        mean_ndcg_at_k: 0.251564984079,
      },
      temporal: {
        positive_case_count: 12,
        mean_recall_at_k: 0.375,
        mean_reciprocal_rank_at_k: 0.402777777778,
        mean_ndcg_at_k: 0.325294472693,
      },
      update: {
        positive_case_count: 8,
        mean_recall_at_k: 0.75,
        mean_reciprocal_rank_at_k: 0.5125,
        mean_ndcg_at_k: 0.564968738792,
      },
    });
  });
});
