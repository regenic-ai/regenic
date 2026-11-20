const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");
const {
  contextVectorAuthorizationHash,
  embeddingGeneration,
} = require("@regenic/domain");
const { SqliteContextVectorIndex } = require("../dist");

void main();

async function main() {
const options = argumentsFor(process.argv.slice(2));
const count = numberOption(options, "messages", 1_000_000);
const databasePath = resolve(options.database ?? "vector-authorization-scale.db");
const outputPath = options.output ? resolve(options.output) : undefined;
mkdirSync(dirname(databasePath), { recursive: true });

const model = {
  model_id: "synthetic/vector-authorization-scale",
  model_revision: "a".repeat(40),
  tokenizer_revision: "a".repeat(40),
  dimensions: 2,
  max_input_tokens: 128,
  query_template: "query: ",
  document_template: "document: ",
  normalization: "l2",
  similarity: "cosine",
  numeric_format: "float32",
};
const generation = embeddingGeneration(model, 32);
const contentHash = "b".repeat(64);
let index = new SqliteContextVectorIndex(databasePath);
await index.registerGeneration("benchmark", generation);
index.close();

const setupStarted = performance.now();
const database = new Database(databasePath);
const existing = database.prepare(
  "SELECT count(*) FROM coverage WHERE org_id=? AND generation=?",
).pluck().get("benchmark", generation.id);
if (existing !== count) {
  database.exec(`
    DELETE FROM chunks;
    DELETE FROM coverage;
    DELETE FROM source_heads;
  `);
  const vector = Buffer.alloc(8);
  vector.writeFloatLE(1, 0);
  database.transaction(() => {
    const insertHead = database.prepare("INSERT INTO source_heads VALUES (?,?,?,?,?)");
    const insertCoverage = database.prepare("INSERT INTO coverage VALUES (?,?,?,?,?,?,?)");
    const insertChunk = database.prepare(`
      INSERT INTO chunks (
        org_id,generation,event_id,ordinal,start,end,text_hash,vector
      ) VALUES (?,?,?,?,?,?,?,?)
    `);
    for (let value = 0; value < count; value += 1) {
      const eventId = `event-${String(value).padStart(7, "0")}`;
      insertHead.run("benchmark", "synthetic", eventId, eventId, 1);
      insertCoverage.run(
        "benchmark", generation.id, eventId, contentHash, "synthetic", eventId, 1,
      );
      insertChunk.run(
        "benchmark", generation.id, eventId, 0, 0, 2, contentHash, vector,
      );
    }
  })();
}
database.close();
const setupMs = performance.now() - setupStarted;

index = new SqliteContextVectorIndex(databasePath);
const authorized = Array.from({ length: count }, (_, value) => ({
  event_id: `event-${String(value).padStart(7, "0")}`,
  content_hash: contentHash,
}));
const hashStarted = performance.now();
const authorizationHash = contextVectorAuthorizationHash(authorized);
const authorizationHashMs = performance.now() - hashStarted;
const base = {
  org_id: "benchmark",
  generation: generation.id,
  authorized,
  query_vector: [1, 0],
  limit: 100,
};

const legacy = await measured(() => index.matchAuthorized(base));
const compactCold = await measured(() => index.matchAuthorized({
  ...base,
  authorization_hash: authorizationHash,
}));
const compactWarm = await measured(() => index.matchAuthorized({
  ...base,
  authorization_hash: authorizationHash,
}));
index.close();

const report = {
  schema_version: "1.0",
  benchmark: "vector-authorization-scale",
  messages: count,
  dimensions: model.dimensions,
  setup_ms: rounded(setupMs),
  authorization_hash_ms: rounded(authorizationHashMs),
  legacy: summary(legacy),
  compact_cold: summary(compactCold),
  compact_warm: summary(compactWarm),
};
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
}

async function measured(operation) {
  const started = performance.now();
  const result = await operation();
  return { elapsed: performance.now() - started, result };
}

function summary(measurement) {
  return {
    latency_ms: rounded(measurement.elapsed),
    covered_keys: measurement.result.covered.length,
    covered_count: measurement.result.coverage?.covered_count
      ?? measurement.result.covered.length,
    matched: measurement.result.matched.length,
  };
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function numberOption(values, key, fallback) {
  const value = values[key] === undefined ? fallback : Number(values[key]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid --${key}`);
  }
  return value;
}

function argumentsFor(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--") || values[index + 1] === undefined) {
      throw new Error(`Invalid argument ${key ?? ""}`);
    }
    parsed[key.slice(2)] = values[index + 1];
  }
  return parsed;
}
