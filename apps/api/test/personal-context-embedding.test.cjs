const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { it } = require("node:test");
const { sqliteAuthorityPlugin } = require("@regenic/authority-store");
const { fsBlobPlugin } = require("@regenic/blob-store");
const { createKernelHost } = require("../dist/kernel-host");

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
