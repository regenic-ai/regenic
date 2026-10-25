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
    path,
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
  it("searches an authorization set above 10000 and retains the global top-k, not the first k", async (t) => {
    const { index } = await fixture(t);
    await reconcile(index, [head("event-00000"), head("event-05000"), head("event-10004"), head("hidden")]);
    const vectors = new Map([
      ["event-00000", [0, 1]], ["event-05000", [0.6, 0.8]], ["event-10004", [1, 0]], ["hidden", [1, 0]],
    ]);
    for (const job of await claim(index)) {
      await index.complete({ job, owner: "owner", now: at, chunks: [chunk(vectors.get(job.event_id))] });
    }
    const authorized = Array.from({ length: 10005 }, (_, id) => ({
      event_id: `event-${String(id).padStart(5, "0")}`, content_hash: hash,
    }));
    const result = await query(index, authorized, { limit: 1 });
    assert.equal(result.covered.length, 3);
    assert.deepEqual(result.matched.map((hit) => [hit.event_id, hit.score]), [["event-10004", 1]]);
  });

  it("requeues only bounded current failed/quarantined jobs without changing leases, successes or other scopes", async (t) => {
    const f = await fixture(t);
    const heads = ["good", "running", "failed", "quarantined", "stale"].map((id) => head(id));
    await reconcile(f.index, heads);
    const jobs = await claim(f.index);
    await f.index.complete({ job: jobs[0], owner: "owner", now: at, chunks: [chunk()] });
    for (const job of jobs.slice(2)) {
      await f.index.fail({ job, owner: "owner", now: at, retry_at: later,
        error_code: "unavailable", retryable: job.event_id === "failed" });
    }
    await reconcile(f.index, [...heads.slice(0, 4), head("replacement", {
      external_id: "stale", operation: "revise", lineage: ["stale", "replacement"],
    })]);
    const next = embeddingGeneration(model, 64);
    for (const [org, gen] of [["other", generation], ["org", next]]) {
      await f.index.registerGeneration(org, gen);
      await reconcile(f.index, [head("separate")], org, gen);
      for (const job of await claim(f.index, "owner", at, org, gen)) {
        await f.index.fail({ job, owner: "owner", now: at, retry_at: later, error_code: "unavailable", retryable: false });
      }
    }
    for (const limit of [0, 21, 1.5]) await assert.rejects(f.index.retryFailed("org", generation.id, limit));
    assert.equal(await f.index.retryFailed("org", generation.id, 1), 1);
    assert.equal(await f.index.retryFailed("org", generation.id, 20), 1);
    assert.equal(await f.index.retryFailed("org", generation.id, 20), 0);
    f.reopen();
    const after = await f.index.listJobs("org", generation.id);
    assert.equal(after.find((job) => job.event_id === "good").status, "succeeded");
    assert.equal(after.find((job) => job.event_id === "stale").status, "superseded");
    assert.equal(after.find((job) => job.event_id === "running").status, "running");
    for (const id of ["failed", "quarantined"]) {
      const job = after.find((value) => value.event_id === id);
      assert.equal(job.status, "pending");
      assert.equal(job.attempts, 1);
      assert.equal(job.error_code, undefined);
    }
    assert.equal((await f.index.listJobs("other", generation.id))[0].status, "quarantined");
    assert.equal((await f.index.listJobs("org", next.id))[0].status, "quarantined");
    assert.deepEqual((await query(f.index, [{ event_id: "good", content_hash: hash }])).matched.map((match) => match.event_id), ["good"]);
    assert.equal(await f.index.complete({ job: jobs[1], owner: "owner", now: at, chunks: [chunk()] }), true);
  });

  it("switches only fully covered reconciled generations, persists rollback and guards collection", async (t) => {
    const f = await fixture(t);
    const next = embeddingGeneration(model, 64);
    await f.index.registerGeneration("org", next);
    assert.equal((await f.index.activeGeneration("org")).id, generation.id);
    await reconcile(f.index, [head("event")], "org", next);
    const proof = { org_id: "org", generation: next.id, read_epoch: "authority:1",
      required: [{ event_id: "event", content_hash: hash }] };
    await assert.rejects(f.index.activateGeneration(proof), /not fully covered/);
    const [job] = await claim(f.index, "owner", at, "org", next);
    await f.index.complete({ job, owner: "owner", now: at, chunks: [chunk()] });
    await assert.rejects(f.index.activateGeneration({ ...proof, read_epoch: "authority:2" }), /current Authority epoch/);
    await assert.rejects(f.index.activateGeneration({ ...proof, required: [...proof.required, ...proof.required] }), /coverage proof/);
    await f.index.activateGeneration(proof);
    f.reopen();
    assert.equal((await f.index.activeGeneration("org")).id, next.id);
    await assert.rejects(f.index.removeGeneration("org", next.id), /active generation/);
    assert.equal(await f.index.activeGeneration("another-org"), undefined);
    await reconcile(f.index, [head("event")]);
    await assert.rejects(f.index.activateGeneration({ ...proof, generation: generation.id }), /not fully covered/);
    const [previous] = await claim(f.index);
    await f.index.complete({ job: previous, owner: "owner", now: at, chunks: [chunk()] });
    await f.index.activateGeneration({ ...proof, generation: generation.id });
    await f.index.removeGeneration("org", next.id);
    await assert.rejects(f.index.registerGeneration("org", next), /was collected/);
    f.reopen();
    await assert.rejects(f.index.registerGeneration("org", next), /was collected/);
    assert.equal((await f.index.listGenerations("org")).length, 1);
    await assert.rejects(query(f.index, proof.required, { generation: next.id }), /not registered/);
    await assert.rejects(f.index.complete({ job, owner: "owner", now: later, chunks: [chunk()] }), /not registered/);
    await f.index.clearOrganization("org");
    assert.equal(await f.index.activeGeneration("org"), undefined);
  });

  it("migrates schema v1 without inventing an active generation before configured registration", async (t) => {
    const f = await fixture(t);
    f.index.close();
    const Database = require("better-sqlite3");
    const db = new Database(f.path);
    db.exec("DROP TABLE active_generations; PRAGMA user_version=1;");
    db.close();
    f.reopen();
    assert.equal(await f.index.activeGeneration("org"), undefined);
    await f.index.registerGeneration("org", generation);
    assert.equal((await f.index.activeGeneration("org")).id, generation.id);
  });

  it("refuses collection while an inactive generation still has a live indexing lease", async (t) => {
    const { index } = await fixture(t);
    const next = embeddingGeneration(model, 64);
    await index.registerGeneration("org", next);
    await reconcile(index, [head("event")], "org", next);
    const now = new Date().toISOString();
    await index.claim({ org_id: "org", generation: next.id, owner: "live", now, lease_ms: 90000, limit: 1 });
    await assert.rejects(index.removeGeneration("org", next.id), /live indexing lease/);
    assert.equal((await index.listGenerations("org")).length, 2);
  });
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
