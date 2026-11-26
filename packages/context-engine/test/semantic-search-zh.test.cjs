const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryContextArtifactStore, MemoryContextRetrieverRegistry } = require("@regenic/domain");
const {
  DeterministicContextEngine,
  DeterministicEventRetriever,
  evaluateContextRetrieval,
} = require("../dist");
const { semanticSearchZhFixture } = require("./fixtures/semantic-search-zh.cjs");

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

describe("Semantic search Chinese baseline", () => {
  it("scores the TimlMemBench subset at k=10", async (t) => {
    const fixture = semanticSearchZhFixture();
    const counts = Object.fromEntries(["lookup", "anaphora", "aggregate", "temporal", "update", "boundary"].map((task) => [
      task,
      fixture.labels.cases.filter((value) => value.task === task).length,
    ]));
    assert.deepEqual(counts, { lookup: 12, anaphora: 12, aggregate: 12, temporal: 12, update: 12, boundary: 8 });
    assert.equal(fixture.events.length > 1000, true);
    const report = await evaluateContextRetrieval(engine(fixture), fixture.dataset, { k: 10 });
    t.diagnostic(JSON.stringify({
      recall: report.metrics.mean_recall_at_k,
      ndcg: report.metrics.mean_ndcg_at_k,
      mrr: report.metrics.mean_reciprocal_rank_at_k,
      positive: report.metrics.positive_case_count,
      negative: report.metrics.negative_case_count,
      negative_selection_rate: report.metrics.negative_selection_rate,
      stale: report.metrics.stale_selections,
      safety: report.metrics.safety_passed,
      citation: report.metrics.citation_coverage,
      by_task: report.metrics.by_task,
    }));
    assert.equal(report.dataset_id, "semantic-search-zh-v1");
    assert.equal(report.k, 10);
    assert.equal(report.metrics.positive_case_count, 68);
    assert.equal(report.metrics.negative_case_count, 0);
    assert.equal(report.metrics.unauthorized_selections, 0);
    assert.equal(report.metrics.citation_coverage, 1);
    assert.equal(report.metrics.negative_selection_rate, 0);
    assert.equal(report.metrics.stale_selections, 8);
    assert.equal(report.metrics.safety_passed, false);
    assert.equal(report.metrics.mean_recall_at_k, 0.442156862745);
    assert.equal(report.metrics.mean_ndcg_at_k, 0.404008098321);
    assert.equal(report.metrics.mean_reciprocal_rank_at_k, 0.584716386555);
    assert.deepEqual(report.metrics.by_task, {
      lookup: {
        positive_case_count: 12,
        mean_recall_at_k: 0.506944444444,
        mean_reciprocal_rank_at_k: 0.44246031746,
        mean_ndcg_at_k: 0.374496554642,
      },
      anaphora: {
        positive_case_count: 12,
        mean_recall_at_k: 0.319444444444,
        mean_reciprocal_rank_at_k: 0.381944444444,
        mean_ndcg_at_k: 0.259579204491,
      },
      aggregate: {
        positive_case_count: 12,
        mean_recall_at_k: 0.426388888889,
        mean_reciprocal_rank_at_k: 0.595238095238,
        mean_ndcg_at_k: 0.42247477397,
      },
      temporal: {
        positive_case_count: 12,
        mean_recall_at_k: 0.447222222222,
        mean_reciprocal_rank_at_k: 0.75625,
        mean_ndcg_at_k: 0.463780864757,
      },
      update: {
        positive_case_count: 12,
        mean_recall_at_k: 0.4375,
        mean_reciprocal_rank_at_k: 0.676388888889,
        mean_ndcg_at_k: 0.411755165291,
      },
      boundary: {
        positive_case_count: 8,
        mean_recall_at_k: 0.552083333333,
        mean_reciprocal_rank_at_k: 0.691666666667,
        mean_ndcg_at_k: 0.535938991004,
      },
    });
  });
});
