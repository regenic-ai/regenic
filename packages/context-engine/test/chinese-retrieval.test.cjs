const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { MemoryContextArtifactStore, MemoryContextRetrieverRegistry } = require("@regenic/domain");
const { SqliteContextLexicalIndex } = require("@regenic/lexical-index");
const {
  DeterministicContextEngine,
  DeterministicEventRetriever,
  IndexedEventRetriever,
  evaluateContextRetrieval,
} = require("../dist");
const { chineseRetrievalFixture } = require("./fixtures/chinese-retrieval.cjs");

function engine(fixture, retriever) {
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(retriever);
  return new DeterministicContextEngine({
    source: fixture.source,
    policy: fixture.policy,
    artifacts: new MemoryContextArtifactStore(),
    retrievers,
  });
}

describe("Chinese retrieval development baseline", () => {
  it("keeps FTS5, unbuilt/partial fallback and literal scoring selections identical", async (t) => {
    const fixture = chineseRetrievalFixture();
    const root = await mkdtemp(join(tmpdir(), "regenic-chinese-retrieval-"));
    const index = new SqliteContextLexicalIndex(join(root, "context.lexical.db"));
    const unavailable = new SqliteContextLexicalIndex(join(root, "unavailable.lexical.db"), { force_unavailable: true });
    t.after(async () => {
      index.close();
      unavailable.close();
      await rm(root, { recursive: true, force: true });
    });
    const baseline = await evaluateContextRetrieval(engine(fixture, new DeterministicEventRetriever()), fixture.dataset);
    const indexed = engine(fixture, new IndexedEventRetriever(index));
    const absent = await evaluateContextRetrieval(engine(fixture, new IndexedEventRetriever(unavailable)), fixture.dataset);
    assert.deepEqual(absent.metrics, baseline.metrics);
    assert.deepEqual(absent.cases.map((value) => value.selected_event_ids), baseline.cases.map((value) => value.selected_event_ids));
    const unbuilt = await evaluateContextRetrieval(indexed, fixture.dataset);
    assert.deepEqual(unbuilt.metrics, baseline.metrics);
    assert.deepEqual(unbuilt.cases.map((value) => value.selected_event_ids), baseline.cases.map((value) => value.selected_event_ids));
    const replacement = {
      org_id: "example-org",
      generation: "chinese-development-v1",
      watermark: "authority:chinese-development-v1",
      documents: fixture.events.filter((value) => value.text).map((value) => ({
        event_id: value.event.event_id,
        content_hash: value.event.content_hash,
        text: value.text,
      })),
    };
    await index.replaceOrganization({ ...replacement, documents: replacement.documents.slice(0, 2) });
    const partial = await evaluateContextRetrieval(indexed, fixture.dataset);
    assert.deepEqual(partial.metrics, baseline.metrics);
    assert.deepEqual(partial.cases.map((value) => value.selected_event_ids), baseline.cases.map((value) => value.selected_event_ids));
    await index.replaceOrganization(replacement);
    const covered = await evaluateContextRetrieval(indexed, fixture.dataset);
    assert.deepEqual(covered, baseline);
    assert.deepEqual(await evaluateContextRetrieval(indexed, fixture.dataset), covered);
    assert.deepEqual(covered.metrics, {
      mean_recall_at_k: 0.833333333333,
      mean_reciprocal_rank_at_k: 0.833333333333,
      mean_ndcg_at_k: 0.833333333333,
      citation_coverage: 1,
      positive_case_count: 12,
      negative_case_count: 4,
      negative_selection_rate: 0,
      unauthorized_selections: 0,
      stale_selections: 0,
      safety_passed: true,
    });
    for (const id of ["cross-language-gap", "synonym-gap"]) {
      assert.deepEqual(covered.cases.find((value) => value.case_id === id).selected_event_ids, []);
    }
    for (const [id, expected] of [["identifier", "incident"], ["full-width", "token"], ["thread-filter", "freeze"]]) {
      assert.equal(covered.cases.find((value) => value.case_id === id).selected_event_ids[0], expected);
    }
    t.diagnostic(JSON.stringify({ dataset_id: covered.dataset_id, k: covered.k, metrics: covered.metrics }));
  });
});
