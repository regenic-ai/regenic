const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { embeddingGeneration } = require("@regenic/domain");
const { SqliteContextVectorIndex } = require("../dist");

const model = {
  model_id: "synthetic/test", model_revision: "a".repeat(40), tokenizer_revision: "a".repeat(40),
  dimensions: 2, max_input_tokens: 128, query_template: "query: ", document_template: "document: ",
  normalization: "l2", similarity: "cosine", numeric_format: "float32",
};
const generation = embeddingGeneration(model, 32);
const hash = "b".repeat(64);
const at = "2026-10-16T00:00:00.000Z";
const later = "2026-10-16T00:00:02.000Z";
const head = (eventId, extra = {}) => ({
  source: "synthetic", external_id: eventId, event_id: eventId, content_hash: hash,
  operation: "create", lineage: [eventId], ...extra,
});
const chunk = (vector = [1, 0], ordinal = 0) => ({ ordinal, start: ordinal * 2, end: (ordinal + 1) * 2, text_hash: hash, vector });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "regenic-vector-test-"));
  const path = join(root, "vectors.db");
  let index = new SqliteContextVectorIndex(path);
  await index.registerGeneration("org", generation);
  t.after(async () => { index.close(); await rm(root, { recursive: true, force: true }); });
  return {
    get index() { return index; },
    reopen() { index.close(); index = new SqliteContextVectorIndex(path); return index; },
  };
}
async function reconcile(index, heads, org = "org", gen = generation) {
  await index.reconcile({ org_id: org, generation: gen.id, heads, read_epoch: "authority:1", now: at });
}
async function claim(index, owner = "owner", now = at, org = "org", gen = generation) {
  return index.claim({ org_id: org, generation: gen.id, owner, now, lease_ms: 1000, limit: 10 });
}
function query(index, authorized, extra = {}) {
  return index.matchAuthorized({ org_id: "org", generation: generation.id, authorized, query_vector: [1, 0], limit: 10, ...extra });
}

describe("SQLite vector projection and independent durable jobs", () => {
  it("scans only authorized Event/hash keys, aggregates chunks once, and has stable ties", async (t) => {
    const { index } = await fixture(t);
    await reconcile(index, [head("event-b"), head("event-a"), head("hidden")]);
    for (const job of await claim(index)) {
      assert.equal(await index.complete({ job, owner: "owner", now: at, chunks: [chunk(), chunk([1, 0], 1)] }), true);
    }
    const result = await query(index, [{ event_id: "event-b", content_hash: hash }, { event_id: "event-a", content_hash: hash }], { limit: 1 });
    assert.equal(result.covered.length, 2);
    assert.equal(result.reconciled_epoch, "authority:1");
    assert.deepEqual(result.matched.map((match) => [match.event_id, match.chunk_ordinal, match.score]), [["event-a", 0, 1]]);
    assert.deepEqual((await query(index, [{ event_id: "event-a", content_hash: "c".repeat(64) }])).covered, []);
    assert.equal((await query(index, [{ event_id: "event-a", content_hash: hash }], {
      query_vector: [1.0005, 0],
    })).matched[0].score, 1);
    await assert.rejects(query(index, [{ event_id: "event-a", content_hash: hash }, { event_id: "event-a", content_hash: hash }]));
  });

  it("recovers expired leases across restart and rejects old owners and partial publications", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("event-a")]);
    const [old] = await claim(f.index);
    assert.equal(await f.index.complete({
      job: { ...old, source: "forged-source" }, owner: "owner", now: at, chunks: [chunk()],
    }), false);
    assert.deepEqual(await claim(f.index, "competing"), []);
    f.reopen();
    const [current] = await claim(f.index, "new-owner", later);
    assert.equal(current.attempts, 2);
    assert.equal(await f.index.complete({ job: old, owner: "owner", now: later, chunks: [chunk()] }), false);
    await assert.rejects(f.index.complete({ job: current, owner: "new-owner", now: later, chunks: [chunk(), chunk([1, 0], 2)] }));
    assert.deepEqual((await query(f.index, [{ event_id: "event-a", content_hash: hash }])).covered, []);
    assert.equal(await f.index.complete({ job: current, owner: "new-owner", now: later, chunks: [chunk()] }), true);
    f.reopen();
    assert.equal((await query(f.index, [{ event_id: "event-a", content_hash: hash }])).covered.length, 1);
    assert.equal((await f.index.listJobs("org", generation.id))[0].status, "succeeded");
  });

  it("invalidates all generations on revision/deletion and fences late or stale work", async (t) => {
    const { index } = await fixture(t);
    const nextGeneration = embeddingGeneration({ ...model, tokenizer_revision: "c".repeat(40) }, 32);
    await index.registerGeneration("org", nextGeneration);
    await reconcile(index, [head("original")]);
    const [oldJob] = await claim(index);
    await reconcile(index, [head("original")], "org", nextGeneration);
    const [otherJob] = await claim(index, "other", at, "org", nextGeneration);
    await index.complete({ job: otherJob, owner: "other", now: at, chunks: [chunk()] });
    const revised = head("revision", { external_id: "original", operation: "revise", lineage: ["original", "revision"] });
    await reconcile(index, [revised]);
    assert.equal(await index.complete({ job: oldJob, owner: "owner", now: at, chunks: [chunk()] }), false);
    assert.deepEqual((await query(index, [{ event_id: "original", content_hash: hash }], { generation: nextGeneration.id })).covered, []);
    await assert.rejects(reconcile(index, [head("original")]), /Stale/);
    const [revisionJob] = await claim(index);
    const deleted = head("deleted", { external_id: "original", operation: "tombstone", content_hash: undefined, lineage: ["original", "revision", "deleted"] });
    await reconcile(index, [deleted]);
    assert.equal(await index.complete({ job: revisionJob, owner: "owner", now: at, chunks: [chunk()] }), false);
    assert.deepEqual((await query(index, [{ event_id: "revision", content_hash: hash }])).matched, []);
  });

  it("isolates org/generation, validates vectors, and clears outstanding jobs without resurrection", async (t) => {
    const { index } = await fixture(t);
    await index.registerGeneration("other-org", generation);
    await reconcile(index, [head("same")]);
    await reconcile(index, [head("same")], "other-org");
    const [job] = await claim(index);
    for (const vector of [[0, 0], [Infinity, 0], [1, 0, 0], Object.assign(Array(2), { 0: 1 })]) {
      await assert.rejects(index.complete({ job, owner: "owner", now: at, chunks: [chunk(vector)] }));
    }
    await index.complete({ job, owner: "owner", now: at, chunks: [chunk()] });
    assert.deepEqual((await query(index, [{ event_id: "same", content_hash: hash }], { org_id: "other-org" })).matched, []);
    await index.clearOrganization("org");
    await assert.rejects(index.complete({ job, owner: "owner", now: at, chunks: [chunk()] }), /not registered/);
    assert.equal((await index.listJobs("other-org", generation.id)).length, 1);
    await index.registerGeneration("org", generation);
    assert.deepEqual(await index.listJobs("org", generation.id), []);
  });

  it("persists safe retry/quarantine states and requires explicit replay of a current quarantined job", async (t) => {
    const { index } = await fixture(t);
    await reconcile(index, [head("event")]);
    const [job] = await claim(index);
    assert.equal(await index.fail({ job, owner: "owner", now: at, retry_at: later, error_code: "timeout", retryable: true }), true);
    assert.deepEqual(await claim(index), []);
    const [retried] = await claim(index, "retry", later);
    assert.equal(await index.fail({ job: retried, owner: "retry", now: later, retry_at: later, error_code: "invalid_input", retryable: false }), true);
    assert.deepEqual(await claim(index, "third", later), []);
    assert.equal(await index.retryQuarantined("org", generation.id, "event"), true);
    assert.equal((await claim(index, "manual", later))[0].attempts, 3);
  });
});
