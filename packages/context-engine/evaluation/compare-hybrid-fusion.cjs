// Manual EmbeddingGemma comparison. Not part of pnpm test.
// NODE_PATH=packages/local-cli/node_modules REGENIC_EMBEDDING_BASE_URL=http://127.0.0.1:8765 node evaluation/compare-hybrid-fusion.cjs both
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { MemoryContextArtifactStore, MemoryContextRetrieverRegistry, embeddingGeneration } = require("@regenic/domain");
const { LocalHttpEmbeddingProvider } = require("@regenic/embedding-provider");
const { SqliteContextVectorIndex } = require("@regenic/vector-index");
const {
  DeterministicContextEngine, DeterministicEventRetriever, ContextEmbeddingWorker,
  HybridEventRetriever, HYBRID_RETRIEVAL_PROFILE, HYBRID_RRF_PROFILE, evaluateContextRetrieval,
} = require("@regenic/context-engine");
const { semanticSearchMemoryFixture } = require("../../context-engine/test/fixtures/semantic-search-memory.cjs");
const { semanticSearchZhFixture } = require("../../context-engine/test/fixtures/semantic-search-zh.cjs");

const baseUrl = process.env.REGENIC_EMBEDDING_BASE_URL;
if (!baseUrl) {
  throw new Error("Set REGENIC_EMBEDDING_BASE_URL to the local EmbeddingGemma service");
}

const sets = {
  en: semanticSearchMemoryFixture,
  zh: semanticSearchZhFixture,
};
const requested = process.argv[2] ?? "both";
const selected = requested === "both" ? ["en", "zh"] : [requested];
if (selected.some((name) => !sets[name])) {
  throw new Error("Pass en, zh, or both");
}

function minmax(threshold) {
  return threshold === HYBRID_RETRIEVAL_PROFILE.vector_min_score
    ? HYBRID_RETRIEVAL_PROFILE
    : { ...HYBRID_RETRIEVAL_PROFILE, version: `personal-hybrid-thread-minmax-${threshold}`, vector_min_score: threshold };
}

function engine(fixture, retriever, profile) {
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(retriever);
  return new DeterministicContextEngine({
    source: fixture.source,
    policy: fixture.policy,
    artifacts: new MemoryContextArtifactStore(),
    retrievers,
    ...(profile ? { retrieval_profile: profile } : {}),
  });
}

function summary(report) {
  const tasks = Object.fromEntries(Object.entries(report.metrics.by_task).map(([task, metrics]) => [task, {
    recall: metrics.mean_recall_at_k,
    ndcg: metrics.mean_ndcg_at_k,
  }]));
  return {
    recall: report.metrics.mean_recall_at_k,
    ndcg: report.metrics.mean_ndcg_at_k,
    mrr: report.metrics.mean_reciprocal_rank_at_k,
    stale: report.metrics.stale_selections,
    safety: report.metrics.safety_passed,
    tasks,
  };
}

async function preparedProvider(provider, fixture) {
  const queries = [...new Set(fixture.dataset.cases.map((entry) => entry.request.query))];
  const vectors = new Map();
  for (const query of queries) {
    vectors.set(query, (await provider.embed([query], "query"))[0]);
  }
  return {
    descriptor: provider.descriptor,
    async countTokens(texts) { return texts.map(() => 8); },
    async embed(texts) {
      return texts.map((text) => {
        const vector = vectors.get(text);
        if (!vector) throw new Error("Query was not prepared");
        return vector;
      });
    },
  };
}

async function indexEvents(fixture, provider, root) {
  const vector = new SqliteContextVectorIndex(join(root, `${fixture.dataset.id}.vector.db`));
  const generation = embeddingGeneration(provider.descriptor, 128);
  const worker = new ContextEmbeddingWorker("example-org", fixture.source, provider, vector, vector, generation, vector);
  const started = performance.now();
  try {
    for (;;) {
      const progress = await worker.runOnce({ max_jobs: 100, time_budget_ms: 30_000 });
      if (progress.failed !== 0) throw new Error(`Embedding failed for ${progress.failed} events`);
      process.stderr.write(`indexed ${fixture.dataset.id} processed=${progress.processed} superseded=${progress.superseded}\n`);
      if (progress.processed + progress.superseded === 0) break;
    }
    return { vector, generation, indexing_ms: performance.now() - started };
  } catch (error) {
    vector.close();
    throw error;
  } finally {
    await worker.stop();
  }
}

async function compare(name, provider, root) {
  const fixture = sets[name]();
  const indexed = await indexEvents(fixture, provider, root);
  try {
    const queries = await preparedProvider(provider, fixture);
    const profiles = [
      ["lexical", null, new DeterministicEventRetriever()],
      ["rrf", HYBRID_RRF_PROFILE, new HybridEventRetriever(new DeterministicEventRetriever(), queries, indexed.vector, indexed.generation, indexed.vector, HYBRID_RRF_PROFILE)],
      ["minmax", HYBRID_RETRIEVAL_PROFILE, new HybridEventRetriever(new DeterministicEventRetriever(), queries, indexed.vector, indexed.generation, indexed.vector, HYBRID_RETRIEVAL_PROFILE)],
      ...[0.3, 0.4, 0.5].map((threshold) => {
        const profile = minmax(threshold);
        return [`minmax-${threshold}`, profile, new HybridEventRetriever(new DeterministicEventRetriever(), queries, indexed.vector, indexed.generation, indexed.vector, profile)];
      }),
    ];
    const reports = {};
    for (const [label, profile, retriever] of profiles) {
      const started = performance.now();
      reports[label] = {
        ...summary(await evaluateContextRetrieval(engine(fixture, retriever, profile), fixture.dataset, { k: 10 })),
        evaluate_ms: Math.round(performance.now() - started),
      };
    }
    return { dataset: fixture.dataset.id, events: fixture.events.length, indexing_ms: Math.round(indexed.indexing_ms), reports };
  } finally {
    indexed.vector.close();
  }
}

async function main() {
  const provider = new LocalHttpEmbeddingProvider({ base_url: baseUrl, timeout_ms: 300000 });
  const root = await mkdtemp(join(tmpdir(), "regenic-hybrid-fusion-"));
  try {
    const results = {};
    for (const name of selected) results[name] = await compare(name, provider, root);
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
