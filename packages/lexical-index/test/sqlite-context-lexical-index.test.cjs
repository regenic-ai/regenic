const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { createHost } = require("@regenic/plugin-host");
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

  it("normalizes full-width text and finds one-, two-, and three-character CJK terms", async () => {
    const dir = await root();
    const index = new SqliteContextLexicalIndex(join(dir, "context.lexical.db"));
    await index.replaceOrganization(replacement([
      { ...key("event-cjk", HASH_A), text: "发布批准计划" },
      { ...key("event-width", HASH_B), text: "ＡＰＰＲＯＶＥＤ roadmap" },
    ]));

    for (const query of ["批", "批准", "发布批"]) {
      const result = await index.matchAuthorized({
        org_id: "example-org",
        query,
        authorized: [key("event-cjk", HASH_A)],
      });
      assert.deepEqual(result.matched, [key("event-cjk", HASH_A)]);
    }
    assert.deepEqual((await index.matchAuthorized({
      org_id: "example-org",
      query: "approved",
      authorized: [key("event-width", HASH_B)],
    })).matched, [key("event-width", HASH_B)]);
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
      algorithm_version: "literal-unicode-v1",
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
      algorithm_version: "literal-unicode-v1",
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
      query: "批",
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
      algorithm_version: "literal-unicode-v1",
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
});
