const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { it } = require("node:test");
const { sqliteAuthorityPlugin } = require("@regenic/authority-store");
const { fsBlobPlugin } = require("@regenic/blob-store");
const { createKernelHost } = require("../dist/kernel-host");
const { EMBEDDINGGEMMA_2 } = require("@regenic/embedding-provider");
const { EmbeddingError } = require("@regenic/domain");
const { ContextEngineError } = require("@regenic/context-engine");
const { PersonalContextService } = require("../dist/personal-context.service");

it("maps observed Authority races to 503 and invalid embedding queries to 400", async () => {
  for (const [error, status, code] of [
    [new ContextEngineError("source_boundary", "private detail"), 503, "retrieval_unavailable"],
    [new ContextEngineError("invalid_candidate", "private detail"), 503, "retrieval_unavailable"],
    [Object.assign(new Error("private detail"), { code: "SQLITE_BUSY" }), 503, "retrieval_unavailable"],
    [new EmbeddingError("input_too_large", false), 400, "invalid_request"],
  ]) {
    const service = new PersonalContextService({
      orgId: () => "owner",
      requireHost: () => ({ get: () => ({ async assemble() { throw error; } }) }),
    });
    await assert.rejects(service.assemble({}), (failure) =>
      failure.httpStatus === status && failure.code === code && !failure.message.includes("private detail"));
  }
});

it("indexes and assembles zero-lexical semantic evidence through the actual kernel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "regenic-api-hybrid-"));
  const database = join(root, "authority.db");
  const modes = [];
  const host = await createKernelHost({
    authority: { plugin: sqliteAuthorityPlugin, config: { path: database } },
    blobs: { plugin: fsBlobPlugin, config: { root: join(root, "blobs") } },
    orgId: "owner", lexicalDatabase: `${database}.lexical.db`,
    embedding: {
      database: `${database}.vector.db`, base_url: "http://127.0.0.1:8765",
      chunk_tokens: 256, max_chunks_per_event: 128,
      fetch: async (url, init) => {
        const input = JSON.parse(init.body);
        modes.push(input.mode);
        return new Response(JSON.stringify({
          descriptor: EMBEDDINGGEMMA_2,
          ...(url.endsWith("/tokens") ? { counts: input.texts.map(() => 10) }
            : { vectors: input.texts.map(() => [1, ...Array(767).fill(0)]) }),
        }));
      },
    },
  });
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }); });
  assert.equal(host.get("context-retrievers").get("event-lexical-indexed"), undefined);
  assert.ok(host.get("context-retrievers").get("event-hybrid"));
  await host.get("ingest").ingest({
    schema_version: "1.0", connector_id: "synthetic", org_id: "owner", delivery_id: "hybrid",
    received_at: "2026-10-16T00:00:00.000Z",
    records: [{
      operation: "create", source: "synthetic", external_id: "rollback",
      occurred_at: "2026-10-16T00:00:00.000Z", actor: { id: "person" }, scope: { id: "thread" },
      type: "message", content: [{ role: "body", media_type: "text/plain", text: "部署失败时恢复上一版本。" }],
    }],
  });
  assert.equal((await host.get("context-embedding-worker").runOnce()).processed, 1);
  const result = await host.get("context").assemble({
    schema_version: "1.0", id: "hybrid-query", org_id: "owner",
    principal: { actor_type: "human", actor_id: "owner" }, consumer_id: "test",
    purpose: "find rollback", allowed_uses: ["display"], query: "rollback",
    temporal: { mode: "current" }, requested_kinds: ["event"],
    budget: { profile: "test-v1", max_tokens: 100, max_items: 10, max_raw_evidence: 10 },
  });
  assert.equal(result.snapshot.selected.length, 1);
  assert.equal(result.snapshot.retrieval_trace[0].mode, "hybrid");
  assert.equal(result.snapshot.retrieval_trace[0].routes[0].lexical_rank, undefined);
  assert.ok(modes.includes("document") && modes.includes("query"));
});

for (const corrupt of [false, true]) {
  it(`preserves API lexical ingestion/retrieval when vector ${corrupt ? "storage is corrupt" : "inference is unavailable"}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-api-embedding-"));
    const database = join(root, "authority.db");
    if (corrupt) await writeFile(`${database}.vector.db`, "not sqlite");
    let calls = 0;
    const host = await createKernelHost({
      authority: { plugin: sqliteAuthorityPlugin, config: { path: database } },
      blobs: { plugin: fsBlobPlugin, config: { root: join(root, "blobs") } },
      orgId: "owner",
      lexicalDatabase: `${database}.lexical.db`,
      embedding: {
        database: `${database}.vector.db`, base_url: "http://127.0.0.1:8765",
        chunk_tokens: 256, max_chunks_per_event: 128,
        fetch: async () => { calls++; throw new TypeError("model offline"); },
      },
    });
    t.after(async () => {
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal(calls, 0, "kernel assembly must not depend on model availability");
    assert.equal(host.get("context-vector-status").status, corrupt ? "unavailable" : "ready");
    const accepted = await host.get("ingest").ingest({
      schema_version: "1.0", connector_id: "synthetic", org_id: "owner", delivery_id: "delivery",
      received_at: "2026-10-16T00:00:00.000Z",
      records: [{
        operation: "create", source: "synthetic", external_id: "release",
        occurred_at: "2026-10-16T00:00:00.000Z", actor: { id: "person" }, scope: { id: "thread" },
        type: "message", content: [{ role: "body", media_type: "text/plain", text: "发布批准 RG-2048" }],
      }],
    });
    assert.equal(accepted.records[0].status, "accepted");
    if (!corrupt) {
      assert.equal((await host.get("context-embedding-worker").runOnce()).failed, 1);
      assert.ok(calls > 0);
    }
    await host.get("context-projections").syncLexicalIndex("owner", "continuous-v1");
    const assembled = await host.get("context").assemble({
      schema_version: "1.0", id: "lexical-without-model", org_id: "owner",
      principal: { actor_type: "human", actor_id: "owner" }, consumer_id: "test",
      purpose: "find release", allowed_uses: ["display"], query: "发布批准",
      temporal: { mode: "current" }, requested_kinds: ["event"],
      budget: { profile: "test-v1", max_tokens: 100, max_items: 10, max_raw_evidence: 10 },
    });
    assert.ok(JSON.stringify(assembled.bundle.sections).includes("RG-2048"));
  });
}
