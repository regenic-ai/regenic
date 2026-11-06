const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const { cpus, platform, totalmem } = require("node:os");
const { resolve } = require("node:path");
const { performance } = require("node:perf_hooks");
const { parseArgs } = require("node:util");
const { LocalHttpEmbeddingProvider } = require("../dist");

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    mean_ms: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50_ms: sorted[Math.floor(values.length * 0.5)],
    p95_ms: sorted[Math.min(values.length - 1, Math.floor(values.length * 0.95))],
    max_ms: sorted.at(-1),
  };
}

async function elapsed(run) {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { values } = parseArgs({ args, options: {
    samples: { type: "string", default: "20" },
    "document-workers": { type: "string", default: "12" },
    "document-batch-size": { type: "string", default: "1" },
    "document-words": { type: "string", default: "80" },
    output: { type: "string" },
  } });
  const samples = positiveInteger(values.samples, "--samples");
  const documentWorkers = positiveInteger(values["document-workers"], "--document-workers");
  const documentBatchSize = positiveInteger(values["document-batch-size"], "--document-batch-size");
  const documentWords = positiveInteger(values["document-words"], "--document-words");
  const baseUrl = process.env.REGENIC_EMBEDDING_BASE_URL;
  if (!baseUrl) throw new Error("REGENIC_EMBEDDING_BASE_URL is required");
  const provider = new LocalHttpEmbeddingProvider({ base_url: baseUrl, timeout_ms: 300000 });

  await provider.embedWithTokenCounts(["interactive latency warmup"], "query");
  const idle = [];
  for (let index = 0; index < samples; index++) {
    idle.push(await elapsed(() =>
      provider.embedWithTokenCounts([`interactive idle query ${index}`], "query")));
  }

  let stop = false;
  let documentCompleted = 0;
  const documentFailures = {};
  const workers = Array.from({ length: documentWorkers }, (_, worker) => (async () => {
    let index = 0;
    while (!stop) {
      try {
        await provider.embed(Array.from({ length: documentBatchSize }, (_, batch) =>
          `background document ${worker}-${index}-${batch} ${"content ".repeat(documentWords)}`), "document");
        index++;
        documentCompleted += documentBatchSize;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : "unexpected";
        documentFailures[code] = (documentFailures[code] ?? 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  })());
  await new Promise((resolve) => setTimeout(resolve, 50));
  const loaded = [];
  try {
    for (let index = 0; index < samples; index++) {
      loaded.push(await elapsed(() =>
        provider.embedWithTokenCounts([`interactive loaded query ${index}`], "query")));
    }
  } finally {
    stop = true;
    await Promise.all(workers);
  }

  assert.equal(loaded.length, samples);
  assert.ok(documentCompleted > 0);
  assert.deepEqual(documentFailures, {});
  const idleStats = statistics(idle);
  const loadedStats = statistics(loaded);
  const report = {
    schema_version: "1.0",
    synthetic: true,
    environment: {
      platform: platform(), node: process.version, cpu: cpus()[0].model,
      logical_cpus: cpus().length, total_memory_bytes: totalmem(),
    },
    workload: {
      samples, document_workers: documentWorkers,
      document_batch_size: documentBatchSize, document_words: documentWords,
    },
    idle_query: idleStats,
    continuous_document_load: loadedStats,
    p95_ratio: loadedStats.p95_ms / idleStats.p95_ms,
    document_completed: documentCompleted,
    document_failures: documentFailures,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) await writeFile(resolve(values.output), output);
  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
