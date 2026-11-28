const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");
const Database = require("better-sqlite3");
const {
  contextVectorAuthorizationAccumulator,
  contextVectorAuthorizationHash,
  contextVectorAuthorizationHashFromAccumulator,
  embeddingGeneration,
  updateContextVectorAuthorizationAccumulator,
} = require("@regenic/domain");
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
  it("can claim newest jobs first without changing the durable default order", async t => {
    const f = await fixture(t);
    await reconcile(f.index, [head("old"), head("middle"), head("new")]);
    assert.deepEqual((await f.index.claim({
      org_id: "org", generation: generation.id, owner: "recent",
      now: at, lease_ms: 1000, limit: 3, order: "newest",
    })).map((job) => job.external_id), ["new", "middle", "old"]);

    await f.index.registerGeneration("other", generation);
    await reconcile(f.index, [head("old"), head("middle"), head("new")], "other");
    assert.deepEqual((await claim(
      f.index, "default", at, "other",
    )).map((job) => job.external_id), ["old", "middle", "new"]);
  });

  it("claims text from the fast lane and leaves a marked attachment for the slow lane", async t => {
    const f = await fixture(t);
    await reconcile(f.index, [head("text"), head("file")]);
    const [file] = await f.index.claim({
      org_id: "org", generation: generation.id, owner: "owner",
      now: at, lease_ms: 1000, limit: 1, order: "newest",
    });
    assert.equal(file.external_id, "file");
    assert.equal(await f.index.noteSlowLane(file, "owner", at), true);
    assert.equal(await f.index.yieldJob(file, "owner", at), true);
    assert.deepEqual((await f.index.claim({
      org_id: "org", generation: generation.id, owner: "fast",
      now: at, lease_ms: 1000, limit: 10, lane: "fast", order: "newest",
    })).map((job) => job.external_id), ["text"]);
    assert.deepEqual((await f.index.claim({
      org_id: "org", generation: generation.id, owner: "slow",
      now: at, lease_ms: 1000, limit: 10, lane: "slow", order: "newest",
    })).map((job) => job.external_id), ["file"]);
    const database = new Database(f.path, { readonly: true });
    try {
      const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM jobs
        WHERE org_id=? AND generation=? AND status='pending' AND lane IS NULL
        ORDER BY id DESC LIMIT ?`).all("org", generation.id, 1)
        .map((row) => row.detail).join("\n");
      assert.match(plan, /INDEX jobs_pending_fast/);
      assert.doesNotMatch(plan, /TEMP B-TREE/);
    } finally {
      database.close();
    }
  });

  it("keeps completed history out of the claim and admits a failure only after its retry time", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("old"), head("new"), head("waiting")]);
    const claims = [];
    const claimOne = async (owner, now, order) => {
      const recorded = [];
      const execs = [];
      const originalPrepare = Database.prototype.prepare;
      const originalExec = Database.prototype.exec;
      Database.prototype.prepare = function (sql) {
        recorded.push(sql);
        return originalPrepare.call(this, sql);
      };
      Database.prototype.exec = function (sql) {
        execs.push(sql);
        return originalExec.call(this, sql);
      };
      try {
        const jobs = await f.index.claim({
          org_id: "org", generation: generation.id, owner, now, lease_ms: 60_000, limit: 1, order,
        });
        claims.push({ order, recorded, execs });
        return jobs;
      } finally {
        Database.prototype.prepare = originalPrepare;
        Database.prototype.exec = originalExec;
      }
    };
    const [oldest] = await claimOne("owner", at, "oldest");
    assert.equal(oldest.external_id, "old");
    assert.equal(await f.index.fail({
      job: oldest, owner: "owner", now: at, retry_at: later, error_code: "timeout", retryable: true,
    }), true);
    assert.deepEqual((await claimOne("owner", at, "oldest")).map((job) => job.external_id), ["new"]);
    assert.equal((await f.index.listJobs("org", generation.id))
      .find((job) => job.external_id === "old").status, "failed");
    assert.deepEqual((await claimOne("owner", later, "newest")).map((job) => job.external_id), ["waiting"]);
    assert.deepEqual((await claimOne("retry", later, "newest")).map((job) => job.external_id), ["old"]);

    await reconcile(f.index, [head("behind"), head("ahead")]);
    const [ahead] = await claimOne("owner", later, "newest");
    assert.equal(ahead.external_id, "ahead");
    assert.equal(await f.index.fail({
      job: ahead, owner: "owner", now: later, retry_at: later, error_code: "timeout", retryable: true,
    }), true);
    assert.deepEqual((await claimOne("owner", later, "newest")).map((job) => job.external_id), ["ahead"]);

    const pending = [];
    const due = [];
    const expired = [];
    for (const claim of claims) {
      assert.deepEqual(claim.execs, []);
      const selects = claim.recorded.filter((sql) => /^\s*SELECT\b/i.test(sql));
      assert.equal(selects.length, 3, selects.join("\n---\n"));
      const pendingSql = selects.find((sql) => sql.includes("status='pending'"));
      const dueSql = selects.find((sql) => sql.includes("status='failed'"));
      const expiredSql = selects.find((sql) => sql.includes("status='running'"));
      assert.ok(pendingSql && dueSql && expiredSql, selects.join("\n---\n"));
      assert.equal(new Set([pendingSql, dueSql, expiredSql]).size, 3, selects.join("\n---\n"));
      const direction = claim.order === "newest" ? "DESC" : "ASC";
      assert.match(pendingSql, new RegExp(`ORDER BY id ${direction}`));
      assert.match(pendingSql, /LIMIT \?/);
      assert.doesNotMatch(pendingSql, /UNION|status='failed'|status='running'/);
      assert.match(dueSql, /retry_at<=\?/);
      assert.doesNotMatch(dueSql, /UNION|ORDER BY|LIMIT|status='pending'|status='running'/);
      assert.match(expiredSql, /started_at/);
      assert.match(expiredSql, /processing_ms/);
      assert.match(expiredSql, /ORDER BY lease_until/);
      assert.doesNotMatch(expiredSql, /UNION|ORDER BY id|status='pending'|status='failed'/);
      pending.push(pendingSql);
      due.push(dueSql);
      expired.push(expiredSql);
    }
    const database = new Database(f.path, { readonly: true });
    try {
      const explain = (sql, params) => {
        assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
        return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
          .map((row) => row.detail).join("\n");
      };
      for (const sql of new Set(pending)) {
        const plan = explain(sql, ["org", generation.id, 1]);
        assert.match(plan, /INDEX jobs_pending_id/, sql);
        assert.doesNotMatch(plan, /TEMP B-TREE/, sql);
      }
      for (const sql of new Set(due)) {
        const plan = explain(sql, ["org", generation.id, at]);
        assert.match(plan, /retry_at</, sql);
        assert.doesNotMatch(plan, /TEMP B-TREE/, sql);
      }
      for (const sql of new Set(expired)) {
        const plan = explain(sql, ["org", generation.id, at]);
        assert.match(plan, /INDEX jobs_running_lease/, sql);
        assert.doesNotMatch(plan, /TEMP B-TREE/, sql);
      }
    } finally {
      database.close();
    }
  });

  it("revokes visual indexes across generations while preserving contiguous text, namespaces and reindex eligibility", async t => {
    const f = await fixture(t);
    const second = embeddingGeneration(model, 64);
    await f.index.registerGeneration("org", second);
    await f.index.registerGeneration("other", generation);
    const visual = (ordinal, start) => ({
      ordinal, start, end: start + 1, vector: [1, 0],
      text_hash: createHash("sha256").update(`${hash}:0`).digest("hex"),
      origin: { part_index: 2, content_hash: hash, mode: "visual", start: 0 },
    });
    const text = (ordinal, start, value) => ({
      ordinal, start, end: start + value.length, vector: [0, 1],
      text_hash: createHash("sha256").update(value).digest("hex"),
      origin: { part_index: 1, content_hash: hash, mode: "text", start: 0, text: value },
    });
    for (const [org, gen] of [["org", generation], ["org", second], ["other", generation]]) {
      await reconcile(f.index, [head("mixed"), head("image"), head("staged")], org, gen);
      for (const job of await claim(f.index, "owner", at, org, gen)) {
        if (job.event_id === "staged") {
          await f.index.stageChunk({ job, owner: "owner", now: at, chunk: visual(0, 0) });
        } else {
          await f.index.complete({ job, owner: "owner", now: at, chunks: job.event_id === "image"
            ? [visual(0, 0)] : [visual(0, 0), text(1, 1, "first"), visual(2, 6), text(3, 7, "second")] });
        }
      }
    }
    await f.index.setVisualEnabled("org", false);
    const db = new Database(f.path);
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM chunks WHERE org_id='org' AND json_extract(origin_json,'$.mode')='visual'").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM staged_chunks s JOIN jobs j ON j.id=s.job_id WHERE j.org_id='org'").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM chunks WHERE org_id='other'").get().n, 5);
      assert.equal(db.prepare("SELECT count(*) AS n FROM staged_chunks s JOIN jobs j ON j.id=s.job_id WHERE j.org_id='other'").get().n, 1);
      for (const gen of [generation, second]) {
        assert.deepEqual(db.prepare("SELECT ordinal,start,end FROM chunks WHERE org_id='org' AND generation=? AND event_id='mixed' ORDER BY ordinal").all(gen.id),
          [{ ordinal: 0, start: 0, end: 5 }, { ordinal: 1, start: 5, end: 11 }]);
        const result = await query(f.index, [{ event_id: "mixed", content_hash: hash }, { event_id: "image", content_hash: hash }],
          { generation: gen.id, query: "first", search_kind: "files" });
        assert.equal(result.matched.length, 1);
        assert.ok(result.matched[0].search_matches.every(match => match.origin.mode === "text"));
      }
    } finally { db.close(); }
    f.reopen();
    await f.index.setVisualEnabled("org", false);
    assert.equal((await f.index.listJobs("org", generation.id)).find(job => job.event_id === "mixed").status, "succeeded");
    await f.index.setVisualEnabled("org", true);
    const jobs = await f.index.listJobs("org", generation.id);
    assert.ok(jobs.every(job => job.status === "pending"));
    assert.equal((await query(f.index, [{ event_id: "mixed", content_hash: hash }], { query: "first" })).matched.length, 1);
  });

  it("denied visual permission fences stale work and rejects visual staging and publication", async t => {
    const f = await fixture(t);
    await reconcile(f.index, [head("image")]);
    const [stale] = await claim(f.index);
    await f.index.setVisualEnabled("org", false);
    const value = {
      ordinal: 0, start: 0, end: 1, vector: [1, 0],
      text_hash: createHash("sha256").update(`${hash}:0`).digest("hex"),
      origin: { part_index: 1, content_hash: hash, mode: "visual", start: 0 },
    };
    assert.equal(await f.index.complete({ job: stale, owner: "owner", now: at, chunks: [value] }), false);
    const [current] = await claim(f.index);
    await assert.rejects(f.index.stageChunk({ job: current, owner: "owner", now: at, chunk: value }), /permission is disabled/);
    await assert.rejects(f.index.complete({ job: current, owner: "owner", now: at, chunks: [value] }), /permission is disabled/);
    await f.index.clearOrganization("org");
    await f.index.registerGeneration("org", generation);
    await reconcile(f.index, [head("image")]);
    const [rebuilt] = await claim(f.index);
    await assert.rejects(f.index.complete({ job: rebuilt, owner: "owner", now: at, chunks: [value] }), /permission is disabled/);
  });

  it("excludes attachment lexical priority from messages-only top-k while preserving file/all priority", async (t) => {
    const f = await fixture(t);
    const heads = [...Array.from({ length: 50 }, (_, index) => head(`mixed-${index}`)), head("message")];
    await reconcile(f.index, heads);
    for (;;) {
      const jobs = await claim(f.index);
      if (!jobs.length) break;
      for (const job of jobs) {
        const body = chunk(job.event_id === "message" ? [1, 0] : [0, 1]);
        const text = "nebula";
        const attachment = {
          ordinal: 1, start: 2, end: 2 + text.length, vector: [0, 1],
          text_hash: createHash("sha256").update(text).digest("hex"),
          origin: { part_index: 1, content_hash: hash, mode: "text", start: 0, text },
        };
        await f.index.complete({ job, owner: "owner", now: at,
          chunks: job.event_id === "message" ? [body] : [body, attachment] });
      }
    }
    const authorized = heads.map((value) => ({ event_id: value.event_id, content_hash: hash, body_length: 2 }));
    const messages = await query(f.index, authorized, { query: "nebula", search_kind: "messages", limit: 50 });
    assert.equal(messages.matched[0].event_id, "message");
    assert.ok(messages.matched.every((hit) => hit.search_matches === undefined));
    for (const search_kind of ["all", "files"]) {
      const result = await query(f.index, authorized, { query: "nebula", search_kind, limit: 50 });
      assert.equal(result.matched.length, 50);
      assert.ok(result.matched.every((hit) => hit.event_id.startsWith("mixed-") && hit.search_matches[0].lexical));
    }
  });

  it("matches continuous file text across chunks but not attachments, hashes, gaps, visual units or missing provenance", async (t) => {
    const f = await fixture(t);
    const cases = ["continuous", "control", "attachment", "hash", "gap", "visual", "missing", "event-a", "event-b"];
    await reconcile(f.index, cases.map((id) => head(id)));
    const textChunk = (text, ordinal, start, partIndex, localStart, contentHash = hash) => ({
      ordinal, start, end: start + text.length, vector: [0, 1],
      text_hash: createHash("sha256").update(text).digest("hex"),
      origin: { part_index: partIndex, content_hash: contentHash, mode: "text", start: localStart, text },
    });
    for (const job of await claim(f.index)) {
      let chunks;
      if (job.event_id === "control") {
        chunks = [textChunk("😀 nebula invoice", 0, 0, 1, 7)];
      } else if (job.event_id.startsWith("event-")) {
        chunks = [textChunk(job.event_id === "event-a" ? " ne" : "bula invoice", 0, 0, 1, 0)];
      } else {
        chunks = [textChunk("😀 ne", 0, 0, 1, 7)];
        if (job.event_id === "visual") {
          chunks.push({ ordinal: 1, start: 5, end: 6, vector: [0, 1],
            text_hash: createHash("sha256").update(`${hash}:0`).digest("hex"),
            origin: { part_index: 1, content_hash: hash, mode: "visual", start: 0 } });
        } else if (job.event_id === "missing") {
          chunks.push({ ...chunk([0, 1], 1), start: 5, end: 6 });
        }
        chunks.push(textChunk("bula invoice", chunks.length, chunks.at(-1).end,
          job.event_id === "attachment" ? 2 : 1, job.event_id === "gap" ? 13 : 12,
          job.event_id === "hash" ? "c".repeat(64) : hash));
      }
      await f.index.complete({ job, owner: "owner", now: at, chunks });
    }
    f.reopen();
    const authorized = cases.map((event_id) => ({ event_id, content_hash: hash }));
    for (const result of [
      await query(f.index, authorized, { query: "nebula", search_kind: "files" }),
      await f.index.matchAuthorizedText({ org_id: "org", generation: generation.id, authorized, query: "nebula", limit: 10 }),
    ]) {
      const lexical = result.matched.filter((hit) => hit.search_matches.some((match) => match.lexical));
      assert.deepEqual(lexical.map((hit) => hit.event_id), ["continuous", "control"]);
      for (const hit of lexical) {
        const origin = hit.search_matches.find((match) => match.lexical).origin;
        assert.equal(origin.part_index, 1);
        assert.equal(origin.start, 7);
        assert.equal(origin.text, "😀 nebula invoice");
      }
    }
    const partial = await f.index.matchAuthorizedText({
      org_id: "org", generation: generation.id,
      authorized: authorized.filter((key) => ["continuous", "control"].includes(key.event_id)),
      query: "ne", limit: 10,
    });
    assert.deepEqual(partial.matched, []);
  });

  it("applies message/file vector selection before top-k rather than filling it with the other kind", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("file"), head("message")]);
    for (const job of await claim(f.index)) {
      const value = chunk(job.event_id === "file" ? [1, 0] : [0.8, 0.6]);
      if (job.event_id === "file") {
        value.origin = { part_index: 1, content_hash: hash, mode: "text", start: 0, text: "xx" };
        value.text_hash = createHash("sha256").update("xx").digest("hex");
      }
      await f.index.complete({ job, owner: "owner", now: at, chunks: [value] });
    }
    const authorized = [
      { event_id: "file", content_hash: hash, body_length: 0 },
      { event_id: "message", content_hash: hash, body_length: 2 },
    ];
    assert.deepEqual((await query(f.index, authorized, { limit: 1, query: "other", search_kind: "messages" })).matched.map((hit) => hit.event_id), ["message"]);
    assert.deepEqual((await query(f.index, authorized, { limit: 1, query: "other", search_kind: "files" })).matched.map((hit) => hit.event_id), ["file"]);
  });

  it("runs message, file, and all searches through partitioned native KNN", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("file"), head("message"), head("both"), head("overflow")]);
    for (const job of await claim(f.index)) {
      if (job.event_id === "file") {
        const value = chunk([1, 0]);
        value.origin = { part_index: 1, content_hash: hash, mode: "text", start: 0, text: "xx" };
        value.text_hash = createHash("sha256").update("xx").digest("hex");
        await f.index.complete({ job, owner: "owner", now: at, chunks: [value] });
      } else if (job.event_id === "message") {
        await f.index.complete({ job, owner: "owner", now: at, chunks: [chunk([0.8, 0.6])] });
      } else if (job.event_id === "overflow") {
        await f.index.complete({ job, owner: "owner", now: at, chunks: [{ ...chunk([0.6, 0.8]), end: 4 }] });
      } else {
        const text = "nebula";
        await f.index.complete({ job, owner: "owner", now: at, chunks: [
          chunk([0, 1]),
          {
            ordinal: 1, start: 2, end: 2 + text.length, vector: [0.6, 0.8],
            text_hash: createHash("sha256").update(text).digest("hex"),
            origin: { part_index: 1, content_hash: hash, mode: "text", start: 0, text },
          },
        ] });
      }
    }
    const authorized = [
      { event_id: "file", content_hash: hash, body_length: 0 },
      { event_id: "message", content_hash: hash, body_length: 2 },
      { event_id: "both", content_hash: hash, body_length: 2 },
      { event_id: "overflow", content_hash: hash, body_length: 2 },
    ];
    const authorization_hash = contextVectorAuthorizationHash(authorized);
    const messages = await query(f.index, authorized, {
      authorization_hash, search_kind: "messages", limit: 2, query: "other",
    });
    assert.equal(messages.acceleration.algorithm_version, "sqlite-vec-authorized-exact-v1");
    assert.equal(messages.acceleration.authorization_update, "rebuilt");
    assert.deepEqual(messages.matched.map((hit) => hit.event_id), ["message", "both"]);
    assert.ok(messages.matched.every((hit) => hit.search_matches === undefined));
    const files = await query(f.index, authorized, {
      authorization_hash, search_kind: "files", limit: 1, query: "other",
    });
    assert.equal(files.acceleration.authorization_update, "reused");
    assert.deepEqual(files.matched.map((hit) => hit.event_id), ["file"]);
    const all = await query(f.index, authorized, {
      authorization_hash, search_kind: "all", limit: 4, query: "nebula",
    });
    assert.equal(all.acceleration.authorized_chunks, 5);
    assert.deepEqual(all.matched.map((hit) => hit.event_id), ["both", "file", "message", "overflow"]);
    assert.equal(all.matched.find((hit) => hit.event_id === "both").search_matches.some((match) => match.lexical), true);
    assert.equal(all.matched.find((hit) => hit.event_id === "overflow").search_matches, undefined);
    f.reopen();
    const reopened = await query(f.index, authorized, {
      authorization_hash, search_kind: "all", limit: 4, query: "nebula",
    });
    assert.equal(reopened.acceleration.authorization_update, "reused");
    assert.equal(reopened.acceleration.authorized_chunks, 5);
    assert.deepEqual(reopened.matched.map((hit) => hit.event_id), ["both", "file", "message", "overflow"]);
  });

  it("round-trips attachment provenance through fenced checkpoints and authorized completed reads", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("origin")]);
    const [job] = await claim(f.index);
    const text = "nebula";
    const origin = { part_index: 3, content_hash: "c".repeat(64), mode: "text", start: 0, text };
    const value = { ordinal: 0, start: 0, end: text.length, text_hash: createHash("sha256").update(text).digest("hex"), vector: [0, 1], origin };
    assert.equal(await f.index.stageChunk({ job, owner: "owner", now: at, chunk: value }), true);
    f.reopen();
    assert.deepEqual(await f.index.loadStagedChunks(job, "owner", at), [value]);
    assert.deepEqual((await query(f.index, [{ event_id: job.event_id, content_hash: hash }], { query: text })).matched, []);
    assert.equal(await f.index.complete({ job, owner: "owner", now: at, chunks: [value] }), true);
    f.reopen();
    const result = await query(f.index, [{ event_id: job.event_id, content_hash: hash }], { query: text });
    assert.deepEqual(result.matched[0].search_matches, [{ origin, score: 0, lexical: true }]);
    assert.deepEqual((await query(f.index, [], { query: text })).matched, []);
    const keyword = await f.index.matchAuthorizedText({
      org_id: "org", generation: generation.id, authorized: [{ event_id: job.event_id, content_hash: hash }],
      query: text, limit: 1,
    });
    assert.equal(keyword.matched[0].score, -1);
    assert.deepEqual(keyword.matched[0].search_matches[0].origin, origin);
  });

  it("migrates schema v4 additively without discarding complete or staged chunks", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("complete"), head("pending")]);
    const jobs = await claim(f.index);
    await f.index.complete({ job: jobs[0], owner: "owner", now: at, chunks: [chunk()] });
    await f.index.stageChunk({ job: jobs[1], owner: "owner", now: at, chunk: chunk() });
    f.index.close();
    const database = new Database(f.path);
    database.exec(`ALTER TABLE chunks DROP COLUMN origin_json;
      ALTER TABLE staged_chunks DROP COLUMN origin_json;
      ALTER TABLE jobs DROP COLUMN started_at;
      ALTER TABLE jobs DROP COLUMN completed_at;
      ALTER TABLE jobs DROP COLUMN processing_ms;
      PRAGMA user_version=4;`);
    database.close();
    f.reopen();
    assert.equal((await query(f.index, [{ event_id: jobs[0].event_id, content_hash: hash }])).covered.length, 1);
    assert.deepEqual(await f.index.loadStagedChunks(jobs[1], "owner", at), [chunk()]);
  });

  it("persists fenced staging across restart and publishes nothing before completion", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("staged")]);
    const [job] = await claim(f.index);
    assert.equal(await f.index.stageChunk({ job, owner: "owner", now: at, chunk: chunk() }), true);
    assert.deepEqual((await query(f.index, [{ event_id: job.event_id, content_hash: hash }])).covered, []);
    f.reopen();
    assert.deepEqual(await f.index.loadStagedChunks(job, "owner", at), [chunk()]);
    assert.equal(await f.index.stageChunk({ job, owner: "wrong", now: at, chunk: chunk([1, 0], 1) }), false);
    assert.equal(await f.index.yieldJob(job, "owner", at), true);
    const [next] = await claim(f.index, "new-owner");
    assert.equal(await f.index.stageChunk({ job, owner: "owner", now: at, chunk: chunk([1, 0], 1) }), false);
    assert.deepEqual(await f.index.loadStagedChunks(next, "new-owner", at), [chunk()]);
    await reconcile(f.index, [head("revised", {
      external_id: "staged", operation: "revise", lineage: ["staged", "revised"],
    })]);
    assert.equal(await f.index.stageChunk({
      job: next, owner: "new-owner", now: at, chunk: chunk([1, 0], 1),
    }), false);
    const database = new Database(f.path);
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM staged_chunks").get().n, 0);
    } finally { database.close(); }
  });

  it("recovers staged chunks after lease expiry and removes them in the final publication transaction", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("expired")]);
    const [old] = await claim(f.index);
    await f.index.stageChunk({ job: old, owner: "owner", now: at, chunk: chunk() });
    const [job] = await claim(f.index, "replacement", later);
    assert.equal(await f.index.yieldJob(old, "owner", later), false);
    assert.equal(await f.index.stageChunk({ job: old, owner: "owner", now: later, chunk: chunk([0, 1], 1) }), false);
    const saved = await f.index.loadStagedChunks(job, "replacement", later);
    await f.index.stageChunk({ job, owner: "replacement", now: later, chunk: chunk([0, 1], 1) });
    assert.equal(await f.index.complete({
      job, owner: "replacement", now: later, chunks: [...saved, chunk([0, 1], 1)],
    }), true);
    assert.equal((await query(f.index, [{ event_id: job.event_id, content_hash: hash }])).covered.length, 1);
    const database = new Database(f.path);
    try { assert.equal(database.prepare("SELECT COUNT(*) AS n FROM staged_chunks").get().n, 0); }
    finally { database.close(); }
  });

  for (const action of ["tombstone", "clear"]) {
    it(`removes staged vectors on ${action} without publishing partial coverage`, async (t) => {
      const f = await fixture(t);
      await reconcile(f.index, [head("original")]);
      const [job] = await claim(f.index);
      await f.index.stageChunk({ job, owner: "owner", now: at, chunk: chunk() });
      if (action === "clear") await f.index.clearOrganization("org");
      else await reconcile(f.index, [head("deleted", {
        external_id: "original", operation: "tombstone", lineage: ["original", "deleted"],
      })]);
      const database = new Database(f.path);
      try {
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM staged_chunks").get().n, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM coverage").get().n, 0);
      } finally { database.close(); }
    });
  }

  it("summarizes job counts and failure categories without materializing every job", async (t) => {
    const { index, path } = await fixture(t);
    await reconcile(index, ["pending", "running", "done", "quarantined"].map((id) => head(id)));
    const claimed = await index.claim({
      org_id: "org", generation: generation.id, owner: "owner", now: at, lease_ms: 1000, limit: 3,
    });
    assert.equal(claimed.length, 3);
    await index.fail({
      job: claimed[0], owner: "owner", now: at, retry_at: later,
      error_code: "timeout", retryable: true,
    });
    await index.fail({
      job: claimed[1], owner: "owner", now: at, retry_at: later,
      error_code: "unsupported_attachment", retryable: false,
    });
    await index.complete({
      job: claimed[2], owner: "owner", now: at, chunks: [chunk()],
    });
    assert.deepEqual(await index.summarizeJobs("org", generation.id, at), {
      counts: { pending: 1, running: 0, succeeded: 1, skipped: 0,
        failed: 1, quarantined: 1, superseded: 0 },
      failures: [
        { error_code: "timeout", failed: 1, quarantined: 0 },
        { error_code: "unsupported_attachment", failed: 0, quarantined: 1 },
      ],
      timing: { as_of: at, recent_processing_ms: 0 },
    });
    const database = new Database(path);
    try {
      database.prepare("UPDATE jobs SET error_code=NULL WHERE status='failed'").run();
    } finally {
      database.close();
    }
    assert.deepEqual((await index.summarizeJobs("org", generation.id)).failures, [
      { error_code: "indexing_failed", failed: 1, quarantined: 0 },
      { error_code: "unsupported_attachment", failed: 0, quarantined: 1 },
    ]);
    assert.equal((await index.summarizeJobs("other-org", generation.id)).counts.succeeded, 0);
  });

  it("persists active and completed processing times across status reads and reopens", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("running"), head("completed")]);
    const claimed = await f.index.claim({
      org_id: "org", generation: generation.id, owner: "owner", now: at, lease_ms: 5000, limit: 2,
    });
    const liveJob = claimed.find((job) => job.event_id === "running");
    const completedJob = claimed.find((job) => job.event_id === "completed");
    assert.equal(liveJob.started_at, at);
    assert.equal(liveJob.processing_ms, 0);
    assert.equal(await f.index.complete({
      job: completedJob, owner: "owner", now: later, chunks: [chunk()],
    }), true);

    let summary = await f.index.summarizeJobs("org", generation.id, later);
    assert.equal(summary.timing.as_of, later);
    assert.equal(summary.timing.running_elapsed_ms, 2000);
    assert.equal(summary.timing.recent_processing_ms, 2000);
    f.reopen();
    summary = await f.index.summarizeJobs("org", generation.id, later);
    assert.equal(summary.timing.running_elapsed_ms, 2000);
    assert.equal(summary.timing.recent_processing_ms, 2000);

    assert.equal(await f.index.yieldJob(liveJob, "owner", later), true);
    const [yielded] = (await f.index.listJobs("org", generation.id)).filter((job) => job.event_id === "running");
    assert.equal(yielded.status, "pending");
    assert.equal(yielded.started_at, undefined);
    assert.equal(yielded.processing_ms, 2000);
    summary = await f.index.summarizeJobs("org", generation.id, later);
    assert.equal(summary.timing.running_elapsed_ms, undefined);
    assert.equal(summary.timing.recent_processing_ms, 2000);
  });

  it("reports an expired indexing lease as waiting and resumes it in its original queue place", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("abandoned"), head("newer")]);
    const [abandoned] = await f.index.claim({
      org_id: "org", generation: generation.id, owner: "gone", now: at, lease_ms: 1000, limit: 1, order: "oldest",
    });
    assert.equal(abandoned.external_id, "abandoned");
    await f.index.stageChunk({ job: abandoned, owner: "gone", now: at, chunk: chunk() });
    const summary = await f.index.summarizeJobs("org", generation.id, later);
    assert.equal(summary.counts.running, 0);
    assert.equal(summary.counts.pending, 2);
    assert.equal(summary.timing.running_elapsed_ms, undefined);

    const [next] = await f.index.claim({
      org_id: "org", generation: generation.id, owner: "live", now: later, lease_ms: 1000, limit: 1, order: "newest",
    });
    assert.equal(next.external_id, "newer");
    const jobs = await f.index.listJobs("org", generation.id);
    const parked = jobs.find((job) => job.external_id === "abandoned");
    assert.equal(parked.status, "pending");
    assert.equal(parked.started_at, undefined);
    assert.equal(parked.processing_ms, 1000);
    const resumed = await f.index.claim({
      org_id: "org", generation: generation.id, owner: "live", now: later, lease_ms: 1000, limit: 1, order: "oldest",
    });
    assert.equal(resumed[0].external_id, "abandoned");
    assert.deepEqual(await f.index.loadStagedChunks(resumed[0], "live", later), [chunk()]);
  });

  it("matches 4000 fully covered 768-dimensional authorized vectors within the scale budget", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-vector-scale-"));
    const path = join(root, "vectors.db");
    const scaleModel = {
      ...model,
      model_id: "synthetic/scale",
      dimensions: 768,
    };
    const scaleGeneration = embeddingGeneration(scaleModel, 64);
    let index = new SqliteContextVectorIndex(path);
    await index.registerGeneration("org", scaleGeneration);
    index.close();
    const database = new Database(path);
    const contentHash = "d".repeat(64);
    const vector = Buffer.alloc(scaleModel.dimensions * 4);
    vector.writeFloatLE(1, 0);
    database.transaction(() => {
      const insertHead = database.prepare("INSERT INTO source_heads VALUES (?, ?, ?, ?, ?)");
      const insertCoverage = database.prepare("INSERT INTO coverage VALUES (?, ?, ?, ?, ?, ?, ?)");
      const insertChunk = database.prepare("INSERT INTO chunks (org_id,generation,event_id,ordinal,start,end,text_hash,vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (let value = 0; value < 4000; value += 1) {
        const eventId = `event-${String(value).padStart(5, "0")}`;
        insertHead.run("org", "synthetic", eventId, eventId, 1);
        insertCoverage.run("org", scaleGeneration.id, eventId, contentHash, "synthetic", eventId, 1);
        insertChunk.run("org", scaleGeneration.id, eventId, 0, 0, 2, contentHash, vector);
      }
    })();
    database.close();
    index = new SqliteContextVectorIndex(path);
    t.after(async () => {
      index.close();
      await rm(root, { recursive: true, force: true });
    });
    const authorized = Array.from({ length: 4000 }, (_, value) => ({
      event_id: `event-${String(value).padStart(5, "0")}`,
      content_hash: contentHash,
    }));
    const authorization_hash = contextVectorAuthorizationHash(authorized);
    const started = performance.now();
    const result = await index.matchAuthorized({
      org_id: "org",
      generation: scaleGeneration.id,
      authorized,
      authorization_hash,
      query_vector: [1, ...Array.from({ length: scaleModel.dimensions - 1 }, () => 0)],
      limit: 100,
    });
    const elapsed = performance.now() - started;
    assert.deepEqual(result.covered, []);
    assert.deepEqual(result.coverage, {
      authorization_hash,
      authorized_count: 4000,
      covered_count: 4000,
      complete: true,
      uncovered: [],
    });
    assert.deepEqual(result.acceleration, {
      algorithm_version: "sqlite-vec-authorized-exact-v1",
      authorized_chunks: 4000,
      candidate_chunks: 4000,
      authorization_update: "rebuilt",
    });
    assert.equal(result.matched.length, 100);
    assert.deepEqual(
      result.matched.slice(0, 3).map((value) => value.event_id),
      ["event-00000", "event-00001", "event-00002"],
    );
    assert.ok(elapsed < 300, `authorized vector search took ${elapsed.toFixed(1)}ms`);
    const pagePlan = index.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT ch.event_id, ch.ordinal, ch.rowid
      FROM chunks ch
      JOIN coverage c
        ON c.org_id=ch.org_id AND c.generation=ch.generation AND c.event_id=ch.event_id
      JOIN source_heads h
        ON h.org_id=c.org_id AND h.source=c.source
        AND h.external_id=c.external_id AND h.event_id=c.event_id
      JOIN vector_authorized a
        ON a.event_id=c.event_id AND a.content_hash=c.content_hash
      WHERE ch.org_id=? AND ch.generation=?
        AND (ch.event_id, ch.ordinal) > (?, ?)
      ORDER BY ch.event_id, ch.ordinal
      LIMIT 1024
    `).all("org", scaleGeneration.id, "event-00000", 0).map((row) => row.detail).join("\n");
    assert.match(pagePlan, /sqlite_autoindex_chunks_1/);
    assert.match(pagePlan, /\(event_id,ordinal\)>\(\?,\?\)/);
    assert.doesNotMatch(pagePlan, /TEMP B-TREE|SCAN ch/);
    const readPlan = index.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT ch.rowid, ch.vector
      FROM vector_knn_backfill_batch b
      JOIN chunks ch ON ch.rowid = b.chunk_rowid
    `).all().map((row) => row.detail).join("\n");
    assert.match(readPlan, /INTEGER PRIMARY KEY/);
    const implementation = readFileSync(join(__dirname, "../dist/index.js"), "utf8");
    assert.match(implementation, /\(ch\.event_id, ch\.ordinal\) > \(\?, \?\)/);
    assert.match(implementation, /JOIN chunks ch ON ch\.rowid = b\.chunk_rowid/);
    assert.doesNotMatch(implementation, /ORDER BY ch\.rowid/);
    const reused = await index.matchAuthorized({
      org_id: "org",
      generation: scaleGeneration.id,
      authorized,
      authorization_hash,
      query_vector: [1, ...Array.from({ length: scaleModel.dimensions - 1 }, () => 0)],
      limit: 100,
    });
    assert.deepEqual(reused.coverage, result.coverage);
    assert.deepEqual(reused.acceleration, {
      ...result.acceleration,
      authorization_update: "reused",
    });
    await assert.rejects(
      index.matchAuthorized({
        org_id: "org",
        generation: scaleGeneration.id,
        authorized,
        authorization_hash: "e".repeat(64),
        query_vector: [1, ...Array.from({ length: scaleModel.dimensions - 1 }, () => 0)],
        limit: 100,
      }),
      /authorization hash/,
    );
    index.close();
    const corrupt = new Database(path);
    corrupt.prepare(
      "DELETE FROM chunks WHERE org_id = ? AND generation = ? AND event_id = ?",
    ).run("org", scaleGeneration.id, "event-00000");
    corrupt.close();
    index = new SqliteContextVectorIndex(path);
    await assert.rejects(
      index.matchAuthorized({
        org_id: "org",
        generation: scaleGeneration.id,
        authorized: [authorized[0]],
        query_vector: [1, ...Array.from({ length: scaleModel.dimensions - 1 }, () => 0)],
        limit: 1,
      }),
      (error) => error.reason === "corrupt",
    );
  });

  it("incrementally updates compact authorization coverage when vector publication completes", async (t) => {
    const f = await fixture(t);
    await reconcile(f.index, [head("covered"), head("pending")]);
    const jobs = await claim(f.index);
    const coveredJob = jobs.find((job) => job.event_id === "covered");
    const pendingJob = jobs.find((job) => job.event_id === "pending");
    await f.index.complete({ job: coveredJob, owner: "owner", now: at, chunks: [chunk()] });
    const authorized = [
      { event_id: "covered", content_hash: hash },
      { event_id: "pending", content_hash: hash },
    ];
    const authorization_hash = contextVectorAuthorizationHash(authorized);
    const partial = await query(f.index, authorized, { authorization_hash });
    assert.deepEqual(partial.covered, []);
    assert.deepEqual(partial.coverage, {
      authorization_hash,
      authorized_count: 2,
      covered_count: 1,
      complete: false,
      uncovered: [{ event_id: "pending", content_hash: hash }],
    });
    assert.equal(partial.acceleration.authorized_chunks, 1);

    const workerIndex = new SqliteContextVectorIndex(f.path);
    assert.equal(await workerIndex.complete({
      job: pendingJob,
      owner: "owner",
      now: at,
      chunks: [chunk([0, 1])],
    }), true);
    workerIndex.close();
    const complete = await query(f.index, authorized, { authorization_hash });
    assert.deepEqual(complete.coverage, {
      authorization_hash,
      authorized_count: 2,
      covered_count: 2,
      complete: true,
      uncovered: [],
    });
    assert.equal(complete.acceleration.authorized_chunks, 2);
  });

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
    const authorized = [{ event_id: "event-b", content_hash: hash }, { event_id: "event-a", content_hash: hash }];
    const result = await query(index, authorized, {
      authorization_hash: contextVectorAuthorizationHash(authorized),
      limit: 1,
    });
    assert.equal(result.covered.length, 0);
    assert.equal(result.coverage.covered_count, 2);
    assert.equal(result.acceleration.authorized_chunks, 4);
    assert.equal(result.reconciled_epoch, "authority:1");
    assert.deepEqual(result.matched.map((match) => [match.event_id, match.chunk_ordinal, match.score]), [["event-a", 0, 1]]);
    assert.deepEqual((await query(index, [{ event_id: "event-a", content_hash: "c".repeat(64) }])).covered, []);
    assert.equal((await query(index, [{ event_id: "event-a", content_hash: hash }], {
      query_vector: [1.0005, 0],
    })).matched[0].score, 1);
    await assert.rejects(query(index, [{ event_id: "event-a", content_hash: hash }, { event_id: "event-a", content_hash: hash }]));
  });

  it("applies authorization deltas and prewarms newly completed vectors without rebuilding", async (t) => {
    const { index, path } = await fixture(t);
    await reconcile(index, [head("event-a"), head("event-b"), head("event-c")]);
    const jobs = await claim(index);
    const pending = jobs.find((job) => job.event_id === "event-c");
    for (const job of jobs.filter((value) => value !== pending)) {
      assert.equal(await index.complete({
        job,
        owner: "owner",
        now: at,
        chunks: [chunk(job.event_id === "event-a" ? [1, 0] : [0.8, 0.6])],
      }), true);
    }
    const initial = [
      { event_id: "event-a", content_hash: hash },
      { event_id: "event-b", content_hash: hash },
    ];
    const initialAccumulator = contextVectorAuthorizationAccumulator(initial);
    const initialHash = contextVectorAuthorizationHashFromAccumulator(
      initial.length,
      initialAccumulator,
    );
    const first = await query(index, initial, {
      authorization_hash: initialHash,
      authorization_accumulator: initialAccumulator,
      limit: 2,
    });
    assert.equal(first.acceleration.authorized_chunks, 2);

    const current = [
      { event_id: "event-b", content_hash: hash },
      { event_id: "event-c", content_hash: hash },
    ];
    const removed = [initial[0]];
    const added = [current[1]];
    const accumulator = updateContextVectorAuthorizationAccumulator(
      initialAccumulator,
      added,
      removed,
    );
    const authorizationHash = contextVectorAuthorizationHashFromAccumulator(
      current.length,
      accumulator,
    );
    const delta = {
      previous_authorization_hash: initialHash,
      previous_accumulator: initialAccumulator,
      accumulator,
      added,
      removed,
    };
    const changed = await query(index, current, {
      authorization_hash: authorizationHash,
      authorization_accumulator: accumulator,
      authorization_delta: delta,
      limit: 2,
    });
    assert.equal(changed.coverage.covered_count, 1);
    assert.deepEqual(changed.coverage.uncovered, [current[1]]);
    assert.equal(changed.acceleration.authorized_chunks, 1);
    assert.equal(changed.acceleration.authorization_update, "delta");
    assert.equal(changed.acceleration.added_events, 1);
    assert.equal(changed.acceleration.removed_events, 1);
    assert.deepEqual(changed.matched.map((match) => match.event_id), ["event-b"]);

    assert.equal(await index.complete({
      job: pending,
      owner: "owner",
      now: at,
      chunks: [chunk([0, 1])],
    }), true);
    const prewarmed = await query(index, current, {
      authorization_hash: authorizationHash,
      authorization_accumulator: accumulator,
      query_vector: [0, 1],
      limit: 2,
    });
    assert.equal(prewarmed.coverage.covered_count, 2);
    assert.equal(prewarmed.acceleration.authorized_chunks, 2);
    assert.equal(prewarmed.acceleration.authorization_update, "reused");
    assert.deepEqual(prewarmed.matched.map((match) => match.event_id), ["event-c", "event-b"]);

    const lifecycleIndex = new SqliteContextVectorIndex(path);
    await reconcile(lifecycleIndex, [
      head("event-c-v2", {
        external_id: "event-c",
        operation: "revise",
        lineage: ["event-c", "event-c-v2"],
      }),
    ]);
    lifecycleIndex.close();
    const fenced = await query(index, current, {
      authorization_hash: authorizationHash,
      authorization_accumulator: accumulator,
      query_vector: [0, 1],
      limit: 2,
    });
    assert.equal(fenced.coverage.covered_count, 1);
    assert.deepEqual(fenced.coverage.uncovered, [current[1]]);
    assert.equal(fenced.acceleration.authorized_chunks, 1);
    assert.deepEqual(fenced.matched.map((match) => match.event_id), ["event-b"]);

    await assert.rejects(query(index, initial, {
      authorization_hash: initialHash,
      authorization_accumulator: initialAccumulator,
      authorization_delta: {
        ...delta,
        previous_authorization_hash: authorizationHash,
        previous_accumulator: accumulator,
        accumulator: initialAccumulator,
        added: removed,
        removed: [],
      },
    }), /authorization delta/);
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

describe("reconcile changed authority heads without a full snapshot", () => {
  it("indexes only heads that are not already current and skips the rest", async (t) => {
    const f = await fixture(t);
    const authority = join(f.path, "../authority.db");
    const db = new Database(authority);
    db.exec(`
      CREATE TABLE source_heads (org_id TEXT, source TEXT, external_id TEXT, current_event_id TEXT);
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT, org_id TEXT, source TEXT, external_id TEXT, operation TEXT,
        content_hash TEXT, parent_event_id TEXT, thread_id TEXT, actor_id TEXT,
        required_scope_ids_json TEXT
      );
      CREATE TABLE blobs (content_hash TEXT, media_type TEXT);
    `);
    const insertHead = db.prepare("INSERT INTO source_heads VALUES (?,?,?,?)");
    const insertEvent = db.prepare(`INSERT INTO events (
      id, org_id, source, external_id, operation, content_hash, parent_event_id,
      thread_id, actor_id, required_scope_ids_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    db.prepare("INSERT INTO blobs VALUES (?,?)").run(hash, "text/plain");
    const add = (id, eligible = true) => {
      insertHead.run("org", "synthetic", id, id);
      insertEvent.run(
        id, "org", "synthetic", id, "create", hash, null, "thread",
        eligible ? "owner" : "",
        JSON.stringify(["personal"]),
      );
    };
    add("kept");
    add("hidden", false);
    add("next");
    const input = {
      org_id: "org", generation: generation.id, authority_path: authority,
      read_epoch: "authorized-stamp:1", now: at, limit: 10,
    };
    const first = await f.index.reconcileChanged(input);
    assert.equal(first.done, true);
    assert.equal(first.changed, 3);
    const jobs = await f.index.listJobs("org", generation.id);
    assert.equal(jobs.find((job) => job.external_id === "hidden").status, "skipped");
    assert.deepEqual(jobs.filter((job) => job.status !== "skipped").map((job) => job.external_id).sort(), ["kept", "next"]);
    const second = await f.index.reconcileChanged(input);
    assert.deepEqual(second, { changed: 0, done: true });
    const other = embeddingGeneration(model, 64);
    await f.index.registerGeneration("org", other);
    const copied = await f.index.reconcileChanged({ ...input, generation: other.id });
    assert.equal(copied.changed, 3);
    assert.equal(copied.done, true);
    add("later");
    const third = await f.index.reconcileChanged(input);
    assert.equal(third.changed, 1);
    assert.equal(third.done, true);
    assert.deepEqual(
      (await f.index.listJobs("org", generation.id)).filter((job) => job.status !== "skipped").map((job) => job.external_id).sort(),
      ["kept", "later", "next"],
    );
    db.close();
  });
});
