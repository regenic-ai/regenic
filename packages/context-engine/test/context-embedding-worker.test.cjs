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

  it("indexes text file attachments stored as connector blobs", async (t) => {
    const embedded = [];
    const f = await fixture(t, provider({
      async embed(texts) {
        embedded.push(...texts);
        return texts.map(() => [1, 0]);
      },
    }));
    const input = batch("create", undefined);
    input.records[0].content = [{
      role: "attachment",
      media_type: "application/octet-stream",
      source_filename: "meeting-notes.txt",
      bytes: Buffer.from("飞书同步的文件正文"),
    }];
    await f.ingest.ingest(input);

    assert.deepEqual(await f.worker.runOnce(), { processed: 1, failed: 0, superseded: 0 });
    assert.ok(embedded.some((text) => text.includes("飞书同步的文件正文")));
  });

  it("preserves valid JSON files mislabeled as octet-stream instead of discarding them as error payloads", async (t) => {
    const embedded = [];
    const f = await fixture(t, provider({
      async embed(texts) { embedded.push(...texts); return texts.map(() => [1, 0]); },
    }));
    const input = batch("create", undefined);
    input.records[0].content = [{
      role: "attachment", media_type: "application/octet-stream",
      source_filename: "data.json", bytes: Buffer.from('{"name":"local"}'),
    }];
    await f.ingest.ingest(input);
    assert.equal((await f.worker.runOnce()).processed, 1);
    assert.ok(embedded.includes('{"name":"local"}'));
  });

  it("indexes body, extracted Office/PDF text and visual units as one fenced projection", async (t) => {
    const seen = [];
    const f = await fixture(t, provider({
      async processAttachment(input) {
        seen.push(input);
        return { text: "extracted document", vectors: [[0, 1], [1, 0]] };
      },
    }));
    const input = batch("create", "body");
    input.records[0].content.push({
      role: "attachment", media_type: "application/pdf", source_filename: "notes.pdf",
      bytes: Buffer.from("%PDF-synthetic"),
    });
    await f.ingest.ingest(input);
    assert.deepEqual(await f.worker.runOnce(), { processed: 1, failed: 0, superseded: 0 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].source_filename, "notes.pdf");
    assert.equal(Buffer.from(seen[0].bytes).toString(), "%PDF-synthetic");
    const [job] = await f.index.listJobs("org", generation.id);
    const match = await f.index.matchAuthorized({
      org_id: "org", generation: generation.id,
      authorized: [{ event_id: job.event_id, content_hash: job.content_hash }],
      query_vector: [0, 1], limit: 10,
    });
    assert.equal(match.matched[0].chunk_ordinal, 2);
    assert.equal(match.matched[0].start, "bodyextracted document".length);
    assert.equal(match.matched[0].material_length, "bodyextracted document".length + 2);
  });

  it("supports direct binary blobs and rejects partial or unavailable attachment inference", async (t) => {
    let fail = true;
    const f = await fixture(t, provider({
      async processAttachment(input) {
        assert.equal(input.media_type, "image/jpeg");
        if (fail) throw new EmbeddingError("unsupported_attachment", false);
        return { vectors: [[1, 0]] };
      },
    }));
    const input = batch("create", undefined);
    input.records[0].content = [{
      role: "attachment", media_type: "image/jpeg", bytes: Buffer.from([255, 216, 255]),
    }];
    await f.ingest.ingest(input);
    assert.equal((await f.worker.runOnce()).failed, 1);
    let [job] = await f.index.listJobs("org", generation.id);
    assert.equal(job.error_code, "unsupported_attachment");
    assert.equal(job.status, "quarantined");
    await assert.rejects(activateEmbeddingGeneration("org", generation.id, f.source, f.index, f.index),
      /not fully covered/);
    fail = false;
    assert.equal(await f.index.retryQuarantined("org", generation.id, job.event_id), true);
    assert.equal((await f.worker.runOnce()).processed, 1);
    [job] = await f.index.listJobs("org", generation.id);
    assert.equal(job.status, "succeeded");
  });

  it("uses binary signatures before connector text MIME or filename hints", async (t) => {
    let calls = 0;
    const f = await fixture(t, provider({
      async processAttachment(input) {
        calls++;
        assert.deepEqual([...input.bytes.subarray(0, 3)], [255, 216, 255]);
        return { vectors: [[1, 0]] };
      },
    }));
    for (const withBody of [true, false]) {
      const input = batch("create", withBody ? "caption" : undefined,
        `delivery-${withBody}`, `file-${withBody}`);
      input.records[0].content ??= [];
      input.records[0].content.push({
        role: "attachment", media_type: "text/plain", source_filename: "wrong.txt",
        bytes: Buffer.from([255, 216, 255, 0, 1, 2]),
      });
      await f.ingest.ingest(input);
    }
    assert.equal((await f.worker.runOnce()).processed, 2);
    assert.equal(calls, 2);
  });

  it("fails explicitly when an attachment provider is unavailable, rather than skipping a file", async (t) => {
    const f = await fixture(t);
    const input = batch("create", undefined);
    input.records[0].content = [{
      role: "attachment", media_type: "image/png", bytes: Buffer.from("synthetic image"),
    }];
    await f.ingest.ingest(input);
    assert.equal((await f.worker.runOnce()).failed, 1);
    const [job] = await f.index.listJobs("org", generation.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "unavailable");
  });

  it("fences an attachment deleted during local visual inference", async (t) => {
    const f = await fixture(t, provider({
      async processAttachment() {
        await f.ingest.ingest(batch("tombstone", undefined));
        return { vectors: [[1, 0]] };
      },
    }));
    const input = batch("create", undefined);
    input.records[0].content = [{
      role: "attachment", media_type: "image/png", bytes: Buffer.from("synthetic image"),
    }];
    await f.ingest.ingest(input);
    assert.deepEqual(await f.worker.runOnce(), { processed: 0, failed: 0, superseded: 1 });
    const [job] = await f.index.listJobs("org", generation.id);
    assert.equal(job.status, "superseded");
    assert.deepEqual((await f.index.matchAuthorized({
      org_id: "org", generation: generation.id,
      authorized: [{ event_id: job.event_id, content_hash: job.content_hash }],
      query_vector: [1, 0], limit: 10,
    })).covered, []);
  });

  it("skips empty events without creating vector coverage or running inference", async (t) => {
    const f = await fixture(t, provider({
      async embed() { assert.fail("empty input must not run inference"); },
      async processAttachment() { assert.fail("empty input must not run inference"); },
    }));
    await f.ingest.ingest(batch("create", "  \n "));
    assert.deepEqual(await f.worker.runOnce(), { processed: 1, failed: 0, superseded: 0 });
    const [job] = await f.index.listJobs("org", generation.id);
    assert.equal(job.status, "skipped");
    const result = await f.index.matchAuthorized({
      org_id: "org", generation: generation.id,
      authorized: [{ event_id: job.event_id, content_hash: job.content_hash }],
      query_vector: [1, 0], limit: 10,
    });
    assert.deepEqual(result.covered, []);
    assert.deepEqual(result.skipped, [{ event_id: job.event_id, content_hash: job.content_hash }]);
    await activateEmbeddingGeneration("org", generation.id, f.source, f.index, f.index);
  });

  it("keeps legacy manifests readable and promotes attachment coverage only once", async (t) => {
    const legacy = embeddingGeneration(descriptor, 32, 128, "stored-body-text-v1");
    const embedded = [];
    const f = await fixture(t, provider({
      async embed(texts) { embedded.push(...texts); return texts.map(() => [1, 0]); },
      async processAttachment() { return { vectors: [[1, 0]] }; },
    }));
    await f.index.registerGeneration("org", legacy);
    const input = batch("create", "legacy body");
    input.records[0].content.push({
      role: "attachment", media_type: "application/octet-stream",
      source_filename: "notes.txt", bytes: Buffer.from("attachment"),
    });
    await f.ingest.ingest(input);
    await f.worker.runOnce();
    assert.ok(embedded.includes("legacy body"));
    assert.ok(embedded.includes("legacy body\n\nattachment"));
    assert.equal((await f.index.activeGeneration("org")).id, generation.id);
    assert.equal((await f.index.listGenerations("org")).find(
      (entry) => entry.manifest.id === generation.id,
    ).previously_active, true);
    await activateEmbeddingGeneration("org", legacy.id, f.source, f.index, f.index);
    await f.worker.runOnce();
    assert.equal((await f.index.activeGeneration("org")).id, legacy.id);
    assert.notEqual(legacy.id, generation.id);
  });

  it("does not publish body coverage when attachment processing exceeds chunk limits", async (t) => {
    const small = embeddingGeneration(descriptor, 32, 1);
    const f = await fixture(t, provider({
      async processAttachment() { return { vectors: [[1, 0]] }; },
    }), small);
    const input = batch("create", "body");
    input.records[0].content.push({
      role: "attachment", media_type: "application/pdf", bytes: Buffer.from("%PDF-synthetic"),
    });
    await f.ingest.ingest(input);
    assert.equal((await f.worker.runOnce()).failed, 1);
    const [job] = await f.index.listJobs("org", small.id);
    assert.equal(job.error_code, "input_too_large");
    assert.deepEqual((await f.index.matchAuthorized({
      org_id: "org", generation: small.id,
      authorized: [{ event_id: job.event_id, content_hash: job.content_hash }],
      query_vector: [1, 0], limit: 10,
    })).covered, []);
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
