const { mkdtemp, rm, stat } = require("node:fs/promises");
const { cpus, tmpdir, totalmem } = require("node:os");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { MemoryContextArtifactStore, MemoryContextRetrieverRegistry } = require("@regenic/domain");
const { SqliteContextLexicalIndex } = require("@regenic/lexical-index");
const {
  DeterministicContextEngine,
  DeterministicEventRetriever,
  IndexedEventRetriever,
  evaluateContextRetrieval,
} = require("../dist");
const { chineseRetrievalFixture } = require("./fixtures/chinese-retrieval.cjs");

async function main() {
  const fixture = chineseRetrievalFixture();
  const root = await mkdtemp(join(tmpdir(), "regenic-chinese-retrieval-bench-"));
  const indexPath = join(root, "context.lexical.db");
  const index = new SqliteContextLexicalIndex(indexPath);
  try {
    await index.replaceOrganization({
      org_id: "example-org",
      generation: "chinese-development-v1",
      watermark: "authority:chinese-development-v1",
      documents: fixture.events.filter((value) => value.text).map((value) => ({
        event_id: value.event.event_id,
        content_hash: value.event.content_hash,
        text: value.text,
      })),
    });
    const routes = {};
    for (const [name, retriever] of [
      ["literal", new DeterministicEventRetriever()],
      ["fts5", new IndexedEventRetriever(index)],
    ]) {
      const retrievers = new MemoryContextRetrieverRegistry();
      retrievers.register(retriever);
      const engine = new DeterministicContextEngine({
        source: fixture.source,
        policy: fixture.policy,
        artifacts: new MemoryContextArtifactStore(),
        retrievers,
      });
      for (let warmup = 0; warmup < 2; warmup += 1) {
        await evaluateContextRetrieval(engine, fixture.dataset);
      }
      const samples = [];
      let peakRss = process.memoryUsage().rss;
      for (let repeat = 0; repeat < 10; repeat += 1) {
        for (const value of fixture.dataset.cases) {
          const started = performance.now();
          await engine.assemble(structuredClone(value.request));
          samples.push(performance.now() - started);
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }
      }
      samples.sort((left, right) => left - right);
      const percentile = (fraction) => Number(samples[Math.ceil(samples.length * fraction) - 1].toFixed(3));
      routes[name] = {
        samples: samples.length,
        p50_ms: percentile(0.5),
        p95_ms: percentile(0.95),
        p99_ms: percentile(0.99),
        observed_process_peak_rss_bytes: peakRss,
        metrics: (await evaluateContextRetrieval(engine, fixture.dataset)).metrics,
      };
    }
    index.close();
    console.log(JSON.stringify({
      dataset_id: fixture.dataset.id,
      scope: "Synthetic development corpus; in-memory Authority/Blob substitute; no inference, cold-start, concurrency or production-scale measurements.",
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpu: cpus()[0]?.model,
        total_memory_bytes: totalmem(),
      },
      events: fixture.events.length,
      queries: fixture.dataset.cases.length,
      k: 10,
      lexical_database_bytes: (await stat(indexPath)).size,
      routes,
    }, null, 2));
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
