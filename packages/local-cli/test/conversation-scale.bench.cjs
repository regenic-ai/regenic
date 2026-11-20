const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { readFile, stat, writeFile } = require("node:fs/promises");
const { cpus, platform, totalmem } = require("node:os");
const { basename, resolve } = require("node:path");
const { createInterface } = require("node:readline");
const { performance } = require("node:perf_hooks");
const { parseArgs } = require("node:util");
const { SqliteContextLexicalIndex } = require("@regenic/lexical-index");
const { contextLexicalAuthorizationHash } = require("@regenic/domain");

const FORBIDDEN_FIELDS = new Set([
  "conversation_hash",
  "country",
  "detoxify_moderation",
  "hashed_ip",
  "header",
  "openai_moderation",
  "state",
  "timestamp",
  "turn_identifier",
]);

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function statistics(values) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    samples: values.length,
    mean_ms: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
    p50_ms: Number(percentile(0.5).toFixed(3)),
    p95_ms: Number(percentile(0.95).toFixed(3)),
    p99_ms: Number(percentile(0.99).toFixed(3)),
    max_ms: Number(sorted.at(-1).toFixed(3)),
  };
}

function parseRow(line, lineNumber) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON on line ${lineNumber}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Line ${lineNumber} must be an object`);
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (field in value) throw new Error(`Line ${lineNumber} contains forbidden field ${field}`);
  }
  if (
    typeof value.id !== "string" || !value.id
    || !Number.isSafeInteger(value.conversation_index) || value.conversation_index < 0
    || !Number.isSafeInteger(value.message_index) || value.message_index < 0
    || typeof value.role !== "string" || !value.role
    || typeof value.text !== "string"
  ) {
    throw new Error(`Line ${lineNumber} does not match normalized WildChat schema`);
  }
  return value;
}

async function fileSizes(path) {
  const entries = await Promise.all(["", "-wal", "-shm"].map(async (suffix) => {
    try {
      return [suffix || "db", (await stat(`${path}${suffix}`)).size];
    } catch (error) {
      if (error?.code === "ENOENT") return [suffix || "db", 0];
      throw error;
    }
  }));
  return {
    files: Object.fromEntries(entries),
    total: entries.reduce((sum, [, size]) => sum + size, 0),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string" },
      manifest: { type: "string" },
      database: { type: "string" },
      output: { type: "string" },
      messages: { type: "string", default: "100000" },
      "batch-size": { type: "string", default: "1000" },
      samples: { type: "string", default: "10" },
      warmup: { type: "string", default: "2" },
      query: { type: "string", multiple: true, default: ["python", "error", "explain"] },
      rebuild: { type: "boolean", default: false },
    },
  });
  if (!values.input) throw new Error("--input is required");
  if (!values.database) throw new Error("--database is required");
  const input = resolve(values.input);
  const manifest = values.manifest
    ? JSON.parse(await readFile(resolve(values.manifest), "utf8"))
    : undefined;
  if (manifest && (
    manifest.dataset !== "allenai/WildChat-1M"
    || manifest.revision !== "7d6490e462285cf85d91eabea0f9a954fbddcd1f"
    || !Number.isSafeInteger(manifest.messages)
    || manifest.messages < 1
    || typeof manifest.output_sha256 !== "string"
  )) {
    throw new Error("--manifest is not a valid pinned WildChat preparation manifest");
  }
  const database = resolve(values.database);
  const messageLimit = positiveInteger(values.messages, "--messages");
  const batchSize = positiveInteger(values["batch-size"], "--batch-size");
  const samples = positiveInteger(values.samples, "--samples");
  const warmup = positiveInteger(values.warmup, "--warmup");
  const queries = values.query.map((query) => query.trim()).filter(Boolean);
  if (queries.length === 0) throw new Error("At least one non-empty --query is required");

  const index = new SqliteContextLexicalIndex(database);
  const orgId = "wildchat-scale-benchmark";
  const generation = `wildchat-pinned-${messageLimit}`;
  const authorized = [];
  const inputDigest = createHash("sha256");
  const roleCounts = {};
  const languageCounts = {};
  let conversations = 0;
  let previousConversation = -1;
  let messages = 0;
  let indexed = 0;
  let peakRss = process.memoryUsage().rss;
  let batch = [];
  const scanStarted = performance.now();
  const status = await index.getStatus(orgId);
  const rebuild = values.rebuild || status.generation !== generation;
  if (rebuild) {
    await index.replaceOrganization({
      org_id: orgId,
      generation,
      watermark: "wildchat:0",
      documents: [],
    });
  }

  const flush = async () => {
    if (!rebuild || batch.length === 0) {
      batch = [];
      return;
    }
    await index.upsertDocuments({
      org_id: orgId,
      generation,
      watermark: `wildchat:${messages}`,
      documents: batch,
    });
    indexed += batch.length;
    batch = [];
  };

  try {
    const lines = createInterface({
      input: createReadStream(input, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      if (messages >= messageLimit) break;
      inputDigest.update(line).update("\n");
      const row = parseRow(line, lineNumber);
      const contentHash = createHash("sha256").update(row.text, "utf8").digest("hex");
      authorized.push({ event_id: row.id, content_hash: contentHash });
      if (row.conversation_index !== previousConversation) {
        conversations += 1;
        previousConversation = row.conversation_index;
      }
      roleCounts[row.role] = (roleCounts[row.role] ?? 0) + 1;
      const language = typeof row.language === "string" && row.language ? row.language : "unknown";
      languageCounts[language] = (languageCounts[language] ?? 0) + 1;
      batch.push({ event_id: row.id, content_hash: contentHash, text: row.text });
      messages += 1;
      if (batch.length >= batchSize) await flush();
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    await flush();
    if (messages !== messageLimit) {
      throw new Error(`Input ended after ${messages} messages; requested ${messageLimit}`);
    }
    if (manifest && manifest.messages < messages) {
      throw new Error(`Manifest contains ${manifest.messages} messages; benchmark consumed ${messages}`);
    }
    if (rebuild && indexed !== messages) {
      throw new Error(`Indexed ${indexed} documents; expected ${messages}`);
    }
    const scanAndIndexMs = performance.now() - scanStarted;
    const routes = {};
    const authorizationHashStarted = performance.now();
    const authorizationHash = contextLexicalAuthorizationHash(authorized);
    const authorizationHashMs = performance.now() - authorizationHashStarted;
    for (const query of queries) {
      const warmupElapsed = [];
      for (let warmupIndex = 0; warmupIndex < warmup; warmupIndex += 1) {
        const started = performance.now();
        await index.matchAuthorized({
          org_id: orgId,
          authorized,
          authorization_hash: authorizationHash,
          query,
        });
        warmupElapsed.push(performance.now() - started);
      }
      const elapsed = [];
      let last;
      for (let sample = 0; sample < samples; sample += 1) {
        const started = performance.now();
        last = await index.matchAuthorized({
          org_id: orgId,
          authorized,
          authorization_hash: authorizationHash,
          query,
        });
        elapsed.push(performance.now() - started);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
      routes[query] = {
        warmup_latency: statistics(warmupElapsed),
        latency: statistics(elapsed),
        covered: last.coverage?.covered_count ?? last.covered.length,
        matches: last.matched.length,
      };
      assert.equal(
        last.coverage?.covered_count ?? last.covered.length,
        messages,
      );
    }
    const sizes = await fileSizes(database);
    const consumedHash = inputDigest.digest("hex");
    if (
      manifest
      && manifest.messages === messages
      && manifest.output_sha256 !== consumedHash
    ) {
      throw new Error("Prepared WildChat JSONL does not match its manifest SHA-256");
    }
    const report = {
      schema_version: "1.0",
      benchmark: "wildchat-authorized-lexical-search",
      dataset: {
        verified_preparation_manifest: manifest !== undefined,
        ...(manifest ? {
          repository: manifest.dataset,
          revision: manifest.revision,
          license: manifest.license,
        } : {
          input_kind: "unverified_normalized_jsonl",
        }),
        input_file: basename(input),
        consumed_prefix_sha256: consumedHash,
        messages,
        conversations,
        role_counts: roleCounts,
        language_counts: Object.fromEntries(
          Object.entries(languageCounts).sort((left, right) => right[1] - left[1]),
        ),
      },
      environment: {
        platform: platform(),
        arch: process.arch,
        node: process.version,
        cpu: cpus()[0]?.model,
        logical_cpus: cpus().length,
        total_memory_bytes: totalmem(),
      },
      workload: { batch_size: batchSize, samples, warmup, queries },
      measurements: {
        rebuilt_index: rebuild,
        scan_and_index_ms: Number(scanAndIndexMs.toFixed(3)),
        authorization_hash_ms: Number(authorizationHashMs.toFixed(3)),
        index_files_bytes: sizes.files,
        index_total_bytes: sizes.total,
        observed_process_peak_rss_bytes: peakRss,
        routes,
      },
      limitations: [
        "Measures the authorized lexical candidate path, not embedding inference.",
        "Free text remains local and is never included in this report.",
        "The consumed hash covers the selected JSONL prefix, not the full source file.",
      ],
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) await writeFile(resolve(values.output), output);
    process.stdout.write(output);
  } finally {
    index.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { parseRow, statistics };
