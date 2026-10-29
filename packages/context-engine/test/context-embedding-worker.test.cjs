const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteSplitAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { embeddingGeneration, EmbeddingError, IngestionService } = require("@regenic/domain");
const { SqliteContextVectorIndex } = require("@regenic/vector-index");
const { AuthorityContextEvidenceSource, ContextEmbeddingWorker, chunkEmbeddingText, activateEmbeddingGeneration } = require("../dist");

const descriptor = {
  model_id: "synthetic/test", model_revision: "a".repeat(40), tokenizer_revision: "a".repeat(40),
  dimensions: 2, max_input_tokens: 128, query_template: "query: ", document_template: "document: ",
  normalization: "l2", similarity: "cosine", numeric_format: "float32",
};
const generation = embeddingGeneration(descriptor, 32);
function provider(overrides = {}) {
  return {
    descriptor,
    async countTokens(texts) { return texts.map((text) => Array.from(text).length + 5); },
    async embed(texts) { return texts.map(() => [1, 0]); },
    async health() { return { status: "ok" }; },
    ...overrides,
  };
}
function batch(operation, text, delivery = operation, externalId = "message") {
  return {
    schema_version: "1.0", connector_id: "synthetic", org_id: "org", delivery_id: delivery,
    received_at: "2026-10-16T00:00:00.000Z",
    records: [{
      operation, source: "synthetic", external_id: externalId,
      occurred_at: "2026-10-16T00:00:00.000Z",
      actor: { id: "actor" }, scope: { id: "thread" }, type: "message",
      ...(text === undefined ? {} : { content: [{ role: "body", media_type: "text/plain", text }] }),
    }],
  };
}
async function fixture(t, embedding = provider(), gen = generation) {
  const root = await mkdtemp(join(tmpdir(), "regenic-embedding-worker-"));
  const authority = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
  const blobs = new FsBlobStore(join(root, "blobs"));
  const index = new SqliteContextVectorIndex(join(root, "vector.db"));
  const source = new AuthorityContextEvidenceSource(authority, blobs, true);
  const worker = new ContextEmbeddingWorker("org", source, embedding, index, index, gen, index);
  t.after(async () => {
    await worker.stop();
    index.close();
    await authority.close();
    await rm(root, { recursive: true, force: true });
  });
  return { authority, blobs, index, source, worker, ingest: new IngestionService(blobs, authority) };
}

describe("independent embedding indexing worker", () => {
  it("dual-writes retained recipes, refuses incomplete activation and catches up before rollback", async (t) => {
    const f = await fixture(t);
    const next = embeddingGeneration(descriptor, 64);
    await f.ingest.ingest(batch("create", "发布批准，允许上线。"));
    await f.worker.runOnce();
    await f.index.registerGeneration("org", next);
    await assert.rejects(activateEmbeddingGeneration("org", next.id, f.source, f.index, f.index), /not fully covered/);
    assert.equal((await f.worker.runOnce()).processed, 1);
    await activateEmbeddingGeneration("org", next.id, f.source, f.index, f.index);
    assert.equal((await f.index.activeGeneration("org")).id, next.id);
    await f.ingest.ingest(batch("revise", "发布延期，重新审批。"));
    await assert.rejects(activateEmbeddingGeneration("org", generation.id, f.source, f.index, f.index), /not fully covered/);
    assert.equal((await f.worker.runOnce()).processed, 2);
    await activateEmbeddingGeneration("org", generation.id, f.source, f.index, f.index);
    for (const gen of [generation, next]) {
      const jobs = await f.index.listJobs("org", gen.id);
      assert.equal(jobs.find((job) => job.operation === "revise").status, "succeeded");
      assert.equal(jobs.find((job) => job.operation === "create").status, "superseded");
    }
    await f.ingest.ingest(batch("tombstone"));
    await f.worker.runOnce();
    await f.worker.runOnce();
    await activateEmbeddingGeneration("org", next.id, f.source, f.index, f.index);
    assert.equal((await f.index.activeGeneration("org")).id, next.id);
    await f.index.removeGeneration("org", generation.id);
    await f.worker.stop();
  });
  it("quarantines invalid UTF-8 and corrupt blobs before making inference calls", async (t) => {
    let calls = 0;
    const f = await fixture(t, provider({ async embed() { calls++; return [[1, 0]]; } }));
    const input = batch("create", "placeholder");
    input.records[0].content = [{ role: "body", media_type: "text/plain", bytes: Buffer.from([0x61, 0xff]) }];
    await f.ingest.ingest(input);
    assert.equal((await f.worker.runOnce()).failed, 1);
    assert.equal((await f.index.listJobs("org", generation.id))[0].status, "quarantined");
    await f.ingest.ingest(batch("revise", "valid replacement"));
    const originalGet = f.blobs.getMany.bind(f.blobs);
    f.blobs.getMany = async (hashes) => new Map(hashes.map((hash) => [hash, Buffer.from("corrupt")]));
    assert.equal((await f.worker.runOnce()).failed, 1);
    f.blobs.getMany = originalGet;
    assert.equal((await f.index.listJobs("org", generation.id))[1].error_code, "invalid_input");
    assert.equal(calls, 0);
  });

  it("cancels and drains inference before clearing projection, then resumes indexing", async (t) => {
    let started;
    let block = true;
    const pending = new Promise((resolve) => { started = resolve; });
    const f = await fixture(t, provider({
      async embed(texts, _mode, signal) {
        if (!block) return texts.map(() => [1, 0]);
        started();
        return new Promise((_resolve, reject) => signal.addEventListener("abort",
          () => reject(new EmbeddingError("cancelled", true)), { once: true }));
      },
    }));
    await f.ingest.ingest(batch("create", "清理并取消。"));
    const running = f.worker.runOnce();
    await pending;
    await f.worker.clearProjection();
    await running;
    assert.deepEqual(await f.index.listJobs("org", generation.id), []);
    block = false;
    assert.equal((await f.worker.runOnce()).processed, 1);
  });

  it("backfills, indexes idempotently and leaves the existing projection queue untouched", async (t) => {
    let calls = 0;
    const f = await fixture(t, provider({ async embed(texts) { calls += 1; return texts.map(() => [1, 0]); } }));
    await f.ingest.ingest(batch("create", "发布批准，允许上线。"));
    assert.deepEqual(await f.worker.runOnce(), { processed: 1, failed: 0, superseded: 0 });
    const read = await f.authority.openContextRead("org");
    const event = read.events[0];
    const result = await f.index.matchAuthorized({
      org_id: "org", generation: generation.id, authorized: [{ event_id: event.id, content_hash: event.content_hash }],
      query_vector: [1, 0], limit: 10,
    });
    assert.equal(result.covered.length, 1);
    assert.equal(result.matched[0].event_id, event.id);
    assert.deepEqual(await f.worker.runOnce(), { processed: 0, failed: 0, superseded: 0 });
    assert.equal(calls, 1);
    assert.equal((await f.authority.listContextProjectionJobs("org"))[0].status, "pending");
  });

  it("drains a bounded idle batch, reuses reads and yields between jobs", async (t) => {
    const f = await fixture(t);
    for (let index = 0; index < 3; index++) {
      await f.ingest.ingest(batch("create", `message-${index}`, `create-${index}`, `message-${index}`));
    }
    let reads = 0;
    const openRead = f.source.openRead.bind(f.source);
    f.source.openRead = async (...args) => {
      reads += 1;
      return openRead(...args);
    };

    let pauseChecks = 0;
    const first = await f.worker.runOnce({
      max_jobs: 3,
      time_budget_ms: 30_000,
      pause_if: () => pauseChecks++ > 0,
    });
    assert.deepEqual(first, { processed: 1, failed: 0, superseded: 0 });

    const second = await f.worker.runOnce({ max_jobs: 2, time_budget_ms: 30_000 });
    assert.deepEqual(second, { processed: 2, failed: 0, superseded: 0 });
    assert.equal(reads, 5);
  });

  it("uses one token-count request for fitting text", async () => {
    let countCalls = 0;
    let embedCalls = 0;
    const embedding = provider({
      async countTokens(texts) {
        countCalls += 1;
        return texts.map((text) => Array.from(text).length + 5);
      },
      async embed(texts) {
        embedCalls += 1;
        return texts.map(() => [1, 0]);
      },
    });
    const chunks = await chunkEmbeddingText("short text", embedding, generation);
    assert.equal(chunks.length, 1);
    assert.equal(countCalls, 1);
    assert.equal(embedCalls, 1);
  });

  it("preserves Unicode source intervals and obeys tokenizer budgets without truncation", async () => {
    const text = "第一句😀，中文内容必须保留。\n第二句，不能按字节截断。\n".repeat(5);
    const chunks = await chunkEmbeddingText(text, provider(), generation);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.map((chunk) => text.slice(chunk.start, chunk.end)).join(""), text);
    for (const chunk of chunks) {
      assert.ok(Array.from(text.slice(chunk.start, chunk.end)).length + 5 <= 32);
      assert.match(chunk.text_hash, /^[a-f0-9]{64}$/);
      assert.ok(!/[\ud800-\udbff]$/.test(text.slice(chunk.start, chunk.end)));
    }
  });

  it("keeps a verified fitting chunk when a preferred boundary increases token count", async () => {
    const boundary = `${"a".repeat(20)}。`;
    const text = `${boundary}${"b".repeat(40)}`;
    const embedding = provider({
      async countTokens(texts) { return texts.map((value) => value === boundary ? 33 : value.length + 5); },
    });
    const chunks = await chunkEmbeddingText(text, embedding, generation);
    assert.equal(chunks[0].end, 27);
    assert.equal(chunks.map((chunk) => text.slice(chunk.start, chunk.end)).join(""), text);
    for (const chunk of chunks) {
      const [count] = await embedding.countTokens([text.slice(chunk.start, chunk.end)], "document");
      assert.ok(count <= generation.chunk_tokens);
    }
  });

  it("quarantines oversized events rather than publishing a partial chunk set", async (t) => {
    const small = embeddingGeneration(descriptor, 32, 1);
    const f = await fixture(t, provider(), small);
    await f.ingest.ingest(batch("create", "这是一段很长的正文。".repeat(30)));
    assert.equal((await f.worker.runOnce()).failed, 1);
    const jobs = await f.index.listJobs("org", small.id);
    assert.equal(jobs[0].status, "quarantined");
    assert.equal(jobs[0].error_code, "input_too_large");
    assert.deepEqual((await f.index.matchAuthorized({
      org_id: "org", generation: small.id,
      authorized: [{ event_id: jobs[0].event_id, content_hash: jobs[0].content_hash }], query_vector: [1, 0], limit: 10,
    })).covered, []);
  });

  it("persists retryable model failures without exposing input or acknowledging authority jobs", async (t) => {
    const f = await fixture(t, provider({ async embed() { throw new EmbeddingError("timeout", true); } }));
    await f.ingest.ingest(batch("create", "private-body"));
    assert.deepEqual(await f.worker.runOnce(), { processed: 0, failed: 1, superseded: 0 });
    const [job] = await f.index.listJobs("org", generation.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "timeout");
    assert.ok(!JSON.stringify(job).includes("private-body"));
    assert.equal((await f.authority.listContextProjectionJobs("org"))[0].status, "pending");
  });

  it("fences a deletion observed during inference and rejects a late publication", async (t) => {
    let ingest;
    const f = await fixture(t, provider({
      async embed(texts) {
        await ingest.ingest(batch("tombstone", undefined));
        return texts.map(() => [1, 0]);
      },
    }));
    ingest = f.ingest;
    await f.ingest.ingest(batch("create", "需要撤回的正文。"));
    assert.deepEqual(await f.worker.runOnce(), { processed: 0, failed: 0, superseded: 1 });
    const jobs = await f.index.listJobs("org", generation.id);
    assert.equal(jobs[0].status, "superseded");
    assert.equal(jobs[1].operation, "tombstone");
    assert.equal(jobs[1].status, "succeeded");
    const matches = await f.index.matchAuthorized({
      org_id: "org", generation: generation.id,
      authorized: [{ event_id: jobs[0].event_id, content_hash: jobs[0].content_hash }], query_vector: [1, 0], limit: 10,
    });
    assert.deepEqual(matches.covered, []);
  });

  it("handles revision during inference and processes the authoritative new head on the next tick", async (t) => {
    let ingest;
    let revised = false;
    const f = await fixture(t, provider({
      async embed(texts) {
        if (!revised) { revised = true; await ingest.ingest(batch("revise", "新版本发布批准。")); }
        return texts.map(() => [1, 0]);
      },
    }));
    ingest = f.ingest;
    await ingest.ingest(batch("create", "旧版本等待批准。"));
    assert.deepEqual(await f.worker.runOnce(), { processed: 1, failed: 0, superseded: 1 });
    const jobs = await f.index.listJobs("org", generation.id);
    assert.deepEqual(jobs.map((job) => job.status), ["superseded", "succeeded"]);
  });

  it("cancels in-flight inference on stop and never overlaps ticks", async (t) => {
    let started;
    const pending = new Promise((resolve) => { started = resolve; });
    const f = await fixture(t, provider({
      async embed(_texts, _mode, signal) {
        started();
        return new Promise((_resolve, reject) => signal.addEventListener("abort",
          () => reject(new EmbeddingError("cancelled", true)), { once: true }));
      },
    }));
    await f.ingest.ingest(batch("create", "取消测试正文。"));
    const running = f.worker.runOnce();
    await pending;
    assert.deepEqual(await f.worker.runOnce(), { processed: 0, failed: 0, superseded: 0 });
    await f.worker.stop();
    assert.equal((await running).failed, 1);
    const [job] = await f.index.listJobs("org", generation.id);
    assert.equal(job.error_code, "cancelled");
    assert.equal(job.status, "failed");
  });
});
