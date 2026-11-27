const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { afterEach, describe, it } = require("node:test");
const { createHost } = require("@regenic/plugin-host");
const { contextLexicalAuthorizationHash } = require("@regenic/domain");
const {
  SqliteContextLexicalIndex,
  sqliteContextLexicalIndexPlugin,
} = require("../dist");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "regenic-lexical-index-"));
  roots.push(value);
  return value;
}

function key(event_id, content_hash) {
  return { event_id, content_hash };
}

function replacement(documents, overrides = {}) {
  return {
    org_id: "example-org",
    generation: "continuous-v1",
    watermark: "authority:1",
    documents,
    ...overrides,
  };
}

describe("SQLite Context lexical index", () => {
  it("asks for a rebuild until documents include filenames", async () => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "text-version.db"));
    assert.equal(await index.needsTextRebuild("example-org"), false);
    await index.replaceOrganization(replacement([
      { event_id: "event-a", content_hash: HASH_A, text: "alpha" },
    ]));
    assert.equal(await index.needsTextRebuild("example-org"), false);
    const Database = require("better-sqlite3");
    const db = new Database(join(dir, "text-version.db"));
    db.prepare("UPDATE context_lexical_meta SET text_version = NULL").run();
    db.close();
    assert.equal(await index.needsTextRebuild("example-org"), true);
    index.close();
  });

  it("walks a rebuild cursor without deleting documents already written", async () => {
    const dir = await root();
    const path = join(dir, "rebuild.db");
    const index = new SqliteContextLexicalIndex(path);
    await index.ensureGeneration({
      org_id: "example-org",
      generation: "continuous-v1",
      watermark: "lexical:rebuild",
    });
    assert.equal(await index.needsTextRebuild("example-org"), true);
    assert.equal(await index.rebuildCursor("example-org"), null);
    await index.upsertDocuments(replacement([
      { event_id: "event-a", content_hash: HASH_A, text: "alpha" },
    ], { watermark: "lexical:event-a" }));
    await index.noteRebuildCursor("example-org", "event-a", false);
    assert.equal(await index.rebuildCursor("example-org"), "event-a");
    await index.ensureGeneration({
      org_id: "example-org",
      generation: "continuous-v1",
      watermark: "lexical:rebuild",
    });
    assert.equal(await index.rebuildCursor("example-org"), "event-a");
    assert.equal((await index.getStatus("example-org")).watermark, "lexical:event-a");
    await index.upsertDocuments(replacement([
      { event_id: "event-b", content_hash: HASH_B, text: "beta" },
    ], { watermark: "authority:full" }));
    await index.noteRebuildCursor("example-org", null, true);
    assert.equal(await index.rebuildCursor("example-org"), null);
    assert.equal(await index.needsTextRebuild("example-org"), false);
    const matched = await index.matchAuthorized({
      org_id: "example-org",
      query: "beta",
      authorized: [key("event-a", HASH_A), key("event-b", HASH_B)],
    });
    assert.deepEqual(matched.matched, [key("event-b", HASH_B)]);

    await index.ensureGeneration({
      org_id: "example-org",
      generation: "continuous-v2",
      watermark: "lexical:rebuild",
    });
    const Database = require("better-sqlite3");
    const db = new Database(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM context_lexical_documents").get().n, 2);
    db.close();
    await index.noteRebuildCursor("example-org", null, true);
    const after = new Database(path);
    assert.equal(after.prepare(
      "SELECT COUNT(*) AS n FROM context_lexical_documents WHERE generation = ?",
    ).get("continuous-v1").n, 0);
    after.close();
    index.close();
  });

  it("reuses compact authorization coverage and invalidates it after index writes", async () => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "authorization.db"));
    const authorized = [key("event-a", HASH_A), key("event-b", HASH_B)];
    const authorization_hash = contextLexicalAuthorizationHash(authorized);
    await index.replaceOrganization(replacement([
      { ...authorized[0], text: "alpha" },
      { ...authorized[1], text: "beta" },
    ]));

    for (const query of ["alpha", "missing"]) {
      const result = await index.matchAuthorized({
        org_id: "example-org",
        query,
        authorized,
        authorization_hash,
      });
      assert.deepEqual(result.covered, []);
      assert.deepEqual(result.coverage, {
        authorization_hash,
        authorized_count: 2,
        covered_count: 2,
        complete: true,
        uncovered: [],
      });
    }
    await assert.rejects(
      index.matchAuthorized({
        org_id: "example-org",
        query: "alpha",
        authorized,
        authorization_hash: HASH_C,
      }),
      /authorization hash/,
    );

    await index.upsertDocuments(replacement([
      { ...key("event-b", HASH_C), text: "gamma" },
    ], { watermark: "authority:2" }));
    const stale = await index.matchAuthorized({
      org_id: "example-org",
      query: "alpha",
      authorized,
      authorization_hash,
    });
    assert.deepEqual(stale.coverage, {
      authorization_hash,
      authorized_count: 2,
      covered_count: 1,
      complete: false,
      uncovered: [key("event-b", HASH_B)],
    });
    index.close();
  });

  it("builds and searches more than 10000 keys without truncating late authorized matches", async (t) => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "large.db"));
    try {
      const documents = Array.from({ length: 10005 }, (_, id) => ({
        ...key(`event-${String(id).padStart(5, "0")}`, HASH_A),
        text: id === 10004 ? "needle release" : "unrelated body",
      }));
      await index.replaceOrganization(replacement(documents));
      await index.upsertDocuments(replacement(documents));
      await index.replaceOrganization(replacement([
        { ...key("hidden", HASH_B), text: "needle secret" },
      ], { org_id: "other-org" }));
      const started = performance.now();
      const result = await index.matchAuthorized({
        org_id: "example-org", query: "needle",
        authorized: [...documents.map(({ event_id, content_hash }) => ({ event_id, content_hash })), key("hidden", HASH_B)],
      });
      const elapsed = performance.now() - started;
      assert.equal(result.covered.length, 10005);
      assert.deepEqual(result.matched, [key("event-10004", HASH_A)]);
      assert.ok(elapsed < 500, `authorized lexical search took ${elapsed.toFixed(1)}ms`);
    } finally {
      index.close();
    }
  });

  it("matches only authorized keys and treats FTS operators as literal text", async () => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "context.lexical.db"));
    await index.replaceOrganization(replacement([
      { ...key("event-a", HASH_A), text: "Release approved plan" },
      { ...key("event-b", HASH_B), text: "Hidden release secret" },
    ]));

    const hidden = await index.matchAuthorized({
      org_id: "example-org",
      query: "secret",
      authorized: [key("event-a", HASH_A)],
    });
    assert.deepEqual(hidden.matched, []);
    assert.deepEqual(hidden.covered, [key("event-a", HASH_A)]);

    const literal = await index.matchAuthorized({
      org_id: "example-org",
      query: "release OR secret NEAR:* \"",
      authorized: [key("event-a", HASH_A), key("event-b", HASH_B)],
    });
    assert.deepEqual(literal.matched, [key("event-a", HASH_A), key("event-b", HASH_B)]);
    index.close();
  });

  it("normalizes full-width text and matches segmented CJK words", async () => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "context.lexical.db"));
    await index.replaceOrganization(replacement([
      { ...key("event-cjk", HASH_A), text: "发布批准计划" },
      { ...key("event-width", HASH_B), text: "ＡＰＰＲＯＶＥＤ roadmap" },
    ]));

    for (const [query, matched] of [
      ["批", []],
      ["批准", [key("event-cjk", HASH_A)]],
      ["发布批", [key("event-cjk", HASH_A)]],
    ]) {
      const result = await index.matchAuthorized({
        org_id: "example-org",
        query,
        authorized: [key("event-cjk", HASH_A)],
      });
      assert.deepEqual(result.matched, matched);
    }
    assert.deepEqual((await index.matchAuthorized({
      org_id: "example-org",
      query: "approved",
      authorized: [key("event-width", HASH_B)],
    })).matched, [key("event-width", HASH_B)]);
    index.close();
  });

  it("splits Latin words adjacent to CJK into whole words instead of letter n-grams", async () => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "context.lexical.db"));
    await index.replaceOrganization(replacement([
      { ...key("event-excel", HASH_A), text: "Q3 budget Excel workbook" },
      { ...key("event-html", HASH_B), text: "width=device-width family=Space+Grotesk" },
      { ...key("event-cjk", HASH_C), text: "季度文件汇总" },
    ]));
    const authorized = [key("event-excel", HASH_A), key("event-html", HASH_B), key("event-cjk", HASH_C)];
    const mixed = await index.matchAuthorized({ org_id: "example-org", query: "看下最近有哪些Excel文件", authorized });
    assert.deepEqual(mixed.matched, [key("event-cjk", HASH_C), key("event-excel", HASH_A)]);
    const mixedDocument = await index.matchAuthorized({ org_id: "example-org", query: "excel", authorized });
    assert.deepEqual(mixedDocument.matched, [key("event-excel", HASH_A)]);
    index.close();
  });

  it("reports stale hashes as uncovered and replaces documents idempotently across restart", async () => {
    const dir = await root();
    const path = join(dir, "context.lexical.db");
    let index = new SqliteContextLexicalIndex(path);
    await index.replaceOrganization(replacement([
      { ...key("event-a", HASH_A), text: "alpha" },
    ]));
    assert.deepEqual((await index.matchAuthorized({
      org_id: "example-org",
      query: "alpha",
      authorized: [key("event-a", HASH_B)],
    })).covered, []);

    await index.upsertDocuments({
      org_id: "example-org",
      generation: "continuous-v1",
      watermark: "authority:2",
      documents: [{ ...key("event-a", HASH_B), text: "beta" }],
    });
    index.close();

    index = new SqliteContextLexicalIndex(path);
    assert.deepEqual(await index.getStatus("example-org"), {
      available: true,
      algorithm_version: "segment-bm25-v1",
      generation: "continuous-v1",
      watermark: "authority:2",
    });
    const result = await index.matchAuthorized({
      org_id: "example-org",
      query: "beta",
      authorized: [key("event-a", HASH_A), key("event-a", HASH_B)],
    });
    assert.deepEqual(result.covered, [key("event-a", HASH_B)]);
    assert.deepEqual(result.matched, [key("event-a", HASH_B)]);
    index.close();
  });

  it("atomically activates a replacement generation and clears one organization", async () => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "context.lexical.db"));
    await index.replaceOrganization(replacement([
      { ...key("event-a", HASH_A), text: "alpha" },
    ]));
    await index.replaceOrganization(replacement([
      { ...key("event-b", HASH_B), text: "beta" },
    ], { generation: "rebuild-v2", watermark: "authority:2" }));

    const result = await index.matchAuthorized({
      org_id: "example-org",
      query: "alpha beta",
      authorized: [key("event-a", HASH_A), key("event-b", HASH_B)],
    });
    assert.equal(result.generation, "rebuild-v2");
    assert.deepEqual(result.covered, [key("event-b", HASH_B)]);
    assert.deepEqual(result.matched, [key("event-b", HASH_B)]);
    await index.clearOrganization("example-org");
    assert.deepEqual(await index.getStatus("example-org"), {
      available: true,
      algorithm_version: "segment-bm25-v1",
    });
    index.close();
  });

  it("leaves operation-heavy documents uncovered so retrieval can safely scan them", async () => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "context.lexical.db"));
    await index.replaceOrganization(replacement([
      { ...key("event-large", HASH_A), text: "批".repeat(100_001) },
      { ...key("event-normal", HASH_B), text: "批准" },
    ]));

    const result = await index.matchAuthorized({
      org_id: "example-org",
      query: "批准",
      authorized: [key("event-large", HASH_A), key("event-normal", HASH_B)],
    });

    assert.deepEqual(result.covered, [key("event-normal", HASH_B)]);
    assert.deepEqual(result.matched, [key("event-normal", HASH_B)]);
    index.close();
  });

  it("degrades without FTS5 and mounts through the plugin lifecycle", async () => {
    const dir = await root();
    const unavailable = new SqliteContextLexicalIndex(join(dir, "unavailable.db"), {
      force_unavailable: true,
    });
    await unavailable.replaceOrganization(replacement([
      { ...key("event-a", HASH_A), text: "alpha" },
    ]));
    assert.deepEqual(await unavailable.matchAuthorized({
      org_id: "example-org",
      query: "alpha",
      authorized: [key("event-a", HASH_A)],
    }), {
      available: false,
      algorithm_version: "segment-bm25-v1",
      matched: [],
      covered: [],
    });
    unavailable.close();

    const host = await createHost();
    await host.plugin(sqliteContextLexicalIndexPlugin, {
      path: join(dir, "plugin.db"),
    });
    assert.equal((await host.get("context-lexical-index").getStatus("example-org")).available, true);
    await host.dispose();
    assert.throws(() => host.get("context-lexical-index"), /Service is not available/);
  });

  it("ranks current heads inside FTS without taking a key list", async () => {
    const Database = require("better-sqlite3");
    const dir = await root();
    const authorityPath = join(dir, "authority.db");
    const authority = new Database(authorityPath);
    authority.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
        operation TEXT NOT NULL, content_hash TEXT, parent_event_id TEXT, thread_id TEXT, actor_id TEXT,
        required_scope_ids_json TEXT, occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL
      );
      CREATE TABLE source_heads (
        org_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
        current_event_id TEXT NOT NULL, PRIMARY KEY (org_id, source, external_id)
      );
      CREATE TABLE blobs (content_hash TEXT PRIMARY KEY, media_type TEXT NOT NULL);
    `);
    const insertEvent = authority.prepare(`
      INSERT INTO events (
        id, org_id, source, external_id, operation, content_hash, thread_id, actor_id,
        required_scope_ids_json, occurred_at, ingested_at
      ) VALUES (?, 'example-org', 'synthetic', ?, 'create', ?, 'thread-1', 'actor-1', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `);
    const insertHead = authority.prepare(`
      INSERT INTO source_heads (org_id, source, external_id, current_event_id)
      VALUES ('example-org', 'synthetic', ?, ?)
    `);
    const insertBlob = authority.prepare("INSERT INTO blobs (content_hash, media_type) VALUES (?, 'text/plain')");
    insertEvent.run("event-a", "message-a", HASH_A, JSON.stringify(["scope"]));
    insertEvent.run("event-hidden", "message-hidden", HASH_B, "[]");
    insertEvent.run("event-old", "message-old", HASH_C, JSON.stringify(["scope"]));
    insertEvent.run("event-gap", "message-gap", "d".repeat(64), JSON.stringify(["scope"]));
    insertHead.run("message-a", "event-a");
    insertHead.run("message-hidden", "event-hidden");
    insertHead.run("message-gap", "event-gap");
    for (const hash of [HASH_A, HASH_B, HASH_C, "d".repeat(64)]) insertBlob.run(hash);
    const index = new SqliteContextLexicalIndex(join(dir, "lexical.db"));
    await index.replaceOrganization(replacement([
      { event_id: "event-a", content_hash: HASH_A, text: "alpha report" },
      { event_id: "event-hidden", content_hash: HASH_B, text: "alpha secret" },
      { event_id: "event-old", content_hash: HASH_C, text: "alpha history" },
      { event_id: "event-rich", content_hash: "e".repeat(64), text: "alpha alpha alpha" },
    ]));
    const first = await index.matchRanked({
      org_id: "example-org", query: "alpha", limit: 10,
      authority_path: authorityPath, stamp: "1:0",
    });
    assert.deepEqual(first.matched.map((key) => key.event_id), ["event-a"]);
    assert.equal(first.authorized_count, 2);
    assert.equal(first.covered_count, 1);
    authority.prepare("DELETE FROM source_heads WHERE current_event_id = 'event-a'").run();
    const cached = await index.matchRanked({
      org_id: "example-org", query: "alpha", limit: 10,
      authority_path: authorityPath, stamp: "1:0",
    });
    assert.deepEqual(cached.matched.map((key) => key.event_id), ["event-a"]);
    const refreshed = await index.matchRanked({
      org_id: "example-org", query: "alpha", limit: 10,
      authority_path: authorityPath, stamp: "1:1",
    });
    assert.deepEqual(refreshed.matched, []);
    assert.equal(refreshed.authorized_count, 1);
    index.close();
    authority.close();
  });
});
