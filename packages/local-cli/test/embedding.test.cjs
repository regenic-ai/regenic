const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { it } = require("node:test");
const { SqliteSplitAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { IngestionService } = require("@regenic/domain");
const { EMBEDDINGGEMMA_2 } = require("@regenic/embedding-provider");
const { runLocalCli } = require("../dist/main");
const { createLocalHost } = require("../dist/host");
const { SqliteContextVectorIndex } = require("@regenic/vector-index");
const { embeddingGeneration } = require("@regenic/domain");
const { createHash } = require("node:crypto");

it("applies default text-only consent to existing CLI visual indexes and requeues on opt-in", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "regenic-cli-visual-consent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, "authority.db");
  const config = { base_url: "http://127.0.0.1:1", chunk_tokens: 128, max_chunks_per_event: 1024 };
  const generation = embeddingGeneration(EMBEDDINGGEMMA_2, config.chunk_tokens, config.max_chunks_per_event);
  const hash = "a".repeat(64);
  const now = new Date().toISOString();
  const index = new SqliteContextVectorIndex(`${database}.vector.db`);
  try {
    await index.registerGeneration("owner", generation);
    await index.reconcile({
      org_id: "owner", generation: generation.id, read_epoch: "fixture", now,
      heads: [{
        source: "synthetic", external_id: "image", event_id: "image", content_hash: hash,
        operation: "create", lineage: ["image"],
      }],
    });
    const [job] = await index.claim({ org_id: "owner", generation: generation.id, owner: "test", now, lease_ms: 1000, limit: 1 });
    await index.complete({
      job, owner: "test", now, chunks: [{
        ordinal: 0, start: 0, end: 1, vector: [1, ...Array(767).fill(0)],
        text_hash: createHash("sha256").update(`${hash}:0`).digest("hex"),
        origin: { part_index: 0, content_hash: hash, mode: "visual", start: 0 },
      }],
    });
  } finally { index.close(); }
  async function mount(embedding, verify) {
    const host = await createLocalHost({ database, blobRoot: join(root, "blobs"), orgId: "owner", embedding });
    try { await verify(host); } finally { await host.dispose(); }
  }
  await mount(config, async (host) => {
    const vectors = host.get("context-vector-index");
    assert.equal(host.get("embedding").visualEnabled, false);
    const result = await vectors.matchAuthorized({
      org_id: "owner", generation: generation.id, authorized: [{ event_id: "image", content_hash: hash }],
      query_vector: [1, ...Array(767).fill(0)], limit: 1,
    });
    assert.equal(result.matched.length, 0);
    assert.equal((await host.get("context-embedding-jobs").listJobs("owner", generation.id))[0].status, "skipped");
  });
  await mount({ ...config, visual_enabled: true }, async (host) => {
    assert.equal(host.get("embedding").visualEnabled, true);
    assert.equal((await host.get("context-embedding-jobs").listJobs("owner", generation.id))[0].status, "pending");
  });
});

it("runs local HTTP indexing/status/retry commands with durable progress across CLI hosts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "regenic-cli-embedding-"));
  const database = join(root, "authority.db");
  const blobRoot = join(root, "blobs");
  let reject = true;
  let embeddings = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    assert.deepEqual(input.descriptor, EMBEDDINGGEMMA_2);
    assert.ok(["document", "query"].includes(input.mode));
    response.setHeader("content-type", "application/json");
    if (reject) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "invalid_input" }));
    } else if (request.url === "/tokens") {
      response.end(JSON.stringify({ descriptor: input.descriptor, counts: input.texts.map((text) => Array.from(text).length + 5) }));
    } else {
      embeddings++;
      response.end(JSON.stringify({
        descriptor: input.descriptor,
        counts: input.texts.map((text) => Array.from(text).length + 5),
        vectors: input.texts.map(() => [1, ...Array(767).fill(0)]),
      }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const env = {
    REGENIC_MODEL_DRIVER: "none", REGENIC_EMBEDDING_DRIVER: "local_http",
    REGENIC_EMBEDDING_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  };
  const authority = await SqliteSplitAuthorityStore.open(database);
  try {
    await new IngestionService(new FsBlobStore(blobRoot), authority).ingest({
      schema_version: "1.0", connector_id: "synthetic", org_id: "owner", delivery_id: "delivery",
      received_at: "2026-10-16T00:00:00.000Z",
      records: [{
        operation: "create", source: "synthetic", external_id: "release",
        occurred_at: "2026-10-16T00:00:00.000Z", actor: { id: "person" }, scope: { id: "thread" },
        type: "message", content: [{ role: "body", media_type: "text/plain", text: "发布批准 RG-2048" }],
      }],
    });
  } finally {
    await authority.close();
  }
  async function run(command, ...extra) {
    let output = "";
    await runLocalCli([command, "--database", database, "--blob-root", blobRoot, "--org", "owner", ...extra], {
      env, stdout: { write(chunk) { output += chunk; return true; } },
    });
    return JSON.parse(output);
  }
  assert.equal((await run("context-embedding-index")).failed, 1);
  const quarantined = await run("context-embedding-status");
  assert.equal(quarantined.jobs[0].status, "quarantined");
  assert.equal(quarantined.jobs[0].error_code, "invalid_input");
  reject = false;
  assert.equal((await run("context-embedding-retry", "--event", quarantined.jobs[0].event_id)).retried, true);
  assert.equal((await run("context-embedding-index")).processed, 1);
  assert.equal((await run("context-embedding-status")).jobs[0].status, "succeeded");
  assert.equal((await run("context-embedding-index")).processed, 0);
  assert.equal(embeddings, 1);
  const searched = await run("context-search", "--query", "release permission", "--limit", "1");
  assert.equal(searched.items.length, 1);
  assert.ok(searched.generation);
  assert.equal(searched.items[0].snippet, "发布批准 RG-2048");
  assert.equal(searched.coverage.covered_count, 1);
  assert.equal(embeddings, 2);
  const assembled = await run("context-assemble", "--query", "release permission");
  assert.equal(assembled.snapshot.retrieval_trace[0].mode, "hybrid");
  await assert.rejects(run("context-search", "--query", "release", "--temporal", "history"), /Invalid search/);
  await assert.rejects(run("context-search", "--query", "release", "--limit", "101"), /Invalid search/);
  await assert.rejects(run("context-search", "--query", "release", "--generation", "injected"), /Unexpected search/);
  await assert.rejects(run("context-embedding-retry", "--event", "missing"), /No current quarantined/);
  const before = await run("context-embedding-status");
  const original = before.generations.find((entry) => entry.active).manifest.id;
  const built = await run("context-embedding-backfill", "--chunk-tokens", "512", "--max-jobs", "10");
  assert.notEqual(built.generation, original);
  assert.equal((await run("context-embedding-activate", "--generation", built.generation)).active, true);
  assert.equal((await run("context-search", "--query", "release permission")).generation, built.generation);
  assert.equal((await run("context-embedding-rollback", "--generation", original)).active, true);
  assert.equal((await run("context-search", "--query", "release permission")).generation, original);
  assert.equal((await run("context-embedding-gc", "--generation", built.generation)).removed, true);
  assert.equal((await run("context-embedding-status")).generations.length, 1);
});
