const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, stat } = require("node:fs/promises");
const { tmpdir, cpus, totalmem, platform } = require("node:os");
const { join, resolve } = require("node:path");
const { parseArgs } = require("node:util");
const { performance } = require("node:perf_hooks");
const { MemoryContextArtifactStore, MemoryContextRetrieverRegistry, embeddingGeneration, hashCanonicalContext } = require("@regenic/domain");
const { LocalHttpEmbeddingProvider } = require("@regenic/embedding-provider");
const { SqliteContextVectorIndex } = require("@regenic/vector-index");
const { SqliteContextLexicalIndex } = require("@regenic/lexical-index");
const {
  DeterministicContextEngine, DeterministicEventRetriever, IndexedEventRetriever,
  ContextEmbeddingWorker, HybridEventRetriever, HYBRID_RETRIEVAL_PROFILE, evaluateContextRetrieval,
} = require("@regenic/context-engine");
const { chineseRetrievalFixture } = require("../../context-engine/test/fixtures/chinese-retrieval.cjs");
const { semanticHoldoutFixture } = require("./fixtures/semantic-holdout.cjs");
const { semanticConfirmationFixture } = require("./fixtures/semantic-confirmation.cjs");
const { SqliteSplitAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { IngestionService } = require("@regenic/domain");
const { runLocalCli } = require("../dist/main");

function profileFor(threshold) {
  return threshold === HYBRID_RETRIEVAL_PROFILE.vector_min_score ? HYBRID_RETRIEVAL_PROFILE
    : { ...HYBRID_RETRIEVAL_PROFILE, version: `synthetic-threshold-${threshold}`, vector_min_score: threshold };
}

function engine(fixture, retriever, hybrid = false, profile = HYBRID_RETRIEVAL_PROFILE) {
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(retriever);
  return new DeterministicContextEngine({
    source: fixture.source, policy: fixture.policy, artifacts: new MemoryContextArtifactStore(), retrievers,
    ...(hybrid ? { retrieval_profile: profile } : {}),
  });
}

async function evaluateSplit(fixture, root, provider, tune) {
  const path = join(root, `${fixture.dataset.id}.vector.db`);
  const vector = new SqliteContextVectorIndex(path);
  const lexical = new SqliteContextLexicalIndex(join(root, `${fixture.dataset.id}.lexical.db`));
  const generation = embeddingGeneration(provider.descriptor, 256);
  const worker = new ContextEmbeddingWorker("example-org", fixture.source, provider, vector, vector, generation, vector);
  const inference = [];
  try {
    const start = performance.now();
    for (let count = 0; count < fixture.events.length; count++) {
      const progress = await worker.runOnce();
      assert.equal(progress.failed, 0, "Real model indexing must succeed; degradation is not evaluation success");
      if (progress.processed + progress.superseded === 0) break;
    }
    const indexing_ms = performance.now() - start;
    await lexical.replaceOrganization({
      org_id: "example-org", generation: "semantic-evaluation", watermark: `authority:${fixture.dataset.id}`,
      documents: fixture.events.filter((entry) => entry.text).map((entry) => ({
        event_id: entry.event.event_id, content_hash: entry.event.content_hash, text: entry.text,
      })),
    });
    const queries = fixture.dataset.cases.map((entry) => entry.request.query);
    const counts = await provider.countTokens(queries, "query");
    const vectors = [];
    for (const query of queries) {
      const start = performance.now();
      vectors.push((await provider.embed([query], "query"))[0]);
      inference.push(performance.now() - start);
    }
    const prepared = {
      descriptor: provider.descriptor,
      async countTokens(texts) { return texts.map((text) => counts[queries.indexOf(text)]); },
      async embed(texts) { return texts.map((text) => {
        const value = vectors[queries.indexOf(text)];
        if (!value) throw new Error("Query is outside the prepared evaluation split");
        return value;
      }); },
    };
    const noLexical = { id: "vector-only", capabilities: () => new DeterministicEventRetriever().capabilities(),
      async retrieve() { return []; } };
    const indexed = () => new IndexedEventRetriever(lexical);
    const hybrid = (threshold = HYBRID_RETRIEVAL_PROFILE.vector_min_score, pure = false, live = false) => new HybridEventRetriever(
      pure ? noLexical : indexed(), live ? provider : prepared,
      vector, generation, vector, profileFor(threshold),
    );
    const reports = {};
    for (const [name, retriever, isHybrid] of [
      ["literal", new DeterministicEventRetriever(), false], ["fts5", indexed(), false],
      ["vector", hybrid(HYBRID_RETRIEVAL_PROFILE.vector_min_score, true), true], ["hybrid", hybrid(), true],
    ]) {
      reports[name] = await evaluateContextRetrieval(engine(fixture, retriever, isHybrid), fixture.dataset);
    }
    const tuning = [];
    if (tune) {
      for (const threshold of [0.6, 0.65, 0.7, 0.72, 0.75, 0.78, 0.8]) {
        const result = await evaluateContextRetrieval(engine(fixture, hybrid(threshold), true, profileFor(threshold)), fixture.dataset);
        tuning.push({ threshold, metrics: result.metrics });
      }
    }
    const liveEngine = engine(fixture, hybrid(HYBRID_RETRIEVAL_PROFILE.vector_min_score, false, true), true);
    const liveSearchMs = [];
    for (const entry of fixture.dataset.cases.filter((entry) => entry.relevant_event_ids.length).slice(0, 5)) {
      const start = performance.now();
      const assembled = await liveEngine.assemble(entry.request);
      assert.equal(assembled.snapshot.retrieval_trace[0].mode, "hybrid");
      assert.equal(assembled.bundle.degradation_flags.some((flag) => /embedding_|vector_index_/.test(flag)), false);
      liveSearchMs.push(performance.now() - start);
    }
    for (const report of Object.values(reports)) {
      assert.equal(report.metrics.unauthorized_selections, 0);
      assert.equal(report.metrics.stale_selections, 0);
      assert.equal(report.metrics.citation_coverage, 1);
    }
    assert.deepEqual(await evaluateContextRetrieval(engine(fixture, hybrid(), true), fixture.dataset), reports.hybrid);
    const files = await Promise.all(["", "-wal", "-shm"].map(async (suffix) => [suffix || "db", (await stat(`${path}${suffix}`)).size]));
    const exact = fixture.dataset.cases.filter((entry) =>
      ["identifier", "full-width", "date", "thread-filter", "negation"].includes(entry.id));
    const acceptance = {
      hybrid_safety: reports.hybrid.metrics.safety_passed,
      recall_not_below_fts: reports.hybrid.metrics.mean_recall_at_k >= reports.fts5.metrics.mean_recall_at_k,
      exact_top1: exact.every((entry) =>
        reports.hybrid.cases.find((result) => result.case_id === entry.id).selected_event_ids[0] === entry.relevant_event_ids[0]),
      deterministic_selections: true,
    };
    return { dataset: fixture.dataset.id, dataset_hash: hashCanonicalContext({ events: fixture.events, dataset: fixture.dataset }),
      generation, profile: HYBRID_RETRIEVAL_PROFILE, reports, tuning, acceptance,
      measurements: { indexing_ms, query_inference_ms: inference, live_assemble_ms: liveSearchMs,
        vector_files_bytes: Object.fromEntries(files),
        vector_sidecar_bytes: files.reduce((sum, [, size]) => sum + size, 0), node_rss_bytes: process.memoryUsage().rss } };
  } finally {
    await worker.stop(); vector.close(); lexical.close();
  }
}

async function scanPerformance(root, provider) {
  const vector = new SqliteContextVectorIndex(join(root, "scale.vector.db"));
  const generation = embeddingGeneration(provider.descriptor, 256);
  const embedding = (await provider.embed(["Synthetic exact scan capacity benchmark."], "document"))[0];
  const samples = [];
  try {
    for (const size of [100, 1000, 10000]) {
      const org = `scale-${size}`;
      await vector.registerGeneration(org, generation);
      const hash = "a".repeat(64);
      const heads = Array.from({ length: size }, (_, index) => ({
        source: "scale", external_id: String(index), event_id: `event-${index}`, content_hash: hash,
        operation: "create", lineage: [`event-${index}`],
      }));
      const now = new Date().toISOString();
      await vector.reconcile({ org_id: org, generation: generation.id, heads, read_epoch: "scale:1", now });
      for (let index = 0; index < size; index += 100) {
        const jobs = await vector.claim({ org_id: org, generation: generation.id, owner: "scale", now,
          lease_ms: 300000, limit: 100 });
        for (const job of jobs) assert.equal(await vector.complete({
          job, owner: "scale", now, chunks: [{ ordinal: 0, start: 0, end: 1, text_hash: hash, vector: embedding }],
        }), true);
      }
      const authorized = heads.map((head) => ({ event_id: head.event_id, content_hash: hash }));
      const elapsed = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        const start = performance.now();
        const result = await vector.matchAuthorized({
          org_id: org, generation: generation.id, authorized, query_vector: embedding, limit: 10,
        });
        elapsed.push(performance.now() - start);
        assert.equal(result.covered.length, size);
        assert.equal(result.matched.length, 10);
      }
      const files = await Promise.all(["", "-wal", "-shm"].map(async (suffix) => (await stat(join(root, `scale.vector.db${suffix}`))).size));
      samples.push({ events: size, dimensions: embedding.length, warm_exact_scan_ms: elapsed,
        vector_sidecar_bytes: files.reduce((sum, size) => sum + size, 0), node_rss_bytes: process.memoryUsage().rss });
      await vector.clearOrganization(org);
    }
    return samples;
  } finally { vector.close(); }
}

async function durablePipeline(root) {
  const database = join(root, "authority.db");
  const blobRoot = join(root, "blobs");
  const env = { ...process.env, REGENIC_EMBEDDING_DRIVER: "local_http", REGENIC_MODEL_DRIVER: "none" };
  async function ingest(operation, text) {
    const authority = await SqliteSplitAuthorityStore.open(database);
    try {
      return (await new IngestionService(new FsBlobStore(blobRoot), authority).ingest({
        schema_version: "1.0", connector_id: "evaluation", org_id: "owner", delivery_id: operation,
        received_at: new Date().toISOString(), records: [{
          operation, source: "evaluation", external_id: "rollback", occurred_at: "2026-10-16T00:00:00.000Z",
          actor: { id: "owner" }, scope: { id: "thread" }, type: "message",
          ...(text === undefined ? {} : { content: [{ role: "body", media_type: "text/plain", text }] }),
        }],
      })).records[0].event_id;
    } finally { await authority.close(); }
  }
  async function run(command, ...extra) {
    let output = "";
    await runLocalCli([command, "--database", database, "--blob-root", blobRoot, "--org", "owner", ...extra], {
      env, stdout: { write(chunk) { output += chunk; return true; } },
    });
    return JSON.parse(output);
  }
  const originalEvent = await ingest("create", "部署异常时先撤回版本，再恢复上一版服务。");
  assert.equal((await run("context-embedding-index", "--max-jobs", "10")).processed, 1);
  const elapsed = [];
  let searched;
  for (let count = 0; count < 3; count++) {
    const start = performance.now();
    searched = await run("context-search", "--query", "rollback");
    elapsed.push(performance.now() - start);
    assert.ok(searched.generation);
    assert.equal(searched.items[0].event_id, originalEvent);
  }
  const original = searched.generation;
  const next = (await run("context-embedding-backfill", "--chunk-tokens", "512", "--max-jobs", "10")).generation;
  await run("context-embedding-activate", "--generation", next);
  const assembled = await run("context-assemble", "--query", "rollback");
  assert.equal(assembled.snapshot.retrieval_trace[0].generation, next);
  await run("context-embedding-rollback", "--generation", original);
  await run("context-embedding-gc", "--generation", next);
  const replayed = await run("context-replay", "--snapshot", assembled.snapshot.id);
  assert.equal(replayed.content_hash, assembled.bundle.content_hash);
  const revised = await ingest("revise", "回滚步骤已经调整：先停止流量，再恢复上一版服务。");
  const beforeIndex = await run("context-search", "--query", "rollback");
  assert.ok(beforeIndex.degradation_flags.includes("vector_index_partial"));
  assert.equal(beforeIndex.items.some((entry) => entry.event_id === originalEvent), false);
  assert.equal((await run("context-embedding-index", "--max-jobs", "10")).processed, 1);
  await ingest("tombstone");
  await run("context-embedding-index");
  const removed = await run("context-search", "--query", "rollback");
  assert.equal(removed.items.some((entry) => [originalEvent, revised].includes(entry.event_id)), false);
  return { live_cli_search_ms: elapsed, original_generation: original, backfilled_generation: next,
    semantic_hit: true, switched: true, rolled_back: true, gc_replay_preserved: true,
    revised_event_fenced_before_indexing: true, tombstone_removed: true };
}

async function main() {
  const { values } = parseArgs({ options: {
    split: { type: "string", default: "development" }, output: { type: "string" }, scale: { type: "boolean" },
  } });
  if (!["development", "holdout", "confirmation", "pipeline"].includes(values.split)) throw new Error("--split must be development, holdout, confirmation or pipeline");
  if (!process.env.REGENIC_EMBEDDING_BASE_URL) throw new Error("Start the pinned model service and set REGENIC_EMBEDDING_BASE_URL");
  const provider = new LocalHttpEmbeddingProvider({
    base_url: process.env.REGENIC_EMBEDDING_BASE_URL, timeout_ms: 300000,
  });
  const root = await mkdtemp(join(tmpdir(), "regenic-real-model-eval-"));
  try {
    const fixture = values.split === "development" ? chineseRetrievalFixture()
      : values.split === "holdout" ? semanticHoldoutFixture() : semanticConfirmationFixture();
    const report = {
      schema_version: "1.0", synthetic: true, split: values.split,
      environment: { platform: platform(), node: process.version, cpu: cpus()[0].model,
        logical_cpus: cpus().length, total_memory_bytes: totalmem() },
      ...(values.split === "pipeline" ? { pipeline: await durablePipeline(root) }
        : await evaluateSplit(fixture, root, provider, values.split === "development")),
      ...(values.scale ? { scale: await scanPerformance(root, provider) } : {}),
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) await writeFile(resolve(values.output), output);
    process.stdout.write(JSON.stringify({
      split: report.split, ...(report.reports ? { metrics: Object.fromEntries(Object.entries(report.reports).map(([name, value]) => [name, value.metrics])) } : {}),
      tuning: report.tuning, measurements: report.measurements, scale: report.scale, pipeline: report.pipeline,
      acceptance: report.acceptance,
    }, null, 2) + "\n");
    if (report.acceptance) assert.ok(Object.values(report.acceptance).every(Boolean), "Synthetic acceptance checks failed; inspect the saved report");
  } finally { await rm(root, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
