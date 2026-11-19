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
    assert.equal(report.metrics.stale_selections, 4);
    assert.equal(report.metrics.safety_passed, false);
    assert.equal(report.metrics.mean_recall_at_k, 0.195588235294);
    assert.equal(report.metrics.mean_ndcg_at_k, 0.151564030967);
    assert.equal(report.metrics.mean_reciprocal_rank_at_k, 0.236093604108);
    assert.deepEqual(report.metrics.by_task, {
      lookup: {
        positive_case_count: 12,
        mean_recall_at_k: 0.229166666667,
        mean_reciprocal_rank_at_k: 0.229861111111,
        mean_ndcg_at_k: 0.161352340582,
      },
      anaphora: {
        positive_case_count: 12,
        mean_recall_at_k: 0.0625,
        mean_reciprocal_rank_at_k: 0.030092592593,
        mean_ndcg_at_k: 0.031798685611,
      },
      aggregate: {
        positive_case_count: 12,
        mean_recall_at_k: 0.251388888889,
        mean_reciprocal_rank_at_k: 0.364814814815,
        mean_ndcg_at_k: 0.22248076303,
      },
      temporal: {
        positive_case_count: 12,
        mean_recall_at_k: 0.120833333333,
        mean_reciprocal_rank_at_k: 0.080654761905,
        mean_ndcg_at_k: 0.067561671109,
      },
      update: {
        positive_case_count: 12,
        mean_recall_at_k: 0.222222222222,
        mean_reciprocal_rank_at_k: 0.43005952381,
        mean_ndcg_at_k: 0.198137542287,
      },
      boundary: {
        positive_case_count: 8,
        mean_recall_at_k: 0.333333333333,
        mean_reciprocal_rank_at_k: 0.303571428571,
        mean_ndcg_at_k: 0.266297759296,
      },
    });
  });
});
