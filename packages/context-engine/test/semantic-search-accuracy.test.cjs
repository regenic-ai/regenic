const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryContextArtifactStore, MemoryContextRetrieverRegistry } = require("@regenic/domain");
const {
  DeterministicContextEngine,
  DeterministicEventRetriever,
  evaluateContextRetrieval,
} = require("../dist");
const { semanticSearchAccuracyFixture } = require("./fixtures/semantic-search-accuracy.cjs");

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

describe("Semantic search accuracy baseline", () => {
  it("scores the synthetic label set at k=10 by lookup, anaphora, and aggregate", async (t) => {
    const fixture = semanticSearchAccuracyFixture();
    assert.equal(fixture.labels.cases.length, 36);
    for (const task of ["lookup", "anaphora", "aggregate"]) {
      assert.equal(fixture.labels.cases.filter((value) => value.task === task).length, 12);
    }
    assert.equal(fixture.labels.cases.filter((value) => value.filters?.occurred_after).length, 2);
    const report = await evaluateContextRetrieval(engine(fixture), fixture.dataset, { k: 10 });
    t.diagnostic(JSON.stringify({
      recall: report.metrics.mean_recall_at_k,
      ndcg: report.metrics.mean_ndcg_at_k,
      mrr: report.metrics.mean_reciprocal_rank_at_k,
      by_task: report.metrics.by_task,
      safety: report.metrics.safety_passed,
    }));
    assert.equal(report.k, 10);
    assert.equal(report.dataset_id, "semantic-search-accuracy-v1");
    assert.equal(report.metrics.positive_case_count, 36);
    assert.equal(report.metrics.negative_case_count, 0);
    assert.equal(report.metrics.safety_passed, true);
    assert.equal(report.metrics.unauthorized_selections, 0);
    assert.equal(report.metrics.stale_selections, 0);
    assert.equal(report.metrics.mean_recall_at_k, 0.875);
    assert.equal(report.metrics.mean_ndcg_at_k, 0.849744705556);
    assert.equal(report.metrics.mean_reciprocal_rank_at_k, 0.87037037037);
    assert.deepEqual(report.metrics.by_task, {
      lookup: {
        positive_case_count: 12,
        mean_recall_at_k: 1,
        mean_reciprocal_rank_at_k: 1,
        mean_ndcg_at_k: 0.993310065762,
      },
      anaphora: {
        positive_case_count: 12,
        mean_recall_at_k: 0.708333333333,
        mean_reciprocal_rank_at_k: 0.652777777778,
        mean_ndcg_at_k: 0.645339745528,
      },
      aggregate: {
        positive_case_count: 12,
        mean_recall_at_k: 0.916666666667,
        mean_reciprocal_rank_at_k: 0.958333333333,
        mean_ndcg_at_k: 0.910584305378,
      },
    });
  });
});
